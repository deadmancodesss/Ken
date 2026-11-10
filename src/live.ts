import "dotenv/config";
import { randomUUID } from "node:crypto";
import { TOOLS, TOOL_NAMES, runTool } from "./tools.js";
import { peopleRoster } from "./people.js";
import { systemPrompt } from "./brain.js";
import { geminiVoiceNames } from "./speech.js";
import { currentSeat, within } from "./seat.js";

/*
 * One persistent Gemini Live socket per open call. The browser never holds a key and
 * never speaks WebSocket to Google. It posts 16 kHz microphone chunks to this server,
 * this server forwards them into the socket, and whatever comes back, the transcript,
 * the tool calls and the 24 kHz reply, is pushed to the browser over an event stream.
 */

const KEY = process.env.LIVE_API_KEY ?? process.env.GEMINI_API_KEY ?? process.env.MODEL_API_KEY;

/**
 * A chain rather than one name, because these preview models are taken out of service
 * without notice and a call that cannot open is worse than a call that opens late.
 * 3.1 leads on measured behaviour, since it hears a spoken question word for word,
 * fires a tool with the right argument and speaks the answer. 3.8 is behind it only
 * because Google published 2026-11-17 as 3.1's earliest shutdown, and it is not an
 * equal substitute: tested on this key on 2026-11-02 it fired a tool, invented the
 * person's name and returned no audio at all. So the tail is a call that still opens
 * rather than one that still tells the truth, and that trade is worth knowing before
 * the day it silently happens.
 */
const CHAIN = (process.env.LIVE_MODEL ?? "gemini-3.1-flash-live-preview,gemini-3.8-live")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);

const ENDPOINT =
  "wss://generativelanguage.googleapis.com/ws/google.ai.generativelanguage.v1beta.GenerativeService.BidiGenerateContent?key=";

/** Anything the browser needs to know, as one flat shape so the stream stays trivial. */
export type LiveEvent =
  | { kind: "open"; id: string; model: string; voice: string }
  | { kind: "heard"; text: string }
  | { kind: "said"; text: string }
  | { kind: "audio"; rate: number; data: string }
  | { kind: "activity"; type: string }
  | { kind: "tool-start"; name: string; args: unknown }
  | { kind: "tool"; name: string; args: unknown; ok: boolean; result?: unknown; error?: string }
  | { kind: "turn" }
  | { kind: "close"; reason: string }
  | { kind: "error"; message: string };

export function liveState() {
  if (!KEY || KEY === "stub") return { enabled: false, model: "", voice: "", why: "no live key in .env" };
  if (!/live|audio/.test(CHAIN[0])) return { enabled: false, model: CHAIN[0], voice: "", why: `${CHAIN[0]} is not a two-way audio model` };
  return { enabled: true, model: CHAIN[0], voice: liveVoice(), why: "" };
}

/**
 * The tool layer is shared with the typed page, so a spoken request runs the exact
 * same code as a written one. Only the schema spelling differs, because the native
 * endpoint wants lower-case JSON types where the OpenAI-compatible one tolerated Google's.
 */
function declarations() {
  return TOOLS.map((t) => ({
    name: t.name,
    description: t.description,
    parameters: {
      type: "object",
      properties: Object.fromEntries(
        Object.entries(t.parameters).map(([k, v]) => [k, { type: v.type.toLowerCase(), description: v.description }]),
      ),
      required: t.required,
    },
  }));
}

/**
 * `FunctionResponse.response` is a protobuf Struct, so it has to be a JSON object.
 * `money_history` and `people_you_know` return lists, and sending one bare closed the
 * socket mid-call on 2026-11-04 with "Proto field is not repeatable". A list or a bare
 * value travels under one key instead, which is still a Struct and still readable.
 */
export function toolStruct(result: unknown): Record<string, unknown> {
  if (result && typeof result === "object" && !Array.isArray(result)) return result as Record<string, unknown>;
  return { result };
}

/**
 * Every tool call gets exactly one reply, whatever happened to it. A model that asks for
 * a name it invented and hears nothing assumes the tool is still working, stops talking
 * and waits, and the microphone frames keep the idle timer from ever closing a call that
 * has gone quiet forever. The same applies to a lookup that never returns, since a fetch
 * with no deadline can sit for minutes and silence sounds identical to thinking.
 */
