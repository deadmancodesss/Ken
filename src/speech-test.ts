import "dotenv/config";

/**
 * The scripted half proves what we send to each voice vendor. A real key, when .env
 * has one, is left in place so the live half can also prove what each vendor answers,
 * which is where the quota that is actually spent becomes visible instead of being
 * argued about from memory.
 *
 * Every vendor is mocked here. A scripted test that reaches the network spends a daily
 * allowance, and an allowance spent by a test is a live conversation that cannot answer.
 */
const GEMINI_KEY = (process.env.GEMINI_API_KEY ?? "").trim();
const FISH_KEY = (process.env.FISH_API_KEY ?? "").trim();
const OR_KEY = (process.env.OPENROUTER_API_KEY ?? "").trim();
process.env.GEMINI_API_KEY = GEMINI_KEY || "test-voice-key";
process.env.FISH_API_KEY = FISH_KEY || "test-fish-key";
// A scripted run needs a value even when .env has none, and no shape is judged by sight.
process.env.OPENROUTER_API_KEY = OR_KEY || "sk-or-v1-test-key";
delete process.env.FISH_VOICES;
// A rested vendor would hide the very failure these checks are trying to read.
process.env.VOICE_COOLDOWN_MS = "0";
process.env.MODEL_BASE_URL = "https://model.test/openai";

const real = globalThis.fetch;
const sent: any[] = [];
let reply: any = {};
let status = 200;
let fishStatus = 200;
let fishBody = new Uint8Array(0);
let orStatus = 200;
let orBody = new Uint8Array(0);
// The content type this vendor really answers with, measured 2026-11-03. It sends a bare
// stream at 44.1 kHz and refuses to wrap it, which is the whole reason the header exists.
let orType = "audio/pcm;rate=44100;channels=1";

globalThis.fetch = (async (url: any, init: any) => {
  const where = String(url);
  if (where.includes("generateContent")) {
    sent.push({ via: "gemini", url: where, body: JSON.parse(String(init.body)), key: (init as any).headers["x-goog-api-key"] });
    return Response.json(reply, { status });
  }
  if (where.includes("api.fish.audio")) {
    sent.push({ via: "fish", url: where, body: JSON.parse(String(init.body)), headers: (init as any).headers });
    return new Response(fishBody, { status: fishStatus, headers: { "content-type": "audio/wav" } });
  }
  if (where.includes("openrouter.ai")) {
    sent.push({ via: "openrouter", url: where, body: JSON.parse(String(init.body)), auth: (init as any).headers.authorization });
    return orBody.length
      ? new Response(orBody, { status: orStatus, headers: { "content-type": orType } })
      : Response.json(orStatus === 200 ? {} : { error: { message: "no credit on the account" } }, { status: orStatus });
  }
  return real(url as any, init as any);
}) as typeof fetch;

const { synthesize, ttsEnabled, ttsState, voices, defaultVoice } = await import("./speech.js");

const checks: string[] = [];
const expect = (label: string, ok: boolean) => {
  checks.push(`${ok ? "ok  " : "FAIL"} ${label}`);
  if (!ok) throw new Error(label);
};

/** A 44 byte header plus signed 16 bit mono PCM is the only shape a browser will decode. */
function readWav(bytes: Buffer) {
  return {
    riff: bytes.subarray(0, 4).toString(),
    wave: bytes.subarray(8, 12).toString(),
    fmt: bytes.subarray(12, 16).toString(),
    format: bytes.readUInt16LE(20),
    channels: bytes.readUInt16LE(22),
    rate: bytes.readUInt32LE(24),
    bits: bytes.readUInt16LE(34),
    data: bytes.subarray(36, 40).toString(),
    declared: bytes.readUInt32LE(40),
    payload: bytes.subarray(44),
  };
}

function wavOf(pcm: Buffer, rate: number) {
  const head = Buffer.alloc(44);
  head.write("RIFF", 0);
  head.writeUInt32LE(36 + pcm.length, 4);
  head.write("WAVE", 8);
  head.write("fmt ", 12);
  head.writeUInt32LE(16, 16);
  head.writeUInt16LE(1, 20);
  head.writeUInt16LE(1, 22);
  head.writeUInt32LE(rate, 24);
  head.writeUInt32LE(rate * 2, 28);
  head.writeUInt16LE(2, 32);
  head.writeUInt16LE(16, 34);
  head.write("data", 36);
  head.writeUInt32LE(pcm.length, 40);
  return Buffer.concat([head, pcm]);
}

// One second of 24 kHz mono PCM holding a 220 Hz tone, which is Gemini's own rate.
const pcm = Buffer.alloc(24000 * 2);
for (let i = 0; i < 24000; i++) pcm.writeInt16LE(Math.round(8000 * Math.sin((2 * Math.PI * 220 * i) / 24000)), i * 2);
const b64 = pcm.toString("base64");

