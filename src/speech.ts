import "dotenv/config";

/*
 * Three vendors answer for the agent's voice, and the browser is the fourth. Fish speaks
 * first because it measured an order of magnitude faster and is not throttled, HeyGen
 * comes through OpenRouter when it has a key, and Gemini speaks when both of them fail.
 * Which one actually answered is returned with the audio rather than assumed, because a
 * demo that quietly falls back mid-sentence has to say so on screen.
 *
 * None of them runs a conversation. Turn taking, listening for the user's voice over the
 * agent's, and knowing when a sentence has ended all belong to the Live socket in
 * src/live.ts, which is a different product from text-to-speech. This file only ever
 * turns a finished sentence into sound.
 */

const GEMINI_BASE = (process.env.TTS_BASE_URL ?? "https://generativelanguage.googleapis.com/v1beta").replace(/\/$/, "");
const GEMINI_MODEL = process.env.TTS_MODEL ?? "gemini-3.8-flash-tts";
const GEMINI_KEY = process.env.TTS_API_KEY ?? process.env.GEMINI_API_KEY ?? process.env.MODEL_API_KEY;
const FISH_KEY = process.env.FISH_API_KEY;

/** A vendor that is present but throttled is not enabled, so the demo does not wait on it. */
const usable = (k?: string) => {
  const v = (k ?? "").trim();
  return v.length > 0 && v !== "stub";
};

/**
 * OpenRouter keys begin `sk-or-v1-`, and that prefix is deliberately not checked here. A
 * credential of any other shape is sent once and answered by the provider's own 401, which
 * is a truer sentence on screen than this file guessing what a value was copied from. It
 * guessed once, called a working key a browser session token, and threw the route away.
 */
const rawOpenRouterKey = (process.env.OPENROUTER_API_KEY ?? "").trim();
const OPENROUTER_KEY = usable(rawOpenRouterKey) ? rawOpenRouterKey : "";
const OPENROUTER_WHY = OPENROUTER_KEY
  ? ""
  : rawOpenRouterKey
    ? "OPENROUTER_API_KEY is set but is not usable, so HeyGen was never asked"
    : "no OPENROUTER_API_KEY in .env. Make one at openrouter.ai/settings/keys";
const OPENROUTER_BASE = (process.env.OPENROUTER_BASE_URL ?? "https://openrouter.ai/api/v1").replace(/\/$/, "");

/**
 * HeyGen is the only voice this route carries, and finding that out cost two wrong answers.
 * The model catalogue does not list it, which made it look fictional, and asking the speech
 * route for `fish/s2.1-pro-free` is answered with "does not exist". Fish speaks only through
 * its own API, so the middle of this ladder is a second vendor's mouth rather than a second
 * door to the first one.
 */
const OPENROUTER_MODEL = process.env.OPENROUTER_TTS_MODEL ?? "heygen/heygen-voice-1-turbo:free";
const OPENROUTER_VOICES = ["nadine", "tabitha", "bram", "gareth", "noelle", "meredith", "sabrina", "lucian", "weston", "vincent"];

export type Provider = "fish" | "openrouter" | "gemini";
export type Voice = { id: string; label: string; provider: Provider; note: string };

/** Who gets asked first when nobody chose. A route with no key is skipped, not stalled. */
const LADDER: Provider[] = (process.env.VOICE_ORDER ?? "fish,openrouter,gemini")
  .split(",")
  .map((s) => s.trim())
  .filter((s): s is Provider => ["fish", "openrouter", "gemini"].includes(s));

/**
 * Google's own prebuilt set. They are multilingual, so a name is a timbre rather than
 * a language, and the licence question is already settled.
 */
const GEMINI_VOICES = [
  "Kore",
  "Puck",
  "Charon",
  "Fenrir",
  "Leda",
  "Orus",
  "Aoede",
  "Zephyr",
  "Callirrhoe",
  "Autonoe",
  "Enceladus",
  "Umbriel",
  "Algieba",
  "Despina",
  "Erinome",
  "Rasalgethi",
  "Laomedeia",
  "Achernar",
  "Alnilam",
  "Schedar",
  "Gacrux",
  "Sadachbia",
  "Sadaltager",
  "Sulafat",
];

