import "dotenv/config";
import { mkdirSync, rmSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { USDC_DECIMALS, USDC_TESTNET, paymentCap } from "./wallet.js";
import type { Quote } from "./x402.js";

/*
 * A note is somebody's writing and somebody's price, so the same paywall that was
 * audited against forged identity payments has to survive a forged note payment too.
 * Nothing here touches the links on this machine: the store is pointed at a scratch
 * file before the module that reads it is even loaded.
 */

const scratch = resolve("vibe_images/notes-test.json");
mkdirSync(dirname(scratch), { recursive: true });
process.env.NOTES_FILE = scratch;

const { createNote } = await import("./notes.js");
const { addressOf, noteResourceId, parseResource, salesOf, sell, verdict } = await import("./x402.js");

let fails = 0;
const expect = (what: string, ok: boolean) => {
  console.log(`${ok ? "ok   " : "FAIL "} ${what}`);
  if (!ok) fails++;
};

const throws = (fn: () => unknown) => {
  try {
    fn();
    return false;
  } catch {
    return true;
  }
};

const AUTHOR = `0x${"a".repeat(63)}1`;
const BUYER = `0x${"b".repeat(63)}2`;
const INDEX = `0x${"c".repeat(63)}3`;
const UNSEEN = `0x${"1".repeat(64)}`;
const WORDS = "half now and half on delivery, with the source files in the shared folder rather than the mail";
const PRICE = 0.02;

const made = createNote({ title: "The deal for the two landing pages", body: WORDS, usdc: PRICE, payTo: AUTHOR });
const resource = noteResourceId(made.id);
const units = BigInt(Math.round(PRICE * 10 ** USDC_DECIMALS));

const quote: Quote = {
  id: "note0001",
  resource,
  payer: BUYER,
  usdc: PRICE,
  baseUnits: String(units),
  asset: USDC_TESTNET,
  payTo: AUTHOR,
  network: "sui:testnet",
  issued: Date.now(),
  expires: Date.now() + 60_000,
};

const deal = (changes: { address: string; amount: bigint; coinType?: string }[], status = "SUCCESS") => ({
  digest: "ANoteDigestNeverSent",
  status,
  timestamp: "2026-11-03T00:00:00Z",
  changes: changes.map((c) => ({ address: c.address, amount: c.amount, coinType: c.coinType ?? USDC_TESTNET })),
});
const right = [{ address: AUTHOR, amount: units }, { address: BUYER, amount: -units }];

expect("a link is written with an id nobody could guess", /^[a-z0-9]{12}$/.test(made.id));
expect("the stored price is exactly the base units on the quote", BigInt(Math.round(made.usdc * 10 ** USDC_DECIMALS)) === units);
expect("a link with no title is refused", throws(() => createNote({ title: "", body: WORDS, usdc: PRICE, payTo: AUTHOR })));
expect("a link with nothing behind the wall is refused", throws(() => createNote({ title: "x", body: "too short", usdc: PRICE, payTo: AUTHOR })));
expect("a link that pays a malformed address is refused", throws(() => createNote({ title: "x", body: WORDS, usdc: PRICE, payTo: "0xabc" })));
expect("a link priced above the signing ceiling is refused", throws(() => createNote({ title: "x", body: WORDS, usdc: paymentCap() + 1, payTo: AUTHOR })));
expect("a price too small to be a whole base unit is refused", throws(() => createNote({ title: "x", body: WORDS, usdc: 0.0000004, payTo: AUTHOR })));

expect("a note id round trips through the resource name", parseResource(resource).kind === "note");
expect("an address still parses as an address", parseResource(`identity:${BUYER}`).kind === "identity");
expect("a note id that is too short is refused", throws(() => parseResource("note:abc")));
expect("a note cannot be read as an address lookup", throws(() => addressOf(resource)));

const run = async () => {
  const unknown = await sell({ resource: `note:${"z".repeat(12)}`, payer: BUYER });
  expect("a link nobody wrote is a 404 rather than a price", unknown.http === 404);

  const junk = await sell({ resource: "note:not-an-id", payer: BUYER });
  expect("a junk id inside the note shape is a 400", junk.http === 400);

  const selfish = await sell({ resource, payer: AUTHOR });
  expect("a link that pays the wallet opening it is refused", selfish.http === 400);

  const ask = await sell({ resource, payer: BUYER });
  expect("a wallet that has never paid is asked to pay for a note", ask.http === 402);
  const acc = (ask.body as any).accepts?.[0];
  expect("the note is priced by its writer rather than by the index", String(acc?.amount) === String(units));
  expect("the money is pointed at the writer rather than at the index", String(acc?.payTo).toLowerCase() === AUTHOR);
  expect("the wallet is told which note it is being asked to sign", String(acc?.memo).includes(made.title));
  expect("the quote carries the asking wallet", String((ask.body as any).quote?.payer) === BUYER);
  expect("the words are not in the answer that asks for money", !JSON.stringify(ask.body).includes("shared folder"));
  expect("an unpaid link has been opened by nobody", salesOf(resource).length === 0);

  expect("the note price travels with the quote, so a cheap payment cannot open it", !verdict(quote, deal([{ address: AUTHOR, amount: units - 1n }, { address: BUYER, amount: 1n - units }]), {}).ok);
  expect("the right amount to the writer from the buyer opens the note", verdict(quote, deal(right), {}).ok);
  expect("money sent to the index instead of the writer is refused", !verdict(quote, deal([{ address: INDEX, amount: units }, { address: BUYER, amount: -units }]), {}).ok);
  expect("money that never left the buyer is refused", !verdict(quote, deal([{ address: AUTHOR, amount: units }]), {}).ok);
  expect("a receipt already spent is refused on a note too", !verdict(quote, deal(right), { ANoteDigestNeverSent: { resource, payer: BUYER, digest: "ANoteDigestNeverSent", usdc: PRICE, at: "2026-11-03" } }).ok);

  rmSync(scratch, { force: true });
  console.log(fails ? `\n${fails} note check(s) failed` : `\nall note checks green, no money moved`);
  process.exit(fails ? 1 : 0);
};

await run();
