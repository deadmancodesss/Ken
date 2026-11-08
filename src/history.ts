import {
  allHoldings,
  coinDecimals,
  coinName,
  formatAmount,
  isUsdcCoin,
  recentActivityPage,
  type Flow,
  type Net,
} from "./chain.js";
import { faucetLabel } from "./known.js";
import { peopleRoster } from "./people.js";
import { sellerWallet } from "./x402.js";

const PAGE = 50;
const PAGES = 4;
/** USDC is the one coin this product spends, and every USDC on Sui uses six decimals. */
const USDC_UNIT = 1_000_000;

/** Four decimals is enough to keep a faucet's 0.0024 SUI from being spoken as zero. */
export function spoken(n: number): string {
  return String(Number(n.toFixed(4)));
}

async function labelsFor(addresses: string[]): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  let vendor = "";
  try {
    vendor = sellerWallet().toLowerCase();
  } catch {
    vendor = "";
  }
  for (const address of addresses) {
    const faucet = faucetLabel(address);
    if (faucet) out.set(address.toLowerCase(), faucet);
    else if (vendor && address.toLowerCase() === vendor) out.set(address.toLowerCase(), "Paid address index");
  }
  try {
    for (const person of await peopleRoster()) out.set(person.address.toLowerCase(), person.alias);
  } catch {
    // A memory read that fails must not turn an unknown address into a named one.
  }
  return out;
}

export type TransferRow = {
  date: string | null;
  asset: string;
  amount: string;
  from: string;
  from_name: string | null;
  tx: string;
  tx_url?: string;
  from_url?: string;
};

/**
 * One line of the statement's ledger. The card above it answers "who matters", and
 * this answers "show me the transactions", so a person who distrusts a total can
 * check it row by row against the same digests the explorer shows.
 */
export type StatementMove = {
  at: string | null;
  dir: "in" | "out";
  asset: string;
  amount: string;
  who: string;
  address: string;
  tx: string;
};

/**
 * Pure so the mapping can be proved without a provider. `amount` is the counterparty's
 * change, which is why a positive number is money leaving this wallet. Two flows in one
 * transaction are two rows, because a single payment that split between two people is
 * two facts and hiding one of them would understate the total.
 */
export function statementMoves(
  flows: Flow[],
  decimals: Map<string, number>,
  labels: Map<string, string>,
  limit = 12,
  since = 0,
): StatementMove[] {
  const seen = new Set<string>();
  const rows: StatementMove[] = [];
  for (const f of flows) {
    const key = `${f.digest}|${f.counterparty.toLowerCase()}|${f.coinType}`;
    if (seen.has(key)) continue;
    seen.add(key);
    if (f.amount === 0n) continue;
    // A statement window starts at midnight, and a row with no timestamp cannot be
    // proved to belong to it, so it stays out rather than being counted twice.
    if (since && (!f.timestamp || Date.parse(f.timestamp) < since)) continue;
    const out = f.amount > 0n;
    rows.push({
      at: f.timestamp,
      dir: out ? "out" : "in",
      asset: coinName(f.coinType),
      amount: formatAmount(out ? f.amount : -f.amount, decimals.get(f.coinType) ?? 0),
      who: labels.get(f.counterparty.toLowerCase()) ?? `${f.counterparty.slice(0, 6)}…${f.counterparty.slice(-4)}`,
      address: f.counterparty,
      tx: f.digest,
    });
  }
  return rows.sort((a, b) => (b.at ?? "").localeCompare(a.at ?? "")).slice(0, limit);
}

export type CoinMoved = { asset: string; amount: string };

/**
 * What moved in one window, split by direction and by coin. USDC is the money this
 * product counts, so it is totalled separately and never added to SUI or anything
 * else: two coins with different decimals cannot share one number. Other coins are
 * measured beside it so a SUI-only week does not read as a week with no money in it.
 */
export type PeriodMoney = {
  usdcIn: bigint;
  usdcOut: bigint;
  otherIn: CoinMoved[];
  otherOut: CoinMoved[];
};

