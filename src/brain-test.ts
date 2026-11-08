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
/*
 * Switched off for the same reason the line above exists. Gemini leads the chain and the
 * pinned stub key and stub host above already turn its requests into mock traffic. NVIDIA
 * reads its own key, which the mock does not intercept, so it is blanked rather than left
 * to spend a real allowance on a test that is meant to prove the tool loop without asking
 * anyone anything.
 */
process.env.NVIDIA_API_KEY = "";

const real = globalThis.fetch;
const BASE = process.env.MODEL_BASE_URL.replace(/\/$/, "");
const GATEWAYS = [
  process.env.TATUM_SUI_GRAPHQL_URL,
  process.env.TATUM_SUI_GRAPHQL_URL_TESTNET,
].filter(Boolean) as string[];

/*
 * A scripted model still drives the real tools, and the real tools read Tatum. Left
 * alone, this suite spends a provider request on every run and turns red when the quota
 * answers 429, which is a rate limit dressed up as a broken tool loop. A gateway read
 * is answered here with an empty wallet, in whichever aliases the query asked for, so
 * the dispatch, the result encoding and the carried history are all still the real code.
 */
const EMPTY_WALLET = {
  balances: { nodes: [] },
  transactions: { pageInfo: { hasPreviousPage: false, startCursor: null }, nodes: [] },
};
function emptyChain(query: string): Response {
  const data: Record<string, unknown> = {};
  for (const m of String(query).matchAll(/(?:(\w+):)?\s*address\(/g)) data[m[1] ?? "address"] = EMPTY_WALLET;
  return Response.json({ data });
}

let script: any[] = [];
let asked: any[] = [];

globalThis.fetch = (async (url: any, init: any) => {
  const target = String(url);
  if (!target.startsWith(BASE)) {
    if (GATEWAYS.some((g) => target.startsWith(g))) return emptyChain(JSON.parse(String(init?.body ?? "{}")).query ?? "");
    return real(url as any, init as any);
  }
  const body = JSON.parse(String(init.body));
  asked.push(body);
  const next = script.shift();
  if (!next) throw new Error(`script ran out at request ${asked.length}`);
  return Response.json({ choices: [{ message: next }] });
}) as typeof fetch;

const { runTurn, groundAnswer } = await import("./brain.js");
const { localDay } = await import("./seat.js");

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

/* A model that decorates its sentence is repaired on the way out. The prompt asks for
 * plain words, and the answer is checked because a rule that is only requested is not
 * a rule. */
script = [{ content: "**Sana** was paid today — 0.52 USDC; she buys groceries." }];
asked = [];
turn = await runTurn("when did I last pay Sana", []);
expect("bold markers are stripped from the answer", !turn.text.includes("*") && turn.text.includes("Sana"));
expect("no em dash and no semicolon reach the screen", !/[—;]/.test(turn.text));

/* The grounding check is deterministic, so it is proved without a model. */
const sanaRow = {
  name: "money_history",
  args: {},
  ok: true,
  result: [{ name: "Sana", flows: 5, usualAmount: "0.52", asset: "USDC", direction: "sent" }],
};
const dropped = groundAnswer("You pay Sana 5 times.", "how often do I pay Sana, and what does she usually get?", [sanaRow]);
expect("a dropped usual amount is added from the tool result", dropped.includes("0.52"));
const worded = groundAnswer("You pay Sana five times and she usually gets 0.52 USDC.", "how often do I pay Sana, and what does she usually get?", [sanaRow]);
expect("a count said as a word is not repeated", !/Sana has 5 payments/.test(worded));
const cadence = groundAnswer("You pay Sana every day, usually 0.52 USDC.", "how often do I pay Sana, and what does she usually get?", [sanaRow]);
expect("a stated cadence answers how often without repeating the count", !/Sana has 5 payments/.test(cadence));
const flipped = groundAnswer("Sana owes you 0.52 USDC.", "how often do I pay Sana", [sanaRow]);
expect("a flipped direction is repaired", /you pay sana/i.test(flipped) && !/sana owes/i.test(flipped));
const invented = groundAnswer("You pay Sana 0.93 USDC.", "how often do I pay Sana", [sanaRow]);
expect("a figure no tool returned is not spoken", !invented.includes("0.93"));
const remembered = groundAnswer("Your rent is 1200 USDC.", "remember my rent is 1200 USDC", [
  { name: "remember_this", args: {}, ok: true, result: { stored: "abc123" } },
]);
expect("a remembered figure is not stripped by a tool that holds no figures", remembered.includes("1200"));
const thousands = groundAnswer("Ravi pays often.", "how often and how much does Ravi pay", [
  { name: "money_history", args: {}, ok: true, result: { name: "Ravi", flows: 3, usual_amount: "1,234.56 USDC" } },
]);
expect("a thousands comma is not read as a decimal point", thousands.includes("1234.56 USDC"));
const decimalComma = groundAnswer("Ravi pays often.", "how often and how much does Ravi pay", [
  { name: "money_history", args: {}, ok: true, result: { name: "Ravi", flows: 3, usual_amount: "1,50 USDC" } },
]);
expect("a decimal comma is still read as a decimal point", decimalComma.includes("1.5 USDC"));

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
expect("the model is told what today is", said.includes(localDay()));
expect("the model is told never to guess a date", /never guess a date/i.test(said));
expect("the instructions obey the two writing rules they teach", !/[—–;]/.test(said));

console.log(checks.join("\n"));
console.log(`\n${asked.length} scripted model calls, every tool above ran for real`);
globalThis.fetch = real;
