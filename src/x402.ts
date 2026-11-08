import "dotenv/config";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { USDC_DECIMALS, signUsdc } from "./wallet.js";
import { PAY_CHAIN, PAY_NET, USDC_ASSET, USDC_COIN, type Net } from "./chain.js";
import { recallAbout, remember } from "./memory.js";
import { labelPerson, personForAddress } from "./people.js";
import { scope } from "./scope.js";
import { session } from "./session.js";
import { canonical, parseResource, type Fact } from "./resources.js";
import {
  HEADER_REQUIRED,
  HEADER_RESPONSE,
  HEADER_SIGNATURE,
  baseToAmount,
  decodeHeader,
  encodeHeader,
  envelopeFromSigned,
  openEnvelope,
  sameVersion,
  type PaymentPayload,
  type PaymentRequired,
  type PaymentRequirements,
  type SettlementResponse,
} from "./x402wire.js";

/**
 * The buyer half of x402. It never calls the seller's code: the two talk over HTTP,
 * the price arrives in a PAYMENT-REQUIRED header, and the payment leaves in a
 * PAYMENT-SIGNATURE header carrying the bytes this wallet actually signed.
 *
 * The old version trusted a JSON body and posted a digest after executing the transfer
 * itself. That made the "seller" a local function call and the wire format a private
 * convention. There is no digest path here on purpose.
 */

const SOURCE_URL = process.env.PAID_SOURCE_URL ?? "http://127.0.0.1:8788/paid";
const LEDGER_FILE = new URL("../.paid.json", import.meta.url).pathname;
const NETWORK = PAY_CHAIN;
const ADDRESS = /^0x[0-9a-fA-F]{64}$/;

export type Sale = { resource: string; payer: string; digest: string; usdc: number; at: string; network?: Net };
type Stuck = { resource: string; payer: string; envelope: string; at: string; network?: Net };
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

function save(l: Ledger): void {
  writeFileSync(LEDGER_FILE, JSON.stringify(l, null, 1));
}

const saleKey = (payer: string, resource: string) => `${payer.toLowerCase()}|${canonical(resource)}`;

/*
 * A purchase and a signed envelope both belong to the ledger they were made on. Keyed
 * without the network, a testnet envelope left stuck was replayed against the mainnet
 * index on every later ask and refused there forever, and testnet spend was counted in
 * the mainnet totals.
 *
 * A row written before the network was recorded is read as testnet, which is where the
 * rows in this ledger were made and the only guess that cannot count testnet dust as
 * mainnet spend. A genuine mainnet purchase from the old format would look unproven on
 * mainnet and could be charged once more. That is the safe direction: a second charge
 * is recoverable, while a mainnet fact released for testnet dust is not.
 */
const LEGACY_NET: Net = "testnet";
const netKey = (net: Net, payer: string, resource: string) => `${net}|${saleKey(payer, resource)}`;
const rowNet = (r: { network?: Net }): Net => r.network ?? LEGACY_NET;

function stuckOn(l: Ledger, net: Net, payer: string, resource: string): { key: string; row: Stuck } | null {
  const fresh = netKey(net, payer, resource);
  if (l.stuck[fresh]) return { key: fresh, row: l.stuck[fresh] };
  const legacy = saleKey(payer, resource);
  const old = l.stuck[legacy];
  return old && rowNet(old) === net ? { key: legacy, row: old } : null;
}

/** The headline price the pages quote. A busy wallet can be priced above this. */
export function priceUsdc(): number {
  return Number(process.env.SELLER_PRICE_USDC ?? "0.01");
}

/** The most this buyer will pay for one fact. A higher quote is refused, not paid. */
export function priceCeiling(): number {
  return Number(process.env.PAID_MAX_USDC ?? "0.02");
}

/** The refusal is a decision, not a fault, so it is a sentence the agent can say. */
export function overCeiling(usdc: number): string | null {
  if (usdc <= priceCeiling()) return null;
  return `the index asks ${usdc} USDC for this answer and my ceiling for one answer is ${priceCeiling()} USDC, so I did not pay it. Raise PAID_MAX_USDC if you mean to go above that`;
}

export function sellerWallet(): string {
  const w = process.env.SELLER_WALLET ?? "";
  if (!ADDRESS.test(w)) {
    throw new Error("the paid index has no payout address. Set SELLER_WALLET to a full 0x Sui address");
  }
  return w;
}