/*
 * Asking for a Gemini voice puts Gemini first, so this group reads the Gemini path on
 * its own while the other two vendors refuse.
 */
fishStatus = 503;
orStatus = 503;
reply = { candidates: [{ content: { parts: [{ inlineData: { mimeType: "audio/L16;codec=pcm;rate=24000", data: b64 } }] } }] };
let out = await synthesize("Sana, one point three three USDC", "gemini:Kore");
let w = readWav(out.bytes);
expect("bare pcm is given a wav header", w.riff === "RIFF" && w.wave === "WAVE" && w.fmt === "fmt " && w.data === "data");
expect("header describes 24 khz mono 16 bit pcm", w.format === 1 && w.channels === 1 && w.rate === 24000 && w.bits === 16);
expect("declared length matches the bytes handed back", w.declared === w.payload.length && w.payload.length === pcm.length);
expect("the audio itself survived the trip", w.payload.equals(pcm));
expect("a gemini answer is reported as gemini", out.voice.provider === "gemini" && out.voice.id === "gemini:Kore");
expect(
  "key went in the header, not the url",
  sent[0].key === process.env.GEMINI_API_KEY && !sent[0].url.includes(process.env.GEMINI_API_KEY!),
);
expect("the voice that was asked for is the voice that is asked first", sent[0].via === "gemini");

const geminiCalls = sent.filter((s) => s.via === "gemini").length;
const cached = await synthesize("Sana, one point three three USDC", "gemini:Kore");
expect(
  "the same sentence twice costs one provider call",
  sent.filter((s) => s.via === "gemini").length === geminiCalls && cached.bytes.equals(out.bytes),
);
expect(
  "request asks for audio only",
  JSON.stringify(sent[0].body.generationConfig).includes("AUDIO") && JSON.stringify(sent[0].body.generationConfig).includes("Kore"),
);

/* The newer shape, which already carries a container. */
const container = wavOf(Buffer.alloc(100), 24000);
reply = { steps: [{ type: "model_output", content: [{ type: "audio", mime_type: "audio/wav", data: container.toString("base64") }] }] };
out = await synthesize("a different sentence", "gemini:Puck");
expect("an already wrapped answer is passed through", readWav(out.bytes).payload.length === 100);
expect("the picked voice reached the request", JSON.stringify(sent.at(-1)!.body).includes("Puck"));

/* A voice nobody offered must not be sent. */
reply = { candidates: [{ content: { parts: [{ inlineData: { mimeType: "audio/L16", data: b64 } }] } }] };
out = await synthesize("hello there", "gemini:Not A Real Voice");
expect("an unknown voice is never sent to a vendor", !JSON.stringify(sent.at(-1)!.body).includes("Not A Real Voice"));
expect("an unknown voice lands on a voice that exists", out.voice.id === `gemini:${process.env.TTS_VOICE ?? "Kore"}` || out.voice.provider !== "gemini");

/*
 * Fish is the vendor that answers by default, and its free tier is chosen by a request
 * header rather than by the key. Omitting that header routes to the paid model, which a
 * zero balance rejects with 402, so it is the single field most likely to be lost in a
 * refactor and the one worth an assertion.
 */
fishStatus = 200;
fishBody = wavOf(Buffer.alloc(88200 * 2, 7), 44100);
const beforeFish = sent.length;
out = await synthesize("the fish speaks this", "fish:default");
const fishCall = sent.filter((s) => s.via === "fish").at(-1);
expect("fish answers before any fallback is tried", out.voice.provider === "fish" && sent.length === beforeFish + 1);
expect("the free model header is sent", fishCall?.headers?.model === "s2.1-pro-free");
expect("a default voice sends no reference id, so no marketplace clone is implied", fishCall?.body?.reference_id === undefined);
expect("fish is asked for a container rather than bare pcm", fishCall?.body?.format === "wav");
expect("fish audio keeps its own 44.1 khz header", readWav(out.bytes).rate === 44100);

/*
 * OpenRouter's speech route is OpenAI shaped, so the model and the voice travel in the body
 * rather than in a header. The one thing this block exists to pin down is the format, because
 * the vendor answers 400 to wav, 400 to mp3, and 200 to pcm, and a request that asks for what
 * it refuses is a voice that never speaks. The rate arrived as 44.1 kHz and is read back out
 * of the content type rather than assumed, since everything else here runs at 24 kHz.
 */
