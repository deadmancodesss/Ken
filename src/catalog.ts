import "dotenv/config";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { PAY_CHAIN, PAY_NET, USDC_COIN, coinDecimals, coinName, formatAmount, short, transactionAt, type Net } from "./chain.js";
import { note } from "./notes.js";
import { personForAddress } from "./people.js";
import { profileOf, profileNote } from "./profile.js";
import { canonical, parseResource, type Fact, type Resource } from "./resources.js";
import {
  openEnvelope,
  paymentRequired,
  requirementsFor,
  type PaymentRequirements,
  type PaymentRequired,
  type SettlementResponse,
} from "./x402wire.js";
import { USDC_DECIMALS } from "./wallet.js";

/**
 * The seller half of the paywall. Nothing in this file pays, signs or holds a key. It
 * answers with a price, then releases one fact once a facilitator has settled the
 * buyer's own signed transaction.
 *
 * It started life as an invented catalogue of businesses. That was a recording, not a
 * product: the seller could invent the answer and the buyer had no way to check it.
 * A profile is arithmetic over public chain history, so the buyer can recompute the
 * sentence from the same chain the seller read.
 */

const BASE_PRICE = Number(process.env.SELLER_PRICE_USDC ?? "0.01");
const BUSY_PRICE = Number(process.env.SELLER_BUSY_PRICE_USDC ?? "0.03");
const BUSY_TXS = Number(process.env.SELLER_BUSY_TXS ?? "20");
const LEDGER_FILE = process.env.SELLER_LEDGER ?? new URL("../.seller.json", import.meta.url).pathname;
const NETWORK = PAY_CHAIN;
const ADDRESS = /^0x[0-9a-fA-F]{64}$/;

export type Sale = { resource: string; payer: string; digest: string; usdc: number; at: string; network?: Net };
type SettledEnvelope = { resource: string; payer: string; digest: string; at: string; network?: Net };
type Ledger = { sold: Record<string, Sale>; envelopes: Record<string, SettledEnvelope> };

function read(): Ledger {
  const empty: Ledger = { sold: {}, envelopes: {} };
  if (!existsSync(LEDGER_FILE)) return empty;
  try {
    return { ...empty, ...(JSON.parse(readFileSync(LEDGER_FILE, "utf8")) as Ledger) };
  } catch {
    return empty;
  }
}

function write(l: Ledger): void {
  writeFileSync(LEDGER_FILE, JSON.stringify(l, null, 1));
}

const saleKey = (payer: string, resource: string) => `${payer.toLowerCase()}|${canonical(resource)}`;

/*
 * A sale is money that settled on one ledger, so it can only ever answer for that
 * ledger. The key used to be payer and resource alone, which meant a profile paid for
 * in testnet dust was handed out for free on mainnet. New sales carry the network in
 * the key.
 *
 * A row written before the network was recorded has no ledger to consult. It is read
 * as testnet, which is the only guess that cannot hand a mainnet fact to somebody who
 * paid testnet dust. A genuine mainnet sale from the old format would have to be paid
 * once more, and charging twice is recoverable where giving the fact away is not.
 */
const LEGACY_NET: Net = "testnet";
const netSaleKey = (net: Net, payer: string, resource: string) => `${net}|${saleKey(payer, resource)}`;
const saleNet = (s: Sale): Net => s.network ?? LEGACY_NET;

function soldOn(l: Ledger, net: Net, payer: string, resource: string): Sale | undefined {
  const fresh = l.sold[netSaleKey(net, payer, resource)];
  if (fresh) return fresh;
  const legacy = l.sold[saleKey(payer, resource)];
  return legacy && saleNet(legacy) === net ? legacy : undefined;
}

const envKey = (net: Net, fingerprint: string) => `${net}|${fingerprint}`;

function envelopeOn(l: Ledger, net: Net, fingerprint: string): SettledEnvelope | undefined {
  const fresh = l.envelopes[envKey(net, fingerprint)];
  if (fresh) return fresh;
  const legacy = l.envelopes[fingerprint];
  return legacy && (legacy.network ?? LEGACY_NET) === net ? legacy : undefined;
}

export function sellerPrice(): number {
  return BASE_PRICE;
}

