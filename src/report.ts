import { counterparties, monthlyTotals, type Party } from "./knowledge.js";
import { memoryStats } from "./people.js";
import { priceUsdc, purchases, totalSpent } from "./x402.js";
import { session } from "./session.js";
import { recentStatement, type StatementMove } from "./history.js";

export type Range = "week" | "month";

export type Sender = {
  name: string;
  amount: string;
  flows: number;
  lastSeen: string | null;
  memorised: boolean;
};

export type Statement = {
  wallet: string;
  network: string;
  preview: boolean;
  range: Range;
  period: string;
  headline: string;
  inPeriod: string;
  outPeriod: string;
  netPeriod: string;
  netDirection: "in" | "out" | "even";
  otherPeriod: string;
  moves: StatementMove[];
  movesComplete: boolean;
  direction: "out" | "in" | "none";
  totalOut: string;
  otherAssets: string;
  asset: string;
  totalIn: string;
  inAsset: string;
  inOtherAssets: string;
  sendCount: number;
  senders: Sender[];
  months: { month: string; amount: number; label: string }[];
  people: { name: string; amount: string; flows: number; cadence: string | null; lastSeen: string | null; memorised: boolean }[];
  remembered: number;
  bought: number;
  paid: string;
  price: string;
  generatedAt: string;
};

const MONTH_NAMES = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const DAY = 86_400_000;
const USDC_UNIT = 1_000_000;

/** "1.328459 USDC" is never spoken or printed, so one rounding rule covers every surface. */
function money(v: number, asset: string) {
  return `${v.toFixed(2)} ${asset}`;
}

/** What this person actually received from the wallet, summed across every coin. */
function outOf(p: Party) {
  return p.coins.reduce((sum, c) => sum + (Number(c.out) || 0), 0);
}

/** The one row a printed card has space for: the coin they were paid the most in. */
function biggestOut(p: Party) {
  return [...p.coins]
    .filter((c) => Number(c.out) > 0)
    .sort((a, b) => Number(b.out) - Number(a.out))[0];
}

/** What this person actually sent the wallet, summed across every coin. */
function inOf(p: Party) {
  return p.coins.reduce((sum, c) => sum + (Number(c.in) || 0), 0);
}

/** The mirror of biggestOut, so a sender is shown in the coin they sent most of. */
function biggestIn(p: Party) {
  return [...p.coins]
    .filter((c) => Number(c.in) > 0)
    .sort((a, b) => Number(b.in) - Number(a.in))[0];
}

function short(addr: string) {
  return `${addr.slice(0, 6)}…${addr.slice(-4)}`;
}

export type Totals = {
  direction: "out" | "in" | "none";
  asset: string;
  totalOut: string;
  otherAssets: string;
  totalIn: string;
  inAsset: string;
  inOtherAssets: string;
  sendCount: number;
  senders: Sender[];
  ranked: Party[];
};

/**
 * A statement that only counts money leaving prints a zero and an empty page for a wallet
 * whose whole history is money arriving. The spend total stays exactly what it was, and
 * the other direction is measured beside it rather than folded into it: a funder who paid
 * us is not a person we paid, and adding the two would make the headline number a lie.
 */
