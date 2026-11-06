import "dotenv/config";
import { mkdirSync, rmSync } from "node:fs";
import { dirname, resolve } from "node:path";

/*
 * This is the half of the product that says a memory is worth money, so the number
 * doing the saying gets tested the way money numbers get tested: against payments that
 * never happened, in a scratch file, with no chain and no ledger on this machine read
 * or written. The fake receipts are handed to the arithmetic directly, which is what
 * lets a check ask whether a payment to somebody else's wallet was quietly counted as
 * yours.
 */

const scratch = resolve("vibe_images/earn-test.json");
const scratchLedger = resolve("vibe_images/earn-seller-test.json");
mkdirSync(dirname(scratch), { recursive: true });
process.env.NOTES_FILE = scratch;
process.env.SELLER_LEDGER = scratchLedger;

const { PAY_CHAIN } = await import("./chain.js");
const { BLOB_ID, createNote, titleFor } = await import("./notes.js");
const { tally } = await import("./earn.js");
const { noteResourceId } = await import("./resources.js");
const { sell } = await import("./catalog.js");
import type { Sale } from "./x402.js";

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

const SELLER = `0x${"a".repeat(63)}1`;
const OTHER = `0x${"b".repeat(63)}2`;
const FRIEND = `0x${"c".repeat(63)}3`;
const STRANGER = `0x${"d".repeat(63)}4`;

const UNNAMED_A = `0x${"1".repeat(64)}`;
const UNNAMED_B = `0x${"2".repeat(64)}`;
const BLOB = "_OcDylhBVR5qRpeQ5PadK1itpmErM2nAcC_fKs_cU1Q";
const PERSON = `Person "Sana" = ${SELLER}, buys groceries every couple of days`;
const COUNTERPARTY = `Counterparty ${UNNAMED_A} , first seen 2026-10-25, paid 4.00 USDC four times`;
const PAID_NAMED = `Paid 1.33 USDC to ${FRIEND} (Sana) on 2026-11-02. tx SomeFakeDigestOne`;
const PAID_RAW = `Paid 0.01 USDC to ${UNNAMED_B} on 2026-11-01. tx SomeFakeDigestTwo`;
const RECEIPT = `Chain receipt for 8tucBNY7DBfADas9BYF4BpCY6R974vgVts9MAcQxZ57J: On ${PAY_CHAIN} that transaction ended SUCCESS`;
const ODD = "the landlord asked for the deposit twice, and the second time was a different bank";

/* ---------- what a line gets called before anyone can buy it ---------- */

expect("a person line is titled with the person, not with the record", titleFor(PERSON) === 'what I know about Sana');
expect("a counterparty line is titled with the wallet it describes", titleFor(COUNTERPARTY).startsWith("what I know about 0x11111111…"));
expect("a payment line names who was paid and when", titleFor(PAID_NAMED) === "the payment to Sana on 2026-11-02");
expect("a payment to an unnamed wallet is shortened rather than pasted", titleFor(PAID_RAW) === "the payment to 0x22222222… on 2026-11-01");
expect("a receipt line is titled as a check rather than as a person", titleFor(RECEIPT).startsWith("a chain check of 8tucBNY7DB"));
expect("a line in no known shape keeps its own first sentence", titleFor(ODD) === ODD);
expect("the amount inside a payment line is not mistaken for the price", !titleFor(PAID_NAMED).includes("1.33"));

// A title is printed on a card and read out loud, so no shape below is allowed to
// produce a sixty four character string or a sentence that runs off the card.
for (const [shape, text] of [["person", PERSON], ["counterparty", COUNTERPARTY], ["payment", PAID_NAMED], ["receipt", RECEIPT], ["sentence", ODD]] as const) {
  const t = titleFor(text);
  expect(`a ${shape} title fits the card without a hash in it`, t.length <= 90 && !/0x[0-9a-f]{40,}/i.test(t) && !t.includes("\n"));
}

/* ---------- a link made out of a stored line ---------- */

const memoryNote = createNote({ title: titleFor(PERSON), body: PERSON, usdc: 0.02, payTo: SELLER, blob: BLOB });
const typedNote = createNote({ title: "The deal for the two landing pages", body: "half now and half on delivery, with the source files in the shared folder", usdc: 0.03, payTo: OTHER });

