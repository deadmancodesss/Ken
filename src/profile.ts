import "dotenv/config";
import { PAY_CHAIN, PAY_NET, recentActivityPage, type Flow, type Net } from "./chain.js";

/*
 * The paid fact was invented once: a JSON file of made-up businesses standing in for
 * an address tagging API. That is fine for a recording and worthless as a product,
 * because the seller could hand back anything it liked and nobody could check it.
 *
 * This reads the one thing the seller cannot invent: the address's own history on
 * the ledger this build sells, counted from Tatum. The buyer pays for arithmetic over public chain data,
 * which is a modest fact, but it is a true one and it is recomputable by anyone.
 */

export type Profile = {
  address: string;
  window: number;
  more: boolean;
  txs: number;
  counterparties: number;
  top: { address: string; txs: number; share: number } | null;
  inbound: number;
  outbound: number;
  first: string | null;
  last: string | null;
  coins: string[];
  read: string;
};

const ADDRESS = /^0x[0-9a-fA-F]{64}$/;

/**
 * One page of the address's own history. The page size is the sample, and `more`
 * says whether the sample is the whole story: a profile that quietly counted forty
 * of four hundred transactions would be a lie of omission, which is the exact kind
 * of thing this endpoint exists to avoid.
 */
export async function profileOf(address: string, limit = 40, net: Net = PAY_NET): Promise<Profile> {
  if (!ADDRESS.test(address)) throw new Error(`${address} is not a full 0x Sui address`);
  const wallet = address.toLowerCase();
  const page = await recentActivityPage(wallet, limit, null, net);
  return summarise(wallet, page.flows, page.count, page.hasNext, limit);
}

/**
 * Split from the read so the arithmetic can be checked against a fixed page instead
 * of against whatever the chain happens to hold on the day of the test.
 *
 * A flow is recorded from the counterparty's side, so a negative amount is money
 * arriving at the profiled wallet and a positive amount is money leaving it. Counting
 * transactions rather than flows matters, because one swap can touch four wallets and
 * would otherwise inflate the count that the top-counterparty share is divided by.
 */
export function summarise(
  address: string,
  flows: Flow[],
  transactionCount: number,
  more: boolean,
  window: number,
): Profile {
  const wallet = address.toLowerCase();
  const perCounterparty = new Map<string, number>();
  const digests = new Set<string>();
  const coins = new Set<string>();
  let inbound = 0;
  let outbound = 0;
  let first: string | null = null;
  let last: string | null = null;

  for (const f of flows) {
    const who = f.counterparty.toLowerCase();
    if (who === wallet) continue;
    digests.add(f.digest);
    coins.add(f.coinType);
    if (f.amount < 0n) inbound++;
    if (f.amount > 0n) outbound++;
    if (f.timestamp) {
      if (!first || f.timestamp < first) first = f.timestamp;
      if (!last || f.timestamp > last) last = f.timestamp;
    }
  }

  // One transaction per counterparty, or a busy partner who sent five small payments
  // would be counted five times and described as five separate relationships.
  const seen = new Set<string>();
  for (const f of flows) {
    const who = f.counterparty.toLowerCase();
    if (who === wallet || seen.has(`${who}|${f.digest}`)) continue;
    seen.add(`${who}|${f.digest}`);
    perCounterparty.set(who, (perCounterparty.get(who) ?? 0) + 1);
  }
  const ranked = [...perCounterparty.entries()].sort((a, b) => b[1] - a[1]);
  const topCount = ranked[0]?.[1] ?? 0;
  const top = ranked[0]
    ? { address: ranked[0][0], txs: topCount, share: Math.round((topCount / Math.max(digests.size, 1)) * 100) }
    : null;

  return {
    address: wallet,
    window,
    more: more || transactionCount >= window,
    txs: digests.size || transactionCount,
    counterparties: perCounterparty.size,
    top,
    inbound,
    outbound,
    first,
    last,
    coins: [...coins],
    read: new Date().toISOString(),
  };
}

/** The words a memory is written from, in one sentence a speaker can finish. */
export function profileNote(p: Profile, net: Net = PAY_NET): string {
  const coinWord = p.coins.length === 1 ? "one coin type" : `${p.coins.length} coin types`;
  const top = p.top
    ? `The busiest counterparty is ${p.top.address.slice(0, 10)}…${p.top.address.slice(-4)} with ${p.top.txs} of ${p.txs} transactions, ${p.top.share}%`
    : "No counterparty appears at all";
  const span = p.first && p.last ? `Between ${p.first.slice(0, 10)} and ${p.last.slice(0, 10)}` : "With no timestamped transaction in the window";
  const edge = p.more ? `This is the newest ${p.window} or fewer, so older history is not counted` : `This is the whole history on sui:${net}`;
  return `${span} the address appears in ${p.txs} transactions across ${coinWord}, with ${p.inbound} legs arriving and ${p.outbound} leaving. ${top}. ${edge}. Read ${p.read.slice(0, 10)}`;
}

export type ProfileFact = { name: string; kind: string; note: string };

export async function readProfile(address: string, net: Net = PAY_NET): Promise<ProfileFact> {
  const p = await profileOf(address, 40, net);
  return { name: p.address, kind: "Chain profile", note: profileNote(p, net) };
}
