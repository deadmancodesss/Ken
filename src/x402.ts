import "dotenv/config";
import { randomUUID } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { type Settled, transactionAt, waitForTransaction } from "./chain.js";
import { note, NOTE_ID } from "./notes.js";
import { labelPerson, personForAddress } from "./people.js";
import { USDC_DECIMALS, USDC_TESTNET } from "./wallet.js";

/**
 * The line this product hangs on is that the agent only pays for a truth it has
 * not already learned. That needs two halves, and they live in this one file so
 * the handshake between them cannot drift apart:
 *
 *   a source that answers HTTP 402 with a price, and only releases the fact once
 *   it has seen the money settle, and
 *   a buyer that pays the price from its own key and comes back with the digest.
 *
 * The source is our own loopback endpoint standing in for a commercial address
 * tagging API. The 402 handshake, the USDC transfer and the settlement check are
 * all real, and only the data behind the paywall is invented.
 */

const PRICE_USDC = Number(process.env.PAID_PRICE_USDC ?? "0.01");
const QUOTE_TTL_MS = 10 * 60_000;
const SOURCE_URL = process.env.PAID_SOURCE_URL ?? "http://127.0.0.1:8787/paid";
const LEDGER_FILE = new URL("../.paid.json", import.meta.url).pathname;
const CATALOG_FILE = new URL("../data/facts.json", import.meta.url).pathname;

const NETWORK = "sui:testnet";
const ADDRESS = /^0x[0-9a-fA-F]{64}$/;
const PKG = USDC_TESTNET.split("::")[0].toLowerCase();

export type Fact = { name: string; kind: string; note: string };

export type Quote = {
  id: string;
  resource: string;
  payer: string;
  usdc: number;
  baseUnits: string;
  asset: string;
  payTo: string;
  network: string;
  issued: number;
  expires: number;
};

export function priceUsdc(): number {
  return PRICE_USDC;
}

function sellerWallet(): string {
  const w = process.env.SELLER_WALLET ?? "";
  if (!ADDRESS.test(w)) {
    throw new Error("the paid index has no payout address. Set SELLER_WALLET to a full 0x Sui testnet address");
  }
  return w;
}

/** The paid index only knows the addresses in the catalogue. */
function catalog(): Record<string, Fact> {
  const raw = JSON.parse(readFileSync(CATALOG_FILE, "utf8")) as Record<string, Fact>;
  return Object.fromEntries(Object.entries(raw).filter(([k]) => ADDRESS.test(k)));
}

/**
 * One thing to buy, one wallet to buy it from, one price. Everything the buyer must
 * satisfy to lift the paywall is written here so a replayed or unrelated payment
 * cannot pass.
 *
 * Two kinds of resource are sold. `identity:` is the index's own fact about somebody
 * else's address, priced by the index and paid to the index. `note:` is a person's own
 * words, priced by them and paid to their wallet, which is why the price and the
 * payout address travel with the quote instead of being read from the environment at
 * judgement time.
 */
export function resourceId(address: string): string {
  if (!ADDRESS.test(address)) throw new Error(`${address} is not a full 0x Sui address`);
  return `identity:${address.toLowerCase()}`;
}

export function noteResourceId(id: string): string {
  if (!NOTE_ID.test(id)) throw new Error(`${id} is not one of the link ids this index issues`);
  return `note:${id}`;
}

export type Resource = { kind: "identity"; address: string } | { kind: "note"; id: string };

export function parseResource(resource: string): Resource {
  const [kind, ...rest] = String(resource).split(":");
  const value = rest.join(":");
  if (kind === "identity" && ADDRESS.test(value)) return { kind: "identity", address: value.toLowerCase() };
  if (kind === "note" && NOTE_ID.test(value)) return { kind: "note", id: value };
  throw new Error(`this index sells identity:<0x address> lookups and note:<id> links, and "${resource}" is neither`);
}

/** The address behind an identity lookup, and a refusal for anything else. */
export function addressOf(resource: string): string {
  const parsed = parseResource(resource);
  if (parsed.kind !== "identity") throw new Error(`${resource} is not an address lookup`);
  return parsed.address;
}

