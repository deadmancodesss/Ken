import "dotenv/config";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { Transaction } from "@mysten/sui/transactions";
import { Ed25519Keypair } from "@mysten/sui/keypairs/ed25519";
import type { PaymentRequirements, SettlementResponse } from "./x402wire.js";

/*
 * The money half of this product is an HTTP paywall, so the checks are written against
 * a seller whose facilitator answers from a fixture. Nothing here sends money, reads the
 * chain or touches Walrus: every settlement below is a value handed to the release rule.
 *
 * The envelope in the middle of the file is really signed by an Ed25519 key. That is the
 * point of the standard shape: the seller never takes a digest on trust, and the same
 * signed bytes cannot buy the same answer twice.
 */

const scratchNotes = resolve("vibe_images/x402-notes-test.json");
const scratchLedger = resolve("vibe_images/x402-seller-test.json");
mkdirSync(dirname(scratchNotes), { recursive: true });

const INDEX = `0x${"c".repeat(63)}3`;
process.env.NOTES_FILE = scratchNotes;
process.env.SELLER_LEDGER = scratchLedger;
process.env.SELLER_WALLET = INDEX;
process.env.SELLER_PRICE_USDC = "0.01";
process.env.SELLER_BUSY_PRICE_USDC = "0.03";
process.env.SELLER_BUSY_TXS = "20";
process.env.PAID_MAX_USDC = "0.02";

const { createNote } = await import("./notes.js");
const { sell, salesOf } = await import("./catalog.js");
const { addressOf, canonical, noteResourceId, parseResource, receiptResourceId, resourceId } = await import("./resources.js");
const { overCeiling, priceCeiling, priceUsdc, buy } = await import("./x402.js");
const { coversTerms } = await import("./facilitator.js");
const { decodeHeader, envelopeFromSigned, requirementsFor } = await import("./x402wire.js");
const { USDC_ASSET } = await import("./wallet.js");
const { PAY_CHAIN } = await import("./chain.js");
const { useNetwork } = await import("./session.js");

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
const buyerKey = Ed25519Keypair.generate();
const otherKey = Ed25519Keypair.generate();
const thirdKey = Ed25519Keypair.generate();
const BUYER = buyerKey.toSuiAddress();
const OTHER = otherKey.toSuiAddress();
const THIRD = thirdKey.toSuiAddress();
const WORDS = "half now and half on delivery, with the source files in the shared folder rather than the mail";

const made = createNote({ title: "The deal for the two landing pages", body: WORDS, usdc: 0.02, payTo: AUTHOR });
const resource = noteResourceId(made.id);
const units = BigInt(20_000);

/* ---------- one spelling for one thing behind the wall ---------- */

expect("an address round trips through the resource name", addressOf(resourceId(BUYER)) === BUYER.toLowerCase());
expect("a resource built from a short address is refused", throws(() => resourceId("0xabc")));
expect("an old identity link still means the same profile", canonical(`identity:${BUYER}`) === `profile:${BUYER.toLowerCase()}`);
expect("identity folds the case of a hex address", canonical(`identity:0x${BUYER.slice(2).toUpperCase()}`) === `profile:${BUYER.toLowerCase()}`);
expect("a note id round trips through the resource name", parseResource(resource).kind === "note");
expect("a note cannot be read as an address", throws(() => addressOf(resource)));
expect("a note id that is too short is refused", throws(() => parseResource("note:abc")));
expect("a resource in no known shape is refused", throws(() => parseResource("invoice:0x1")));

const B58 = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
const PHANTOM = Array.from({ length: 44 }, (_, i) => B58[(i * 7 + 3) % 58]).join("");
const MIXED = "8tucBNY7DBfADas9BYF4BpCY6R974vgVts9MAcQxZ57J";
const OTHER_DIGEST = "8TucBNY7DBfADas9BYF4BpCY6R974vgVts9MAcQxZ57J";
expect("a digest parses as a receipt", parseResource(receiptResourceId(MIXED)).kind === "receipt");
expect("a digest using a character base58 never uses is refused", throws(() => receiptResourceId(`${MIXED.slice(0, 42)}0`)));
expect("one digest spelled two ways is one thing to buy", canonical(receiptResourceId(MIXED)) === `receipt:${MIXED}`);
expect("two digests differing only in case are two things to buy", canonical(receiptResourceId(OTHER_DIGEST)) !== canonical(receiptResourceId(MIXED)));

