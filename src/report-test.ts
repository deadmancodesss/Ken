/**
 * A statement that only counts money leaving prints a zero and an empty page for a wallet
 * whose whole history is money arriving. These checks hold the card to both directions at
 * once, against a week or a month, without a chain, a wallet or a model.
 */
import { cardSvg, previewStatement, summarise, windowOf, type Statement, type Totals } from "./report.js";
import { periodMoney, statementMoves } from "./history.js";
import type { Party } from "./knowledge.js";
import type { Flow } from "./chain.js";

const checks: string[] = [];
function expect(label: string, ok: boolean) {
  checks.push(`${ok ? "ok  " : "FAIL"} ${label}`);
  if (!ok) throw new Error(label);
}

const A = (n: string) => "0x" + n.repeat(64);

function coin(over: Partial<Party["coins"][number]> & { asset: string }) {
  return {
    type: `0x${over.asset.toLowerCase()}`,
    in: "0",
    out: "0",
    net: "0",
    flows: 1,
    usual: null,
    ...over,
  };
}

function party(over: Partial<Party> & { address: string; coins: Party["coins"] }): Party {
  return {
    name: null,
    note: "",
    asset: "USDC",
    flows: 1,
    net: "0",
    direction: "received",
    firstSeen: "2026-11-04",
    lastSeen: "2026-11-04",
    usualAmount: null,
    gapDays: null,
    memorised: false,
    service: false,
    faucet: false,
    ...over,
  };
}

/** His wallet on 2026-11-05: four transfers arriving, none leaving. */
const funder = party({
  address: A("e"),
  flows: 2,
  coins: [coin({ asset: "SUI", in: "0.002422631" }), coin({ asset: "USDC", in: "20" })],
});
const john = party({
  address: A("f"),
  name: "John Doe",
  memorised: true,
  coins: [coin({ asset: "SUI", in: "1.001988099" })],
});
const faucet = party({
  address: A("c"),
  flows: 2,
  faucet: true,
  coins: [coin({ asset: "SUI", in: "2.002" })],
});
const service = party({
  address: A("d"),
  service: true,
  coins: [coin({ asset: "USDC", in: "5" })],
});
const payee = party({
  address: A("a"),
  name: "Sana",
  memorised: true,
  direction: "sent",
  coins: [coin({ asset: "USDC", out: "12" })],
});

const arriving = summarise([funder, john, faucet, service]);
expect("a wallet that only received reads as inbound", arriving.direction === "in");
expect("the inbound total is the largest coin received", arriving.totalIn === "20.00 USDC");
expect("the spend total stays zero rather than borrowing the incoming money", arriving.totalOut === "0.00 USDC");
expect("the paid index is not called a person who sent money", arriving.sendCount === 3);
expect("the sender list is sorted by what each sent", arriving.senders[0].name === "0xeeee…eeee");
expect("a named person keeps their name on the card", arriving.senders.some((s) => s.name === "John Doe"));
expect("a faucet is named as a machine", arriving.senders.some((s) => s.name === "testnet faucet"));
expect("every sender carries the coin they sent", arriving.senders.find((s) => s.name === "John Doe")?.amount === "1.00 SUI");
expect("the other coin received is measured beside the main one", arriving.inOtherAssets === "3.01 SUI in");
expect("nobody was paid, so the outbound list is empty", arriving.ranked.length === 0);

const spending = summarise([funder, john, faucet, service, payee]);
expect("money leaving wins the headline when both directions exist", spending.direction === "out");
expect("the outbound total is the largest coin paid", spending.totalOut === "12.00 USDC");
expect("the inbound total is still measured", spending.totalIn === "20.00 USDC" && spending.sendCount === 3);
expect("the paid person is the only outbound row", spending.ranked.length === 1 && spending.ranked[0].name === "Sana");

const quiet = summarise([]);
expect("a wallet with no history has no direction", quiet.direction === "none");
expect("a quiet wallet prints zeroes rather than an empty string", quiet.totalOut === "0.00 USDC" && quiet.totalIn === "0.00 USDC");
expect("a quiet wallet has no senders", quiet.sendCount === 0 && quiet.senders.length === 0);

/* ---------- the window is a calendar fact, not a locale guess ---------- */

