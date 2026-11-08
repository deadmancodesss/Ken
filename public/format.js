/*
 * The words this product will say out loud, kept apart from shared.js so a test can
 * import them in node. shared.js pulls in wallet.js, which reads window the moment it
 * is loaded, and a check that has to fake a browser is a check that quietly stops
 * running. Every function here is arithmetic and strings and nothing else.
 */

export const shortAddr = (a) => `${a.slice(0, 6)}…${a.slice(-4)}`;

export const SUI_ADDRESS = /^0x[0-9a-fA-F]{64}$/;

/**
 * The one place a digest becomes a link a person can press. SuiVision names the network
 * in the host, not the path: the mainnet host says "Invalid Transaction digest" for a
 * testnet digest, so the host has to carry the network. The digest is base58 and has no
 * character that needs escaping, but it is encoded anyway because this function is fed
 * values from a browser.
 */
const explorerHost = (network) =>
  network === "mainnet" ? "https://suivision.xyz" : "https://testnet.suivision.xyz";

export const explorerTx = (network, digest) =>
  `${explorerHost(network)}/txblock/${encodeURIComponent(String(digest))}`;

export const explorerAccount = (network, address) =>
  `${explorerHost(network)}/account/${encodeURIComponent(String(address))}`;

/** Enough of an address to recognise a paste without printing all 66 characters on screen. */
export const maskAddress = (a) => `${String(a).slice(0, 8)}…${String(a).slice(-6)}`;

/**
 * A tool result that says needs_address is the page's cue to open the one field a
 * microphone cannot fill. Two tools can say it in one turn, find_person without an
 * amount and pay_usdc with one, and the form must carry the amount because the person
 * already said what they wanted to send. Pure on purpose, so a node test can read it.
 */
export function addressNeed(steps) {
  const needs = [];
  for (const step of steps || []) {
    const r = step?.result;
    if (!r || typeof r !== "object" || r.needs_address !== true) continue;
    const who = String(r.who ?? r.not_found ?? "").trim();
    if (!who) continue;
    const amount = Number(r.amount);
    needs.push({
      who,
      amount: Number.isFinite(amount) && amount > 0 ? amount : null,
      // The coin travels with the amount, or the address form would finish a SUI
      // sentence as a USDC payment.
      asset: r.asset === "SUI" ? "SUI" : "USDC",
      looksLikeAddress: r.looks_like_address === true,
      ...(r.inspect === true ? { inspect: true } : {}),
    });
  }
  return needs.find((n) => n.amount !== null) ?? needs[0] ?? null;
}

/**
 * A tool result that says needs_request_fields is the page's cue to open the small
 * request form. The amount, what the money is for, and the lifetime come from the
 * sentence the person already spoke, and the form lets them correct any of them
 * before a public link exists. Pure on purpose, so a node test can read it.
 */
export function requestNeed(steps) {
  for (const step of steps || []) {
    const r = step?.result;
    if (!r || typeof r !== "object" || r.needs_request_fields !== true) continue;
    const usdc = Number(r.usdc);
    const minutes = Number(r.minutes);
    const max = Number(r.max_usdc);
    return {
      usdc: Number.isFinite(usdc) && usdc > 0 ? usdc : null,
      whatFor: typeof r.what_for === "string" ? r.what_for : "",
      minutes: [30, 120, 1440].includes(minutes) ? minutes : 30,
      maxUsdc: Number.isFinite(max) && max > 0 ? max : 5,
    };
  }
  return null;
}

/**
 * The four invented people in the demo cast each have a drawn portrait in
 * public/assets. Anything else gets an empty string, and the caller draws no
 * face, because handing a stranger a stock portrait is how this product starts
 * pretending to know someone it does not.
 */
const FACES = { sana: "face-sana", dev: "face-dev", tara: "face-tara", imran: "face-imran" };
export const faceUrl = (name) => {
  const f = FACES[String(name ?? "").trim().toLowerCase()];
  return f ? `/assets/${f}.webp` : "";
};

// Chain units and ISO dates are the two things this product exists to hide.
export function spoken(text) {
  const [num, ...rest] = String(text).split(" ");
  const x = Number(num);
  if (!Number.isFinite(x)) return text;
  const unit = rest.join(" ");
  if (x !== 0 && Math.abs(x) < 0.01) return unit ? `under a cent of ${unit}` : "under a cent";
  return [x >= 100 ? String(Math.round(x)) : x.toFixed(2).replace(/\.?0+$/, ""), unit].join(" ");
}

export function when(iso) {
  if (!iso) return "never";
  // Both sides are pinned to local midday, because a stored date is a calendar day and
  // a millisecond difference across a timezone boundary used to call today yesterday.
  const noon = (d) => new Date(d).setHours(12, 0, 0, 0);
  const days = Math.round((noon(new Date()) - noon(iso.slice(0, 10))) / 86_400_000);
  if (days <= 0) return "today";
  if (days === 1) return "yesterday";
  if (days < 7) return days + " days ago";
  if (days < 14) return "last week";
  return Math.floor(days / 7) + " weeks ago";
}

/**
 * A stored line is written by code, so it comes back holding a whole address, a whole
 * digest and an ISO date. Those are the exact three things this product exists to hide,
 * and Walrus memory has no delete, so the only place to fix it is on the way to screen.
 */
export function plain(text) {
  return String(text)
    .replace(/\bCounterparty\b/g, "An address")
    .replace(/\btx\s+([1-9A-HJ-NP-Za-km-z]{30,})/g, (_, d) => `tx ${d.slice(0, 8)}…`)
    .replace(/\b0x[0-9a-f]{40,}\b/gi, (a) => shortAddr(a))
    .replace(/\bon (\d{4}-\d{2}-\d{2})\b/g, (_, d) => when(d))
    .replace(/\b\d{4}-\d{2}-\d{2}\b/g, (d) => when(d))
    .replace(/\b\d+\.\d{5,}\s+[A-Z]{3,4}\b/g, (m) => spoken(m))
    .replace(/\b(\d+) transaction\(s\)/g, (_, n) => `${n} transaction${n === "1" ? "" : "s"}`)
    .replace(/\bnot yet labelled by the user\.?/gi, "Nothing has named it yet")
    .replace(/\buser revoked\b/gi, "you revoked")
    .replace(/\s+,/g, ",")
    .replace(/\s{2,}/g, " ")
    .trim();
}
