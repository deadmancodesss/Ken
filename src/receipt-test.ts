import "dotenv/config";
import { PAY_CHAIN } from "./chain.js";
import { rmSync } from "node:fs";
import { resolve } from "node:path";

/*
 * A receipt check is the one thing on this paywall whose answer is not stored anywhere,
 * so the checks below are about the two ways it could still lie: leaking the answer in
 * the reply that asks for money, and folding the case of a base58 digest so that two
 * different transactions are sold as one.
 *
 * Nothing here reads the chain. The live receipt sentence is proved in npm run plumb,
 * where the read is already paid for, rather than spending a Tatum query to re-learn it.
 */

const scratchLedger = resolve("vibe_images/receipt-seller-test.json");
const INDEX = `0x${"c".repeat(63)}3`;
process.env.SELLER_LEDGER = scratchLedger;
process.env.SELLER_WALLET = INDEX;
process.env.SELLER_PRICE_USDC = "0.01";

const { sell } = await import("./catalog.js");
const { addressOf, canonical, parseResource, receiptResourceId } = await import("./resources.js");
const { decodeHeader } = await import("./x402wire.js");

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

const BUYER = `0x${"b".repeat(63)}2`;
// base58 has no 0, I, O or lower case L, so a string that uses one of them is not a
// transaction anybody could have signed however many characters it has.
const B58 = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
const PHANTOM = Array.from({ length: 44 }, (_, i) => B58[(i * 7 + 3) % 58]).join("");
const MIXED = "8tucBNY7DBfADas9BYF4BpCY6R974vgVts9MAcQxZ57J";
// Same transaction spelled with one letter in the other case. base58 is case
// sensitive, so this is a different 44 byte hash and must never be sold as the first.
const OTHER = "8TucBNY7DBfADas9BYF4BpCY6R974vgVts9MAcQxZ57J";

expect("a digest parses as a receipt", parseResource(`receipt:${MIXED}`).kind === "receipt");
expect("a digest with no prefix is still read as a receipt", parseResource(receiptResourceId(MIXED)).kind === "receipt");
expect("a digest containing a character base58 never uses is refused", throws(() => receiptResourceId(`${MIXED.slice(0, 42)}0`)));
expect("a digest one character short is refused", throws(() => receiptResourceId(MIXED.slice(0, 42))));
expect("one digest spelled two ways is one thing to buy", canonical(receiptResourceId(MIXED)) === `receipt:${MIXED}`);
expect("two digests differing only in case are two things to buy", canonical(receiptResourceId(OTHER)) !== canonical(receiptResourceId(MIXED)));
expect("a receipt cannot be read as a person's address", throws(() => addressOf(receiptResourceId(MIXED))));

const run = async () => {
  const ask = await sell({ resource: receiptResourceId(PHANTOM), payer: BUYER });
  expect("a chain question is priced like any other lookup", ask.http === 402);
  const acc = (ask.body as any).accepts?.[0];
  expect("the money is pointed at the index that pays for the chain read", String(acc?.payTo).toLowerCase() === INDEX);
  expect("the buyer is told which transaction it is paying to ask about", String(acc?.description).includes(PHANTOM.slice(0, 12)));
  expect("the answer is not in the reply that asks for money", (ask.body as any).fact === undefined);
  expect("no word from the answer appears in the price", !["SUCCESS", "sent ", "received ", "Nothing with that digest"].some((w) => JSON.stringify(ask.body).includes(w)));

  const header = decodeHeader<any>(ask.headers["payment-required"] ?? "");
  expect("the chain question is published as a version 2 payment", header.x402Version === 2 && header.accepts?.[0]?.scheme === "exact");
  expect("the chain question is priced in whole base units", header.accepts?.[0]?.amount === "10000");
  expect("the chain question is priced on the network this build settles", header.accepts?.[0]?.network === PAY_CHAIN);

  const junk = await sell({ resource: "receipt:not-a-digest-at-all-because-it-is-too-short", payer: BUYER });
  expect("a malformed digest is a 400 rather than a chain call", junk.http === 400);

  rmSync(scratchLedger, { force: true });
  console.log(fails ? `\n${fails} receipt check(s) failed` : `\nall receipt checks green, no chain read, no money moved`);
  process.exit(fails ? 1 : 0);
};

await run();
