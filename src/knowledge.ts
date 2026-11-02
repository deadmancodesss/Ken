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
 * "when is it due". The features that cost an hour each all read from here.
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

export async function counterparties(wallet: string, network: Net = "mainnet", limit?: number): Promise<Party[]> {
  const cacheKey = `${wallet.toLowerCase()}|${network}`;
  const cached = memo.get(cacheKey);
  if (cached) return take(cached, limit);

  const [own, roster] = await Promise.all([
    recentActivity(wallet, READ_DEPTH, network),
    peopleRoster(),
  ]);
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
  await Promise.all(
    [...buckets.values()].map((list) => coinDecimals(mostFrequent(list.map((f) => f.coinType)), network)),
  );

  const parties: Party[] = [];
  for (const [address, list] of buckets) {
    const dominant = mostFrequent(list.map((f) => f.coinType));
    const same = list.filter((f) => f.coinType === dominant);
    const decimals = await coinDecimals(dominant, network);
    const net = same.reduce((sum, f) => sum + f.amount, 0n);
    const dates = same.map((f) => f.timestamp).filter((t): t is string => !!t).sort();
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
    });
  }

  const sorted = parties.sort((a, b) => b.flows - a.flows);
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

export type Due = {
  address: string;
  name: string;
  note: string;
  asset: string;
  every_days: number | null;
  last: string | null;
  since_days: number | null;
  expected_on: string | null;
  usual: string | null;
  who_pays: "you" | "them" | "both";
  state: "late" | "due" | "on track" | "no rhythm yet";
  line: string;
};

const DAY_MS = 86_400_000;
const iso = (ms: number) => new Date(ms).toISOString().slice(0, 10);
/** Midnight of the day a timestamp falls in, so a rhythm is counted in whole days and never in hours. */
const dayStart = (ms: number) => Date.parse(iso(ms));
const count = (n: number, word: string) => `${n} ${n === 1 ? word : word + "s"}`;

/**
 * Out loud, money has two decimals. The chain carries six and a spoken "zero point five
 * one six four four three" is not a sentence anyone says about a coffee.
 */
const spoken = (amount: string) => {
  const n = Number(amount);
  return Number.isFinite(n) ? String(Math.round(n * 100) / 100) : amount;
};

/**
 * A rhythm is the only thing memory gives you that a ledger cannot. Two dated flows
 * make a period, the period projects a date, and the date is either past or it is not.
 * Nothing here is guessed: one flow says "no rhythm yet" out loud rather than inventing
 * a monthly bill from a single payment, which is how a summariser turns into a liar.
 */
export function dueRows(parties: Party[], today = Date.now()): Due[] {
  const now = dayStart(today);
  return parties
    .filter((p) => p.flows > 1 || p.name)
    .map((p) => {
      const who: Due["who_pays"] = p.direction === "mixed" ? "both" : p.direction === "sent" ? "you" : "them";
      const last = p.lastSeen ? Date.parse(p.lastSeen) : null;
      const since = last === null ? null : Math.round((now - last) / DAY_MS);
      const every = p.gapDays;
      const expected = every && last !== null ? iso(last + every * DAY_MS) : null;
      // Positive means days until it is due, negative means days past it. The window
      // that counts as "coming up" is a quarter of the rhythm and never under a day,
      // because a fortnightly bill a week out is worth mentioning and a daily coffee
      // run two days out is noise.
      const toDue = expected ? Math.round((Date.parse(expected) - now) / DAY_MS) : null;
      const soon = every === null ? 1 : Math.max(1, Math.round(every / 4));
      const state: Due["state"] =
        every === null || since === null || toDue === null ? "no rhythm yet" : toDue < 0 ? "late" : toDue <= soon ? "due" : "on track";
      const whoWord = who === "you" ? "you pay" : who === "them" ? `${p.name ?? "they"} pays you` : "you exchange";
      const cadence = every === null ? "" : every === 1 ? "every day" : `every ${count(every, "day")}`;
      const sum = p.usualAmount ? `${spoken(p.usualAmount)} ${p.asset}` : `what you usually send`;
      /*
       * The sentence never carries a date. A model reading this aloud says "today" or
       * "in two days", and an ISO string that reaches its mouth is a sentence nobody
       * said to it. The exact date stays in the data field beside it.
       */
      const whenDue = toDue === 0 ? "today" : toDue === 1 ? "tomorrow" : `in ${count(toDue ?? 0, "day")}`;
      const line =
        state === "late"
          ? `${whoWord} about ${sum} ${cadence}, ${since === 0 ? "the last one was today" : `the last one was ${count(since ?? 0, "day")} ago`}, and it is ${count(-toDue!, "day")} overdue`
          : state === "due"
            ? `${whoWord} about ${sum} ${cadence}, and the next one is due ${whenDue}`
            : state === "on track"
              ? `${whoWord} about ${sum} ${cadence}, nothing due for another ${count(toDue!, "day")}`
              : `only ${count(p.flows, "payment")} with ${p.name ?? p.address.slice(0, 10)} so far, so there is no rhythm to expect yet`;
      return {
        address: p.address,
        name: p.name ?? p.address.slice(0, 10) + "…",
        note: p.note,
        asset: p.asset,
        every_days: every ?? null,
        last: p.lastSeen,
        since_days: since,
        expected_on: expected,
        usual: p.usualAmount ? `${p.usualAmount} ${p.asset}` : null,
        who_pays: who,
        state,
        line,
      };
    })
    .sort((a, b) => {
      const rank = { late: 0, due: 1, "on track": 2, "no rhythm yet": 3 } as const;
      return rank[a.state] - rank[b.state] || (b.since_days ?? 0) - (a.since_days ?? 0);
    });
}

export type Month = { month: string; total: string; asset: string; flows: number };/** Month totals must cover the same slice of history as the people totals on the
 *  statement card, so both read at READ_DEPTH rather than a caller-chosen window. */
export async function monthlyTotals(wallet: string, network: Net = "mainnet"): Promise<Month[]> {
  const flows = await recentActivity(wallet, READ_DEPTH, network);
  const byMonth = new Map<string, { total: bigint; decimals: number; asset: string; flows: number }>();

  for (const f of flows) {
    if (!f.timestamp) continue;
    const month = f.timestamp.slice(0, 7);
    const decimals = await coinDecimals(f.coinType, network);
    const row = byMonth.get(month) ?? { total: 0n, decimals, asset: coinName(f.coinType), flows: 0 };
    row.total += f.amount < 0n ? -f.amount : f.amount;
    row.flows++;
    byMonth.set(month, row);
  }

  return [...byMonth.entries()]
    .sort((a, b) => (a[0] < b[0] ? 1 : -1))
    .map(([month, r]) => ({ month, total: formatAmount(r.total, r.decimals), asset: r.asset, flows: r.flows }));
}