export function indexPayout(): string {
  return process.env.SELLER_WALLET ?? "";
}

export type Price =
  | { requirements: PaymentRequirements; usdc: number }
  | { free: true; fact: Fact; reason: string; tx: string; paid: number; on: string }
  | { error: string; refusal?: true };

function parseRequirements(header: string, net: Net = PAY_NET): PaymentRequirements {
  const chain = `sui:${net}`;
  const required = decodeHeader<PaymentRequired>(header);
  if (!sameVersion(required.x402Version)) throw new Error("the index published a price in an x402 version this client does not speak");
  const req = required.accepts?.find((a) => a.scheme === "exact" && a.network === chain);
  if (!req) throw new Error(`the index published no exact-scheme price for ${chain}`);
  if (String(req.asset) !== USDC_COIN[net]) throw new Error(`the index priced the answer in a coin that is not ${chain} USDC`);
  if (!ADDRESS.test(String(req.payTo ?? ""))) throw new Error("the index named no payout address in its terms");
  if (!/^\d+$/.test(String(req.amount ?? "")) || BigInt(req.amount) <= 0n) {
    throw new Error("the index named no amount in base units in its terms");
  }
  return req;
}

/**
 * What one answer costs this wallet, before anything is signed. A 200 means the seller
 * already sold this resource to this wallet; a 402 must carry the standard header or it
 * is not x402 and the buyer will not guess at a private shape.
 */
export async function price(resource: string, payer: string, net: Net = PAY_NET): Promise<Price> {
  let res: Response;
  try {
    res = await fetch(`${SOURCE_URL}?resource=${encodeURIComponent(resource)}&payer=${encodeURIComponent(payer)}&network=${encodeURIComponent(net)}`);
  } catch (err) {
    return { error: `the paid index is not answering at ${SOURCE_URL}: ${String((err as Error)?.message ?? err).slice(0, 160)}` };
  }
  const body = (await res.json().catch(() => ({}))) as any;
  if (res.status === 200) {
    return {
      free: true,
      fact: body.fact,
      reason: String(body.reason ?? "already bought"),
      tx: String(body.tx ?? ""),
      paid: Number(body.paid_then ?? body.charged ?? 0),
      on: String(body.paid_on ?? ""),
    };
  }
  if (res.status === 402) {
    const header = res.headers.get(HEADER_REQUIRED);
    if (!header) {
      return { error: "the index answered 402 without a PAYMENT-REQUIRED header, so this is not x402 and I did not pay" };
    }
    try {
      const requirements = parseRequirements(header, net);
      return { requirements, usdc: baseToAmount(requirements.amount) };
    } catch (err) {
      return { error: (err as Error).message };
    }
  }
  return { error: String(body?.error ?? `the index answered ${res.status}`) };
}

export type Release =
  | { fact: Fact; usdc: number; tx: string; reason: string; on: string }
  | { error: string };

/**
 * The second half. The envelope is the buyer's own signed transaction, untouched by
 * this server, and the seller's facilitator decides whether it settles.
 */
export async function settleEnvelope(resource: string, payer: string, envelope: string, net: Net = PAY_NET): Promise<Release> {
  const payload: PaymentPayload = {
    x402Version: 2,
    scheme: "exact",
    network: `sui:${net}` as "sui:testnet" | "sui:mainnet",
    payload: { transaction: envelope },
  };
  let res: Response;
  try {
    res = await fetch(`${SOURCE_URL}?resource=${encodeURIComponent(resource)}&network=${encodeURIComponent(net)}`, {
      method: "POST",
      headers: { "content-type": "application/json", [HEADER_SIGNATURE]: encodeHeader(payload) },
      body: JSON.stringify({ resource, network: net }),
    });
  } catch (err) {
    return { error: `the signed payment could not reach the index: ${String((err as Error)?.message ?? err).slice(0, 160)}` };
  }
  const body = (await res.json().catch(() => ({}))) as any;
  const header = res.headers.get(HEADER_RESPONSE);
  let settled: SettlementResponse | null = null;
  if (header) {
    try {
      settled = decodeHeader<SettlementResponse>(header);
    } catch {
      return { error: "the index sent a PAYMENT-RESPONSE header this client could not read" };
    }
  }
  if (settled && !settled.success) {
    return { error: settled.errorReason ?? "the facilitator refused that payment" };
  }
  // A receipt that names another ledger is not a receipt for this payment. Without
  // this, an index could answer a mainnet signature with a testnet settlement.
  if (settled?.network && settled.network !== `sui:${net}`) {
    return { error: `the index says that payment settled on ${settled.network}, not sui:${net}, so it did not settle the transfer this wallet signed` };
  }
  if (res.status !== 200) {
    return { error: String(body?.error ?? `the index answered ${res.status}`) };
  }
  if (!body?.fact) return { error: "the index settled something but sent no fact" };
  const charged = Number(body.charged ?? 0);
  return {
    fact: body.fact,
    usdc: charged || Number(body.paid_then ?? 0),
    tx: String(settled?.transaction ?? body.tx ?? ""),
    reason: charged ? "bought" : String(body.reason ?? "already bought"),
    on: String(body.paid_on ?? ""),
  };
}

