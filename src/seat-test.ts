/**
 * The build used to hold one session, one unsigned payment and one transcript for the
 * whole process, so a second browser connecting a wallet changed the first browser's
 * wallet and cleared its screen. These checks hold two seats open at once and prove
 * neither can see or release the other's.
 */
import { seatFor, seatsOpen, sweepSeats, within } from "./seat.js";
import { capOwner, chainMismatch, session, useNoWallet, useWallet } from "./session.js";
import { savedSession, saveSession } from "./seat-store.js";
import { PENDING_TTL_MS, forgotten, held, hold, release, settle } from "./pending.js";
import { chatKey } from "./chats.js";
import { scope } from "./scope.js";

process.env.SEATS_DB = ":memory:";

const checks: string[] = [];
function expect(label: string, ok: boolean) {
  checks.push(`${ok ? "ok  " : "FAIL"} ${label}`);
  if (!ok) throw new Error(label);
}

const A = `0x${"a".repeat(64)}`;
const B = `0x${"b".repeat(64)}`;
const CHAIN = "testnet";

const ticket = (sender: string, amount: number) => ({
  sender,
  to: B,
  name: null,
  amount,
  asset: "USDC" as const,
  bytes: "unsigned",
  chain: CHAIN,
});

expect("a process with no seat still reads as no wallet", session().source === "none");

const one = seatFor("seat-one");
const two = seatFor("seat-two");

within(one, () => {
  useWallet(A, CHAIN);
  hold(ticket(A, 0.5));
});
within(two, () => {
  expect("a second seat still has no wallet after the first connects", session().source === "none");
  expect("a second seat cannot see the first seat's unsigned payment", held() === null);
  useWallet(B, CHAIN);
});

within(one, () => {
  expect("the first seat still speaks for its own wallet", session().wallet === A);
  expect("the first seat still holds its own ticket", held()?.sender === A);
});

// The name the agent keeps is filed under the wallet it heard, not under the browser.
// This is why a name saved while a wallet was connected goes quiet after disconnecting.
const peopleA = within(one, () => scope("people"));
const peopleB = within(two, () => scope("people"));
expect("two wallets read two different people namespaces", peopleA !== peopleB);
expect("the people namespace is derived from the wallet", peopleA.includes(A.slice(2, 14)) && !peopleA.includes("seat-one"));
within(two, () => {
  expect("the second seat speaks for its own wallet", session().wallet === B);
  expect("the second seat's slot is still empty", held() === null);
  hold(ticket(B, 0.1));
});

within(one, () => release());
within(two, () => {
  expect("releasing one seat does not drop the other seat's ticket", held()?.amount === 0.1);
  release();
});

// A ticket that nobody signed is still held so a late signature can settle, but the
// page must stop reopening the form for it, and a settled ticket is never forgotten.
within(one, () => {
  const made = hold(ticket(A, 0.5));
  expect("a fresh ticket is not forgotten", forgotten(made) === false);
  expect(
    "a ticket older than the half hour is forgotten",
    forgotten({ ...made, createdAt: made.createdAt - PENDING_TTL_MS - 1 }) === true &&
      forgotten({ ...made, createdAt: made.createdAt - PENDING_TTL_MS + 1_000 }) === false,
  );
  expect("a settled ticket is never forgotten", forgotten({ ...made, digest: "0x" + "d".repeat(64), createdAt: 0 }) === false);
  const settled = settle("0x" + "d".repeat(64));
  expect("settling keeps the ticket and records the digest", settled?.amount === 0.5 && held()?.digest === "0x" + "d".repeat(64));
  expect("settling with nothing held changes nothing", within(one, () => (release(), settle("0x" + "e".repeat(64)))) === null);
  release();
});

// The ticket remembers the thread it was spoken in, because the signature can arrive
// after the seat has moved to another conversation.
within(one, () => {
  one.chat = `wallet:${A}:testnet::thread-nine`;
  const inThread = hold(ticket(A, 0.2));
  expect("a ticket spoken in a thread is filed under that thread", inThread.chat.endsWith("::thread-nine"));
  one.chat = null;
  const loose = hold(ticket(A, 0.2));
  expect("a ticket with no thread falls back to the wallet's chat key", loose.chat === chatKey() && loose.chat.startsWith("wallet:"));
  release();
});