export function summarise(parties: Party[]): Totals {
  const byAsset = new Map<string, { total: number; people: number }>();
  const byInAsset = new Map<string, { total: number; people: number }>();
  for (const p of parties) {
    for (const c of p.coins) {
      const out = Number(c.out) || 0;
      const inn = Number(c.in) || 0;
      if (out > 0) {
        const row = byAsset.get(c.asset) ?? { total: 0, people: 0 };
        row.total += out;
        row.people++;
        byAsset.set(c.asset, row);
      }
      if (inn > 0 && !p.service) {
        const row = byInAsset.get(c.asset) ?? { total: 0, people: 0 };
        row.total += inn;
        row.people++;
        byInAsset.set(c.asset, row);
      }
    }
  }

  const rankedAssets = [...byAsset.entries()].sort((a, b) => b[1].total - a[1].total);
  const [mainAsset, main] = rankedAssets[0] ?? ["USDC", { total: 0, people: 0 }];
  const rest = rankedAssets.slice(1);

  const rankedIn = [...byInAsset.entries()].sort((a, b) => b[1].total - a[1].total);
  const [inAsset, mainIn] = rankedIn[0] ?? ["USDC", { total: 0, people: 0 }];
  const inRest = rankedIn.slice(1);

  // The paid index is a service we bought, not a person who sent us money. A faucet is a
  // machine and is named as one rather than left looking like a stranger.
  const senders: Sender[] = [...parties]
    .filter((p) => !p.service && inOf(p) > 0)
    .sort((a, b) => inOf(b) - inOf(a))
    .slice(0, 6)
    .map((p) => {
      const got = biggestIn(p);
      return {
        name: p.faucet ? "testnet faucet" : (p.name ?? short(p.address)),
        amount: got ? money(Number(got.in) || 0, got.asset) : money(0, inAsset),
        flows: p.flows,
        lastSeen: p.lastSeen,
        memorised: p.memorised,
      };
    });

  const ranked = [...parties]
    .filter((p) => outOf(p) > 0)
    .sort((a, b) => outOf(b) - outOf(a))
    .slice(0, 6);

  const direction: Totals["direction"] = main.total > 0 ? "out" : mainIn.total > 0 ? "in" : "none";

  return {
    direction,
    asset: direction === "in" ? inAsset : mainAsset,
    totalOut: money(main.total, mainAsset),
    otherAssets: rest.map(([a, r]) => `${money(r.total, a)} to ${r.people}`).join(" · "),
    totalIn: money(mainIn.total, inAsset),
    inAsset,
    inOtherAssets: inRest.map(([a, r]) => `${money(r.total, a)} in`).join(" · "),
    sendCount: senders.length,
    senders,
    ranked,
  };
}

export type Window = { start: number; end: number; label: string };

function dayLabel(ms: number): string {
  const d = new Date(ms);
  return `${d.getUTCDate()} ${MONTH_NAMES[d.getUTCMonth()]}`;
}

/**
 * A statement window that a person can name and a chain can answer. A month is the
 * calendar month in UTC, which is the same boundary the monthly limit uses. A week is
 * today and the six days before it in UTC, not a locale week: Sunday in one country is
 * Saturday in another, and a figure that changes with the reader is not a statement.
 */
export function windowOf(range: Range, now = Date.now()): Window {
  const d = new Date(now);
  const year = d.getUTCFullYear();
  const month = d.getUTCMonth();

  if (range === "week") {
    const end = Date.UTC(year, month, d.getUTCDate() + 1);
    const start = end - 7 * DAY;
    const a = new Date(start);
    const b = new Date(end - 1);
    const label =
      a.getUTCMonth() === b.getUTCMonth()
        ? `${a.getUTCDate()} to ${b.getUTCDate()} ${MONTH_NAMES[a.getUTCMonth()]} ${a.getUTCFullYear()}`
        : a.getUTCFullYear() === b.getUTCFullYear()
          ? `${dayLabel(start)} to ${dayLabel(end - 1)} ${a.getUTCFullYear()}`
          : `${dayLabel(start)} ${a.getUTCFullYear()} to ${dayLabel(end - 1)} ${b.getUTCFullYear()}`;
    return { start, end, label };
  }

  return {
    start: Date.UTC(year, month, 1),
    end: Date.UTC(year, month + 1, 1),
    label: `${MONTH_NAMES[month]} ${year}`,
  };
}

function headlineFor(range: Range) {
  return range === "week" ? "Your week, as the agent remembers it" : "Your month, as the agent remembers it";
}

/** The card a page with no wallet shows: real geometry, zeros, and no invented money. */
export function previewStatement(network: string, range: Range = "month"): Statement {
  return {
    wallet: "0x" + "0".repeat(64),
    network,
    preview: true,
    range,
    period: windowOf(range).label,
    headline: headlineFor(range),
    inPeriod: money(0, "USDC"),
    outPeriod: money(0, "USDC"),
    netPeriod: money(0, "USDC"),
    netDirection: "even",
    otherPeriod: "",
    moves: [],
    movesComplete: true,
    direction: "none",
    totalOut: money(0, "USDC"),
    otherAssets: "",
    asset: "USDC",
    totalIn: money(0, "USDC"),
    inAsset: "USDC",
    inOtherAssets: "",
    sendCount: 0,
    senders: [],
    months: [],
    people: [],
    remembered: 0,
    bought: 0,
    paid: money(0, "USDC"),
    price: money(priceUsdc(), "USDC"),
    generatedAt: new Date().toISOString().slice(0, 16).replace("T", " "),
  };
}