export function busyPrice(): number {
  return BUSY_PRICE;
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

/**
 * A wallet with a long history is more work to summarise, and the seller pays Tatum for
 * every page it reads. The threshold is published in the 402 reply so the buyer sees
 * the reason for the number rather than a price that moved on its own.
 */
export function tierPrice(txs: number): number {
  return txs > BUSY_TXS ? BUSY_PRICE : BASE_PRICE;
}

export function busyThreshold(): number {
  return BUSY_TXS;
}

type Found = { usdc: number; payTo: string; description: string; reveal: () => Promise<Fact> };
type Listing = Found | { missing: string };

/** The chain's own words about one transaction, in the shape a memory is written from. */
export async function readReceipt(digest: string, net: Net = PAY_NET): Promise<Fact> {
  const chain = `sui:${net}`;
  const proof = await transactionAt(digest, net);
  const checked = new Date().toISOString().slice(0, 10);
  if (!proof) {
    return {
      name: digest,
      kind: "Chain receipt",
      note: `Nothing with that digest exists on ${chain}, checked ${checked}`,
    };
  }

  // Balance changes are per coin object, so one wallet that moved 1 USDC in two coins
  // appears twice. Summing by wallet and coin is what makes the sentence true.
  const perWallet = new Map<string, Map<string, bigint>>();
  for (const c of proof.changes) {
    if (c.amount === 0n) continue;
    const coins = perWallet.get(c.address) ?? new Map<string, bigint>();
    coins.set(c.coinType, (coins.get(c.coinType) ?? 0n) + c.amount);
    perWallet.set(c.address, coins);
  }
  const moved: string[] = [];
  for (const [address, coins] of perWallet) {
    for (const [coinType, amount] of coins) {
      const out = amount < 0n;
      const who = (await personForAddress(address))?.alias ?? short(address);
      moved.push(
        `${who} ${out ? "sent" : "received"} ${formatAmount(out ? -amount : amount, await coinDecimals(coinType, net))} ${coinName(coinType)}`,
      );
    }
  }
  const tail = moved.length > 6 ? ` and ${moved.length - 6} more` : "";
  const legs = moved.slice(0, 6).join(", ");
  return {
    name: digest,
    kind: "Chain receipt",
    note: `On ${chain} that transaction ended ${proof.status}${proof.timestamp ? ` on ${proof.timestamp.slice(0, 10)}` : ""}. It moved ${legs}${tail}. Checked ${checked}`,
  };
}

function listing(resource: Resource, net: Net = PAY_NET): Listing {
  const chain = `sui:${net}`;
  if (resource.kind === "note") {
    const n = note(resource.id);
    if (!n) return { missing: `no link ${resource.id} is open here` };
    const fact: Fact = { name: n.title, kind: n.blob ? "Memory line" : "Note", note: n.body };
    return {
      usdc: n.usdc,
      payTo: n.pay_to,
      description: n.blob ? `a memory line, "${n.title}"` : `note "${n.title}"`,
      reveal: async () => fact,
    };
  }
  if (resource.kind === "receipt") {
    return {
      usdc: BASE_PRICE,
      payTo: sellerWallet(),
      description: `chain check of transaction ${resource.digest.slice(0, 12)}… on ${chain}`,
      reveal: () => readReceipt(resource.digest, net),
    };
  }
  return {
    usdc: BASE_PRICE,
    payTo: sellerWallet(),
    description: `a chain profile of ${short(resource.address)} on ${chain}`,
    // The price tier needs the count, so the profile is read before the paywall goes
    // up. The paid request reads it again, because a fact that changed between the
    // price and the payment is not the fact the buyer agreed to.
    reveal: async () => {
      const p = await profileOf(resource.address, 40, net);
      return { name: p.address, kind: "Chain profile", note: profileNote(p, net) };
    },
  };
}

/** The profile is read once to price it, and that same read is what the payer buys. */
async function profileListing(address: string, net: Net = PAY_NET): Promise<Found> {
  const chain = `sui:${net}`;
  const p = await profileOf(address, 40, net);
  return {
    usdc: tierPrice(p.txs),
    payTo: sellerWallet(),
    description: `a chain profile of ${short(address)} on ${chain}, ${p.txs} transactions in the window`,
    reveal: async () => ({ name: p.address, kind: "Chain profile", note: profileNote(p, net) }),
  };
}

export type SellInput = {
  resource?: string;
  payer?: string;
  /** The base64 SenderSignedTransaction a standard client put in PAYMENT-SIGNATURE. */
  envelope?: string;
  /** A bare digest is read as a receipt, which is how a person asks about a payment. */
  receipt?: string;
  network?: Net;
};

export type SellDeps = {
  settle?: (input: {
    x402Version: number;
    paymentPayload: string;
    paymentRequirements: PaymentRequirements;
  }) => Promise<SettlementResponse>;
};

export type SellAnswer = {
  http: number;
  headers: Record<string, string>;
  body: unknown;
};

const HEADER_REQUIRED = "payment-required";
const HEADER_RESPONSE = "payment-response";

function requiredHeader(required: PaymentRequired): Record<string, string> {
  return { [HEADER_REQUIRED]: Buffer.from(JSON.stringify(required), "utf8").toString("base64") };
}

/**
 * A resource that nobody can pay, because the buyer and the seller are the same wallet,
 * is refused rather than settled into itself. The facilitator would see a debit and a
 * credit on one address and the money would never move.
 */
function selfDeal(payTo: string, payer: string): boolean {
  return payTo.toLowerCase() === payer.toLowerCase();
}

/**
 * One HTTP exchange: raise the wall, or lower it for a settled payment. `deps.settle`
 * is injected so the release rules can be tested against a settlement that never
 * happened, without a chain and without moving money.
 */
export async function sell(input: SellInput, deps: SellDeps = {}): Promise<SellAnswer> {
  const net: Net = input.network === "testnet" || input.network === "mainnet" ? input.network : PAY_NET;
  const chain = `sui:${net}` as "sui:testnet" | "sui:mainnet";
  let resource = "";
  try {
    const raw = String(input.resource ?? "").trim();
    if (raw) {
      resource = canonical(
        /^(profile|identity|note|receipt):/.test(raw) ? raw : ADDRESS.test(raw) ? `profile:${raw}` : `receipt:${raw}`,
      );
    } else if (input.receipt) {
      resource = canonical(`receipt:${String(input.receipt).trim()}`);
    }
  } catch (err) {
    return { http: 400, headers: {}, body: { error: (err as Error).message } };
  }
  if (!resource) {
    return { http: 400, headers: {}, body: { error: "tell the index which address, link or digest you are asking about" } };
  }

  let parsed: Resource;
  try {
    parsed = parseResource(resource);
  } catch (err) {
    return { http: 400, headers: {}, body: { error: (err as Error).message } };
  }

  // An envelope names its own payer. Taking a payer from the request body as well
  // would let a caller ask for one wallet's free answer using another wallet's money.
  let payer = String(input.payer ?? "").trim().toLowerCase();
  let fingerprint = "";
  if (input.envelope) {
    try {
      const opened = openEnvelope(input.envelope);
      fingerprint = opened.fingerprint;
      if (payer && payer !== opened.sender.toLowerCase()) {
        return { http: 400, headers: {}, body: { error: "the signed transaction was sent by a different wallet than the one asking" } };
      }
      payer = opened.sender.toLowerCase();
    } catch (err) {
      return { http: 400, headers: {}, body: { error: (err as Error).message } };
    }
  }
  if (!ADDRESS.test(payer)) {
    return { http: 400, headers: {}, body: { error: "payer must be a full 0x Sui address" } };
  }

  const l = read();

  // A response can be lost after the money moved. The same signed envelope is then the
  // buyer's only proof, so it is answered with the same fact and the same digest
  // instead of being refused as a replay. The facilitator never sees it twice. The
  // envelope is only proof on the ledger it settled, so a testnet signature cannot
  // unlock the same answer on mainnet by naming that ledger in the next request.
  if (fingerprint) {
    const already = envelopeOn(l, net, fingerprint);
    if (already) {
      if (already.resource !== resource) {
        return { http: 400, headers: {}, body: { error: "that signed payment was for a different resource" } };
      }
      const item = parsed.kind === "profile" ? await profileListing(parsed.address, net) : listing(parsed, net);
      if ("missing" in item) return { http: 404, headers: {}, body: { error: item.missing, resource } };
      const fact = await item.reveal();
      return {
        http: 200,
        headers: {
          [HEADER_RESPONSE]: Buffer.from(
            JSON.stringify({ success: true, transaction: already.digest, network: chain, payer, amount: String(BigInt(Math.round(item.usdc * 10 ** USDC_DECIMALS))) }),
            "utf8",
          ).toString("base64"),
        },
        body: { fact, resource, charged: 0, tx: already.digest, paid_to: item.payTo, reason: "this exact signed payment already settled" },
      };
    }
  }

  const sold = soldOn(l, net, payer, resource);
  if (sold) {
    const item = parsed.kind === "profile" ? await profileListing(parsed.address, net) : listing(parsed, net);
    if ("missing" in item) return { http: 404, headers: {}, body: { error: item.missing, resource } };
    return {
      http: 200,
      headers: {},
      body: {
        fact: await item.reveal(),
        resource,
        charged: 0,
        paid_then: sold.usdc,
        paid_on: sold.at,
        tx: sold.digest,
        reason: `already bought on ${sold.at}`,
      },
    };
  }

  const item = parsed.kind === "profile" ? await profileListing(parsed.address, net) : listing(parsed, net);
  if ("missing" in item) return { http: 404, headers: {}, body: { error: item.missing, resource } };

  if (selfDeal(item.payTo, payer)) {
    return { http: 400, headers: {}, body: { error: "that resource pays the wallet trying to buy it, so no money would ever move" } };
  }

  const baseUnits = BigInt(Math.round(item.usdc * 10 ** USDC_DECIMALS));
  const requirements = requirementsFor({
    resource,
    description: item.description,
    payTo: item.payTo,
    baseUnits,
    network: chain,
    asset: USDC_COIN[net],
    timeoutSeconds: 600,
    name: "Ken paid index",
  });

  if (!input.envelope) {
    const required = paymentRequired({
      error: "payment required",
      url: requirements.resource,
      description: item.description,
      accepts: [requirements],
    });
    return {
      http: 402,
      headers: requiredHeader(required),
      body: {
        error: "payment required",
        resource,
        payer,
        price_usdc: item.usdc,
        accepts: [requirements],
        how: "sign the exact transfer the accepts block names, then repeat this request with PAYMENT-SIGNATURE carrying the signed Sui transaction",
      },
    };
  }

  if (!deps.settle) {
    return { http: 503, headers: {}, body: { error: "this seller has no facilitator to settle the payment with" } };
  }

  const settlement = await deps.settle({ x402Version: 2, paymentPayload: input.envelope, paymentRequirements: requirements });
  const responseHeader = Buffer.from(JSON.stringify(settlement), "utf8").toString("base64");
  if (!settlement.success || !settlement.transaction) {
    return {
      http: 402,
      headers: { [HEADER_RESPONSE]: responseHeader },
      body: { error: settlement.errorReason ?? "the facilitator refused that payment", resource, accepts: [requirements] },
    };
  }

  // A settlement that happened on one ledger cannot pay for a fact released on the
  // other. Trusting the success flag alone let a facilitator answer for the wrong chain.
  if (settlement.network && settlement.network !== chain) {
    return {
      http: 402,
      headers: { [HEADER_RESPONSE]: responseHeader },
      body: {
        error: `that settlement happened on ${settlement.network}, not ${chain}, so it cannot release this answer`,
        resource,
        accepts: [requirements],
      },
    };
  }

  // Only a settled payment can release a fact. A thrown reveal after this point is
  // money that moved without an answer, so the sale is not written and the same
  // envelope can be retried for the fact without a second payment.
  const fact = await item.reveal().catch(() => null);
  if (!fact) {
    return {
      http: 503,
      headers: { [HEADER_RESPONSE]: responseHeader },
      body: {
        error: `the payment settled as ${settlement.transaction} but the answer could not be built. Send the same signed payment again and it will not move a second time`,
        resource,
        tx: settlement.transaction,
      },
    };
  }

  const sale: Sale = {
    resource,
    payer,
    digest: settlement.transaction,
    usdc: item.usdc,
    at: new Date().toISOString().slice(0, 10),
    network: net,
  };
  l.sold[netSaleKey(net, payer, resource)] = sale;
  l.envelopes[envKey(net, fingerprint)] = { resource, payer, digest: settlement.transaction, at: new Date().toISOString(), network: net };
  write(l);

  return {
    http: 200,
    headers: { [HEADER_RESPONSE]: responseHeader },
    body: { fact, resource, charged: item.usdc, tx: settlement.transaction, paid_to: item.payTo },
  };
}

/** Every sale of one resource, or only the ones that settled on one ledger when asked. */
export function salesOf(resource: string, net?: Net): Sale[] {
  const want = canonical(resource);
  return Object.values(read().sold).filter((s) => s.resource === want && (!net || saleNet(s) === net));
}

export function allSales(): Sale[] {
  return Object.values(read().sold);
}

/**
 * A settlement the seller has written down is one it must be able to answer for. Used
 * by the seller process to tell a facilitator replay from a lost response.
 */
export function saleFor(payer: string, resource: string, net: Net = PAY_NET): Sale | undefined {
  return soldOn(read(), net, payer, resource);
}