export type Purchase =
  | { usdc: number; fact: Fact; resource: string; reason: string; tx: string; on: string }
  | { error: string; resource: string; refusal?: true };

function recordSale(resource: string, payer: string, released: Exclude<Release, { error: string }>, net: Net = PAY_NET): void {
  const l = ledger();
  const sale: Sale = {
    resource,
    payer,
    digest: released.tx,
    usdc: released.usdc,
    at: new Date().toISOString().slice(0, 10),
    network: net,
  };
  l.sold[netKey(net, payer, resource)] = sale;
  if (released.tx) l.receipts[released.tx] = sale;
  delete l.stuck[netKey(net, payer, resource)];
  const legacy = l.stuck[saleKey(payer, resource)];
  if (legacy && rowNet(legacy) === net) delete l.stuck[saleKey(payer, resource)];
  save(l);
}

/**
 * A payment the browser wallet already signed, handed to the seller without being
 * executed anywhere else. The envelope is journalled before the POST for the same
 * reason the agent's own signature is: a process that dies after the money settles and
 * before the fact is read must retry the same signature, never sign a second one.
 */
export async function settleSigned(resource: string, payer: string, bytes: string, signature: string, net: Net = PAY_NET): Promise<Release> {
  let envelope: string;
  let sender: string;
  try {
    envelope = envelopeFromSigned(bytes, signature);
    sender = openEnvelope(envelope).sender;
  } catch (err) {
    return { error: `that signature could not be wrapped as a Sui payment: ${String((err as Error)?.message ?? err)}` };
  }
  if (sender.toLowerCase() !== payer.toLowerCase()) {
    return { error: "the signed transfer came from a different wallet than the one this payment was prepared for" };
  }
  const l = ledger();
  l.stuck[netKey(net, payer, resource)] = { resource, payer, envelope, at: new Date().toISOString(), network: net };
  save(l);
  const released = await settleEnvelope(resource, payer, envelope, net);
  if ("error" in released) return released;
  recordSale(resource, payer, released, net);
  return released;
}

/**
 * A signed payment from an earlier ask that never got its answer. Tried before anything
 * new is prepared, so a lost response cannot cost this wallet a second transfer.
 */
export async function retryStuck(resource: string, payer: string, net: Net = PAY_NET): Promise<Release | null> {
  const stuck = stuckOn(ledger(), net, payer, resource);
  if (!stuck) return null;
  const released = await settleEnvelope(resource, payer, stuck.row.envelope, net);
  if ("error" in released) return released;
  recordSale(resource, payer, released, net);
  return released;
}

/**
 * Ask, get priced, check the ceiling, sign, hand the signed bytes over. The wallet does
 * not execute the transfer: the facilitator broadcasts the exact bytes after checking
 * that they pay the published terms.
 */