/** What is behind the wall for one resource, what it costs, and who gets paid. */
type Found = { fact: Fact; usdc: number; payTo: string; memo: string };
type Listing = Found | { missing: string };

function listing(resource: Resource): Listing {
  if (resource.kind === "note") {
    const n = note(resource.id);
    if (!n) return { missing: `no link ${resource.id} is open here` };
    return {
      // A note is released in the same shape as a fact so that one judgement path
      // covers both kinds. The kind is what tells a reader these words came from a
      // person rather than from the index.
      fact: { name: n.title, kind: "Note", note: n.body },
      usdc: n.usdc,
      payTo: n.pay_to,
      memo: `note "${n.title}"`,
    };
  }
  const fact = catalog()[resource.address];
  if (!fact) return { missing: `the index has nothing on ${resource.address}` };
  return { fact, usdc: PRICE_USDC, payTo: sellerWallet(), memo: `identity lookup for ${resource.address}` };
}

type Sale = { resource: string; payer: string; digest: string; usdc: number; at: string };
type Stuck = { quote: Quote; digest: string; at: string };
type Ledger = { sold: Record<string, Sale>; receipts: Record<string, Sale>; stuck: Record<string, Stuck> };

function ledger(): Ledger {
  const empty: Ledger = { sold: {}, receipts: {}, stuck: {} };
  if (!existsSync(LEDGER_FILE)) return empty;
  try {
    return { ...empty, ...(JSON.parse(readFileSync(LEDGER_FILE, "utf8")) as Ledger) };
  } catch {
    return empty;
  }
}

function saveLedger(l: Ledger): void {
  writeFileSync(LEDGER_FILE, JSON.stringify(l, null, 1));
}

const saleKey = (payer: string, resource: string) => `${payer.toLowerCase()}|${resource.toLowerCase()}`;

/**
 * Money that left without the fact being handed over is written down against the
 * quote it was paid for. Every later ask retries that receipt before any new money
 * moves, so a slow signature, a refusal or a restart cannot make a wallet pay twice
 * for one answer.
 */
export function notePayment(quote: Quote, digest: string): void {
  const l = ledger();
  l.stuck[saleKey(quote.payer, quote.resource)] = { quote, digest, at: new Date().toISOString() };
  saveLedger(l);
}

const quotes = new Map<string, Quote>();

function prune(): void {
  const now = Date.now();
  for (const [id, q] of quotes) if (q.expires < now) quotes.delete(id);
}

function newQuote(resource: string, payer: string, item: Found): Quote {
  const q: Quote = {
    id: randomUUID().slice(0, 8),
    resource,
    payer,
    usdc: item.usdc,
    baseUnits: String(BigInt(Math.round(item.usdc * 10 ** USDC_DECIMALS))),
    asset: USDC_TESTNET,
    payTo: item.payTo,
    network: NETWORK,
    issued: Date.now(),
    expires: Date.now() + QUOTE_TTL_MS,
  };
  quotes.set(q.id, q);
  return q;
}

const isUsdc = (coinType: string) => {
  const t = coinType.toLowerCase();
  return t.includes(PKG) && t.includes("usdc");
};

export type Verdict = { ok: true } | { ok: false; why: string };

/**
 * Everything the index insists on before it hands over a fact, written against the
 * transaction exactly as the chain read it. Split out from the read so the refusals
 * can be tested one fake transfer at a time instead of by moving real money.
 */
export function verdict(quote: Quote, proof: Settled, spent: Record<string, Sale>): Verdict {
  if (proof.status !== "SUCCESS") return { ok: false, why: `that transaction ended ${proof.status}` };

  // The price being judged against is the one written on the quote, because a link can
  // be priced by whoever wrote it. Reading the environment here would let a two cent
  // note be released for one cent whenever the index's own price differs from the ask.
  const need = BigInt(quote.baseUnits);
  const arrived = proof.changes.find((c) => isUsdc(c.coinType) && c.amount >= need && c.address.toLowerCase() === quote.payTo.toLowerCase());
  if (!arrived) return { ok: false, why: `nothing worth ${quote.usdc} USDC reached the payout address in that transaction` };

  // Matching the debit too stops a payment that merely touched the index being
  // read as this buyer's payment.
  const left = proof.changes.find(
    (c) => isUsdc(c.coinType) && c.amount === -arrived.amount && c.address.toLowerCase() === quote.payer.toLowerCase(),
  );
  if (!left) return { ok: false, why: "that money did not leave the wallet asking to be charged" };

  if (spent[proof.digest]) return { ok: false, why: "that receipt was already spent on an earlier lookup" };
  return { ok: true };
}