orStatus = 200;
const orPcm = Buffer.alloc(44100 * 2, 3);
orBody = orPcm;
out = await synthesize("heygen speaks this instead", "openrouter:noelle");
const orCall = sent.filter((s) => s.via === "openrouter").at(-1);
expect("a heygen voice is answered by openrouter", out.voice.provider === "openrouter" && out.voice.id === "openrouter:noelle");
expect("the free heygen slug is what gets sent", orCall?.body?.model === "heygen/heygen-voice-1-turbo:free");
expect("the voice name travels in the body", orCall?.body?.voice === "noelle");
expect("pcm is asked for, because wav and mp3 are both refused", orCall?.body?.response_format === "pcm");
expect("the sentence is sent as input and never as text", orCall?.body?.input === "heygen speaks this instead" && orCall?.body?.text === undefined);
expect("the key is a bearer header and never in the url", orCall?.auth === `Bearer ${process.env.OPENROUTER_API_KEY}` && !orCall.url.includes(process.env.OPENROUTER_API_KEY!));
const orWav = readWav(out.bytes);
expect("the bare stream is wrapped in a header a browser can decode", orWav.riff === "RIFF" && orWav.rate === 44100 && orWav.channels === 1 && orWav.bits === 16);
expect("every sample byte survived the header", orWav.payload.equals(orPcm));

/* A vendor that did send a container must not have a second header written onto it. */
orBody = wavOf(orPcm, 44100);
orType = "audio/wav";
out = await synthesize("heygen answers with a container this time", "openrouter:noelle");
expect("a container is handed back untouched", readWav(out.bytes).payload.equals(orPcm));
orType = "audio/pcm;rate=44100;channels=1";

/* The ladder: fish spent, so the middle vendor speaks and the page is told who did. */
fishStatus = 429;
out = await synthesize("fish is out so the next voice covers this", "fish:default");
expect("a throttled first vendor falls through to the second", out.voice.provider === "openrouter");
expect("the page is told the audio did not come from the vendor it asked for", out.voice.id.startsWith("openrouter:"));

/* Two vendors down is still one sentence spoken rather than an error thrown. */
fishStatus = 429;
orStatus = 402;
status = 200;
reply = { candidates: [{ content: { parts: [{ inlineData: { mimeType: "audio/L16;codec=pcm;rate=24000", data: b64 } }] } }] };
out = await synthesize("fish and openrouter are both out so gemini covers this", "fish:default");
expect("the third vendor speaks when the first two refuse", out.voice.provider === "gemini");
expect("the last vendor reports its own voice, not the one that was asked for", out.voice.id.startsWith("gemini:"));

/*
 * The same sentence is often said twice, and the second one must be free. What it must not
 * be is a lie: the answer is filed under the voice that was asked for, so a cache that
 * stores only bytes hands back "fish" on the repeat for audio that gemini made. The producer
 * travels with the audio instead.
 */
const beforeRepeat = sent.length;
const again = await synthesize("fish and openrouter are both out so gemini covers this", "fish:default");
expect("a repeat still names the vendor that really made the audio", again.voice.provider === "gemini");
expect("a repeat costs no second call at anyone", sent.length === beforeRepeat && again.ms === 0);

/* Failures have to come back as words the page can show, so nothing may answer here. */
fishStatus = 503;
orStatus = 503;
status = 400;
reply = { error: { message: "Model not found." } };
let message = "";
await synthesize("a sentence nobody asked for twice", "gemini:Kore").catch((e) => (message = e.message));
expect("a failed call names its status and drops the provider blob", message.includes("400") && !message.includes("Model not found"));

status = 429;
reply = { error: { message: "You exceeded your current quota. Please retry in 23h13m9.6s." } };
await synthesize("another sentence", "gemini:Kore").catch((e) => (message = e.message));
expect("a throttled voice says how long until it can speak", message.includes("out of sentences") && message.includes("23 h"));

status = 429;
reply = { error: { message: "You exceeded your current quota. Please retry in 18.9s." } };
await synthesize("third sentence", "gemini:Kore").catch((e) => (message = e.message));
expect("a short throttle is not reported as a day", message.includes("19 s") && !message.includes("23 h"));

status = 200;
reply = { candidates: [{ content: { parts: [] } }] };
await synthesize("fourth sentence", "gemini:Kore").catch((e) => (message = e.message));
expect("an answer with no audio is named as such", message.includes("no audio"));

expect("state reports all three vendors to the pages", ttsState().providers.map((p) => p.id).join(",") === "fish,openrouter,gemini" && ttsEnabled());
expect("the gemini voice list is the prebuilt set", voices().filter((v) => v.provider === "gemini").length === 24);
expect("the ten heygen voices are offered", voices().filter((v) => v.provider === "openrouter").length === 10);
expect("a fish key makes fish the default rather than a possibility", defaultVoice().startsWith("fish:"));

/*
 * Two ways this route can be absent, and only one of them is fixable by the person reading
 * the page. An empty value is the first, and the answer is a link to make a key. The second
 * is a credential of a shape this file used to distrust, and that distrust cost a working
 * vendor: a value beginning `apikey_` was called a browser session token, sent to a server
 * that never accepts such keys, and written off. It was a real key for a different company.
 * No prefix is judged here, so the checks below pin that down in both directions. Each needs
 * a second copy of the module because the choice is made once, when the file is first read.
 */