const nov = windowOf("month", Date.UTC(2026, 10, 8, 15));
expect("a month window starts on the first at midnight UTC", nov.start === Date.UTC(2026, 10, 1) && nov.end === Date.UTC(2026, 11, 1));
expect("a month is named with its year", nov.label === "Nov 2026");

const week = windowOf("week", Date.UTC(2026, 10, 8, 15));
expect("a week window is the last seven days", week.start === Date.UTC(2026, 10, 2) && week.end === Date.UTC(2026, 10, 9));
expect("a week is named with both ends", week.label === "2 to 8 Nov 2026");

const across = windowOf("week", Date.UTC(2026, 11, 2, 15));
expect("a week that crosses a month names both months", across.label === "26 Nov to 2 Dec 2026");
expect("a week that crosses a year names both years", windowOf("week", Date.UTC(2027, 0, 2, 15)).label === "27 Dec 2026 to 2 Jan 2027");

/* ---------- credits and debits are counted apart, and only in the window ---------- */

const USDC = "0xa1ec7fc00a6f40db9693ad1415d0c193ad3906494428cf252621037bd7117e29::usdc::USDC";
const SUI = "0x2::sui::SUI";
const decimals = new Map([
  [USDC, 6],
  [SUI, 9],
]);
const since = Date.UTC(2026, 10, 2);

const flow = (over: Partial<Flow>): Flow => ({
  digest: "0x1",
  timestamp: "2026-11-04T10:00:00Z",
  counterparty: A("b"),
  coinType: USDC,
  amount: 0n,
  ...over,
});
const flows = [
  flow({ amount: -20_000_000n }),
  flow({ digest: "0x2", amount: 950_000n }),
  flow({ digest: "0x3", coinType: SUI, amount: -2_000_000_000n }),
  flow({ digest: "0x4", amount: -5_000_000n, timestamp: "2026-11-01T10:00:00Z" }),
];
const money = periodMoney(flows, decimals, since);
expect("USDC in is summed on its own", money.usdcIn === 20_000_000n);
expect("USDC out is summed on its own", money.usdcOut === 950_000n);
expect("another coin is measured rather than added to USDC", money.otherIn.length === 1 && money.otherIn[0].asset === "SUI" && money.otherIn[0].amount === "2");
expect("a transfer before the window is not in the totals", money.usdcIn === 20_000_000n && money.otherIn.length === 1);

const rows = statementMoves(flows, decimals, new Map(), 10, since);
expect("a transfer before the window is not on the list", rows.length === 3 && !rows.some((r) => r.tx === "0x4"));
expect("a row keeps its direction and its coin", rows.some((r) => r.dir === "in" && r.amount === "20" && r.asset === "USDC"));

/* ---------- the card draws both sides of the month ---------- */

function statement(t: Totals, over: Partial<Statement> = {}): Statement {
  return {
    wallet: A("1"),
    network: "testnet",
    preview: false,
    range: "month",
    period: "Nov 2026",
    headline: "Your month, as the agent remembers it",
    inPeriod: t.totalIn,
    outPeriod: t.totalOut,
    netPeriod: "+0.00 USDC",
    netDirection: "even",
    otherPeriod: t.inOtherAssets,
    moves: [],
    movesComplete: true,
    direction: t.direction,
    totalOut: t.totalOut,
    otherAssets: t.otherAssets,
    asset: t.asset,
    totalIn: t.totalIn,
    inAsset: t.inAsset,
    inOtherAssets: t.inOtherAssets,
    sendCount: t.sendCount,
    senders: t.senders,
    months: [{ month: "2026-11", amount: 20, label: "Nov" }],
    people: t.ranked.map((p) => {
      const paid = [...p.coins].filter((c) => Number(c.out) > 0).sort((a, b) => Number(b.out) - Number(a.out))[0];
      return {
        name: p.name ?? "unnamed",
        amount: paid ? `${Number(paid.out).toFixed(2)} ${paid.asset}` : "0.00 USDC",
        flows: p.flows,
        cadence: null,
        lastSeen: p.lastSeen,
        memorised: p.memorised,
      };
    }),
    remembered: 1,
    bought: 0,
    paid: "0.00 USDC",
    price: "0.01 USDC",
    generatedAt: "2026-11-05 08:31",
    ...over,
  };
}