expect("a link made from a memory keeps the id of the line it came from", memoryNote.blob === BLOB);
expect("a link made by hand claims no memory at all", typedNote.blob === undefined);
expect("a blob id that could not be a Walrus id is refused", throws(() => createNote({ title: "x", body: PERSON, usdc: 0.02, payTo: SELLER, blob: "not a blob id" })));
expect("the twelve character memory id is refused where a blob id is asked for", throws(() => createNote({ title: "x", body: PERSON, usdc: 0.02, payTo: SELLER, blob: "goD3Ropc-hfH" })));
expect("a blob id is the forty three characters of the Walrus hash", BLOB_ID.test(BLOB) && BLOB.length === 43 && !BLOB_ID.test(`${BLOB}x`));
expect("a memory line too short to sell says what the line is", (() => {
  try {
    createNote({ title: titleFor("a two word memory"), body: "a two word memory", usdc: 0.02, payTo: SELLER, blob: BLOB });
    return false;
  } catch (err) {
    return /that line is/.test((err as Error).message) && !/Write at least/.test((err as Error).message);
  }
})());

const ask = await sell({ resource: noteResourceId(memoryNote.id), payer: STRANGER });
const acc = (ask.body as any)?.accepts?.[0];
expect("a memory link still answers with a price rather than with the words", ask.http === 402 && !JSON.stringify(ask.body).includes("groceries"));
expect("a memory link tells the buyer it is buying a memory", String(acc?.description).startsWith("a memory line"));
const askTyped = await sell({ resource: noteResourceId(typedNote.id), payer: STRANGER });
expect("a handwritten link is still called a note", String((askTyped.body as any)?.accepts?.[0]?.description).startsWith('note "'));

/* ---------- the arithmetic over receipts that were never real ---------- */

const sale = (resource: string, payer: string, usdc: number, at: string, digest: string): Sale => ({ resource, payer, digest, usdc, at });
const ledger: Record<string, Sale[]> = {
  [`note:${memoryNote.id}`]: [
    sale(`note:${memoryNote.id}`, FRIEND, 0.02, "2026-11-01", "DigestOne"),
    sale(`note:${memoryNote.id}`, STRANGER, 0.02, "2026-11-03", "DigestTwo"),
  ],
  [`note:${typedNote.id}`]: [sale(`note:${typedNote.id}`, FRIEND, 0.03, "2026-11-02", "DigestThree")],
};
const sales = (resource: string) => ledger[resource] ?? [];
const names = (address: string) => (address === FRIEND ? "Ravi" : `${address.slice(0, 10)}…`);

const earned = tally([memoryNote, typedNote], sales, SELLER, names);
const byId = new Map(earned.rows.map((r) => [r.id, r]));
const mem = byId.get(memoryNote.id)!;
const typ = byId.get(typedNote.id)!;

expect("two payments for one link add up to the money a wallet can count", mem.earned === 0.04 && String(mem.earned) === "0.04");
expect("three one cent payments are written as three cents and not as a float", tally([typedNote], () => [sale(`note:${typedNote.id}`, FRIEND, 0.01, "2026-11-01", "A"), sale(`note:${typedNote.id}`, STRANGER, 0.01, "2026-11-02", "B"), sale(`note:${typedNote.id}`, SELLER, 0.01, "2026-11-03", "C")], SELLER, names).rows[0].earned === 0.03);
expect("a link nobody opened is still on the list, at zero", (() => {
  const e = tally([typedNote], () => [], SELLER, names);
  return e.rows.length === 1 && e.rows[0].earned === 0 && e.rows[0].opened === 0 && e.bought === 0;
})());
expect("only the links that were paid for are counted as bought", earned.links === 2 && earned.bought === 2);
expect("the money trail is newest first", mem.money[0].on === "2026-11-03" && mem.money[1].on === "2026-11-01");
expect("a buyer the memory can name is named", mem.money.some((m) => m.from === "Ravi"));
expect("a buyer nobody named is shown as the wallet and not as a blank", mem.money[0].from === `${STRANGER.slice(0, 10)}…`);
expect("a trail carries the receipt a reader could go and check", mem.money[0].tx === "DigestTwo" && mem.money[0].usdc === 0.02);
expect("the total is every link added together", earned.total === 0.07);
expect("money paid to a different wallet is not counted as this wallet's", earned.into_this_wallet === 0.04 && earned.total === 0.07);
expect("a wallet that is paid nothing is told so rather than shown the other wallet's money", tally([typedNote], sales, FRIEND, names).into_this_wallet === 0);
expect("a receipt for one link is never counted for another", typ.earned === 0.03 && mem.money.length === 2);
expect("a link made from memory is marked as one", mem.from_memory === true && typ.from_memory === false);
expect("the price on the link is the price that was asked", mem.usdc === 0.02 && typ.usdc === 0.03);
expect("a link is listed under the address it pays", mem.pay_to === SELLER && typ.pay_to === OTHER);
expect("an address written any way round is still the same wallet's money", tally([memoryNote], sales, SELLER.toUpperCase(), names).into_this_wallet === 0.04);

rmSync(scratch, { force: true });
rmSync(scratchLedger, { force: true });
console.log(fails ? `\n${fails} earning check(s) failed` : `\nall earning checks green, no money moved`);
process.exit(fails ? 1 : 0);