process.env.OPENROUTER_API_KEY = "";
const unkeyed = await import(`./speech.js?no-key=${Date.now()}`);
const quiet = unkeyed.ttsState().providers.find((p: any) => p.id === "openrouter");
expect("a route with no key at all is not offered", quiet?.ready === false);
expect("the reason says where to get one", /openrouter\.ai\/settings\/keys/.test(quiet?.why ?? ""));
expect("a route with no key offers no voices", unkeyed.voices().every((v: any) => v.provider !== "openrouter"));

process.env.OPENROUTER_API_KEY = `apikey_${"0".repeat(35)}_${"a".repeat(64)}`;
const trusting = await import(`./speech.js?any-shape=${Date.now()}`);
const believed = trusting.ttsState().providers.find((p: any) => p.id === "openrouter");
expect("a key is believed whatever prefix it starts with", believed?.ready === true);
expect("and believing it costs nothing until a sentence asks", trusting.voices().filter((v: any) => v.provider === "openrouter").length === 10);
process.env.OPENROUTER_API_KEY = OR_KEY || "sk-or-v1-test-key";

/*
 * A vendor can hold a working key and still be out of sentences, which is the one state
 * a voice picker must not render as available, because it turns a chosen voice into
 * silence with no explanation. A third copy of the module is needed for the same reason
 * as the last one: the retry window is read once when the file loads, and the scripted
 * checks above run with it turned off so that each failure stays visible.
 */
process.env.VOICE_COOLDOWN_MS = "60000";
const watched = await import(`./speech.js?retry-window=${Date.now()}`);
process.env.VOICE_COOLDOWN_MS = "0";
fishStatus = 429;
status = 200;
reply = { candidates: [{ content: { parts: [{ inlineData: { mimeType: "audio/L16;codec=pcm;rate=24000", data: b64 } }] } }] };
const said = await watched.synthesize("a sentence asked while fish is throttled", "fish:default");
const shown = watched.ttsState().providers;
expect("a vendor that refused is reported as resting", /concurrency limit/.test(shown.find((p: any) => p.id === "fish")?.resting ?? ""));
expect("a vendor that answered is not", shown.filter((p: any) => p.resting).length === 1);
expect("the vendor that refused is not named as the one in charge", watched.ttsState().model === said.voice.provider);
const asked = sent.filter((s) => s.via === "fish").length;
await watched.synthesize("a second sentence asked of fish again", "fish:default");
expect("a resting vendor is not paid for twice inside its own window", sent.filter((s) => s.via === "fish").length === asked);

console.log(checks.join("\n"));
globalThis.fetch = real;

/*
 * One real sentence per vendor, when real keys exist. A provider that is out of quota
 * is reported rather than treated as a code failure, because the point of this half is
 * to see the wall, not to be surprised by it. Set VOICE_LIVE=0 to skip it.
 */
const live: [string, string][] = [["fish", "fish:default"]];
if (OR_KEY) live.push(["openrouter", "openrouter:noelle"]);
live.push(["gemini", "gemini:Kore"]);

if ((GEMINI_KEY || FISH_KEY) && process.env.VOICE_LIVE !== "0") {
  console.log(`\nlive voice, one sentence asked of each vendor:`);
  for (const [label, id] of live) {
    if (label === "fish" && !FISH_KEY) continue;
    if (label === "gemini" && !GEMINI_KEY) continue;
    const t0 = Date.now();
    try {
      const said = await synthesize("Sana buys groceries every couple of days, mostly at the shop near the depot.", id);
      const ms = Date.now() - t0;
      const ok = said.bytes.length > 44 && said.bytes.subarray(0, 4).toString() === "RIFF";
      const rate = ok ? readWav(said.bytes).rate : 0;
      // Asked for one vendor and answered by another is the normal shape of a spent
      // free tier, so both names get printed rather than only the one requested.
      const fell = said.voice.provider !== label ? ` (asked of ${label}, which did not answer)` : "";
      console.log(`  ${ok ? "ok  " : "FAIL"} asked ${label}, answered ${said.voice.provider} as ${said.voice.id} in ${ms} ms, ${Math.round(said.bytes.length / 1024)} KB at ${rate} hz${fell}`);
      if (!ok) process.exitCode = 1;
    } catch (e) {
      console.log(`  --   ${label} unavailable after ${Date.now() - t0} ms: ${(e as Error).message}`);
    }
  }
} else {
  const why = process.env.VOICE_LIVE === "0" ? "VOICE_LIVE=0 was set" : "no voice key is set";
  console.log(`\n${sent.length} scripted voice calls, and no live run because ${why}.`);
}
