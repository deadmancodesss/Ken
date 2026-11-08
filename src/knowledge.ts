import {
  recentActivity,
  flowsFromOthers,
  coinDecimals,
  formatAmount,
  coinName,
  type Flow,
  type Net,
} from "./chain.js";
import { peopleRoster } from "./people.js";
import { sellerWallet } from "./x402.js";
import { isFaucet } from "./known.js";

/**
 * The index is paid from this wallet, so its payout address shows up in the same
 * history as a person who keeps taking money. It is a vendor, and a list of people
 * headed by a lookup service makes the busiest contact out of a machine. The address
 * is compared rather than the name, because the name lives in somebody's memory and
 * can be spelled any way the person who wrote it chose.
 */
function vendorAddress(): string {
  try {
    return sellerWallet().toLowerCase();
  } catch {
    return "";
  }
}

export type CoinRow = {
  asset: string;
  type: string;
  in: string;
  out: string;
  net: string;
  flows: number;
  usual: string | null;
};

export type Party = {
  address: string;
  name: string | null;
  note: string;
  asset: string;
  flows: number;
  net: string;
  direction: "sent" | "received" | "mixed";
  firstSeen: string | null;
  lastSeen: string | null;
  usualAmount: string | null;
  gapDays: number | null;
  memorised: boolean;
  service: boolean;
  faucet: boolean;
  /* One row per coin this relationship moved. A funder who sent SUI and 20 USDC is
     two facts, and the dominant-coin net used to hide the larger one. */
  coins: CoinRow[];
};

function day(iso: string | null): string | null {
  return iso ? new Date(iso).toISOString().slice(0, 10) : null;
}

function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

function gapInDays(a: string, b: string): number {
  return Math.round((new Date(b).getTime() - new Date(a).getTime()) / 86_400_000);
}

/**
 * Groups a wallet's flows by counterparty and joins the chain facts against
 * Walrus, so one call answers "who is this", "what do I usually pay them" and
 * "how often has this repeated". The features that cost an hour each all read from here.
 *
 * Each call is several seconds of network time, so a result is kept for the whole
 * session. The history only moves when money moves, and every place money moves
 * already calls forgetCounterparties(), so a warm question answers without
 * touching Tatum at all. Use /state?refresh=1 to force a re-read.
 */
const memo = new Map<string, Party[]>();

/**
 * How far back into a wallet's history every read goes, decided once. Callers used
 * to pass their own depth, and one tool reading 15 transactions while another read
 * 12 made the agent say "four times" and then "five times" about the same person in
 * two adjacent spoken answers. A caller can still ask for fewer rows to display,
 * never for a shallower slice of the truth.
 */
export const READ_DEPTH = 40;

/**
 * A relationship split by coin. `amount` in a Flow is the counterparty's change, so a
 * negative amount is money this wallet received and a positive amount is money it sent.
 * The split is what lets the agent answer "who gave me the USDC" when the same person
 * also moved a far smaller amount of SUI and the old dominant-coin row hid it.
 */
export function coinRows(flows: Flow[], decimals: Map<string, number>): CoinRow[] {
  const byType = new Map<string, Flow[]>();
  for (const f of flows) {
    const list = byType.get(f.coinType) ?? [];
    list.push(f);
    byType.set(f.coinType, list);
  }
  const rows: CoinRow[] = [];
  for (const [type, list] of byType) {
    const d = decimals.get(type) ?? 0;
    let came = 0n;
    let went = 0n;
    const amounts: bigint[] = [];
    for (const f of list) {
      if (f.amount < 0n) came += -f.amount;
      else went += f.amount;
      amounts.push(f.amount < 0n ? -f.amount : f.amount);
    }
    const net = came >= went ? came - went : went - came;
    rows.push({
      asset: coinName(type),
      type,
      in: formatAmount(came, d),
      out: formatAmount(went, d),
      net: formatAmount(net, d),
      flows: list.length,
      usual: amounts.length ? formatAmount(BigInt(Math.round(median(amounts.map(Number)))), d) : null,
    });
  }
  return rows.sort((a, b) => b.flows - a.flows || Number(b.out) - Number(a.out));
}

