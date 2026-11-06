import "dotenv/config";
import { mkdirSync, rmSync } from "node:fs";
import { dirname, resolve } from "node:path";
import type { PaymentRequirements } from "./x402wire.js";

/*
 * A note is somebody's writing and somebody's price, so the same standard paywall that
 * was checked against forged profile payments has to survive a forged note payment too.
 * Nothing here touches the links on this machine: both stores are pointed at scratch
 * files before the modules that read them are loaded.
 */

const scratch = resolve("vibe_images/notes-test.json");
const scratchLedger = resolve("vibe_images/notes-seller-test.json");
mkdirSync(dirname(scratch), { recursive: true });

const INDEX = `0x${"c".repeat(63)}3`;
process.env.NOTES_FILE = scratch;
process.env.SELLER_LEDGER = scratchLedger;
process.env.SELLER_WALLET = INDEX;
process.env.SELLER_PRICE_USDC = "0.01";

const { createNote } = await import("./notes.js");
const { sell, salesOf } = await import("./catalog.js");
const { addressOf, noteResourceId, parseResource } = await import("./resources.js");
const { coversTerms } = await import("./facilitator.js");
const { decodeHeader, requirementsFor } = await import("./x402wire.js");
const { USDC_DECIMALS, USDC_ASSET, paymentCap } = await import("./wallet.js");
const { PAY_CHAIN } = await import("./chain.js");

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
const UNSEEN = `0x${"1".repeat(64)}`;
const WORDS = "half now and half on delivery, with the source files in the shared folder rather than the mail";
const PRICE = 0.02;

const made = createNote({ title: "The deal for the two landing pages", body: WORDS, usdc: PRICE, payTo: AUTHOR });
const resource = noteResourceId(made.id);
const units = BigInt(Math.round(PRICE * 10 ** USDC_DECIMALS));

expect("a link is written with an id nobody could guess", /^[a-z0-9]{12}$/.test(made.id));
expect("the stored price is exactly the base units on the terms", BigInt(Math.round(made.usdc * 10 ** USDC_DECIMALS)) === units);
expect("a link with no title is refused", throws(() => createNote({ title: "", body: WORDS, usdc: PRICE, payTo: AUTHOR })));
expect("a link with nothing behind the wall is refused", throws(() => createNote({ title: "x", body: "too short", usdc: PRICE, payTo: AUTHOR })));
expect("a link that pays a malformed address is refused", throws(() => createNote({ title: "x", body: WORDS, usdc: PRICE, payTo: "0xabc" })));
expect("a link priced above the signing ceiling is refused", throws(() => createNote({ title: "x", body: WORDS, usdc: paymentCap() + 1, payTo: AUTHOR })));
expect("a price too small to be a whole base unit is refused", throws(() => createNote({ title: "x", body: WORDS, usdc: 0.0000004, payTo: AUTHOR })));

expect("a note id round trips through the resource name", parseResource(resource).kind === "note");
expect("an old identity link still parses as a profile", parseResource(`identity:${BUYER}`).kind === "profile");
expect("a note id that is too short is refused", throws(() => parseResource("note:abc")));
expect("a note cannot be read as an address lookup", throws(() => addressOf(resource)));

const right = [
  { address: AUTHOR, amount: units, coinType: USDC_ASSET },
  { address: BUYER, amount: -units, coinType: USDC_ASSET },
];

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
  expect("the wallet is told which note it is being asked to sign", String(acc?.description).includes(made.title));
  expect("the answer does not contain the words being sold", !JSON.stringify(ask.body).includes("shared folder"));
  expect("the unpaid link has been opened by nobody", salesOf(resource).length === 0);

  const header = decodeHeader<any>(ask.headers["payment-required"] ?? "");
  expect("the note price is published in a PAYMENT-REQUIRED header", header.x402Version === 2 && header.accepts?.[0]?.resource === resource);
  expect("the note terms use the standard exact scheme on the network this build settles", header.accepts?.[0]?.scheme === "exact" && header.accepts?.[0]?.network === PAY_CHAIN);
  expect("the note is priced in the USDC this build settles", String(header.accepts?.[0]?.asset) === USDC_ASSET);

  const terms: PaymentRequirements = requirementsFor({
    resource,
    description: `note "${made.title}"`,
    payTo: AUTHOR,
    baseUnits: units,
  });
  expect("the right amount to the writer from the buyer opens the note", coversTerms(terms, BUYER, right) === null);
  expect("a note price one base unit short is refused", coversTerms(terms, BUYER, [{ address: AUTHOR, amount: units - 1n, coinType: USDC_ASSET }, { address: BUYER, amount: 1n - units, coinType: USDC_ASSET }]) !== null);
  expect("money sent to the index instead of the writer is refused", coversTerms(terms, BUYER, [{ address: INDEX, amount: units, coinType: USDC_ASSET }, { address: BUYER, amount: -units, coinType: USDC_ASSET }]) !== null);
  expect("money that never left the buyer is refused", coversTerms(terms, BUYER, [{ address: AUTHOR, amount: units, coinType: USDC_ASSET }]) !== null);
  expect("a buyer with no money of their own is not a payer", coversTerms(terms, UNSEEN, right) !== null);

  rmSync(scratch, { force: true });
  rmSync(scratchLedger, { force: true });
  console.log(fails ? `\n${fails} note check(s) failed` : `\nall note checks green, no money moved`);
  process.exit(fails ? 1 : 0);
};

await run();