const inMove = {
  at: "2026-11-04T10:00:00Z",
  dir: "in" as const,
  asset: "USDC",
  amount: "20",
  who: "John Doe",
  address: A("f"),
  tx: "0x" + "1".repeat(64),
};
const outMove = {
  at: "2026-11-03T10:00:00Z",
  dir: "out" as const,
  asset: "USDC",
  amount: "12",
  who: "Sana",
  address: A("a"),
  tx: "0x" + "2".repeat(64),
};

const inCard = cardSvg(
  statement(arriving, {
    inPeriod: "20.00 USDC",
    outPeriod: "0.00 USDC",
    netDirection: "in",
    netPeriod: "+20.00 USDC",
    otherPeriod: "3.01 SUI in",
    moves: [inMove],
  }),
);
expect("the card shows both directions at once", inCard.includes("MONEY IN") && inCard.includes("MONEY OUT"));
expect("the plus and the minus are drawn as vector strokes", inCard.includes('data-icon="in"') && inCard.includes('data-icon="out"'));
expect("a wallet that only received still prints the amount that arrived", inCard.includes(">20.00<") && inCard.includes(">0.00<"));
expect("the net line is stated for the window", inCard.includes("net +20.00 USDC this month"));
expect("the other coin is named beside the USDC total", inCard.includes("3.01 SUI in"));
expect("the card lists the newest moves with a sign", inCard.includes("LAST 5 MOVES") && inCard.includes("+20 USDC") && inCard.includes("John Doe"));
expect("the card names the period it covers", inCard.includes("Nov 2026"));
expect("a move carries its date", inCard.includes("4 Nov"));
expect("the card never calls a pattern a due date", !/due|overdue|bill|subscription|committed/i.test(inCard));

const outCard = cardSvg(
  statement(spending, {
    inPeriod: "20.00 USDC",
    outPeriod: "12.00 USDC",
    netDirection: "in",
    netPeriod: "+8.00 USDC",
    otherPeriod: "",
    moves: [outMove, inMove],
  }),
);
expect("debits are printed beside credits rather than instead of them", outCard.includes(">12.00<") && outCard.includes(">20.00<"));
expect("a move out carries a minus", outCard.includes("−12 USDC"));
expect("a move in carries a plus", outCard.includes("+20 USDC"));
expect("the net line keeps both figures honest", outCard.includes("net +8.00 USDC this month"));
expect("only the newest five moves are printed", cardSvg(statement(spending, { moves: [outMove, inMove, outMove, inMove, outMove, inMove] })).match(/data-icon="(in|out)"/g)?.length === 7);

const zeroCard = cardSvg(statement(quiet));
expect("a quiet month says nothing moved instead of printing a bare zero", zeroCard.includes("no money moved this month"));
expect("a quiet month still prints the zero on both sides", zeroCard.includes(">0.00<"));
expect("a quiet month admits there are no moves", zeroCard.includes("no transfers this month"));

const partial = cardSvg(statement(arriving, { inPeriod: "20.00 USDC", moves: [inMove], movesComplete: false }));
expect("a window that did not reach its start says so", partial.includes("only the newest 50 transactions"));
expect("a complete window does not carry the warning", !inCard.includes("only the newest 50 transactions"));

const weekCard = cardSvg(statement(arriving, { range: "week", period: "2 to 8 Nov 2026", headline: "Your week, as the agent remembers it", inPeriod: "20.00 USDC", moves: [inMove] }));
expect("a week card is named as a week", weekCard.includes("Your week") && weekCard.includes("2 to 8 Nov 2026") && weekCard.includes("this week"));

const preview = cardSvg(previewStatement("testnet", "week"));
const thisWeek = windowOf("week").label;
expect("the no-wallet card is an honest week of zeros", preview.includes("Your week") && preview.includes(thisWeek) && preview.includes("no money moved this week"));
expect("the no-wallet card asks for a wallet instead of inventing one", preview.includes("connect a wallet on the statement page"));
expect("the no-wallet card carries no invented names to disclaim", !preview.includes("invented"));

const hostile = summarise([
  party({ address: A("b"), name: "John <Doe>", memorised: true, coins: [coin({ asset: "SUI", in: "1" })] }),
]);
const hostileCard = cardSvg(statement(hostile, { moves: [{ ...inMove, who: "John <Doe>" }] }));
expect("a name from memory cannot inject markup into the card", hostileCard.includes("John &lt;Doe&gt;") && !hostileCard.includes("<Doe>"));

console.log(checks.join("\n"));
console.log(`${checks.length} checks`);