export async function counterparties(wallet: string, network: Net = "mainnet", limit?: number): Promise<Party[]> {
  const cacheKey = `${wallet.toLowerCase()}|${network}`;
  const cached = memo.get(cacheKey);
  if (cached) return take(cached, limit);

  const [own, roster] = await Promise.all([
    recentActivity(wallet, READ_DEPTH, network),
    peopleRoster(),
  ]);
  const vendor = vendorAddress();
  const named = new Map(roster.map((p) => [p.address.toLowerCase(), p]));
  // Anyone already seen outbound, plus everyone the agent can name, is worth
  // reading from the other side. That is the only way inbound money surfaces.
  const others = [...new Set([...roster.map((p) => p.address), ...own.map((f) => f.counterparty)])];
  const inbound = await flowsFromOthers(wallet, others, 6, network);

  const seen = new Set<string>();
  const flows: Flow[] = [];
  for (const f of [...own, ...inbound]) {
    const k = `${f.digest}|${f.counterparty.toLowerCase()}|${f.coinType}`;
    if (seen.has(k)) continue;
    seen.add(k);
    flows.push(f);
  }

  const buckets = new Map<string, Flow[]>();
  for (const f of flows) {
    const list = buckets.get(f.counterparty) ?? [];
    list.push(f);
    buckets.set(f.counterparty, list);
  }

  // Resolve every coin's decimals in one parallel pass. Doing it per party inside
  // the loop serialized a round trip for each one.
  const types = [...new Set(flows.map((f) => f.coinType))];
  const decimalsByType = new Map<string, number>();
  await Promise.all(types.map(async (t) => decimalsByType.set(t, await coinDecimals(t, network))));

  const parties: Party[] = [];
  for (const [address, list] of buckets) {
    const dominant = mostFrequent(list.map((f) => f.coinType));
    const same = list.filter((f) => f.coinType === dominant);
    const decimals = decimalsByType.get(dominant) ?? 0;
    const net = same.reduce((sum, f) => sum + f.amount, 0n);
    // Every coin counts for when this relationship was first and last seen, because
    // a person whose only recent payment was in a second coin still moved recently.
    const dates = list.map((f) => f.timestamp).filter((t): t is string => !!t).sort();
    const amounts = same.map((f) => (f.amount < 0n ? -f.amount : f.amount));

    // The roster read above already returns every person line, so an address
    // missing from it cannot be found by a per-address recall either.
    const person = named.get(address.toLowerCase());
    const gaps = dates.slice(1).map((d, i) => gapInDays(dates[i], d)).filter((g) => g > 0);
    // Direction spans every coin: someone you pay in USDC who sends SUI back is
    // a two-way relationship, not a donation, and the dominant-coin net hides it.
    const hasIn = list.some((f) => f.amount < 0n);
    const hasOut = list.some((f) => f.amount > 0n);

    parties.push({
      address,
      name: person?.alias ?? null,
      note: person?.note ?? "",
      asset: coinName(dominant),
      flows: list.length,
      net: formatAmount(net < 0n ? -net : net, decimals),
      direction: hasIn && hasOut ? "mixed" : hasIn ? "received" : "sent",
      firstSeen: day(dates[0] ?? null),
      lastSeen: day(dates[dates.length - 1] ?? null),
      usualAmount: amounts.length ? formatAmount(BigInt(Math.round(median(amounts.map(Number)))), decimals) : null,
      // One observed gap is a rhythm already worth naming. Waiting for two made
      // every person read "last seen" instead of "every three days", which is the
      // difference between a ledger and the subscription story the demo tells.
      gapDays: gaps.length ? Math.round(median(gaps)) : null,
      memorised: !!person,
      service: !!vendor && address.toLowerCase() === vendor,
      faucet: isFaucet(address),
      coins: coinRows(list, decimalsByType),
    });
  }

  /* A vendor buys the top of the list on flow count alone, because a lookup is a cent
     and paid for often, while a person is dinner and paid for monthly. The busiest entry
     a reader sees should be a busiest *someone*, and a faucet is a machine that funded
     the wallet rather than a relationship in it. */
  const sorted = parties.sort(
    (a, b) => Number(a.service || a.faucet) - Number(b.service || b.faucet) || b.flows - a.flows,
  );
  memo.set(cacheKey, sorted);
  return take(sorted, limit);
}

/** Narrowing happens after the read, so a cached answer can be shortened without a second trip to Tatum. */
function take(rows: Party[], limit?: number): Party[] {
  const n = Math.floor(Number(limit));
  return Number.isFinite(n) && n > 0 ? rows.slice(0, n) : rows;
}

/** Called after anything that can move the wallet's history. */
export function forgetCounterparties(): void {
  memo.clear();
}

function mostFrequent(values: string[]): string {
  const counts = new Map<string, number>();
  for (const v of values) counts.set(v, (counts.get(v) ?? 0) + 1);
  return [...counts.entries()].sort((a, b) => b[1] - a[1])[0][0];
}

export type Month = { month: string; asset: string; in: string; out: string; flows: number };

/**
 * One row per month and per coin. The version this replaces keyed on the month alone and
 * used the first coin's decimals for every flow, so 6.87 USDC and 0.103976 SUI became
 * one row reading 110.84 USDC. The arithmetic is separated from the network so a fake
 * flow can prove the split without a provider call.
 */
export function monthRows(flows: Flow[], decimals: Map<string, number>): Month[] {
  const by = new Map<string, { came: bigint; went: bigint; flows: number; type: string }>();
  for (const f of flows) {
    if (!f.timestamp) continue;
    const key = `${f.timestamp.slice(0, 7)}|${f.coinType}`;
    const row = by.get(key) ?? { came: 0n, went: 0n, flows: 0, type: f.coinType };
    if (f.amount < 0n) row.came += -f.amount;
    else row.went += f.amount;
    row.flows++;
    by.set(key, row);
  }
  return [...by.entries()]
    .map(([key, r]) => {
      const d = decimals.get(r.type) ?? 0;
      return {
        month: key.slice(0, 7),
        asset: coinName(r.type),
        in: formatAmount(r.came, d),
        out: formatAmount(r.went, d),
        flows: r.flows,
      };
    })
    .sort((a, b) =>
      a.month === b.month
        ? Number(b.out) - Number(a.out) || Number(b.in) - Number(a.in)
        : a.month < b.month
          ? 1
          : -1,
    );
}

/** Month totals must cover the same slice of history as the people totals on the
 *  statement card, so both read at READ_DEPTH rather than a caller-chosen window. */
export async function monthlyTotals(wallet: string, network: Net = "mainnet"): Promise<Month[]> {
  const flows = await recentActivity(wallet, READ_DEPTH, network);
  const decimals = new Map<string, number>();
  await Promise.all(
    [...new Set(flows.map((f) => f.coinType))].map(async (t) => decimals.set(t, await coinDecimals(t, network))),
  );
  return monthRows(flows, decimals);
}