/* ---------- the buyer's ceiling is a refusal, not a warning ---------- */

expect("the published price is the one the seller quotes", priceUsdc() === 0.01);
expect("a quote at the ceiling is paid", overCeiling(priceCeiling()) === null);
expect("a quote above the ceiling is refused", overCeiling(0.03) !== null);
expect("the refusal says the number and how to raise it", /0\.02/.test(overCeiling(0.05) ?? "") && /PAID_MAX_USDC/.test(overCeiling(0.05) ?? ""));

/* ---------- the facilitator's one money rule, against forged changes ---------- */

const terms: PaymentRequirements = requirementsFor({
  resource: `profile:${BUYER}`,
  description: "fixture",
  payTo: INDEX,
  baseUnits: units,
});
const change = (address: string, amount: bigint, coinType = USDC_ASSET) => ({ address, amount, coinType });
const right = [change(INDEX, units), change(BUYER, -units)];

expect("an exact payment from the signing wallet releases the fact", coversTerms(terms, BUYER, right) === null);
expect("a payment one base unit short is refused", coversTerms(terms, BUYER, [change(INDEX, units - 1n), change(BUYER, 1n - units)]) !== null);
expect("money sent to another address is refused", coversTerms(terms, BUYER, [change(OTHER, units), change(BUYER, -units)]) !== null);
expect("a credit with no matching debit is refused", coversTerms(terms, BUYER, [change(INDEX, units)]) !== null);
expect("a debit from a wallet that did not sign is refused", coversTerms(terms, BUYER, [change(INDEX, units), change(OTHER, -units)]) !== null);
expect("an overpayment in the wrong coin is refused", coversTerms(terms, BUYER, [change(INDEX, units, "0x2::sui::SUI"), change(BUYER, -units, "0x2::sui::SUI")]) !== null);

/* ---------- the HTTP handshake, with a facilitator made of a value ---------- */

async function signedBy(key: Ed25519Keypair): Promise<{ envelope: string; sender: string }> {
  const tx = new Transaction();
  tx.setSender(key.toSuiAddress());
  tx.setGasBudget(1_000_000);
  tx.setGasPrice(1000);
  tx.setGasPayment([{ objectId: `0x${"1".repeat(64)}`, version: "1", digest: "1".repeat(32) }]);
  const built = await tx.build();
  const { signature } = await key.signTransaction(built);
  return {
    envelope: envelopeFromSigned(Buffer.from(built).toString("base64"), signature),
    sender: key.toSuiAddress(),
  };
}

let settles = 0;
const settleOk = async (input: { paymentRequirements: PaymentRequirements }): Promise<SettlementResponse> => {
  settles++;
  return {
    success: true,
    transaction: "FakeDigestFromTheFixture",
    network: PAY_CHAIN,
    payer: BUYER,
    amount: input.paymentRequirements.amount,
  };
};