within(one, () => useNoWallet());
const peopleNone = within(one, () => scope("people"));
expect("letting go of a wallet changes which names that page can read", peopleNone !== peopleA);
within(two, () => expect("letting go in one seat leaves the other seat's wallet alone", session().wallet === B));

const noWalletOne = within(one, () => chatKey());
const noWalletTwo = within(two, () => (useNoWallet(), chatKey()));
within(two, () => useWallet(B, CHAIN));
const walletTwo = within(two, () => chatKey());
const three = seatFor("seat-three");
const walletThree = within(three, () => {
  useWallet(B, CHAIN);
  return chatKey();
});

expect("two visitors without a wallet never share one chat transcript", noWalletOne !== noWalletTwo && noWalletOne.includes("seat-one"));
expect("unconnected chats are stored under the seat", noWalletOne.startsWith("seat:"));
expect("the same wallet on two seats reads the same chat", walletTwo === walletThree && walletTwo.startsWith("wallet:"));
expect("a wallet chat is not keyed to a browser seat", !walletTwo.includes("seat-"));

expect("three seats are open", seatsOpen() === 3);

const restored = seatFor("seat-restored", () => ({ wallet: A, network: "testnet", source: "wallet", reported: "testnet" }));
expect("a new seat starts from the wallet it saved before a restart", within(restored, () => session().wallet === A));

// A wallet that reported one ledger while the page reads the other would be shown
// bytes for a chain it is not on, so the mismatch is named before anything is built.
// useNetwork always keeps the two in step, which leaves a restored or inconsistent
// seat as the way this state can exist at all.
const matched = seatFor("seat-matched", () => ({ wallet: A, network: "mainnet", source: "wallet", reported: "mainnet" }));
expect("a wallet and its page on one ledger are not a mismatch", within(matched, () => chainMismatch() === null));
const skewed = seatFor("seat-skewed", () => ({ wallet: A, network: "testnet", source: "wallet", reported: "mainnet" }));
within(skewed, () => {
  const said = chainMismatch() ?? "";
  expect("a mainnet wallet behind a testnet page is refused", said.includes("mainnet") && said.includes("testnet"));
  expect("the refusal says to line the two up", /same network/.test(said));
});
expect("the restored seat keeps its matching ledger untroubled", within(restored, () => chainMismatch() === null));
within(three, () => {
  useWallet(B, "sui:devnet");
  expect("a reported ledger this build does not know is not called a mismatch", chainMismatch() === null);
  useNoWallet();
  expect("a seat with no wallet is never a mismatch", chainMismatch() === null);
});

// The budget is written by a person, so it belongs to the wallet when one is
// connected and to the browser seat otherwise, spelled in one case.
const mixed = seatFor("seat-mixed");
within(mixed, () => {
  useWallet("0x" + "A".repeat(64), CHAIN);
  expect("the budget belongs to the lowercased wallet, not the browser", capOwner() === `wallet:${A}`);
});
const bare = seatFor("seat-bare");
expect("without a wallet the budget belongs to the browser seat", within(bare, () => capOwner()) === "seat:seat-bare");
saveSession("seat-saved", { wallet: B, network: "testnet", source: "wallet", reported: "testnet" });
expect("a saved seat reads back with its wallet", savedSession("seat-saved")?.wallet === B);
saveSession("seat-saved", null);
expect("clearing a saved seat forgets the wallet", savedSession("seat-saved") === null);

expect("sweeping an idle seat closes it", sweepSeats(-1) === 8 && seatsOpen() === 0);
expect("a sweep with nothing left closes nothing", sweepSeats(-1) === 0);

console.log(checks.join("\n"));
console.log(`\neach browser keeps its own wallet, its own ticket and its own transcript, and every check above is offline`);