export function periodMoney(flows: Flow[], decimals: Map<string, number>, since: number): PeriodMoney {
  let usdcIn = 0n;
  let usdcOut = 0n;
  const otherIn = new Map<string, bigint>();
  const otherOut = new Map<string, bigint>();

  for (const f of flows) {
    if (f.amount === 0n) continue;
    if (since && (!f.timestamp || Date.parse(f.timestamp) < since)) continue;
    // `amount` is the counterparty's change, so what happened to this wallet is its negative.
    const mine = -f.amount;
    if (isUsdcCoin(f.coinType)) {
      if (mine > 0n) usdcIn += mine;
      else usdcOut -= mine;
      continue;
    }
    const into = mine > 0n ? otherIn : otherOut;
    into.set(f.coinType, (into.get(f.coinType) ?? 0n) + (mine > 0n ? mine : -mine));
  }

  const rows = (m: Map<string, bigint>): CoinMoved[] =>
    [...m.entries()]
      .map(([type, base]) => ({ asset: coinName(type), amount: formatAmount(base, decimals.get(type) ?? 0) }))
      .sort((a, b) => a.asset.localeCompare(b.asset));

  return { usdcIn, usdcOut, otherIn: rows(otherIn), otherOut: rows(otherOut) };
}

export type PeriodRead = {
  moves: StatementMove[];
  money: PeriodMoney;
  complete: boolean;
  read: number;
};

const periodCache = new Map<string, { at: number; body: PeriodRead }>();

/**
 * One page of history, read once for both the totals and the rows under them. Fifty
 * is the same window the month cap reads, and `complete` is false when those rows do
 * not reach back past the start of the window: a total that may be short says so
 * instead of printing a partial month as the month.
 */
export async function recentStatement(wallet: string, net: Net, since: number, limit = 5): Promise<PeriodRead> {
  const key = `${wallet.toLowerCase()}|${net}|${since}|${limit}`;
  const hit = periodCache.get(key);
  if (hit && hit.at + 15_000 > Date.now()) return hit.body;

  const page = await recentActivityPage(wallet, 50, null, net);
  const types = [...new Set(page.flows.map((f) => f.coinType))];
  const decimals = new Map<string, number>();
  await Promise.all(types.map(async (t) => decimals.set(t, await coinDecimals(t, net))));
  const labels = await labelsFor([...new Set(page.flows.map((f) => f.counterparty))]);
  const oldest = page.flows.reduce<string | null>(
    (min, f) => (f.timestamp && (!min || f.timestamp < min) ? f.timestamp : min),
    null,
  );

  const body: PeriodRead = {
    moves: statementMoves(page.flows, decimals, labels, limit, since),
    money: periodMoney(page.flows, decimals, since),
    complete: !page.hasNext || (!!oldest && Date.parse(oldest) < since),
    read: page.count,
  };
  periodCache.set(key, { at: Date.now(), body });
  return body;
}

const moveCache = new Map<string, { at: number; body: { rows: StatementMove[]; complete: boolean; read: number } }>();

/** Anything that moves the wallet's history makes the next statement read fresh. */
export function forgetTransfers(): void {
  moveCache.clear();
  periodCache.clear();
  spendCache.clear();
}

/**
 * The newest transactions in both directions, named from the same memory the rest of
 * the page uses. One page of digests is enough for the twelve rows a statement prints,
 * and recentActivityPage reads that page with its effects in a single provider call.
 */
export async function recentTransfers(
  wallet: string,
  net: Net,
  limit = 12,
): Promise<{ rows: StatementMove[]; complete: boolean; read: number }> {
  const key = `${wallet.toLowerCase()}|${net}|${limit}`;
  const hit = moveCache.get(key);
  if (hit && hit.at + 15_000 > Date.now()) return hit.body;

  const page = await recentActivityPage(wallet, Math.min(50, Math.max(limit, 20)), null, net);
  const types = [...new Set(page.flows.map((f) => f.coinType))];
  const decimals = new Map<string, number>();
  await Promise.all(types.map(async (t) => decimals.set(t, await coinDecimals(t, net))));
  const labels = await labelsFor([...new Set(page.flows.map((f) => f.counterparty))]);
  const body = {
    rows: statementMoves(page.flows, decimals, labels, limit),
    complete: !page.hasNext,
    read: page.count,
  };
  moveCache.set(key, { at: Date.now(), body });
  return body;
}

export type MonthSpend = {
  month: string;
  spent: number;
  spent_text: string;
  transactions: number;
  complete: boolean;
};

const spendCache = new Map<string, { at: number; body: MonthSpend }>();

/**
 * What left this wallet in USDC since the first of the month, read from the chain
 * rather than counted by this server. A cap that only saw payments made through this
 * page would be a budget for one shop, not for the wallet, so the rows come from the
 * same public history the statement prints.
 *
 * `complete` is false when fifty transactions do not reach the start of the month,
 * which is the only case where the figure can be lower than the truth. The page says
 * so instead of presenting a partial month as a total.
 */