/**
 * Fish picks its voice from a marketplace of cloned ones, and the most-used entries
 * returned by a catalogue query are game announcers and named celebrities, so nothing
 * from that list is shipped here by default. `default` means no reference id and gets
 * whatever voice Fish ships with. More can be added without touching this file by
 * listing `id:Label` pairs in FISH_VOICES, and each one is then the builder's own
 * licensing decision.
 */
function fishVoices(): Voice[] {
  const extra = (process.env.FISH_VOICES ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean)
    .map((pair) => {
      const [id, ...rest] = pair.split(":");
      return { id: `fish:${id}`, label: rest.join(":") || id, provider: "fish" as const, note: "community clone" };
    });
  return [{ id: "fish:default", label: "Fish default", provider: "fish", note: "83 languages, detected from the text" }, ...extra];
}

/**
 * The names the live socket will actually honour. It shares Google's prebuilt set with
 * `/speak`, and a name outside this list is not rejected, it is ignored, which is how a
 * call ends up with a different speaker every answer.
 */
export const geminiVoiceNames = () => [...GEMINI_VOICES];

export function voices(): Voice[] {
  const out: Voice[] = [];
  if (usable(FISH_KEY)) out.push(...fishVoices());
  if (usable(OPENROUTER_KEY))
    out.push(...OPENROUTER_VOICES.map((v) => ({ id: `openrouter:${v}`, label: `HeyGen ${v}`, provider: "openrouter" as const, note: "free through OpenRouter" })));
  if (usable(GEMINI_KEY)) out.push(...GEMINI_VOICES.map((v) => ({ id: `gemini:${v}`, label: v, provider: "gemini" as const, note: "Google prebuilt" })));
  return out;
}

/** Anything without a vendor prefix is a bare Gemini name, which is what older visits saved. */
function resolve(raw?: string): Voice | null {
  const list = voices();
  if (!list.length) return null;
  const want = raw ? (raw.includes(":") ? raw : `gemini:${raw}`) : "";
  return list.find((v) => v.id === want) ?? list.find((v) => v.id === defaultVoice()) ?? list[0];
}

export const defaultVoice = () => {
  const first = LADDER.find((p) => (p === "fish" ? usable(FISH_KEY) : p === "openrouter" ? usable(OPENROUTER_KEY) : usable(GEMINI_KEY)));
  if (first === "fish") return "fish:default";
  if (first === "openrouter") return `openrouter:${OPENROUTER_VOICES[0]}`;
  if (first === "gemini") return `gemini:${process.env.TTS_VOICE ?? "Kore"}`;
  return "";
};

export function ttsEnabled() {
  return voices().length > 0;
}

/**
 * Which vendor last produced bytes. A page prints this as "speaks with openrouter", so
 * it has to be a measurement of who answered rather than a reading of which keys exist.
 * A route that holds a working credential and still refuses every sentence is not the
 * voice of the demo, and naming it as one is the same lie the `x-voice` header exists to
 * stop. Empty until a sentence has actually been spoken.
 */
let spoke: Provider | "" = "";

export function ttsState() {
  const providers: { id: Provider; ready: boolean; why: string; resting: string }[] = [
    { id: "fish", ready: usable(FISH_KEY), why: usable(FISH_KEY) ? "" : "no FISH_API_KEY in .env", resting: restingFor("fish") },
    { id: "openrouter", ready: usable(OPENROUTER_KEY), why: OPENROUTER_WHY, resting: restingFor("openrouter") },
    { id: "gemini", ready: usable(GEMINI_KEY), why: usable(GEMINI_KEY) ? "" : "no GEMINI_API_KEY in .env", resting: restingFor("gemini") },
  ];
  const answered = providers.find((p) => p.id === spoke && p.ready);
  return {
    enabled: ttsEnabled(),
    model: answered?.id ?? providers.find((p) => p.ready && !p.resting)?.id ?? providers.find((p) => p.ready)?.id ?? "none",
    voice: defaultVoice(),
    voices: voices(),
    providers,
  };
}