const TOOL_TIMEOUT_MS = Number(process.env.LIVE_TOOL_TIMEOUT_MS ?? 20_000);

/**
 * A read that misses its deadline can be dropped. A payment that misses it has already
 * been signed and is waiting on chain finality, which on Tatum measured about twenty
 * seconds and once landed exactly as the tool was cut off. Money therefore gets a
 * deadline longer than finality, and a timeout on it is reported as an unknown payment
 * rather than as a failed one.
 */
const MONEY_TIMEOUT_MS = Number(process.env.LIVE_MONEY_TIMEOUT_MS ?? 75_000);
const MONEY_TOOLS = new Set(["pay_usdc", "paid_lookup", "verify_payment", "open_paid_link"]);

export function withToolTimeout<T>(work: Promise<T>, ms = TOOL_TIMEOUT_MS, what = "the lookup"): Promise<T> {
  const waited = ms >= 1000 ? `${Math.round(ms / 1000)} seconds` : `${ms} milliseconds`;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`${what} took longer than ${waited}`)), ms);
    work.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (err) => {
        clearTimeout(timer);
        reject(err);
      },
    );
  });
}

export async function answerToolCall(
  call: { id?: string; name?: string; args?: Record<string, unknown> },
  reply: (message: unknown) => void,
): Promise<LiveEvent> {
  const name = call.name ?? "";
  const args = call.args ?? {};
  const respond = (response: Record<string, unknown>) =>
    reply({ toolResponse: { functionResponses: [{ id: call.id, name, response }] } });

  if (!TOOL_NAMES.includes(name)) {
    respond(toolStruct({ error: `no tool named "${name}". available: ${TOOL_NAMES.join(", ")}` }));
    return { kind: "tool", name, args, ok: false, error: "unknown tool" };
  }

  const money = MONEY_TOOLS.has(name);
  try {
    const result = await withToolTimeout(runTool(name, args), money ? MONEY_TIMEOUT_MS : TOOL_TIMEOUT_MS, money ? "the payment" : "the lookup");
    respond(toolStruct(result));
    return { kind: "tool", name, args, ok: true, result };
  } catch (err) {
    const message = (err as Error).message;
    if (money && /took longer than/.test(message)) {
      // The transfer may settle after this answer. Saying "failed" invites a second
      // payment for a debt the chain has already recorded, so the model is handed the
      // uncertainty and told to read the recipient's history before it speaks.
      respond(
        toolStruct({
          pending: true,
          may_have_been_sent: true,
          instruction: "Do not call this tool again for this payment. Read money_history for this recipient and tell the user what the chain shows.",
        }),
      );
      return { kind: "tool", name, args, ok: false, error: `${message}, and the money may have moved. Do not resend` };
    }
    respond(toolStruct({ error: message }));
    return { kind: "tool", name, args, ok: false, error: message };
  }
}

export type LiveCall = {
  id: string;
  model: string;
  voice: string;
  send: (pcm: Buffer) => void;
  say: (text: string) => void;
  stop: () => void;
};

/**
 * Opens a call on the first model in the chain that completes its handshake, then
 * keeps it open until the browser hangs up or goes quiet.
 */
export async function startLive(emit: (e: LiveEvent) => void, voice?: string): Promise<LiveCall> {
  const state = liveState();
  if (!state.enabled) throw new Error(state.why || "live is not available");

  // The first name lookup reads the whole roster and measured 3.7 seconds. Starting
  // it beside the handshake hides that behind time the caller spends talking, and the
  // shared read below means the tool joins this one instead of starting a second.
  void peopleRoster().catch(() => {});

  for (const model of CHAIN) {
    try {
      return await open(model, emit, voice);
    } catch (err) {
      emit({ kind: "error", message: `${model} could not open: ${(err as Error).message}` });
    }
  }
  throw new Error(`no live model on this key answered. tried ${CHAIN.join(", ")}`);
}

/**
 * Maps anything the page can hand us onto one real speaker name, always the same answer
 * for the same input, so a call keeps one voice from open to hangup. A prefixed id is
 * what the picker stores (`gemini:Kore`), a bare name is what an older visit stored, and
 * a Fish or HeyGen id means the listener chose a voice this socket cannot speak, so they
 * get the configured default and the page says which name is in use.
 */
