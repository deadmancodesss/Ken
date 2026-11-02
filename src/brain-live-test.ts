import "dotenv/config";

/**
 * The sibling of `npm run selftest`. That one scripts the model so the dispatch,
 * the result encoding and the carried history are checked without spending a call.
 * This one sends the real questions to the real model, because a scripted model
 * always picks the right tool and the live model is the thing that can pick the
 * wrong one, read a number off one tool and say a different number, or re-read the
 * chain for a fact it was handed two seconds ago.
 *
 * Costs a handful of free-tier model calls and a few seconds of Tatum.
 */
if (process.env.PAY_ENABLED) delete process.env.PAY_ENABLED;

const key = process.env.MODEL_API_KEY ?? process.env.GEMINI_API_KEY ?? process.env.OPENROUTER_API_KEY;
const base = process.env.MODEL_BASE_URL ?? "";
if (!key || key === "stub" || /127\.0\.0\.1|localhost|model\.test/.test(base)) {
  console.error("refusing to run: this test needs the real model key in .env, not the stub");
  process.exit(1);
}

const { runTurn, modelName } = await import("./brain.js");
const { runTool } = await import("./tools.js");
const { counterparties } = await import("./knowledge.js");
const { session } = await import("./session.js");

const checks: string[] = [];
function expect(label: string, ok: boolean, detail = "") {
  checks.push(`${ok ? "ok  " : "FAIL"} ${label}${detail ? `  [${detail}]` : ""}`);
  if (!ok) throw new Error(`${label} ${detail}`);
}

const CHAIN_TOOLS = new Set(["money_history", "who_is_this", "monthly_summary"]);

/** Every count the agent said out loud, whether it said "five" or "5". */
const WORDS: Record<string, number> = {
  one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9,
  ten: 10, eleven: 11, twelve: 12, fifteen: 15, twenty: 20,
};
function countsSaid(text: string): number[] {
  return [...text.matchAll(/\b(\d+|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|fifteen|twenty)\s+times\b/gi)]
    .map((m) => Number(m[1]) || WORDS[m[1].toLowerCase()] || -1);
}
function amountsSaid(text: string): number[] {
  return [...text.matchAll(/(\d+(?:\.\d+)?)\s*(?:usdc| dollars)/gi)].map((m) => Number(m[1]));
}
const round2 = (n: number) => Math.round(n * 100) / 100;

const truth = await counterparties(session().wallet, session().network);
const sana = truth.find((p) => p.name === "Sana");
if (!sana) {
  console.error("the demo wallet has no Sana, so there is nothing to check");
  process.exit(1);
}
console.log(`ground truth from Tatum: Sana has ${sana.flows} flows, last seen ${sana.lastSeen}, usual ${sana.usualAmount}`);
console.log(`brain: ${modelName()}\n`);

/* Part one, no model in the loop. The two tools that describe one wallet have to
   describe it the same way. This is the exact bug that made the agent say "four
   times" and then "five times" about Sana in two adjacent spoken answers. */
const history = (await runTool("money_history", {})) as any[];
const mine = history.find((r) => r.name === "Sana");
const who = (await runTool("who_is_this", { address: sana.address })) as any;
expect(
  "money_history and who_is_this agree on how many payments",
  mine?.flows === who.relationship.flows,
  `${mine?.flows} vs ${who.relationship.flows}`,
);
expect(
  "and agree on when the last one was",
  mine?.lastSeen === who.relationship.last_seen,
  `${mine?.lastSeen} vs ${who.relationship.last_seen}`,
);
expect(
  "and agree on the usual amount",
  mine?.usualAmount === who.relationship.usual_amount,
  `${mine?.usualAmount} vs ${who.relationship.usual_amount}`,
);
const memories: string[] = who.memories ?? [];
expect(
  "no memory about Sana is a second copy of the first",
  new Set(memories).size === memories.length,
  `${memories.length} rows, ${new Set(memories).size} unique`,
);

/* Part two, the real model, cold. It should reach the chain rather than guess. */
const t1 = await runTurn("who do I pay most often?");
console.log(`Q1 who do I pay most often?\n   ${t1.text}\n`);
expect(
  "q1 read the chain instead of guessing",
  t1.steps.some((s) => CHAIN_TOOLS.has(s.name) && s.ok),
  t1.steps.map((s) => s.name).join(",") || "no tool at all",
);
expect("q1 named Sana", /sana/i.test(t1.text));

/* Part three, the same conversation. A warm question is allowed to re-read the
   chain, that only costs a second of latency. What it must never do is spend USDC
   on a name it was already handed, because that is the promise the demo makes. */
const t2 = await runTurn("what do you remember about Sana?", t1.history);
console.log(`Q2 what do you remember about Sana?\n   ${t2.text}\n`);
const reread = t2.steps.filter((s) => CHAIN_TOOLS.has(s.name)).map((s) => s.name);
console.log(`   (q2 tool choices: ${reread.join(", ") || "answered from what it already had"})`);
expect(
  "q2 spent no money on a person it already knew",
  !t2.steps.some((s) => s.name === "paid_lookup"),
  t2.steps.map((s) => s.name).join(","),
);

/* Anything it said about her money has to be a number the chain actually holds. */
const usual = Number(sana.usualAmount) || 0;
const said = amountsSaid(t2.text);
expect(
  "every amount it said is the chain's amount, rounded",
  said.every((n) => round2(n) === round2(usual) || truth.some((p) => round2(Number(p.net)) === round2(n))),
  `said ${said.join(", ")}, chain says ${sana.usualAmount} usual / ${sana.net} total`,
);
const counts = [...countsSaid(t1.text), ...countsSaid(t2.text)];
const realCounts = new Set(truth.map((p) => p.flows));
expect(
  "every count it said exists on the chain",
  counts.every((n) => realCounts.has(n)),
  `said ${counts.join(", ") || "nothing countable"}, chain has ${[...realCounts].sort((a, b) => a - b).join(", ")}`,
);

console.log(checks.join("\n"));
console.log(`\n${t1.steps.length + t2.steps.length} live tool calls through the real model`);