/** PCM comes back bare, and a browser will only decode a container, so the header is written here. */
function wav(pcm: Buffer, rate: number) {
  const out = Buffer.alloc(44 + pcm.length);
  out.write("RIFF", 0);
  out.writeUInt32LE(36 + pcm.length, 4);
  out.write("WAVE", 8);
  out.write("fmt ", 12);
  out.writeUInt32LE(16, 16);
  out.writeUInt16LE(1, 20);
  out.writeUInt16LE(1, 22);
  out.writeUInt32LE(rate, 24);
  out.writeUInt32LE(rate * 2, 28);
  out.writeUInt16LE(2, 32);
  out.writeUInt16LE(16, 34);
  out.write("data", 36);
  out.writeUInt32LE(pcm.length, 40);
  pcm.copy(out, 44);
  return out;
}

/**
 * A vendor that just failed is left alone for a minute. Without this, every sentence
 * of a demo pays for a retry against a quota that is already spent, and the fall over
 * looks like slowness rather than absence. Zero turns the guard off, which is what the
 * scripted tests need in order to see each failure rather than the memory of one.
 */
const COOLDOWN = Number(process.env.VOICE_COOLDOWN_MS ?? 60_000);
const cooled = new Map<Provider, number>();
const cooldown = (p: Provider) => COOLDOWN > 0 && (cooled.get(p) ?? 0) > Date.now();
const cool = (p: Provider) => cooled.set(p, Date.now() + COOLDOWN);

/**
 * The reason a vendor last refused, which is a different fact from having a key. A
 * picker that lists twenty-four voices whose vendor has been out of sentences for
 * thirteen hours looks broken rather than honest, so the refusal is reported back out
 * through `ttsState` for exactly as long as the retry guard above still believes it.
 * When retries are turned off there is no window to expire, and the next sentence that
 * speaks is what clears it.
 */
const refused = new Map<Provider, string>();
const restingFor = (p: Provider) => {
  const why = refused.get(p) ?? "";
  if (!why) return "";
  return COOLDOWN > 0 ? (cooldown(p) ? why : "") : why;
};

/** The vendor's own name for a voice, since the three vendors do not share an id space. */
function nameFor(v: Voice, p: Provider): string {
  const own = `${p}:`;
  const bare = v.id.startsWith(own) ? v.id.slice(own.length) : "";
  if (p === "fish") return bare || "default";
  if (p === "openrouter") return bare || OPENROUTER_VOICES[0];
  return bare || (process.env.TTS_VOICE ?? "Kore");
}

/**
 * The voice to report for a vendor that was not the one asked for. Handing back the
 * requested id when a different vendor produced the bytes would put a lie on the
 * screen about who spoke, which is the one thing this function exists to get right.
 */
function voiceFor(p: Provider): Voice {
  if (p === "fish") return fishVoices()[0];
  if (p === "openrouter")
    return { id: `openrouter:${OPENROUTER_VOICES[0]}`, label: `HeyGen ${OPENROUTER_VOICES[0]}`, provider: "openrouter", note: "free through OpenRouter" };
  const name = process.env.TTS_VOICE ?? "Kore";
  return { id: `gemini:${name}`, label: name, provider: "gemini", note: "Google prebuilt" };
}