export async function monthSpend(wallet: string, net: Net): Promise<MonthSpend> {
  const key = `${wallet.toLowerCase()}|${net}`;
  const hit = spendCache.get(key);
  if (hit && hit.at + 20_000 > Date.now()) return hit.body;
  const month = new Date().toISOString().slice(0, 7);
  const start = `${month}-01`;
  const page = await recentActivityPage(wallet, 50, null, net);
  let base = 0n;
  let transactions = 0;
  let reachedBack = !page.hasNext;
  for (const f of page.flows) {
    if (!f.timestamp) continue;
    if (f.timestamp.slice(0, 10) < start) {
      reachedBack = true;
      continue;
    }
    if (f.amount <= 0n || !/usdc/i.test(f.coinType)) continue;
    base += f.amount;
    transactions++;
  }
  const body = {
    month,
    spent: Number(base) / USDC_UNIT,
    spent_text: formatAmount(base, 6),
    transactions,
    complete: reachedBack,
  };
  spendCache.set(key, { at: Date.now(), body });
  return body;
}

export type CoinGap = { asset: string; balance: string; transfers: string; gap: string; matches: boolean };

export type MoneyOrigin = {
  wallet: string;
  network: Net;
  explorer_url?: string;
  balance: { asset: string; amount: number; decimals: number; base: string }[];
  transfers: TransferRow[];
  in_by_coin: { asset: string; amount: string; flows: number }[];
  out_by_coin: { asset: string; amount: string; flows: number }[];
  gaps: CoinGap[];
  read: { transactions: number; pages: number; oldest: string | null; stopped: string; complete: boolean };
  said: string[];
};

/**
 * Walks a wallet's public history back until the transfers explain the balance or the
 * read cap is reached. The cap is four pages because the free Tatum tier answers three
 * requests a second, and a question about a balance should not hold a person for a
 * minute. When the cap stops the walk, the answer says so instead of implying it reached
 * the beginning of the wallet.
 */
