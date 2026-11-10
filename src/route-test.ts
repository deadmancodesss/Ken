/**
 * Proves the fallback order without spending a provider request. Two fake hosts stand in
 * for the lanes: Gemini refuses the first name, and the test asserts the very next call
 * went to NVIDIA Ultra rather than to Gemini's second name. The lanes are alternated by
 * depth, so a return to grouped ordering fails here rather than in front of a person.
 *
 * Nothing here reaches a network. The env is set before brain.ts is imported, because the
 * route table is built at import time and dotenv never overrides a value already present.
 */
process.env.MODEL_API_KEY = "test-gemini-key";
process.env.MODEL_BASE_URL = "https://gemini.test/openai";
process.env.MODEL_NAME = "gemini-lite,gemini-flash";
process.env.NVIDIA_API_KEY = "test-nvidia-key";
process.env.NVIDIA_BASE_URL = "https://nvidia.test/v1";
process.env.NVIDIA_MODEL = "ultra,bolt";
process.env.NVIDIA_THINKING = "0";

const real = globalThis.fetch;
const seen: { host: string; model: string }[] = [];
let calls = 0;

/** The refusal each fake host sends next. A 429 means busy, a 400 is Gemini's junk-key answer. */
let geminiStatus = 429;

globalThis.fetch = (async (url: any, init: any) => {
  const host = new URL(String(url)).host;
  const body = JSON.parse(String(init?.body ?? "{}"));
  const model = String(body.model ?? "");
  seen.push({ host, model });
  calls++;
  if (host === "gemini.test") {
    // Measured on the real endpoint: a junk key is a 400 with this sentence, not a 401.
    const error = geminiStatus === 400 ? { code: 400, message: "Please pass a valid API key", status: "INVALID_ARGUMENT" } : { message: "quota or key refused" };
    return Response.json({ error }, { status: geminiStatus });
  }
  if (host === "nvidia.test") {
    return Response.json({ model, choices: [{ message: { role: "assistant", content: `answered by ${model}` } }] });
  }
  return real(url as any, init as any);
}) as typeof fetch;

const { runTurn, modelName, fallbackNote } = await import("./brain.js");

const checks: string[] = [];
function expect(label: string, ok: boolean) {
  checks.push(`${ok ? "ok  " : "FAIL"} ${label}`);
  if (!ok) throw new Error(label);
}

/* A busy first name hands the turn to the other provider, not to the same key's second
 * name. This is the interleave in one assertion. */
seen.length = 0;
let turn = await runTurn("hello", []);
expect(
  "a 429 on Gemini lite is followed by NVIDIA Ultra",
  seen.length === 2 && seen[0].host === "gemini.test" && seen[0].model === "gemini-lite" && seen[1].host === "nvidia.test" && seen[1].model === "ultra",
);
expect("Gemini flash is not asked while Ultra can answer", !seen.some((s) => s.model === "gemini-flash"));
expect("the answer is the one Ultra wrote", turn.text === "answered by ultra");
expect("the badge names the model that actually spoke", modelName() === "ultra");
expect("the page can say the first name was rate limited", fallbackNote() === "Gemini was rate limited, so NVIDIA answered this turn.");

/* A refused key kills the whole provider for this attempt. Gemini flash shares that key,
 * so asking it would be a second wasted request on a refusal that cannot get better. */
geminiStatus = 400;
seen.length = 0;
turn = await runTurn("hello again", []);
expect("a 400 saying the key is invalid never reaches Gemini flash", seen.length === 2 && seen[1].model === "ultra");
expect("the second answer still came from Ultra", turn.text === "answered by ultra");
expect("a refused key is reported by name", fallbackNote() === "Gemini refused the key, so NVIDIA answered this turn.");

seen.length = 0;
await runTurn("third", []);
expect(
  "a refused Gemini route is left out of the next turn",
  seen.length === 1 && seen[0].host === "nvidia.test" && seen[0].model === "ultra",
);
expect("a turn with no refusal says nothing extra", fallbackNote() === "");

console.log(checks.join("\n"));
console.log(`\n${calls} scripted provider calls, no key and no request spent`);
globalThis.fetch = real;