export function liveVoice(raw?: string): string {
  const fallback = process.env.LIVE_VOICE || process.env.TTS_VOICE || "Kore";
  const bare = String(raw ?? "").split(":").pop() ?? "";
  return geminiVoiceNames().includes(bare) ? bare : fallback;
}

/**
 * A typed request can be followed by a second sentence if the first was not clear.
 * A caller standing in a room will not repeat themselves while the model decides, so
 * the live socket is told once, at handshake, that the tool call itself draws the field
 * and the first sentence is enough to make it.
 */
function liveInstruction(): string {
  return `${systemPrompt()}

This is a live voice call. The moment a sentence needs a typed field, call the tool that draws it on that same turn: name_a_person with an empty address when the person wants an address kept, address_activity with an empty address when they want a wallet inspected, pay_usdc with the amount they said and an empty address when they want money sent, request_money with the amount and note when they want a request link. The page draws the field from that call. Never ask them to say a wallet address aloud, and do not wait for them to repeat the request before calling.`;
}

function open(model: string, emit: (e: LiveEvent) => void, voice?: string): Promise<LiveCall> {
  return new Promise((resolve, reject) => {
    /*
     * A call outlives the request that opened it, and a tool it fires arrives on a
     * socket event rather than on that request. Pinning the seat here means the socket
     * answers from the wallet that opened the call even if the event loop would
     * otherwise have lost the context, and two calls open in two browsers stay two
     * separate wallets for their whole life.
     */
    const seat = currentSeat();
    const inSeat = <T>(fn: () => T) => (seat ? within(seat, fn) : fn());
    const ws = new WebSocket(ENDPOINT + KEY);
    const id = randomUUID();
    let settled = false;
    // The browser streams silence as faithfully as speech, so mic frames cannot tell
    // a person who is thinking from a room somebody walked out of. Only a transcribed
    // word or a detected voice start counts as company on the line.
    let lastHeard = Date.now();
    let speaking = false;
    let pendingText = "";
    let transcribed = false;

    const send = (obj: unknown) => {
      if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(obj));
    };

    /*
     * The voice is pinned here rather than trusted from the page. A name Google does not
     * know is not an error, it is silently ignored, and the socket then answers with
     * whatever speaker it felt like that turn, so every reply sounds like a different
     * person. The picker on the page carries three vendors' ids, and only the bare Google
     * names mean anything to this socket.
     */
    const voiceName = liveVoice(voice);
    const generationConfig: Record<string, unknown> = {
      responseModalities: ["AUDIO"],
      speechConfig: { voiceConfig: { prebuiltVoiceConfig: { voiceName } } },
    };

    const fail = (message: string) => {
      if (settled) emit({ kind: "error", message });
      else reject(new Error(message));
    };

    ws.addEventListener("open", () =>
      inSeat(() =>
        send({
          setup: {
            model: `models/${model}`,
            generationConfig,
            systemInstruction: { parts: [{ text: liveInstruction() }] },
            tools: [{ functionDeclarations: declarations() }],
          },
        }),
      ),
    );

    const idleMs = Number(process.env.LIVE_IDLE_MS ?? 90_000);
    const idle = setInterval(() => {
      if (Date.now() - lastHeard > idleMs) {
        clearInterval(idle);
        ws.close(1000, `no one spoke for ${Math.round(idleMs / 1000)} seconds`);
      }
    }, 5_000);

    const handleMessage = async (ev: MessageEvent) => {
      // A text frame arrives as a Blob on this runtime, so both shapes get handled.
      const d = ev.data as unknown;
      let m: any;
      try {
        m = JSON.parse(typeof d === "string" ? d : await (d as Blob).text());
      } catch {
        // One unreadable frame is not a reason to end the call, and it is certainly not
        // a reason to end the server. The next frame may still be a normal turn.
        emit({ kind: "error", message: "the live socket sent a frame this server could not read" });
        return;
      }
      if (m.setupComplete) {
        settled = true;
        clearTimeout(guard);
        // A first name lookup reads the whole roster off Walrus and takes a couple of
        // seconds. Asking for it while the caller is still saying their sentence moves
        // that wait somewhere the speaker cannot feel it.
        void peopleRoster().catch(() => {});
        emit({ kind: "open", id, model, voice: voiceName });
        resolve({
          id,
          model,
          voice: voiceName,
          send(pcm) {
            // Only ever push raw audio. The turn is closed by the server's own voice
            // activity detection, and a client turnComplete on top of it truncates the
            // sentence before the model has heard the end of it, which reads as silence.
            send({ realtimeInput: { audio: { mimeType: "audio/pcm;rate=16000", data: pcm.toString("base64") } } });
          },
          say(text) {
            // A typed address cannot be spoken into this model, so the page hands over a
            // note instead. A client turn is the only way to tell a live socket something
            // without a microphone, and the turn is completed here because nothing else
            // will close it.
            send({ clientContent: { turns: [{ role: "user", parts: [{ text }] }], turnComplete: true } });
            lastHeard = Date.now();
          },
          stop() {
            clearInterval(idle);
            ws.close();
          },
        });
        return;
      }

      for (const c of m.toolCall?.functionCalls ?? []) {
        // A payment can sit in finality for twenty seconds. Saying nothing for that
        // long is what made a settling transfer read as a dead call.
        emit({ kind: "tool-start", name: c.name ?? "", args: c.args ?? {} });
        emit(await answerToolCall(c, send));
      }

      if (m.serverContent?.inputTranscription?.text) {
        lastHeard = Date.now();
        emit({ kind: "heard", text: m.serverContent.inputTranscription.text });
      }
      /* In audio mode the same sentence arrives twice, once as a text part and once as
         the output transcription. Showing both puts words on the screen that the voice
         never said in that order, so the transcription wins and the text part is only
         used if the model turned out not to transcribe at all. */
      for (const p of m.serverContent?.modelTurn?.parts ?? []) {
        if (p.text && !p.thought) pendingText += p.text;
        if (p.inlineData?.data) {
          const rate = Number(/rate=(\d+)/.exec(p.inlineData.mimeType ?? "")?.[1] ?? 24000);
          speaking = true;
          emit({ kind: "audio", rate, data: p.inlineData.data });
        }
      }
      if (m.serverContent?.outputTranscription?.text) {
        transcribed = true;
        emit({ kind: "said", text: m.serverContent.outputTranscription.text });
      }
      if (m.voiceActivity?.type) {
        if (m.voiceActivity.type === "ACTIVITY_START") lastHeard = Date.now();
        emit({ kind: "activity", type: m.voiceActivity.type });
      }
      if (m.serverContent?.turnComplete) {
        if (!transcribed && pendingText) emit({ kind: "said", text: pendingText });
        pendingText = "";
        transcribed = false;
        speaking = false;
        // A turn that finished without audio still finished. Keeping the page's line
        // open for it made the next sentence join the last one, which is how one
        // utterance appeared twice on screen.
        emit({ kind: "turn" });
      }
      if (m.goAway) {
        // The provider is about to close this session. Saying so is the difference
        // between a caller who knows to call back and a call that just stops talking.
        const left = m.goAway?.timeLeft ? ` in ${String(m.goAway.timeLeft)}` : " shortly";
        emit({ kind: "error", message: `the live session is ending${left}. Hang up and start a new call` });
      }
      if (m.error) {
        // An error frame means this session will not carry another turn. Leaving the
        // socket open would show an error on a call that looks alive and never speaks
        // again, so the close that follows is the honest end of it.
        fail(m.error?.message ?? JSON.stringify(m.error).slice(0, 200));
        ws.close();
      }
    };

    ws.addEventListener("message", (ev) => {
      // Anything thrown in here used to become an unhandled rejection strong enough to
      // end the whole process, which drops every page the server is serving, not just
      // this call. A frame that breaks something is reported and the call carries on.
      inSeat(() => handleMessage(ev)).catch((err) =>
        emit({ kind: "error", message: `the live socket broke a frame: ${(err as Error).message}` }),
      );
    });

    ws.addEventListener("error", () => fail("the live socket failed"));
    ws.addEventListener("close", (e: any) => {
      clearInterval(idle);
      const reason = e?.reason ? String(e.reason).slice(0, 200) : "socket closed";
      if (!settled) reject(new Error(reason));
      else emit({ kind: "close", reason });
    });

    // A preview model can accept the socket and never finish the handshake, which would
    // otherwise leave the call button spinning for the whole call.
    const guard = setTimeout(() => {
      if (settled) return;
      ws.close();
      reject(new Error("no handshake in 12s"));
    }, 12_000);
  });
}