export async function moneyOrigin(wallet: string, net: Net): Promise<MoneyOrigin> {
  const unique = new Map<string, Flow>();
  let cursor: string | null = null;
  let pages = 0;
  let transactions = 0;
  let oldest: string | null = null;
  let stopped = "history ended";

  for (let pageNo = 1; pageNo <= PAGES; pageNo++) {
    const page = await recentActivityPage(wallet, PAGE, cursor, net);
    pages++;
    transactions += page.count;
    for (const f of page.flows) {
      const key = `${f.digest}|${f.counterparty.toLowerCase()}|${f.coinType}`;
      if (!unique.has(key)) unique.set(key, f);
      if (f.timestamp && (!oldest || f.timestamp < oldest)) oldest = f.timestamp;
    }
    if (!page.hasNext || !page.cursor) break;
    cursor = page.cursor;
    if (pageNo === PAGES) stopped = "read cap reached";
  }

  const holdings = await allHoldings(wallet, net);
  const types = [...new Set([...holdings.map((h) => h.type!), ...[...unique.values()].map((f) => f.coinType)])];
  const decimals = new Map<string, number>();
  await Promise.all(types.map(async (t) => decimals.set(t, await coinDecimals(t, net))));

  const balanceBase = new Map<string, bigint>();
  for (const h of holdings) balanceBase.set(h.type!, BigInt(h.base));
  const netBase = new Map<string, bigint>();
  const cameBase = new Map<string, bigint>();
  const wentBase = new Map<string, bigint>();
  const cameFlows = new Map<string, number>();
  const wentFlows = new Map<string, number>();

  for (const f of unique.values()) {
    // amount is the counterparty's change, so the wallet's own change is its negative.
    const mine = -f.amount;
    netBase.set(f.coinType, (netBase.get(f.coinType) ?? 0n) + mine);
    if (mine > 0n) {
      cameBase.set(f.coinType, (cameBase.get(f.coinType) ?? 0n) + mine);
      cameFlows.set(f.coinType, (cameFlows.get(f.coinType) ?? 0) + 1);
    } else if (mine < 0n) {
      wentBase.set(f.coinType, (wentBase.get(f.coinType) ?? 0n) - mine);
      wentFlows.set(f.coinType, (wentFlows.get(f.coinType) ?? 0) + 1);
    }
  }

  const gaps: CoinGap[] = types.map((type) => {
    const d = decimals.get(type) ?? 0;
    const balance = balanceBase.get(type) ?? 0n;
    const explained = netBase.get(type) ?? 0n;
    const gap = balance - explained;
    return {
      asset: coinName(type),
      balance: formatAmount(balance, d),
      transfers: formatAmount(explained, d),
      gap: formatAmount(gap, d),
      matches: gap === 0n,
    };
  });

  const labels = await labelsFor([...unique.values()].map((f) => f.counterparty));
  const transfers: TransferRow[] = [...unique.values()]
    .filter((f) => f.amount < 0n)
    .sort((a, b) => (b.timestamp ?? "").localeCompare(a.timestamp ?? ""))
    .slice(0, 40)
    .map((f) => {
      const d = decimals.get(f.coinType) ?? 0;
      return {
        date: f.timestamp ? f.timestamp.slice(0, 10) : null,
        asset: coinName(f.coinType),
        amount: formatAmount(-f.amount, d),
        from: f.counterparty,
        from_name: labels.get(f.counterparty.toLowerCase()) ?? null,
        tx: f.digest,
        tx_url: `https://suiscan.xyz/${net}/tx/${f.digest}`,
        from_url: `https://suiscan.xyz/${net}/account/${f.counterparty}`,
      };
    });

  const held = holdings
    .filter((h) => h.amount > 0)
    .sort((a, b) => b.amount - a.amount)
    .map((h) => ({ asset: h.symbol, amount: h.amount, decimals: h.decimals, base: h.base }));

  const inByCoin = [...cameBase.entries()]
    .map(([type, sum]) => ({
      asset: coinName(type),
      amount: formatAmount(sum, decimals.get(type) ?? 0),
      flows: cameFlows.get(type) ?? 0,
    }))
    .sort((a, b) => b.flows - a.flows);
  const outByCoin = [...wentBase.entries()]
    .map(([type, sum]) => ({
      asset: coinName(type),
      amount: formatAmount(sum, decimals.get(type) ?? 0),
      flows: wentFlows.get(type) ?? 0,
    }))
    .sort((a, b) => b.flows - a.flows);

  const said: string[] = [];
  if (held.length) {
    said.push(`You hold ${held.map((h) => `${spoken(h.amount)} ${h.asset}`).join(" and ")}.`);
  } else {
    said.push(`This wallet holds no coin on ${net}.`);
  }
  if (transfers.length) {
    for (const t of transfers.slice(0, 10)) {
      // Out loud an unnamed address is shortened, because a full 64 character hex
      // string is not something a person can listen to.
      const from = t.from_name ?? `${t.from.slice(0, 10)}…`;
      said.push(`${t.amount} ${t.asset} came in on ${t.date ?? "an unrecorded date"} from ${from}.`);
    }
    if (transfers.length > 10) said.push(`${transfers.length - 10} more incoming transfers are in the data.`);
  } else {
    said.push("None of the transactions read moved money into this wallet.");
  }
  said.push(
    stopped === "read cap reached"
      ? `I stopped after ${transactions} transactions, so older money is not in this answer.`
      : `That is all ${transactions} transactions this index returned, back to ${oldest?.slice(0, 10) ?? "no date"}.`,
  );
  for (const g of gaps) {
    if (g.matches) continue;
    if (g.gap.startsWith("-")) {
      said.push(
        `${g.gap.slice(1)} ${g.asset} left the wallet outside these transfers, which is usually network gas.`,
      );
    } else {
      said.push(`${g.gap} ${g.asset} is in the wallet but not in these transfers, so some history is missing.`);
    }
  }

  return {
    wallet,
    network: net,
    explorer_url: `https://suiscan.xyz/${net}/account/${wallet}`,
    balance: held,
    transfers,
    in_by_coin: inByCoin,
    out_by_coin: outByCoin,
    gaps,
    read: { transactions, pages, oldest, stopped, complete: stopped !== "read cap reached" },
    said,
  };
}

export type AddressActivity = {
  address: string;
  network: Net;
  explorer_url: string;
  transactions_read: number;
  first_seen: string | null;
  last_seen: string | null;
  in_by_coin: { asset: string; amount: string; flows: number }[];
  out_by_coin: { asset: string; amount: string; flows: number }[];
  counterparties: { address: string; name: string | null; flows: number; explorer_url?: string }[];
  transactions: (StatementMove & { tx_url: string; who_url: string })[];
  with_you: number;
  pattern: string[];
  note: string;
  said: string[];
};

const activityCache = new Map<string, { at: number; body: AddressActivity }>();

export type ActivityShape = {
  count: number;
  sent: number;
  received: number;
  addresses: number;
  withYou: number;
  hasNext: boolean;
};

/**
 * What a read window can honestly support. Everything here is a count over the
 * rows that were actually read, so "only sent, never received" is a statement
 * about this window and never a verdict about the wallet.
 */