export async function buy(resource: string, payer: string): Promise<Purchase> {
  // The agent's own key can only sign on the ledger this build pays on, and a fact is
  // about the ledger it was read from. Buying while the page reads the other one would
  // charge on one chain and remember an answer about the other.
  if (session().network !== PAY_NET) {
    return {
      error: `the agent's own key pays on ${PAY_CHAIN} and this page is reading sui:${session().network}, so it will not buy a fact that belongs to the other ledger. Move the switch to ${PAY_NET} first, or connect a wallet to pay from this page`,
      resource,
    };
  }
  const quoted = await price(resource, payer, PAY_NET);
  if ("error" in quoted) return { error: quoted.error, resource };
  if ("free" in quoted) {
    return { usdc: quoted.paid, fact: quoted.fact, resource, reason: quoted.reason, tx: quoted.tx, on: quoted.on };
  }

  const refused = overCeiling(quoted.usdc);
  if (refused) return { error: refused, resource, refusal: true };

  const stuck = stuckOn(ledger(), PAY_NET, payer, resource);
  let envelope = stuck?.row.envelope ?? "";
  if (!envelope) {
    try {
      const signed = await signUsdc(quoted.requirements.payTo, BigInt(quoted.requirements.amount));
      envelope = envelopeFromSigned(signed.bytes, signed.signature);
    } catch (err) {
      return { error: String((err as Error)?.message ?? err), resource };
    }
    // Written before the POST, because a process that dies after the money settles and
    // before it reads the fact must be able to retry the same signature, not sign again.
    const l = ledger();
    l.stuck[netKey(PAY_NET, payer, resource)] = { resource, payer, envelope, at: new Date().toISOString(), network: PAY_NET };
    save(l);
  }

  const released = await settleEnvelope(resource, payer, envelope, PAY_NET);
  if ("error" in released) {
    return {
      error: `${released.error}. The signed payment is kept, so asking again retries the same signature instead of paying twice`,
      resource,
    };
  }

  recordSale(resource, payer, released, PAY_NET);
  return { usdc: released.usdc, fact: released.fact, resource, reason: released.reason, tx: released.tx, on: released.on };
}

/**
 * A profile is bought as arithmetic, not as a name, so it is written as the sentence it
 * is. Naming a wallet requires a person to have told us the name, and paying an index
 * does not produce one.
 */
export async function learn(
  resource: string,
  fact: Fact,
  usdc: number,
  digest: string,
  on?: string,
): Promise<{ name: string; note: string }> {
  const parsed = parseResource(resource);
  const day = on || new Date().toISOString().slice(0, 10);
  const cost = usdc > 0 ? `bought for ${usdc} USDC on ${day}` : `nothing charged, already owned on ${day}`;
  if (parsed.kind === "profile") {
    const text = `Chain profile for ${parsed.address}: ${fact.note}. ${cost}, tx ${digest}`;
    await remember(text);
    return { name: parsed.address, note: text };
  }
  const text = `${fact.kind} for ${fact.name}: ${fact.note}. ${cost}, tx ${digest}`;
  await remember(text);
  return { name: fact.name, note: text };
}

/**
 * Memory is read before the price so a profile this wallet already holds is never
 * bought twice. The address is matched literally, because recall on a 64 character hex
 * string has a thin margin and a near miss must not be read as a purchase.
 */
export async function knownProfile(address: string): Promise<string | null> {
  const want = `Chain profile for ${address.toLowerCase()}:`;
  try {
    const rows = await recallAbout(address.toLowerCase());
    return rows.find((r) => r.text.toLowerCase().startsWith(want.toLowerCase()))?.text ?? null;
  } catch {
    return null;
  }
}

const indexNamed = new Set<string>();

/**
 * The payout address shows up in the history the moment anything is bought, so it gets
 * named first. An unexplained debit is the thing that makes people suspicious. Memory is
 * kept per wallet and per ledger, so the name is written once into each of those rather
 * than once for the life of the process.
 */
export async function nameTheIndex(): Promise<void> {
  const where = scope("people");
  if (indexNamed.has(where)) return;
  const wallet = sellerWallet();
  if (await personForAddress(wallet)) {
    indexNamed.add(where);
    return;
  }
  await labelPerson(
    "Paid chain index",
    wallet,
    `a service that sells arithmetic over public sui:${session().network} history, costs ${priceUsdc()} USDC for a profile and the same for a chain check, and the answer is kept so it is only paid for once`,
  );
  indexNamed.add(where);
}

/** What the buyer has spent, so the interface can show a running figure. One ledger when asked. */
export function purchases(payer: string, net?: Net): Sale[] {
  const key = payer.toLowerCase();
  return Object.values(ledger().sold).filter((s) => s.payer.toLowerCase() === key && (!net || rowNet(s) === net));
}

export function totalSpent(payer: string, net?: Net): number {
  return purchases(payer, net).reduce((s, x) => s + x.usdc, 0);
}