/**
 * The index does not take a word for it. It re-reads the claimed transaction from
 * the chain and only then hands over the fact, because the thing reporting a
 * digest is a client, and a client is allowed to lie.
 */
async function check(quote: Quote, digest: string): Promise<{ ok: true } | { ok: false; why: string; unreadable?: true }> {
  let proof: Awaited<ReturnType<typeof transactionAt>>;
  try {
    proof = await waitForTransaction(digest, "testnet");
  } catch {
    // The chain read failing is the index refusing to take a word for it, not a fault
    // in the buyer's money, so the provider's own wording never goes further and the
    // buyer is told to come back rather than to pay again.
    return { ok: false, why: `the chain cannot read ${digest.slice(0, 12)}… right now`, unreadable: true };
  }
  if (!proof) return { ok: false, why: `no transaction ${digest.slice(0, 12)}… exists on testnet` };
  return verdict(quote, proof, ledger().receipts);
}

/**
 * One endpoint, two stages, exactly like a 402 exchange: the same request comes
 * back once with a price and once more with a receipt attached.
 */
export async function sell(body: {
  resource?: string;
  payer?: string;
  quote?: string;
  receipt?: string;
}): Promise<{ http: number; body: unknown }> {
  const payer = String(body.payer ?? "");
  if (!ADDRESS.test(payer)) return { http: 400, body: { error: "payer must be a full 0x Sui address" } };

  // A redeem carries the quote instead of the resource, so the two stages have to
  // resolve to the same thing before anything is checked.
  let resource = "";
  if (body.resource) {
    const raw = String(body.resource);
    // Junk arrives over HTTP, so a malformed address is an answer rather than a crash:
    // a thrown error here would take the whole endpoint down for one bad request.
    try {
      resource = (/^(identity|note):/.test(raw) ? raw : resourceId(raw)).toLowerCase();
    } catch (err) {
      return { http: 400, body: { error: (err as Error).message } };
    }
  } else if (body.quote) {
    // The quote may have left memory with the payment already made, so the journal is
    // searched too rather than sending a paid buyer away.
    const id = String(body.quote);
    const held = quotes.get(id) ?? Object.values(ledger().stuck).find((s) => s.quote.id === id)?.quote;
    if (!held) return { http: 400, body: { error: "that quote is gone. Ask for the lookup again" } };
    resource = held.resource;
  } else {
    return { http: 400, body: { error: "tell the index which address you want a name for" } };
  }

  let parsed: Resource;
  try {
    parsed = parseResource(resource);
  } catch (err) {
    return { http: 400, body: { error: (err as Error).message } };
  }

  const item = listing(parsed);
  if ("missing" in item) {
    return { http: 404, body: { error: item.missing, resource } };
  }

  // A link that pays the same wallet asking to open it would settle into itself and
  // leave nothing on the chain to point at, so the degenerate case is refused rather
  // than judged by a rule that can never see it pass.
  if (parsed.kind === "note" && item.payTo.toLowerCase() === payer.toLowerCase()) {
    return { http: 400, body: { error: "that link pays the wallet trying to open it, so no money would ever move" } };
  }

  prune();
  const l = ledger();
  const sold = l.sold[saleKey(payer, resource)];
  if (sold) {
    // A receipt that arrived after the fact was already released has done its job, so
    // it is cleared rather than kept as money the buyer might be asked to pay again.
    const key = saleKey(payer, resource);
    if (l.stuck[key]) {
      delete l.stuck[key];
      saveLedger(l);
    }
    // charged is what this ask costs and paid_then is what the receipt cost, so a
    // memory written from a free answer can still say honestly how much was spent.
    return {
      http: 200,
      body: {
        fact: item.fact,
        resource,
        charged: 0,
        paid_then: sold.usdc,
        paid_on: sold.at,
        tx: sold.digest,
        reason: `already bought on ${sold.at}`,
      },
    };
  }

  if (!body.receipt) {
    const q = newQuote(resource, payer.toLowerCase(), item);
    return {
      http: 402,
      body: {
        error: "payment required",
        resource,
        accepts: [
          {
            scheme: "sui-usdc",
            network: q.network,
            amount: q.baseUnits,
            asset: q.asset,
            payTo: q.payTo,
            memo: item.memo,
          },
        ],
        quote: q,
        expires: new Date(q.expires).toISOString(),
        instructions: "pay the amount to payTo on testnet, then resend this request with the transaction digest",
      },
    };
  }

  // A quote lives in memory, so a restart would strand a payment that was already
  // made. The stuck journal is the same quote written to disk for exactly that case.
  const q = (body.quote ? quotes.get(String(body.quote)) : undefined) ?? l.stuck[saleKey(payer, resource)]?.quote;
  if (!q) return { http: 400, body: { error: "that quote is gone. Ask for the lookup again" } };
  if (q.payer.toLowerCase() !== payer.toLowerCase()) {
    return { http: 400, body: { error: "that quote was issued to a different wallet" } };
  }

  const digest = String(body.receipt);
  const ruling = await check(q, digest);
  if (!ruling.ok) {
    // Expiry is only ever an excuse to reprice an *unpaid* quote. Once the money has
    // verifiably moved on the agreed terms the price was already agreed, so the fact
    // is released rather than the wallet being told its receipt was too late.
    if (ruling.unreadable) return { http: 503, body: { error: ruling.why, quote: q } };
    if (q.expires < Date.now()) {
      return { http: 402, body: { error: `${ruling.why}, and the quote for it has expired`, quote: newQuote(q.resource, q.payer, item) } };
    }
    return { http: 402, body: { error: ruling.why, quote: q } };
  }

  const sale: Sale = { resource, payer: q.payer, digest, usdc: q.usdc, at: new Date().toISOString().slice(0, 10) };
  l.receipts[digest] = sale;
  l.sold[saleKey(q.payer, resource)] = sale;
  delete l.stuck[saleKey(q.payer, resource)];
  saveLedger(l);
  quotes.delete(q.id);

  return { http: 200, body: { fact: item.fact, resource, charged: q.usdc, tx: digest, paid_to: q.payTo } };
}

