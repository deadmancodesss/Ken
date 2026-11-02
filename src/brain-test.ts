import "dotenv/config";

/**
 * Proves the tool loop without spending a model call. The "model" is scripted, so
 * everything between its requests, the dispatch, the result encoding and what gets
 * carried into the next turn, is genuinely exercised against the real tools.
 * This says nothing about whether a real model picks the right tool. That is
 * `npm run selftest:live`.
 */
// An empty MODEL_API_KEY in .env is still a value to `??=`, so test for falsy.
process.env.MODEL_API_KEY = "stub-key";
// Pinned so the fake always matches, whatever the demo profile has in .env.
process.env.MODEL_BASE_URL = "https://model.test/openai";

const real = globalThis.fetch;
const BASE = process.env.MODEL_BASE_URL.replace(/\/$/, "");

let script: any[] = [];
let asked: any[] = [];

globalThis.fetch = (async (url: any, init: any) => {
  if (!String(url).startsWith(BASE)) return real(url as any, init as any);
  const body = JSON.parse(String(init.body));
  asked.push(body);
  const next = script.shift();
  if (!next) throw new Error(`script ran out at request ${asked.length}`);
  return Response.json({ choices: [{ message: next }] });
}) as typeof fetch;

const { runTurn } = await import("./brain.js");

const checks: string[] = [];
function expect(label: string, ok: boolean) {
  checks.push(`${ok ? "ok  " : "FAIL"} ${label}`);
  if (!ok) throw new Error(label);
}

/* One tool call, then an answer. The point is what the next turn gets handed. */
script = [
  { content: "", tool_calls: [{ id: "c1", function: { name: "find_person", arguments: '{"name":"Sana"}' } }] },
  { content: "Sana is at the address I found" },
];
asked = [];
let turn = await runTurn("where does Sana live");
expect("single tool call ran", turn.steps.length === 1 && turn.steps[0].ok);
expect("tool result reached the model", asked[1].messages.some((m: any) => m.role === "tool"));
expect(
  "tool result is carried into the next turn",
  turn.history.some((m: any) => m.role === "tool") && turn.history.some((m: any) => m.role === "assistant" && m.tool_calls),
);
expect("no system prompt leaked into carried history", !turn.history.some((m: any) => m.role === "system"));

/* Speech and a tool request in the same message, and two calls in one round. */
script = [
  {
    content: "Let me check that",
    tool_calls: [
      { id: "a", function: { name: "memory_stats", arguments: "{}" } },
      { id: "b", function: { name: "money_history", arguments: '{"limit":1}' } },
    ],
  },
  { content: "Both read fine" },
];
asked = [];
turn = await runTurn("what is happening", turn.history);
expect("both calls in one round ran", turn.steps.length === 2 && turn.steps.every((s) => s.ok));
// Counted by call id because the history handed in already carries an older tool reply.
expect(
  "each call got its own tool reply",
  asked[1].messages.filter((m: any) => m.role === "tool" && (m.tool_call_id === "a" || m.tool_call_id === "b")).length === 2,
);
expect(
  "assistant words are kept next to its tool calls",
  asked[1].messages.some((m: any) => m.role === "assistant" && m.content === "Let me check that"),
);
expect("second turn answered", turn.text === "Both read fine");

/* A model that will not stop asking: the closing round must answer, not throw. */
const refuse = { content: "", tool_calls: [{ id: "x", function: { name: "memory_stats", arguments: "{}" } }] };
script = [refuse, refuse, refuse, refuse, refuse, { content: "Fine, here is the plain answer" }];
asked = [];
turn = await runTurn("keep going", [], 6);
expect("never threw after exhausting rounds", turn.text === "Fine, here is the plain answer");
expect("final request had no tools on offer", !("tools" in asked[asked.length - 1]));
expect("earlier requests did have tools", asked.slice(0, -1).every((b: any) => "tools" in b));

/* The calendar is the one fact a voice agent cannot recover from the chain, so it has
 * to be handed over. A payment made today read out as yesterday is a wrong statement
 * about the person's own money. */
const said = String(asked[0].messages.find((m: any) => m.role === "system")?.content ?? "");
expect("the model is told what today is", said.includes(new Date().toISOString().slice(0, 10)));
expect("the model is told never to guess a date", /never guess a date/i.test(said));
expect("the instructions obey the two writing rules they teach", !/[—–;]/.test(said));

console.log(checks.join("\n"));
console.log(`\n${asked.length} scripted model calls, every tool above ran for real`);
globalThis.fetch = real;