const run = async () => {
  const ask = await sell({ resource, payer: BUYER });
  expect("a wallet that has never paid is asked to pay", ask.http === 402);
  const header = ask.headers["payment-required"];
  expect("the price arrives in a PAYMENT-REQUIRED header", typeof header === "string" && header.length > 0);
  const required = decodeHeader<any>(header ?? "");
  expect("the handshake declares x402 version 2", required.x402Version === 2);
  const acc = required.accepts?.[0];
  expect("the accepted scheme is exactly the standard one", acc?.scheme === "exact");
  expect("the accepted network is the one this build settles", acc?.network === PAY_CHAIN);
  expect("the asset is testnet USDC and not a lookalike", String(acc?.asset) === USDC_ASSET);
  expect("the amount is the note price in base units", String(acc?.amount) === String(units));
  expect("the money is pointed at the writer", String(acc?.payTo).toLowerCase() === AUTHOR);
  expect("the terms carry the resource they price", String(acc?.resource) === resource);
  expect("the terms say how long a signature may take", Number(acc?.maxTimeoutSeconds) > 0);
  expect("the body repeats the accepted terms instead of hiding them in a header only", (ask.body as any).accepts?.[0]?.amount === String(units));
  expect("the words are not in the answer that asks for money", !JSON.stringify(ask.body).includes("shared folder"));
  expect("the words are not in the header that asks for money", !decodeHeader<any>(header ?? "").accepts?.[0]?.description.includes("shared folder"));

  const junk = await sell({ resource: "note:not-an-id", payer: BUYER });
  expect("a junk id inside the note shape is a 400", junk.http === 400);
  const unknown = await sell({ resource: `note:${"z".repeat(12)}`, payer: BUYER });
  expect("a link nobody wrote is a 404 rather than a price", unknown.http === 404);
  const selfish = await sell({ resource, payer: AUTHOR });
  expect("a link that pays the wallet opening it is refused", selfish.http === 400);
  const walletless = await sell({ resource });
  expect("a request that names no payer is refused", walletless.http === 400);

  const signed = await signedBy(buyerKey);
  const paid = await sell({ resource, payer: BUYER, envelope: signed.envelope }, { settle: settleOk });
  expect("a valid signed payment releases the note", paid.http === 200);
  expect("the settled price is charged once", Number((paid.body as any).charged) === 0.02);
  expect("the settled transaction is named in the reply", (paid.body as any).tx === "FakeDigestFromTheFixture");
  const settledHeader = decodeHeader<SettlementResponse>(paid.headers["payment-response"] ?? "");
  expect("the PAYMENT-RESPONSE header says the settlement succeeded", settledHeader.success === true && settledHeader.transaction === "FakeDigestFromTheFixture");
  expect("the note's own words are released only after settlement", String((paid.body as any).fact?.note).includes("shared folder"));

  const replay = await sell({ resource, payer: BUYER, envelope: signed.envelope }, { settle: settleOk });
  expect("the same signed payment is answered rather than settled twice", replay.http === 200 && settles === 1);
  expect("a replay is charged nothing", Number((replay.body as any).charged) === 0);
  expect("a replay names the original transaction", (replay.body as any).tx === "FakeDigestFromTheFixture");
  expect("a replay says why it cost nothing", /already settled/.test(String((replay.body as any).reason)));

  const owned = await sell({ resource, payer: BUYER });
  expect("a wallet that already bought is answered without a price", owned.http === 200);
  expect("the fact is handed over for nothing", Number((owned.body as any).charged) === 0);
  expect("the price that moved earlier is still stated", Number((owned.body as any).paid_then) === 0.02);
  expect("the receipt named is the one that was paid", (owned.body as any).tx === "FakeDigestFromTheFixture");

  const wrongWallet = await signedBy(otherKey);
  const mismatched = await sell({ resource, payer: THIRD, envelope: wrongWallet.envelope }, { settle: settleOk });
  expect("a signed payment from another wallet cannot buy this payer's answer", mismatched.http === 400);

  const refused = async (): Promise<SettlementResponse> => ({
    success: false,
    transaction: "",
    network: PAY_CHAIN,
    errorReason: "fixture refused it",
  });
  const rejected = await sell({ resource, payer: OTHER, envelope: wrongWallet.envelope }, { settle: refused });
  expect("a refused settlement is a 402 and not a release", rejected.http === 402);
  expect("the refusal is named in the PAYMENT-RESPONSE header", decodeHeader<SettlementResponse>(rejected.headers["payment-response"] ?? "").success === false);
  expect("a refused payment does not open the note", (await sell({ resource, payer: OTHER })).http === 402);

  const unreadable = await sell({ resource, payer: THIRD, envelope: "not-a-signed-transaction" }, { settle: settleOk });
  expect("a payment payload that is not a signed Sui transaction is refused", unreadable.http === 400);

  const noSettle = await signedBy(thirdKey);
  const orphan = await sell({ resource, payer: THIRD, envelope: noSettle.envelope });
  expect("an envelope without a facilitator is a 503 rather than a free answer", orphan.http === 503);

  const receiptAsk = await sell({ resource: `receipt:${PHANTOM}`, payer: BUYER });
  expect("a chain question is priced like any other lookup", receiptAsk.http === 402);
  expect("a chain question is priced at the published base price", String((receiptAsk.body as any).accepts?.[0]?.amount) === "10000");
  expect("the buyer is told which transaction it is paying to ask about", String((receiptAsk.body as any).accepts?.[0]?.description).includes(PHANTOM.slice(0, 12)));
  expect("the answer is not in the reply that asks for money", (receiptAsk.body as any).fact === undefined);

  expect("only the settled note is on the seller's books", salesOf(resource).length === 1);
  expect("the sale names the payer and the transaction", salesOf(resource)[0].payer === BUYER && salesOf(resource)[0].digest === "FakeDigestFromTheFixture");

  /* ---------- a fact belongs to the ledger its money settled on ---------- */

  const payNet = PAY_CHAIN.split(":")[1] as "mainnet" | "testnet";
  const otherNet = payNet === "mainnet" ? "testnet" : "mainnet";

  const askedOnOther = await sell({ resource, payer: BUYER, network: otherNet });
  expect("a note bought on one ledger is not free on the other", askedOnOther.http === 402);
  expect(
    "only the ledger that paid lists the sale",
    salesOf(resource, payNet).length === 1 && salesOf(resource, otherNet).length === 0,
  );

  const replayOnOther = await sell(
    { resource, payer: BUYER, envelope: signed.envelope, network: otherNet },
    { settle: settleOk },
  );
  expect("the same envelope cannot be replayed on the other ledger", replayOnOther.http === 402);
  expect(
    "the replay refusal names the ledger the settlement belongs to",
    /settlement happened on/.test(String((replayOnOther.body as any).error)),
  );

  const legacyNote = createNote({ title: "words from before the split", body: WORDS, usdc: 0.02, payTo: AUTHOR });
  const legacyResource = noteResourceId(legacyNote.id);
  const book = JSON.parse(readFileSync(scratchLedger, "utf8"));
  book.sold[`${BUYER.toLowerCase()}|${canonical(legacyResource)}`] = {
    resource: legacyResource,
    payer: BUYER,
    digest: "LegacyTestnetSale",
    usdc: 0.02,
    at: "2026-01-01",
  };
  writeFileSync(scratchLedger, JSON.stringify(book, null, 1));

  const legacyTestnet = await sell({ resource: legacyResource, payer: BUYER, network: "testnet" });
  expect(
    "a sale written before the network existed is honoured on testnet",
    legacyTestnet.http === 200 && Number((legacyTestnet.body as any).charged) === 0,
  );
  const legacyMainnet = await sell({ resource: legacyResource, payer: BUYER, network: "mainnet" });
  expect("the same old row does not open the fact on mainnet", legacyMainnet.http === 402);

  const crossNote = createNote({ title: "settled on the wrong ledger", body: WORDS, usdc: 0.02, payTo: AUTHOR });
  const crossResource = noteResourceId(crossNote.id);
  const crossSigned = await signedBy(buyerKey);
  const crossed = await sell(
    { resource: crossResource, payer: BUYER, envelope: crossSigned.envelope, network: otherNet },
    { settle: settleOk },
  );
  expect(
    "a facilitator that settles on another ledger cannot release this one",
    crossed.http === 402 && /settlement happened on/.test(String((crossed.body as any).error)),
  );
  expect("a cross-ledger settlement writes nothing to the seller's books", salesOf(crossResource, otherNet).length === 0);

  useNetwork(otherNet);
  const wrongLedger = await buy(`receipt:${PHANTOM}`, BUYER);
  expect(
    "the agent's own key refuses to buy while the page reads the other ledger",
    "error" in wrongLedger && /will not buy/.test(wrongLedger.error),
  );
  useNetwork(payNet);

  rmSync(scratchNotes, { force: true });
  rmSync(scratchLedger, { force: true });
  console.log(fails ? `\n${fails} x402 check(s) failed` : `\nall x402 checks green, no money moved`);
  process.exit(fails ? 1 : 0);
};

await run();
