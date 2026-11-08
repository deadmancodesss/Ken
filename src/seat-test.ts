/**
 * The build used to hold one session, one unsigned payment and one transcript for the
 * whole process, so a second browser connecting a wallet changed the first browser's
 * wallet and cleared its screen. These checks hold two seats open at once and prove
 * neither can see or release the other's.
 */
import { seatFor, seatsOpen, sweepSeats, within } from "./seat.js";
import { session, useDemoWallet, useWallet } from "./session.js";
import { savedSession, saveSession } from "./seat-store.js";
import { held, hold, release } from "./pending.js";
import { chatKey } from "./chats.js";
import { scope } from "./scope.js";

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

expect("a process with no seat still reads the demo story", session().source === "demo");

const one = seatFor("seat-one");
const two = seatFor("seat-two");

within(one, () => {
  useWallet(A, CHAIN);
  hold(ticket(A, 0.5));
});
within(two, () => {
  expect("a second seat is still on the demo story after the first connects", session().source === "demo");
  expect("a second seat cannot see the first seat's unsigned payment", held() === null);
  useWallet(B, CHAIN);
});

within(one, () => {
  expect("the first seat still speaks for its own wallet", session().wallet === A);
  expect("the first seat still holds its own ticket", held()?.sender === A);
});

// The name the agent keeps is filed under the wallet it heard, not under the browser.
// This is why a name saved while a wallet was connected goes quiet on the demo wallet.
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

within(one, () => useDemoWallet());
const peopleDemo = within(one, () => scope("people"));
expect("letting go of a wallet changes which names that page can read", peopleDemo !== peopleA);
within(two, () => expect("letting go in one seat leaves the other seat's wallet alone", session().wallet === B));

const demoOne = within(one, () => chatKey());
const demoTwo = within(two, () => useDemoWallet() && chatKey());
within(two, () => useWallet(B, CHAIN));
const walletTwo = within(two, () => chatKey());
const three = seatFor("seat-three");
const walletThree = within(three, () => {
  useWallet(B, CHAIN);
  return chatKey();
});

expect("two demo visitors never share one chat transcript", demoOne !== demoTwo && demoOne.includes("seat-one"));
expect("demo chats are stored under the seat, not the shared demo wallet", demoOne.startsWith("demo:"));
expect("the same wallet on two seats reads the same chat", walletTwo === walletThree && walletTwo.startsWith("wallet:"));
expect("a wallet chat is not keyed to a browser seat", !walletTwo.includes("seat-"));

expect("three seats are open", seatsOpen() === 3);

const restored = seatFor("seat-restored", () => ({ wallet: A, network: "testnet", source: "wallet", reported: "testnet" }));
expect("a new seat starts from the wallet it saved before a restart", within(restored, () => session().wallet === A));
saveSession("seat-saved", { wallet: B, network: "testnet", source: "wallet", reported: "testnet" });
expect("a saved seat reads back with its wallet", savedSession("seat-saved")?.wallet === B);
saveSession("seat-saved", null);
expect("clearing a saved seat forgets the wallet", savedSession("seat-saved") === null);

expect("sweeping an idle seat closes it", sweepSeats(-1) === 4 && seatsOpen() === 0);

console.log(checks.join("\n"));
console.log(`\neach browser keeps its own wallet, its own ticket and its own demo transcript, and every check above is offline`);
