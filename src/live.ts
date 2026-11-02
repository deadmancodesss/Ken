import "dotenv/config";
import { randomUUID } from "node:crypto";
import { TOOLS, TOOL_NAMES, runTool } from "./tools.js";
import { peopleRoster } from "./people.js";
import { systemPrompt } from "./brain.js";
import { geminiVoiceNames } from "./speech.js";

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

export type LiveCall = { id: string; model: string; send: (pcm: Buffer) => void; stop: () => void };

/**
 * Opens a call on the first model in the chain that completes its handshake, then
 * keeps it open until the browser hangs up or goes quiet.
 */
export async function startLive(emit: (e: LiveEvent) => void, voice?: string): Promise<LiveCall> {
  const state = liveState();
  if (!state.enabled) throw new Error(state.why || "live is not available");

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

function open(model: string, emit: (e: LiveEvent) => void, voice?: string): Promise<LiveCall> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(ENDPOINT + KEY);
    const id = randomUUID();
    let settled = false;
    let lastMic = Date.now();
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
      send({
        setup: {
          model: `models/${model}`,
          generationConfig,
          systemInstruction: { parts: [{ text: systemPrompt() }] },
          tools: [{ functionDeclarations: declarations() }],
        },
      }),
    );

    const idle = setInterval(() => {
      if (Date.now() - lastMic > 90_000) {
        clearInterval(idle);
        ws.close();
      }
    }, 5_000);

    ws.addEventListener("message", async (ev) => {
      // A text frame arrives as a Blob on this runtime, so both shapes get handled.
      const d = ev.data as unknown;
      const m: any = JSON.parse(typeof d === "string" ? d : await (d as Blob).text());
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
          send(pcm) {
            lastMic = Date.now();
            // Only ever push raw audio. The turn is closed by the server's own voice
            // activity detection, and a client turnComplete on top of it truncates the
            // sentence before the model has heard the end of it, which reads as silence.
            send({ realtimeInput: { audio: { mimeType: "audio/pcm;rate=16000", data: pcm.toString("base64") } } });
          },
          stop() {
            clearInterval(idle);
            ws.close();
          },
        });
        return;
      }

      for (const c of m.toolCall?.functionCalls ?? []) {
        const name = c.name ?? "";
        const args = c.args ?? {};
        let step: LiveEvent = { kind: "tool", name, args, ok: false, error: "unknown tool" };
        if (TOOL_NAMES.includes(name)) {
          try {
            const result = await runTool(name, args);
            step = { kind: "tool", name, args, ok: true, result };
            send({ toolResponse: { functionResponses: [{ id: c.id, name, response: result as object }] } });
          } catch (err) {
            step = { kind: "tool", name, args, ok: false, error: (err as Error).message };
            send({ toolResponse: { functionResponses: [{ id: c.id, name, response: { error: (err as Error).message } }] } });
          }
        }
        emit(step);
      }

      if (m.serverContent?.inputTranscription?.text) emit({ kind: "heard", text: m.serverContent.inputTranscription.text });
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
      if (m.voiceActivity?.type) emit({ kind: "activity", type: m.voiceActivity.type });
      if (m.serverContent?.turnComplete) {
        if (!transcribed && pendingText) emit({ kind: "said", text: pendingText });
        pendingText = "";
        transcribed = false;
        if (speaking) {
          speaking = false;
          emit({ kind: "turn" });
        }
      }
      if (m.error) fail(m.error?.message ?? JSON.stringify(m.error).slice(0, 200));
    });

    ws.addEventListener("error", () => fail("the live socket failed"));
    ws.addEventListener("close", (e: any) => {
      clearInterval(idle);
      const reason = e?.reason ? String(e.reason).slice(0, 200) : "socket closed";
      if (!settled) reject(new Error(reason));
      else emit({ kind: "close", reason });
    });

    // A preview model can accept the socket and never finish the handshake, which would
    // otherwise leave the call button spinning for the whole demo.
    const guard = setTimeout(() => {
      if (settled) return;
      ws.close();
      reject(new Error("no handshake in 12s"));
    }, 12_000);
  });
}
