import { bills, counterparties, dueRows, monthlyTotals, type Due, type Party } from "./knowledge.js";
import { memoryStats } from "./people.js";
import { indexPayout, priceUsdc, purchases, totalSpent } from "./x402.js";
import { session } from "./session.js";

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
  isDemo: boolean;
  period: string;
  headline: string;
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
  people: { name: string; amount: string; flows: number; cadence: string | null; state: Due["state"] | null; lastSeen: string | null; memorised: boolean }[];
  overdue: number;
  dueNow: number;
  remembered: number;
  bought: number;
  paid: string;
  price: string;
  generatedAt: string;
};

const MONTH_NAMES = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

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

/**
 * A printed card has room for three words per person, not the sentence the voice lane
 * needs. Same measurement, shorter telling, so the card and the agent cannot disagree
 * about whether a payment is late.
 */
function duePhrase(d: Due, today = Date.now()) {
  if (d.state === "no rhythm yet" || !d.expected_on) return "no rhythm yet";
  const midnight = Math.floor(today / 86_400_000) * 86_400_000;
  const days = Math.round((Date.parse(`${d.expected_on}T00:00:00Z`) - midnight) / 86_400_000);
  if (days < 0) return `${-days}d late`;
  if (days === 0) return "due today";
  if (days === 1) return "due tomorrow";
  return `due in ${days}d`;
}

export async function buildStatement(): Promise<Statement> {
  const s = session();
  const [parties, months, stats] = await Promise.all([
    counterparties(s.wallet, s.network),
    monthlyTotals(s.wallet, s.network),
    memoryStats(),
  ]);

  const totals = summarise(parties);

  // One pass over the same parties the rest of the card reads, so the date on the
  // statement and the date the agent speaks out loud come from one measurement. The
  // paid index is left out because a per-question fee is not a bill.
  const due = bills(dueRows(parties), [indexPayout()]);
  const byAddress = new Map(due.map((d) => [d.address.toLowerCase(), d]));
  const overdue = due.filter((d) => d.state === "late").length;
  const dueNow = due.filter((d) => d.state === "due").length;

  return {
    wallet: s.wallet,
    network: s.network,
    isDemo: s.source === "demo",
    period: months[0]?.month ?? new Date().toISOString().slice(0, 7),
    headline: s.source === "demo" ? "A made-up circle, real transactions" : "Your week, as the agent remembers it",
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
      const d = byAddress.get(p.address.toLowerCase());
      const paid = biggestOut(p);
      return {
        name: p.name ?? short(p.address),
        amount: paid ? money(Number(paid.out) || 0, paid.asset) : money(0, totals.asset),
        flows: p.flows,
        cadence: d ? duePhrase(d) : p.gapDays ? `every ${p.gapDays}d` : null,
        state: d?.state ?? null,
        lastSeen: p.lastSeen,
        memorised: p.memorised,
      };
    }),
    overdue,
    dueNow,
    remembered: stats.total,
    bought: purchases(s.wallet).length,
    paid: money(totalSpent(s.wallet), "USDC"),
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
 */