export function activityPattern(s: ActivityShape): string[] {
  const pattern = [
    `In the last ${s.count} transactions it sent money ${s.sent} times and received ${s.received} times.`,
  ];
  if (s.sent > 0 && s.received === 0) pattern.push("It only sent money in this window, never received.");
  if (s.received > 0 && s.sent === 0) pattern.push("It only received money in this window, never sent.");
  if (s.addresses >= 5) pattern.push(`It dealt with ${s.addresses} different addresses in this window.`);
  if (s.withYou) {
    pattern.push(`${s.withYou} of those transactions were with this wallet.`);
  } else if (s.hasNext) {
    // The window stops before older history, so a transfer with this wallet that
    // happened later or earlier can simply be outside it. Absence is not evidence.
    pattern.push("None of them were with this wallet, and the window does not reach all of its history, so that proves nothing either way.");
  } else {
    pattern.push("None of them were with this wallet.");
  }
  if (s.count <= 3) pattern.push("There is very little public history here to judge.");
  if (!s.hasNext) pattern.push("This is the whole history the index holds for it.");
  return pattern;
}

/**
 * The last twenty public transactions of any address, read from the same index as the
 * wallet's own history. It returns counts and shapes rather than a verdict: twenty rows
 * can support "it only sends, to many addresses" and cannot support "this is spam".
 */
export async function addressActivity(address: string, net: Net, me: string): Promise<AddressActivity> {
  const key = `${address.toLowerCase()}|${net}|${me.toLowerCase()}`;
  const hit = activityCache.get(key);
  if (hit && hit.at + 30_000 > Date.now()) return hit.body;

  const page = await recentActivityPage(address, 20, null, net);
  const flows = page.flows;
  const types = [...new Set(flows.map((f) => f.coinType))];
  const decimals = new Map<string, number>();
  await Promise.all(types.map(async (t) => decimals.set(t, await coinDecimals(t, net))));

  const came = new Map<string, bigint>();
  const went = new Map<string, bigint>();
  const cameN = new Map<string, number>();
  const wentN = new Map<string, number>();
  const people = new Map<string, number>();

  for (const f of flows) {
    // This address' own change is the negative of the counterparty's.
    const mine = -f.amount;
    if (mine > 0n) {
      came.set(f.coinType, (came.get(f.coinType) ?? 0n) + mine);
      cameN.set(f.coinType, (cameN.get(f.coinType) ?? 0) + 1);
    } else if (mine < 0n) {
      went.set(f.coinType, (went.get(f.coinType) ?? 0n) - mine);
      wentN.set(f.coinType, (wentN.get(f.coinType) ?? 0) + 1);
    }
    people.set(f.counterparty.toLowerCase(), (people.get(f.counterparty.toLowerCase()) ?? 0) + 1);
  }

  const labels = await labelsFor([...people.keys()]);
  const counterparties = [...people.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 8)
    .map(([a, n]) => ({
      address: a,
      name: labels.get(a) ?? null,
      flows: n,
      explorer_url: `https://suiscan.xyz/${net}/account/${a}`,
    }));

  const transactions = statementMoves(flows, decimals, labels, 12).map((row) => ({
    ...row,
    tx_url: `https://suiscan.xyz/${net}/tx/${row.tx}`,
    who_url: `https://suiscan.xyz/${net}/account/${row.address}`,
  }));

  const times = flows.map((f) => f.timestamp).filter((t): t is string => !!t).sort();
  const inByCoin = [...came.entries()].map(([t, sum]) => ({
    asset: coinName(t),
    amount: formatAmount(sum, decimals.get(t) ?? 0),
    flows: cameN.get(t) ?? 0,
  }));
  const outByCoin = [...went.entries()].map(([t, sum]) => ({
    asset: coinName(t),
    amount: formatAmount(sum, decimals.get(t) ?? 0),
    flows: wentN.get(t) ?? 0,
  }));

  const sent = outByCoin.reduce((n, r) => n + r.flows, 0);
  const received = inByCoin.reduce((n, r) => n + r.flows, 0);
  const withYou = people.get(me.toLowerCase()) ?? 0;
  const pattern = activityPattern({
    count: page.count,
    sent,
    received,
    addresses: people.size,
    withYou,
    hasNext: page.hasNext,
  });

  const body: AddressActivity = {
    address,
    network: net,
    explorer_url: `https://suiscan.xyz/${net}/account/${address}`,
    transactions_read: page.count,
    first_seen: times[0]?.slice(0, 10) ?? null,
    last_seen: times.at(-1)?.slice(0, 10) ?? null,
    in_by_coin: inByCoin,
    out_by_coin: outByCoin,
    counterparties,
    transactions,
    with_you: withYou,
    pattern,
    note: "the last 20 public transactions, not a verdict about the wallet",
    said: [...pattern, "I can tell you the pattern, not whether it is spam."],
  };
  activityCache.set(key, { at: Date.now(), body });
  return body;
}