export async function buildStatement(range: Range = "month"): Promise<Statement> {
  const s = session();
  const win = windowOf(range);
  const [parties, months, stats, windowRead] = await Promise.all([
    counterparties(s.wallet, s.network),
    monthlyTotals(s.wallet, s.network),
    memoryStats(),
    recentStatement(s.wallet, s.network, win.start, 5),
  ]);

  const totals = summarise(parties);

  const netBase = windowRead.money.usdcIn - windowRead.money.usdcOut;
  const netDirection: Statement["netDirection"] = netBase === 0n ? "even" : netBase > 0n ? "in" : "out";
  const netAbs = netBase < 0n ? -netBase : netBase;
  const otherBits = [
    ...windowRead.money.otherIn.map((r) => `${r.amount} ${r.asset} in`),
    ...windowRead.money.otherOut.map((r) => `${r.amount} ${r.asset} out`),
  ];

  return {
    wallet: s.wallet,
    network: s.network,
    preview: false,
    range,
    period: win.label,
    headline: headlineFor(range),
    inPeriod: money(Number(windowRead.money.usdcIn) / USDC_UNIT, "USDC"),
    outPeriod: money(Number(windowRead.money.usdcOut) / USDC_UNIT, "USDC"),
    netPeriod: netDirection === "even" ? money(0, "USDC") : `${netDirection === "in" ? "+" : "−"}${money(Number(netAbs) / USDC_UNIT, "USDC")}`,
    netDirection,
    otherPeriod:
      otherBits.slice(0, 4).join(" · ") + (otherBits.length > 4 ? ` · ${otherBits.length - 4} more` : ""),
    moves: windowRead.moves,
    movesComplete: windowRead.complete,
    direction: totals.direction,
    totalOut: totals.totalOut,
    otherAssets: totals.otherAssets,
    asset: totals.asset,
    totalIn: totals.totalIn,
    inAsset: totals.inAsset,
    inOtherAssets: totals.inOtherAssets,
    sendCount: totals.sendCount,
    senders: totals.senders,
    months: [...months]
      .filter((m) => m.asset === totals.asset)
      .sort((a, b) => (a.month < b.month ? -1 : 1))
      .slice(-5)
      .map((m) => ({
        month: m.month,
        amount: Number(totals.direction === "in" ? m.in : m.out) || 0,
        label: MONTH_NAMES[Number(m.month.slice(5, 7)) - 1] ?? m.month,
      })),
    people: totals.ranked.map((p) => {
      const paid = biggestOut(p);
      return {
        name: p.name ?? short(p.address),
        amount: paid ? money(Number(paid.out) || 0, paid.asset) : money(0, totals.asset),
        flows: p.flows,
        // Only what the transfers show. A repeated gap is an observed pattern,
        // never a promise about the next payment.
        cadence: p.gapDays ? (p.gapDays === 1 ? "about every day" : `about every ${p.gapDays}d`) : null,
        lastSeen: p.lastSeen,
        memorised: p.memorised,
      };
    }),
    remembered: stats.total,
    bought: purchases(s.wallet, s.network).length,
    paid: money(totalSpent(s.wallet, s.network), "USDC"),
    price: money(priceUsdc(), "USDC"),
    generatedAt: new Date().toISOString().slice(0, 16).replace("T", " "),
  };
}

const C = {
  paper: "#f5f2ea",
  sunk: "#ece7dc",
  ink: "#211f1b",
  ink2: "#5d5a51",
  ink3: "#908c81",
  rule: "#d9d3c5",
  wash: "#f2e5da",
  clay: "#a34f24",
  moss: "#4c6b3f",
};

const SERIF = `'Iowan Old Style','Palatino Linotype',Palatino,Georgia,serif`;
const SANS = `-apple-system,'Helvetica Neue','Segoe UI',Roboto,sans-serif`;
const MONO = `ui-monospace,'SF Mono',Menlo,Consolas,monospace`;