/** One round trip to the index, with the HTTP status kept. */
async function ask(payload: Record<string, unknown>): Promise<{ code: number; body: any }> {
  const res = await fetch(SOURCE_URL, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(payload),
  });
  return { code: res.status, body: (await res.json()) as any };
}

export type Price =
  | { quote: Quote }
  | { free: true; fact: Fact; reason: string; tx: string; paid: number; on: string }
  | { error: string };

/** What a lookup would cost this wallet, before anybody has spent anything. */
export async function price(resource: string, payer: string): Promise<Price> {
  const first = await ask({ resource, payer });
  if (first.code === 200) {
    return {
      free: true,
      fact: first.body.fact,
      reason: first.body.reason,
      tx: first.body.tx,
      paid: Number(first.body.paid_then ?? 0),
      on: String(first.body.paid_on ?? ""),
    };
  }
  if (first.code === 402) return { quote: first.body.quote };
  return { error: first.body?.error ?? `the index answered ${first.code}` };
}

export type Release = { fact: Fact; usdc: number; tx: string; reason: string; on: string } | { error: string };

/** The second half of the handshake, after the money has moved. */
export async function redeem(resource: string, payer: string, quoteId: string, digest: string): Promise<Release> {
  const res = await ask({ resource, payer, quote: quoteId, receipt: digest });
  if (res.code !== 200) {
    if (res.code === 402) return { error: res.body?.error ?? "the index refused that receipt" };
    return { error: res.body?.error ?? `the index answered ${res.code}` };
  }
  // A receipt replayed onto a fact the index already released answers with charged 0
  // and the earlier price alongside it. The number written into memory has to be the
  // one that moved, or the agent grows a record that claims an answer was free.
  const charged = Number(res.body.charged ?? 0);
  return {
    fact: res.body.fact,
    usdc: charged || Number(res.body.paid_then ?? 0),
    tx: charged ? digest : res.body.tx || digest,
    reason: charged ? "bought" : res.body.reason ?? "already bought",
    on: String(res.body.paid_on ?? ""),
  };
}