async function viaOpenRouter(text: string, voice: string): Promise<Buffer> {
  const res = await fetch(`${OPENROUTER_BASE}/audio/speech`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${OPENROUTER_KEY}` },
    body: JSON.stringify({
      model: OPENROUTER_MODEL,
      input: text,
      voice,
      // Measured 2026-11-03: this vendor answers 400 for both wav and mp3 and says out
      // loud that it supports pcm only. The format is therefore asked for by its real
      // name, and the bare samples get their header written below.
      response_format: "pcm",
    }),
  });
  const type = res.headers.get("content-type") ?? "";
  if (!res.ok || type.includes("json")) {
    const body = await res.json().catch(() => ({} as any));
    const msg = String(body?.error?.message ?? JSON.stringify(body)).replace(/\s+/g, " ").slice(0, 160);
    if (res.status === 401) throw new Error(`openrouter refused the voice key (${msg})`);
    if (res.status === 402) throw new Error("openrouter voice needs credit, and this account has none");
    if (res.status === 429) throw new Error(`openrouter voice is out of free requests (${msg})`);
    throw new Error(`openrouter voice failed (${res.status}${msg ? `, ${msg}` : ""})`);
  }
  const bytes = Buffer.from(await res.arrayBuffer());
  if (bytes.length < 1000) throw new Error("openrouter sent an empty take");
  // A container already carries its own rate, so only a bare stream needs a header. The
  // rate is read from the content type because the vendor's own answer was measured at
  // 44.1 kHz, which is not the 24 kHz this file uses everywhere else.
  if (type.includes("wav")) return bytes;
  return wav(bytes, Number(type.match(/rate=(\d+)/)?.[1]) || 44100);
}

async function viaFish(text: string, voice: string): Promise<Buffer> {
  const ref = voice === "default" ? "" : voice;
  const res = await fetch("https://api.fish.audio/v1/tts", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${FISH_KEY!}`,
      // Free is a model choice rather than a key property. Omit it and the request
      // silently routes to the paid s2.1-pro, which a zero balance rejects with a 402.
      model: "s2.1-pro-free",
      latency: "balanced",
    },
    body: JSON.stringify({
      text,
      ...(ref && ref !== "default" ? { reference_id: ref } : {}),
      // A container carries its own sample rate. Requesting raw PCM would mean trusting
      // a number, and this vendor's default is 44.1 kHz where the Live path is 24 kHz.
      format: "wav",
      latency: "balanced",
      chunk_length: 200,
    }),
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({} as any));
    const msg = String(body?.message ?? body?.error?.message ?? "").slice(0, 160);
    if (res.status === 402) throw new Error(`fish needs the free model header (${msg})`);
    if (res.status === 429) throw new Error(`fish is at its concurrency limit of five`);
    throw new Error(`fish failed (${res.status}${msg ? `, ${msg}` : ""})`);
  }
  const bytes = Buffer.from(await res.arrayBuffer());
  if (bytes.length < 1000) throw new Error("fish sent an empty take");
  return bytes;
}

async function viaGemini(text: string, voiceName: string): Promise<Buffer> {
  const res = await fetch(`${GEMINI_BASE}/models/${GEMINI_MODEL}:generateContent`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-goog-api-key": GEMINI_KEY! },
    body: JSON.stringify({
      contents: [{ role: "user", parts: [{ text: `Say the following in a warm, unhurried voice. Repeat it exactly and add nothing:\n${text}` }] }],
      generationConfig: {
        responseModalities: ["AUDIO"],
        speechConfig: { voiceConfig: { prebuiltVoiceConfig: { voiceName } } },
      },
    }),
  });
  const body: any = await res.json().catch(() => ({}));
  if (!res.ok) {
    const raw = String(body?.error?.message ?? JSON.stringify(body).slice(0, 240));
    // The provider's blob is not something to put on screen mid demo, but the wait is
    // the whole story: twenty seconds and until midnight are different problems.
    const wait = (unit: string) => Number(raw.match(new RegExp(`retry in [\\dhm]*?([\\d.]+)${unit}`))?.[1]);
    const h = wait("h");
    const m = wait("m");
    const s = wait("s");
    if (res.status === 429) {
      const until = h ? `again in about ${Math.round(h)} h` : m ? `again in about ${Math.round(m)} min` : s ? `again in about ${Math.max(1, Math.round(s))} s` : "again later, the daily quota is spent";
      throw new Error(`gemini voice is out of sentences, ${until}`);
    }
    throw new Error(`gemini voice failed (${res.status})`);
  }
  const audio = audioFrom(body);
  if (!audio) throw new Error("gemini answered but sent no audio back");
  return audio;
}

/**
 * Google moved speech to a second request shape while this was being written, so both
 * readings are accepted here and a wrong one surfaces as the provider's own message
 * instead of silence.
 */
