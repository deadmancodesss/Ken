/*
 * The morning brief.
 *
 * This file has no model in it on purpose. Every sentence is a reading of transfers the
 * server already measured, which is the same rule the statement card follows: a voice
 * agent that guesses is worse than one that says nothing. A repeated gap is reported as
 * an observed pattern, never as a bill or a due date. It is a module of its own rather
 * than code inside app.html because src/brief-test.ts runs the exact same functions the
 * page runs, so a sentence that is wrong in a test is wrong on screen.
 */
import { plain, spoken, when } from "./format.js";

/**
 * The person's own words are the whole reason this is not a wallet, so they are quoted
 * rather than paraphrased. A stored note can hold a whole address or digest, so it goes
 * through plain() on the way into a sentence, and it is cut at the first full stop
 * because a brief is one breath and a note can be a paragraph.
 */
function quote(text) {
  const one = plain(String(text || "").split(". ")[0]).replace(/[.,]+$/, "").trim();
  return one.length > 90 ? one.slice(0, 90).replace(/\s+\S*$/, "") + "…" : one;
}

function nameOf(p) {
  if (p?.faucet) return "the testnet faucet";
  if (/^0x/i.test(String(p?.name ?? ""))) return "an address you have not named";
  return p?.name || "an address you have not named";
}

/**
 * One past-tense line. It describes what the transfers show and stops there. There is
 * no next date in it, because a pattern is not a promise and the product does not know
 * when, or whether, money will move again.
 */
function patternLine(p) {
  const who = nameOf(p);
  const times = p.flows === 1 ? "once" : `${p.flows} times`;
  const way = p.direction === "mixed" ? "money moved both ways" : p.direction === "sent" ? "you paid them" : "they paid you";
  const cadence = p.gapDays ? `, about every ${p.gapDays === 1 ? "day" : `${p.gapDays} days`}` : "";
  const usual = p.usualAmount ? `, usually ${spoken(`${p.usualAmount} ${p.asset ?? ""}`.trim())}` : "";
  const last = p.lastSeen ? `, most recently ${when(p.lastSeen)}` : "";
  return `${who}: ${way} ${times}${cadence}${usual}${last}.`;
}

/**
 * The rows worth saying out loud, busiest first and never more than three, because a
 * brief that reads seven lines is a report and the person has not asked for one. The
 * paid index is a price per question rather than a relationship, so it is left out.
 */
export function patterns(state) {
  return (state?.parties ?? [])
    .filter((p) => !p?.service && p?.flows > 1)
    .sort((a, b) => b.flows - a.flows)
    .slice(0, 3);
}

/** One spoken paragraph. `now` is a Date so a test can pin the hour. */
export function brief(state, balance, now = new Date()) {
  if (!state) return "";
  const hour = now.getHours();
  const hello = hour < 12 ? "Good morning" : hour < 18 ? "Good afternoon" : "Good evening";
  const out = [`${hello}. Nothing here cost money to find out, because I already knew it.`];

  const rows = patterns(state);
  if (rows.length) {
    out.push(`${["", "One", "Two", "Three"][rows.length]} ${rows.length === 1 ? "pattern stands" : "patterns stand"} out from the transfers I read.`);
    for (const [i, p] of rows.entries()) out.push(patternLine(p));
    const note = quote(rows[0].note);
    if (note) out.push(`Your note reads "${note}".`);
  } else {
    out.push("No payment has repeated yet, so there is no pattern to tell you about.");
  }

  const stats = state.stats ?? {};
  const spend = state.spend ?? {};
  if (stats.total) {
    out.push(
      spend.lookups
        ? `I keep ${stats.total} lines on Walrus, and ${spend.lookups} of them cost ${spoken(`${spend.usdc} USDC`)} to buy.`
        : `I keep ${stats.total} lines on Walrus, and not one of them was bought.`,
    );
  }
  return out.join(" ");
}