export type Purchase =
  | { usdc: number; fact: Fact; resource: string; reason: string; tx: string; on: string }
  | { error: string; resource: string };

/**
 * Ask, get priced, pay, come back. The buyer never sends money before the source
 * has named a price and a payout address in the same reply.
 */
export async function buy(resource: string, payer: string, pay: (q: Quote) => Promise<{ digest: string }>): Promise<Purchase> {
  const first = await price(resource, payer);
  if ("error" in first) return { error: first.error, resource };
  if ("free" in first) {
    return { usdc: first.paid, fact: first.fact, resource, reason: first.reason, tx: first.tx, on: first.on };
  }

  const key = saleKey(payer, resource);
  // Money that left without releasing the fact is offered that same receipt again
  // before any new money moves. Paying twice for one answer is the failure this
  // build has to make impossible.
  const stuck = ledger().stuck[key];
  const q = stuck?.quote ?? first.quote;
  let digest: string;
  if (stuck) {
    digest = stuck.digest;
  } else {
    digest = (await pay(q)).digest;
    notePayment(q, digest);
  }

  const released = await redeem(resource, payer, q.id, digest);
  if ("error" in released) {
    // The money moved and the fact did not arrive. Saying so out loud is the whole
    // point, because it is the case a quiet client would pretend never happened.
    // The amount named is the one on the quote that was paid, not the index's own
    // price, because a link can be priced by whoever wrote it.
    const moved = Number(q.baseUnits) / 10 ** USDC_DECIMALS;
    return {
      error: `${released.error}. ${moved} USDC moved as ${digest.slice(0, 12)}… and nothing came back. Ask again and it retries that receipt rather than paying twice`,
      resource,
    };
  }
  return { usdc: released.usdc, fact: released.fact, resource, reason: released.reason, tx: released.tx, on: released.on };
}

/**
 * A fact the agent paid for is written as a name it will find next time. That
 * write is the entire economics of the product: the same question asked again is
 * answered from memory and costs nothing.
 */
export async function record(fact: Fact, address: string, usdc: number, digest: string, on?: string) {
  // The day in the note is the day the money moved. An answer released on an older
  // receipt has to keep saying so, or the memory claims a payment for today.
  const day = on || new Date().toISOString().slice(0, 10);
  const cost = usdc > 0 ? `Bought for ${usdc} USDC from the paid index on ${day}, tx ${digest}` : `Named by the paid index on ${day}, nothing charged, tx ${digest}`;
  const note = `${fact.kind.toLowerCase()}, ${fact.note}. ${cost}`;
  return labelPerson(fact.name, address, note);
}

let indexNamed = false;

/**
 * The payout address shows up in the history the moment anything is bought, so it
 * gets named first. An unexplained debit is the thing that makes people suspicious.
 */
export async function nameTheIndex(): Promise<void> {
  if (indexNamed) return;
  const wallet = sellerWallet();
  if (await personForAddress(wallet)) {
    indexNamed = true;
    return;
  }
  await labelPerson(
    "Paid address index",
    wallet,
    `a lookup service, costs ${PRICE_USDC} USDC each time the agent has never seen an address before`,
  );
  indexNamed = true;
}

/** What the buyer has spent, so the interface can show a running figure. */
export function purchases(payer: string): Sale[] {
  const key = payer.toLowerCase();
  return Object.values(ledger().sold).filter((s) => s.payer.toLowerCase() === key);
}

/**
 * How many wallets have paid to open one resource. The journal is the only counter
 * on purpose: a number written beside the note would be a second record of the same
 * money, and two records of one payment is how a receipt gets invented.
 */
export function salesOf(resource: string): Sale[] {
  const want = resource.toLowerCase();
  return Object.values(ledger().sold).filter((s) => s.resource.toLowerCase() === want);
}

export function totalSpent(payer: string): number {
  return purchases(payer).reduce((s, x) => s + x.usdc, 0);
}
