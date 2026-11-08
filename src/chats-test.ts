/**
 * A conversation that disappears on reload is not a conversation a person can keep.
 * The store is tested offline against a real SQLite file, because the point of it is
 * surviving a process, and an in-memory stub would prove the opposite of the claim.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { liveDelta, openChats } from "./chats.js";

const checks: string[] = [];
function expect(label: string, ok: boolean) {
  checks.push(`${ok ? "ok  " : "FAIL"} ${label}`);
  if (!ok) throw new Error(label);
}

const store = openChats(":memory:");
const turn = (n: number) => ({
  asked: `question ${n}`,
  said: `answer ${n}`,
  steps: [{ name: "money_history", ok: true, result: { flows: n } }],
  delta: [
    { role: "user", content: `question ${n}` },
    { role: "assistant", content: "", tool_calls: [{ id: `c${n}`, function: { name: "money_history", arguments: "{}" } }] },
    { role: "tool", tool_call_id: `c${n}`, content: JSON.stringify({ flows: n }) },
    { role: "assistant", content: `answer ${n}` },
  ],
  at: 1_700_000_000_000 + n,
});

store.append("wallet:a:testnet", turn(1));
store.append("wallet:a:testnet", turn(2));
store.append("wallet:b:testnet", turn(3));

const mine = store.turns("wallet:a:testnet");
expect("a chat reads its own turns oldest first", mine.length === 2 && mine[0].asked === "question 1" && mine[1].asked === "question 2");
expect("a second wallet's turns never appear in the first one", store.turns("wallet:b:testnet").length === 1);
expect("the answer came back with its turn", mine[0].said === "answer 1");
expect("the trace came back with its tool name", mine[0].steps[0].name === "money_history" && mine[0].steps[0].ok);

const history = store.history("wallet:a:testnet");
expect("the model history is the concatenated deltas", history.length === 8);
expect(
  "the first message of the first turn is the question",
  (history[0] as { role?: string }).role === "user" && (history[0] as { content?: string }).content === "question 1",
);
expect(
  "the tool result that stops a double payment survives the round trip",
  (history[2] as { role?: string }).role === "tool" && String((history[2] as { content?: string }).content).includes('"flows":1'),
);

const capped = store.history("wallet:a:testnet", 1);
expect("a cap keeps the newest turn, not the oldest", capped.length === 4);
expect("the capped history starts at the newer question", (capped[0] as { content?: string }).content === "question 2");
expect("a negative cap still keeps one turn", store.history("wallet:a:testnet", -5).length === 4);

expect("count reports what the screen will show", store.count("wallet:a:testnet") === 2);
expect("an unknown chat is empty rather than an error", store.turns("nobody").length === 0 && store.history("nobody").length === 0);

/*
 * A spoken turn used to store only the two voices, so the next typed question could
 * not see the payment that failed mid call. The live delta is the same assistant and
 * tool exchange the typed path has kept all along.
 */
const spokenSteps = [
  { name: "pay_usdc", args: {}, ok: true, result: { needs_recipient: true } },
  { name: "find_person", args: { name: "Albert" }, ok: false, error: "the lookup timed out" },
];
const spoken = liveDelta("I can give you the address", "Paste it into the field", spokenSteps, 1_700_000_000_500) as Record<string, any>[];
expect("a live turn keeps the question, both tool replies and the answer", spoken.map((m) => m.role).join(",") === "user,assistant,tool,tool,assistant");
expect("the two calls live in one assistant message", spoken[1].tool_calls.length === 2);
expect("the call ids are unique inside the turn", spoken[1].tool_calls[0].id !== spoken[1].tool_calls[1].id);
expect("the call keeps the tool name and the arguments", spoken[1].tool_calls[1].function.name === "find_person" && spoken[1].tool_calls[1].function.arguments === '{"name":"Albert"}');
expect("each reply points at its own call", spoken[2].tool_call_id === spoken[1].tool_calls[0].id && spoken[3].tool_call_id === spoken[1].tool_calls[1].id);
expect("a successful result survives", String(spoken[2].content).includes('"needs_recipient":true'));
expect("a failed tool keeps its reason", String(spoken[3].content).includes("the lookup timed out"));
expect("the answer is the last thing in the history", spoken[4].content === "Paste it into the field");

const missing = liveDelta("look", "no result", [{ name: "read_the_stars", ok: true }], 1_700_000_000_600) as Record<string, any>[];
expect("a tool that returned nothing still writes a JSON reply", missing[2].content === "null");
expect("a live turn with no tools is still the two voices", (liveDelta("hi", "hello", [], 1) as unknown[]).length === 2);

store.append("wallet:live:testnet", { asked: "spoken", said: "answer", steps: spokenSteps, delta: spoken, at: 1 });
const replayed = store.history("wallet:live:testnet") as Record<string, any>[];
expect("a saved live turn replays its tool replies", replayed.length === 5 && replayed[3].role === "tool" && String(replayed[3].content).includes("timed out"));

expect("clearing one chat leaves the other", store.clear("wallet:a:testnet") === 2 && store.turns("wallet:b:testnet").length === 1);
store.close();

const dir = mkdtempSync(join(tmpdir(), "tr-chats-"));
const file = join(dir, "chats.db");
const first = openChats(file);
first.append("wallet:c:testnet", turn(9));
first.close();
const second = openChats(file);
const after = second.turns("wallet:c:testnet");
expect("a chat survives closing and reopening the store", after.length === 1 && after[0].asked === "question 9");
second.close();
rmSync(dir, { recursive: true, force: true });

console.log(checks.join("\n"));
console.log(`\nthe chat store keeps every turn, saves it to disk, and every check above is offline`);
