/**
 * A wallet can keep more than one conversation, and the sidebar is only trustworthy if
 * the store can name, list, rename and delete threads without one owner reading another.
 * This runs against a real SQLite file, because the migration it checks is a write.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { autoTitle, openChats } from "./chats.js";

const checks: string[] = [];
function expect(label: string, ok: boolean) {
  checks.push(`${ok ? "ok  " : "FAIL"} ${label}`);
  if (!ok) throw new Error(label);
}

const turn = (n: number) => ({
  asked: `question ${n}`,
  said: `answer ${n}`,
  steps: [],
  delta: [{ role: "user", content: `question ${n}` }],
  at: 1_700_000_000_000 + n,
});

const store = openChats(":memory:");
const owner = "wallet:a:testnet";

const first = store.ensure(owner);
expect("a new owner gets one thread", first.id === "main" && first.title === "New chat" && first.turns === 0);
expect("asking again returns the same thread", store.ensure(owner).id === first.id);
expect("one thread is listed", store.sessions(owner).length === 1);

const made = store.create(owner);
expect("a new thread gets its own id", made.id !== first.id && made.title === "New chat");
store.append(store.key(owner, made.id), turn(1));
store.touch(owner, made.id, turn(1).asked);
const titled = store.sessions(owner).find((s) => s.id === made.id);
expect("the first question names the thread", titled?.title === "question 1");
expect("the thread reports its own turn count", titled?.turns === 1);
expect("the empty thread stays empty", store.count(store.key(owner, first.id)) === 0);
expect("the newest thread is first", store.sessions(owner)[0].id === made.id);

store.append(store.key(owner, first.id), turn(2));
store.append(store.key(owner, first.id), turn(3));
store.touch(owner, first.id, turn(2).asked);
expect("a second thread keeps its own turns", store.turns(store.key(owner, first.id)).length === 2);
expect("the first thread's model history is its own", store.history(store.key(owner, first.id)).length === 2);

const renamed = store.rename(owner, made.id, "  money   questions  ");
expect("rename collapses the spaces", renamed?.title === "money questions");
expect("a blank name is refused", store.rename(owner, made.id, "   ") === null);
expect("another owner cannot rename this thread", store.rename("wallet:b:testnet", made.id, "not yours") === null);

expect("another owner sees none of these threads", store.sessions("wallet:b:testnet").length === 0);
expect("a foreign thread id resolves to the other owner's own", store.ensure("wallet:b:testnet", made.id).id !== made.id);

const removed = store.remove(owner, made.id);
expect("deleting a thread takes its turns with it", removed === 1 && store.turns(store.key(owner, made.id)).length === 0);
expect("the other thread survives", store.sessions(owner).length === 1);

const legacy = openChats(":memory:");
legacy.append("wallet:c:testnet", turn(5));
legacy.append("wallet:c:testnet", turn(6));
const migrated = legacy.ensure("wallet:c:testnet");
expect("legacy turns move into the first thread", migrated.id === "main" && legacy.turns("wallet:c:testnet::main").length === 2);
expect("legacy turns stop living under the bare owner", legacy.turns("wallet:c:testnet").length === 0);
expect("the migrated thread is named from its first question", migrated.title === "question 5");
legacy.close();

expect("a title is cut at a word, not mid word", autoTitle("a".repeat(80)).endsWith("…") && autoTitle("short question") === "short question");
store.close();

const dir = mkdtempSync(join(tmpdir(), "tr-sessions-"));
const file = join(dir, "chats.db");
const a = openChats(file);
a.create("wallet:d:testnet", "kept across a restart");
a.close();
const b = openChats(file);
expect("threads survive closing the file", b.sessions("wallet:d:testnet").some((s) => s.title === "kept across a restart"));
b.close();
rmSync(dir, { recursive: true, force: true });

console.log(checks.join("\n"));
console.log(`\nthe session store names, renames, deletes and migrates threads without mixing owners`);
