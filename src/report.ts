import { counterparties, monthlyTotals, type Party } from "./knowledge.js";
import { memoryStats } from "./people.js";
import { priceUsdc, purchases, totalSpent } from "./x402.js";
import { session } from "./session.js";

export type Statement = {
  wallet: string;
  network: string;
  isDemo: boolean;
  period: string;
  headline: string;
  totalOut: string;
  otherAssets: string;
  asset: string;
  months: { month: string; amount: number; label: string }[];
  people: { name: string; amount: string; flows: number; cadence: string | null; lastSeen: string | null; memorised: boolean }[];
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

function amountOf(s: string) {
  return Number(s.replace(/[^0-9.]/g, "")) || 0;
}

function assetOf(p: Party) {
  return p.asset || "USDC";
}

function short(addr: string) {
  return `${addr.slice(0, 6)}…${addr.slice(-4)}`;
}

export async function buildStatement(): Promise<Statement> {
  const s = session();
  const [parties, months, stats] = await Promise.all([
    counterparties(s.wallet, s.network),
    monthlyTotals(s.wallet, s.network),
    memoryStats(),
  ]);

  // A wallet pays in more than one coin, and one headline number labelled USDC
  // that quietly includes a SUI transfer is the exact error this product exists
  // to avoid, so the card groups by asset before it adds anything up.
  const byAsset = new Map<string, { total: number; people: number }>();
  for (const p of parties) {
    const a = assetOf(p);
    const row = byAsset.get(a) ?? { total: 0, people: 0 };
    row.total += amountOf(p.net);
    row.people++;
    byAsset.set(a, row);
  }
  const rankedAssets = [...byAsset.entries()].sort((a, b) => b[1].total - a[1].total);
  const [mainAsset, main] = rankedAssets[0] ?? ["USDC", { total: 0, people: 0 }];
  const rest = rankedAssets.slice(1);

  const ranked = [...parties]
    .sort((a, b) => (assetOf(a) === assetOf(b) ? amountOf(b.net) - amountOf(a.net) : assetOf(a) === mainAsset ? -1 : 1))
    .slice(0, 6);

  return {
    wallet: s.wallet,
    network: s.network,
    isDemo: s.source === "demo",
    period: months[0]?.month ?? new Date().toISOString().slice(0, 7),
    headline: s.source === "demo" ? "A made-up circle, real transactions" : "Your week, as the agent remembers it",
    totalOut: money(main.total, mainAsset),
    otherAssets: rest.map(([a, r]) => `${money(r.total, a)} to ${r.people}`).join(" · "),
    asset: mainAsset,
    months: [...months]
      .sort((a, b) => (a.month < b.month ? -1 : 1))
      .slice(-5)
      .map((m) => ({
        month: m.month,
        amount: amountOf(m.total),
        label: MONTH_NAMES[Number(m.month.slice(5, 7)) - 1] ?? m.month,
      })),
    people: ranked.map((p) => ({
      name: p.name ?? short(p.address),
      amount: money(amountOf(p.net), assetOf(p)),
      flows: p.flows,
      cadence: p.gapDays ? `every ${p.gapDays}d` : null,
      lastSeen: p.lastSeen,
      memorised: p.memorised,
    })),
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
    `<text x="${pad}" y="126" font-family="${SANS}" font-size="21" letter-spacing="6" fill="${C.ink2}">TOTAL RECALL</text>`,
    `<text x="${right}" y="126" text-anchor="end" font-family="${SANS}" font-size="21" letter-spacing="2" fill="${C.ink3}">STATEMENT</text>`,
    `<line x1="${pad}" y1="158" x2="${right}" y2="158" stroke="${C.rule}" stroke-width="1.5"/>`,
    `<text x="${pad}" y="238" font-family="${SERIF}" font-size="56" fill="${C.ink}">${esc(d.headline)}</text>`,
    `<text x="${pad}" y="284" font-family="${MONO}" font-size="23" fill="${C.ink3}">${esc(short(d.wallet))} · ${esc(d.network)} · ${esc(d.period)}</text>`,
  );

  // One cursor down the page instead of hand-placed rows, and the cost panel plus
  // the footer are reserved from the bottom first. Content length varies with the
  // wallet, and fixed offsets are how the cost panel used to land on the footer.
  const boxH = 176;
  const footerTop = h - 118;
  const boxTop = footerTop - boxH - 26;
  const rowH = 56;

  let y = 392;
  out.push(
    `<text x="${pad}" y="${y}" font-family="${SERIF}" font-size="96" fill="${C.ink}">${esc(d.totalOut.split(" ")[0])}</text>`,
    `<text x="${pad}" y="${y + 40}" font-family="${SANS}" font-size="25" fill="${C.clay}">${esc(d.asset)} out, across the people below</text>`,
  );
  if (d.otherAssets) {
    out.push(`<text x="${pad}" y="${y + 74}" font-family="${SANS}" font-size="22" fill="${C.ink2}">${esc(d.otherAssets)}</text>`);
    y += 40;
  }

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

  y += 58;
  const shown = Math.max(0, Math.min(d.people.length, Math.floor((boxTop - 30 - y) / rowH)));
  out.push(`<line x1="${pad}" y1="${y - 34}" x2="${right}" y2="${y - 34}" stroke="${C.rule}" stroke-width="1.5"/>`);
  out.push(
    `<text x="${pad}" y="${y}" font-family="${SANS}" font-size="19" letter-spacing="3" fill="${C.ink3}">WHO GOT WHAT</text>`,
    `<text x="${colCadence}" y="${y}" font-family="${SANS}" font-size="19" letter-spacing="3" fill="${C.ink3}">RHYTHM</text>`,
    `<text x="${colAmount}" y="${y}" text-anchor="end" font-family="${SANS}" font-size="19" letter-spacing="3" fill="${C.ink3}">AMOUNT</text>`,
  );

  for (const p of d.people.slice(0, shown)) {
    y += rowH;
    out.push(
      `<circle cx="${pad + 7}" cy="${y - 10}" r="6" fill="${p.memorised ? C.moss : "none"}" stroke="${p.memorised ? "none" : C.ink3}" stroke-width="2"/>`,
      `<text x="${pad + 26}" y="${y}" font-family="${SERIF}" font-size="31" fill="${C.ink}">${esc(fit(p.name, 22))}</text>`,
      `<text x="${colCadence}" y="${y}" font-family="${SANS}" font-size="24" fill="${C.ink2}">${esc(p.cadence ?? "not enough yet")}</text>`,
      `<text x="${colAmount}" y="${y}" text-anchor="end" font-family="${MONO}" font-size="27" fill="${C.ink}">${esc(p.amount)}</text>`,
      `<line x1="${pad}" y1="${y + 15}" x2="${right}" y2="${y + 15}" stroke="${C.wash}" stroke-width="1"/>`,
    );
  }
  if (d.people.length > shown) {
    out.push(`<text x="${pad}" y="${y + 34}" font-family="${SANS}" font-size="21" fill="${C.ink3}">${d.people.length - shown} more people the agent knows that this card has no room for</text>`);
  }

  out.push(
    `<rect x="${pad}" y="${boxTop}" width="${inner}" height="${boxH}" fill="${C.sunk}"/>`,
    `<text x="${pad + 32}" y="${boxTop + 44}" font-family="${SANS}" font-size="19" letter-spacing="3" fill="${C.ink2}">WHAT IT COST TO KNOW ALL THIS</text>`,
    `<text x="${pad + 32}" y="${boxTop + 104}" font-family="${SERIF}" font-size="50" fill="${C.ink}">${esc(d.bought ? d.paid : "0.00 USDC")}</text>`,
    `<text x="${pad + 32}" y="${boxTop + 144}" font-family="${SANS}" font-size="22" fill="${C.ink2}">paid to learn ${d.bought} ${d.bought === 1 ? "fact" : "facts"} at ${esc(d.price)} each</text>`,
    `<text x="${right - 32}" y="${boxTop + 104}" text-anchor="end" font-family="${SERIF}" font-size="50" fill="${C.ink}">${d.remembered}</text>`,
    `<text x="${right - 32}" y="${boxTop + 144}" text-anchor="end" font-family="${SANS}" font-size="22" fill="${C.ink2}">things kept on Walrus</text>`,
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