export function cardSvg(d: Statement, w = 1080, h = 1350) {
  const pad = 82;
  const right = w - pad;
  const inner = w - pad * 2;
  const out: string[] = [];
  const colAmount = right;
  const colCadence = pad + 400;

  out.push(`<rect width="${w}" height="${h}" fill="${C.paper}"/>`);
  out.push(`<rect x="0" y="0" width="${w}" height="10" fill="${C.clay}"/>`);
  out.push(
    `<text x="${pad}" y="126" font-family="${SANS}" font-size="21" letter-spacing="6" fill="${C.ink2}">KEN</text>`,
    `<text x="${right}" y="126" text-anchor="end" font-family="${SANS}" font-size="21" letter-spacing="2" fill="${C.ink3}">STATEMENT</text>`,
    `<line x1="${pad}" y1="158" x2="${right}" y2="158" stroke="${C.rule}" stroke-width="1.5"/>`,
    `<text x="${pad}" y="238" font-family="${SERIF}" font-size="56" fill="${C.ink}">${esc(d.headline)}</text>`,
    `<text x="${pad}" y="284" font-family="${MONO}" font-size="23" fill="${C.ink3}">${esc(short(d.wallet))} · ${esc(d.network)} · ${esc(d.period)}</text>`,
  );

  // The one number on a statement a person can still act on. It only appears when the
  // rhythm actually says something, so a card with no dates on it does not shout.
  const dueWords = [d.overdue ? `${d.overdue} overdue` : "", d.dueNow ? `${d.dueNow} coming due` : ""].filter(Boolean).join(" · ");
  if (dueWords) {
    out.push(
      `<text x="${pad}" y="330" font-family="${SANS}" font-size="25" fill="${d.overdue ? C.clay : C.moss}">${esc(dueWords)}</text>`,
    );
  }

  // One cursor down the page instead of hand-placed rows, and the cost panel plus
  // the footer are reserved from the bottom first. Content length varies with the
  // wallet, and fixed offsets are how the cost panel used to land on the footer.
  const boxH = 176;
  const footerTop = h - 118;
  const boxTop = footerTop - boxH - 26;
  const rowH = 56;

  let y = 392;
  // A wallet whose history is all money arriving gets an honest inbound statement. The
  // spend total is still printed, quietly, because "nothing left this wallet" is the
  // answer to the zero a reader would otherwise think was a failure.
  const inbound = d.direction === "in";
  const primary = inbound ? d.totalIn : d.totalOut;
  const primaryAsset = inbound ? d.inAsset : d.asset;
  out.push(
    `<text x="${pad}" y="${y}" font-family="${SERIF}" font-size="96" fill="${C.ink}">${esc(primary.split(" ")[0])}</text>`,
    `<text x="${pad}" y="${y + 40}" font-family="${SANS}" font-size="25" fill="${C.clay}">${esc(primaryAsset)} ${inbound ? "in, from the people below" : "out, across the people below"}</text>`,
  );

  const notes: string[] = [];
  if (inbound) {
    notes.push(Number(d.totalOut.split(" ")[0]) > 0 ? `${d.totalOut} out` : "nothing left this wallet in this period");
    if (d.inOtherAssets) notes.push(d.inOtherAssets);
  } else {
    if (d.otherAssets) notes.push(d.otherAssets);
    if (Number(d.totalIn.split(" ")[0]) > 0) {
      notes.push(`${d.totalIn} in from ${d.sendCount} ${d.sendCount === 1 ? "address" : "addresses"}`);
    }
  }
  notes.slice(0, 3).forEach((line, i) => {
    out.push(
      `<text x="${pad}" y="${y + 74 + i * 34}" font-family="${SANS}" font-size="22" fill="${C.ink2}">${esc(line)}</text>`,
    );
  });
  if (notes.length) y += 40 + (notes.length - 1) * 34;

  y += 68;
  const bars = d.months.slice(-3);
  if (bars.length) {
    const peak = Math.max(...bars.map((b) => b.amount), 1);
    out.push(`<text x="${pad}" y="${y}" font-family="${SANS}" font-size="19" letter-spacing="3" fill="${C.ink3}">MONTH BY MONTH</text>`);
    for (const b of bars) {
      y += 42;
      const bw = Math.max(4, Math.round((b.amount / peak) * (inner - 250)));
      out.push(
        `<text x="${pad}" y="${y}" font-family="${SANS}" font-size="22" fill="${C.ink2}">${esc(b.label)}</text>`,
        `<rect x="${pad + 74}" y="${y - 16}" width="${inner - 250}" height="21" fill="${C.sunk}"/>`,
        `<rect x="${pad + 74}" y="${y - 16}" width="${bw}" height="21" fill="${C.clay}"/>`,
        `<text x="${right}" y="${y}" text-anchor="end" font-family="${MONO}" font-size="22" fill="${C.ink}">${esc(money(b.amount, d.asset))}</text>`,
      );
    }
  }

  type CardRow = {
    name: string;
    amount: string;
    lastSeen: string | null;
    memorised: boolean;
    cadence?: string | null;
    state?: Due["state"] | null;
  };
  const rows: CardRow[] = inbound ? d.senders : d.people;
  y += 58;
  const shown = Math.max(0, Math.min(rows.length, Math.floor((boxTop - 30 - y) / rowH)));
  out.push(`<line x1="${pad}" y1="${y - 34}" x2="${right}" y2="${y - 34}" stroke="${C.rule}" stroke-width="1.5"/>`);
  out.push(
    `<text x="${pad}" y="${y}" font-family="${SANS}" font-size="19" letter-spacing="3" fill="${C.ink3}">${inbound ? "WHO SENT IT" : "WHO GOT WHAT"}</text>`,
    `<text x="${colCadence}" y="${y}" font-family="${SANS}" font-size="19" letter-spacing="3" fill="${C.ink3}">${inbound ? "LAST SEEN" : "NEXT PAYMENT"}</text>`,
    `<text x="${colAmount}" y="${y}" text-anchor="end" font-family="${SANS}" font-size="19" letter-spacing="3" fill="${C.ink3}">${inbound ? "RECEIVED" : "AMOUNT"}</text>`,
  );

  for (const p of rows.slice(0, shown)) {
    y += rowH;
    // Late is the one colour a person needs to find fast on a printed sheet, so it
    // takes the accent and everything quieter stays in ink.
    const dueInk = p.state === "late" ? C.clay : p.state === "due" ? C.moss : p.state ? C.ink2 : C.ink3;
    const second = inbound ? (p.lastSeen ?? "no date") : (p.cadence ?? "no rhythm yet");
    out.push(
      `<circle cx="${pad + 7}" cy="${y - 10}" r="6" fill="${p.memorised ? C.moss : "none"}" stroke="${p.memorised ? "none" : C.ink3}" stroke-width="2"/>`,
      `<text x="${pad + 26}" y="${y}" font-family="${SERIF}" font-size="31" fill="${C.ink}">${esc(fit(p.name, 22))}</text>`,
      `<text x="${colCadence}" y="${y}" font-family="${SANS}" font-size="24" fill="${inbound ? C.ink3 : dueInk}">${esc(second)}</text>`,
      `<text x="${colAmount}" y="${y}" text-anchor="end" font-family="${MONO}" font-size="27" fill="${C.ink}">${esc(p.amount)}</text>`,
      `<line x1="${pad}" y1="${y + 15}" x2="${right}" y2="${y + 15}" stroke="${C.wash}" stroke-width="1"/>`,
    );
  }
  if (rows.length > shown) {
    out.push(
      `<text x="${pad}" y="${y + 34}" font-family="${SANS}" font-size="21" fill="${C.ink3}">${inbound ? `${rows.length - shown} more addresses sent money, with no room on this card` : `${rows.length - shown} more people the agent knows that this card has no room for`}</text>`,
    );
  }

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
  if (d.isDemo) {
    out.push(
      `<text x="${pad}" y="${h - 30}" font-family="${SANS}" font-size="20" fill="${C.clay}">the people named here are invented for the demo, every transaction is real</text>`,
    );
  }

  return `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}" role="img" aria-label="Statement for ${esc(short(d.wallet))}">${out.join("")}</svg>`;
}