function audioFrom(body: any): Buffer | null {
  for (const p of body?.candidates?.[0]?.content?.parts ?? []) {
    const inline = p?.inlineData ?? p?.inline_data;
    if (!inline?.data) continue;
    const mime = String(inline.mimeType ?? inline.mime_type ?? "audio/L16;rate=24000");
    const raw = Buffer.from(String(inline.data), "base64");
    // A unary call now hands back a RIFF header on its own, and wrapping it again
    // produces a file the browser decodes as silence.
    return mime.includes("wav") || mime.includes("ogg") ? raw : wav(raw, Number(mime.match(/rate=(\d+)/)?.[1]) || 24000);
  }
  for (const step of body?.steps ?? []) {
    for (const c of step?.content ?? []) {
      if (c?.type === "audio" && c?.data) return Buffer.from(String(c.data), "base64");
    }
  }
  return null;
}

/**
 * Spoken answers get repeated on screen, and a repeat must never cost a second call. The
 * producer travels with the bytes rather than the requested voice id, because a sentence
 * that fish refused and gemini covered would otherwise come back on the second reading
 * claiming to be fish.
 */
const heard = new Map<string, { bytes: Buffer; voice: Voice }>();

/**
 * Letting go of a wallet has to drop these bytes too. The key of every entry is the
 * sentence the agent said, and the sentences are about this person's own people, so a
 * cache that survives a disconnect survives with their names spelled inside it.
 */
export function forgetAudio(): void {
  heard.clear();
}

export type Spoken = { bytes: Buffer; voice: Voice; ms: number };

/**
 * Says `text` through the first vendor that will answer, and throws only when neither
 * will. The caller gets the voice back rather than just the bytes, so the page can
 * name the engine that spoke instead of naming the one it asked for.
 */
export async function synthesize(text: string, raw?: string): Promise<Spoken> {
  const clean = String(text).trim().slice(0, 1500);
  if (!clean) throw new Error("nothing to say");
  const chosen = resolve(raw);
  if (!chosen) throw new Error("no voice key in .env, so this browser speaks");

  const memo = `${chosen.id}|${clean.toLowerCase()}`;
  const remembered = heard.get(memo);
  if (remembered) {
    spoke = remembered.voice.provider;
    return { bytes: remembered.bytes, voice: remembered.voice, ms: 0 };
  }

  // The chosen voice is tried first and the rest follow in the configured order, because
  // a listener who picked HeyGen should get HeyGen until it fails rather than a ladder.
  const order: Provider[] = [chosen.provider, ...LADDER.filter((p) => p !== chosen.provider)];
  const failures: string[] = [];

  for (const p of order) {
    const key = p === "fish" ? FISH_KEY : p === "openrouter" ? OPENROUTER_KEY : GEMINI_KEY;
    if (!usable(key)) continue;
    if (cooldown(p)) {
      failures.push(`${p} is resting after a recent failure${restingFor(p) ? ` (${restingFor(p)})` : ""}`);
      continue;
    }
    const voice = p === chosen.provider ? chosen : voiceFor(p);
    const name = nameFor(voice, p);
    const t0 = Date.now();
    try {
      const bytes = p === "fish" ? await viaFish(clean, name) : p === "openrouter" ? await viaOpenRouter(clean, name) : await viaGemini(clean, name);
      if (heard.size > 24) heard.delete(heard.keys().next().value as string);
      heard.set(memo, { bytes, voice });
      refused.delete(p);
      spoke = p;
      return { bytes, voice, ms: Date.now() - t0 };
    } catch (err) {
      const message = (err as Error).message;
      failures.push(message);
      refused.set(p, message);
      // A quota that is spent will not open again inside this demo, so the vendor is
      // rested. A network blip is not that, and resting it would hide a working voice.
      if (/out of sentences|out of free requests|concurrency|needs the free model|refused the voice key|needs credit|empty take/.test(message)) cool(p);
    }
  }
  throw new Error(failures.join(" · ") || "no voice vendor answered");
}