function esc(s: string) {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

function fit(s: string, max: number) {
  return s.length > max ? `${s.slice(0, max - 1)}…` : s;
}

/**
 * The card is typeset vector text rather than a generated picture on purpose. Every
 * image model we can reach draws convincing paper and unreliable digits, and a
 * statement with a total that is wrong by forty cents destroys the one claim this
 * product makes. Same numbers whether it is printed, shared or posted.
 *
 * Credits and debits are drawn as two sides of one figure rather than one headline,
 * because a wallet whose whole history is money arriving must not print a zero as if
 * nothing happened. The plus and minus are real vector strokes, so they survive a PNG
 * export and never depend on a font having the glyph.
 */
function arrow(cx: number, cy: number, r: number, kind: "in" | "out") {
  const fill = kind === "in" ? C.moss : C.clay;
  const arm = Math.round(r * 0.48);
  const cross =
    kind === "in"
      ? `M${cx - arm} ${cy}H${cx + arm}M${cx} ${cy - arm}V${cy + arm}`
      : `M${cx - arm} ${cy}H${cx + arm}`;
  return `<g data-icon="${kind}"><circle cx="${cx}" cy="${cy}" r="${r}" fill="${fill}"/><path d="${cross}" stroke="${C.paper}" stroke-width="${r > 16 ? 3 : 2.5}" stroke-linecap="round"/></g>`;
}

function shortDate(at: string | null) {
  if (!at) return "no date";
  const d = new Date(at);
  if (Number.isNaN(d.getTime())) return "no date";
  return `${d.getUTCDate()} ${MONTH_NAMES[d.getUTCMonth()]}`;
}

export function cardSvg(d: Statement, w = 1080, h = 1350) {
  const pad = 82;
  const right = w - pad;
  const inner = w - pad * 2;
  const out: string[] = [];
  const split = pad + 440;
  const col2 = split + 30;
  const fig = (s: string) => s.split(" ")[0];
  const rangeWord = d.range === "week" ? "this week" : "this month";

  out.push(`<rect width="${w}" height="${h}" fill="${C.paper}"/>`);
  out.push(`<rect x="0" y="0" width="${w}" height="10" fill="${C.clay}"/>`);
  out.push(
    `<text x="${pad}" y="126" font-family="${SANS}" font-size="21" letter-spacing="6" fill="${C.ink2}">KEN</text>`,
    `<text x="${right}" y="126" text-anchor="end" font-family="${SANS}" font-size="21" letter-spacing="2" fill="${C.ink3}">STATEMENT</text>`,
    `<line x1="${pad}" y1="158" x2="${right}" y2="158" stroke="${C.rule}" stroke-width="1.5"/>`,
    `<text x="${pad}" y="238" font-family="${SERIF}" font-size="52" fill="${C.ink}">${esc(d.headline)}</text>`,
    `<text x="${pad}" y="284" font-family="${MONO}" font-size="23" fill="${C.ink3}">${esc(short(d.wallet))} · ${esc(d.network)} · ${esc(d.period)} UTC</text>`,
  );

  // The cost panel and the footer are reserved from the bottom first. Five moves are
  // a known height, and the notes above them vary, so the whole block is placed from
  // the rule down rather than from hand-measured row offsets.
  const boxH = 176;
  const footerTop = h - 118;
  const boxTop = footerTop - boxH - 26;

  let y = 372;
  out.push(`<line x1="${pad}" y1="${y}" x2="${right}" y2="${y}" stroke="${C.rule}" stroke-width="1.5"/>`);

  y = 416;
  out.push(
    `<text x="${pad}" y="${y}" font-family="${SANS}" font-size="19" letter-spacing="3" fill="${C.ink3}">MONEY IN</text>`,
    `<text x="${col2}" y="${y}" font-family="${SANS}" font-size="19" letter-spacing="3" fill="${C.ink3}">MONEY OUT</text>`,
  );

  const iconY = y + 68;
  out.push(
    arrow(pad + 24, iconY, 22, "in"),
    arrow(col2 + 24, iconY, 22, "out"),
    `<text x="${pad + 62}" y="${iconY + 24}" font-family="${SERIF}" font-size="60" fill="${C.ink}">${esc(fig(d.inPeriod))}</text>`,
    `<text x="${col2 + 62}" y="${iconY + 24}" font-family="${SERIF}" font-size="60" fill="${C.ink}">${esc(fig(d.outPeriod))}</text>`,
    `<text x="${pad + 62}" y="${iconY + 56}" font-family="${SANS}" font-size="22" fill="${C.ink2}">USDC in</text>`,
    `<text x="${col2 + 62}" y="${iconY + 56}" font-family="${SANS}" font-size="22" fill="${C.ink2}">USDC out</text>`,
    `<line x1="${split}" y1="${y - 4}" x2="${split}" y2="${iconY + 44}" stroke="${C.rule}" stroke-width="1.5"/>`,
  );

  let lineY = iconY + 100;
  const noUsdc = Number(fig(d.inPeriod)) === 0 && Number(fig(d.outPeriod)) === 0;
  const netLine = noUsdc
    ? d.otherPeriod
      ? `no USDC moved ${rangeWord}`
      : `no money moved ${rangeWord}`
    : d.netDirection === "even"
      ? `net ${d.netPeriod} ${rangeWord}, money in and out match`
      : `net ${d.netPeriod} ${rangeWord}`;
  out.push(`<text x="${pad}" y="${lineY}" font-family="${SANS}" font-size="26" fill="${C.ink2}">${esc(netLine)}</text>`);
  lineY += 34;

  if (d.otherPeriod) {
    out.push(`<text x="${pad}" y="${lineY}" font-family="${SANS}" font-size="21" fill="${C.ink3}">${esc(d.otherPeriod)}</text>`);
    lineY += 28;
  }
  if (!d.movesComplete) {
    out.push(
      `<text x="${pad}" y="${lineY}" font-family="${SANS}" font-size="19" fill="${C.ink3}">only the newest 50 transactions were read, so older money may be missing from this window</text>`,
    );
    lineY += 26;
  }

  const rulesY = lineY + 8;
  const headY = rulesY + 44;
  const firstRow = headY + 52;
  out.push(`<line x1="${pad}" y1="${rulesY}" x2="${right}" y2="${rulesY}" stroke="${C.rule}" stroke-width="1.5"/>`);
  out.push(
    `<text x="${pad}" y="${headY}" font-family="${SANS}" font-size="19" letter-spacing="3" fill="${C.ink3}">LAST 5 MOVES</text>`,
    `<text x="${right}" y="${headY}" text-anchor="end" font-family="${SANS}" font-size="17" letter-spacing="2" fill="${C.ink3}">newest first</text>`,
  );

  if (!d.moves.length) {
    out.push(
      `<text x="${pad}" y="${firstRow}" font-family="${SANS}" font-size="23" fill="${C.ink3}">no transfers ${rangeWord}</text>`,
    );
  }

  d.moves.slice(0, 5).forEach((m, i) => {
    const rowY = firstRow + i * 56;
    out.push(
      arrow(pad + 13, rowY - 9, 13, m.dir),
      `<text x="${pad + 38}" y="${rowY}" font-family="${SERIF}" font-size="28" fill="${C.ink}">${esc(fit(m.who, 26))}</text>`,
      `<text x="${right - 380}" y="${rowY}" font-family="${MONO}" font-size="20" fill="${C.ink3}">${esc(shortDate(m.at))}</text>`,
      `<text x="${right}" y="${rowY}" text-anchor="end" font-family="${MONO}" font-size="25" fill="${C.ink}">${esc(`${m.dir === "in" ? "+" : "−"}${m.amount} ${m.asset}`)}</text>`,
      `<line x1="${pad}" y1="${rowY + 13}" x2="${right}" y2="${rowY + 13}" stroke="${C.wash}" stroke-width="1"/>`,
    );
  });

  out.push(
    `<rect x="${pad}" y="${boxTop}" width="${inner}" height="${boxH}" fill="${C.sunk}"/>`,
    `<text x="${pad + 32}" y="${boxTop + 44}" font-family="${SANS}" font-size="19" letter-spacing="3" fill="${C.ink2}">WHAT IT COST TO KNOW ALL THIS</text>`,
    `<text x="${pad + 32}" y="${boxTop + 104}" font-family="${SERIF}" font-size="50" fill="${C.ink}">${esc(d.bought ? d.paid : "0.00 USDC")}</text>`,
    `<text x="${pad + 32}" y="${boxTop + 144}" font-family="${SANS}" font-size="22" fill="${C.ink2}">paid to learn ${d.bought} ${d.bought === 1 ? "fact" : "facts"} at ${esc(d.price)} each</text>`,
    `<text x="${right - 32}" y="${boxTop + 104}" text-anchor="end" font-family="${SERIF}" font-size="50" fill="${C.ink}">${d.remembered}</text>`,
    `<text x="${right - 32}" y="${boxTop + 144}" text-anchor="end" font-family="${SANS}" font-size="22" fill="${C.ink2}">${d.remembered === 1 ? "thing" : "things"} kept on Walrus</text>`,
  );

  out.push(
    `<text x="${pad}" y="${h - 62}" font-family="${SANS}" font-size="20" fill="${C.ink3}">amounts read from the chain · names and notes read from memory · ${esc(d.generatedAt)} UTC</text>`,
  );
  if (d.preview) {
    out.push(
      `<text x="${pad}" y="${h - 30}" font-family="${SANS}" font-size="20" fill="${C.clay}">connect a wallet on the statement page to read your own</text>`,
    );
  }

  return `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}" role="img" aria-label="Statement for ${esc(short(d.wallet))}">${out.join("")}</svg>`;
}
