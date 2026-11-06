/*
 * The morning brief.
 *
 * This file has no model in it on purpose. Every sentence is arithmetic over numbers
 * the server already read, which is the same rule the statement card follows: a voice
 * agent that guesses at a total is worse than one that says nothing. It is a module of
 * its own rather than code inside app.html because src/brief-test.ts runs the exact
 * same functions the page runs, so a sentence that is wrong in a test is wrong on
 * screen and gets caught before somebody records a demo.
 */
import { plain, spoken, when } from "./format.js";

const amount = (text) => Number(String(text ?? "").split(" ")[0]);
const sumBy = (rows, asset) => rows.filter((r) => r.asset === asset).reduce((t, r) => t + amount(r.per_month), 0);

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

/**
 * The rows worth saying out loud, overdue first, and never more than three, because a
 * brief that reads seven lines is a report and the person has not asked for a report.
 */
export function dueNow(state) {
  const rows = state?.due?.rows ?? [];
  return [...rows.filter((r) => r.state === "late"), ...rows.filter((r) => r.state === "due")].slice(0, 3);
}

/**
 * How long the money in the wallet lasts against what it has already committed to.
 * Returns null whenever the answer would be a guess, which includes the ordinary case
 * of a wallet that has committed to nothing.
 */
export function runway(state, balance) {
  const committed = state?.due?.committed ?? [];
  const perMonth = sumBy(committed, "USDC");
  if (!(perMonth > 0)) return null;
  const held = (balance?.holdings ?? []).find((h) => h.symbol === "USDC")?.amount;
  if (!Number.isFinite(held) || held <= 0) return null;
  const months = held / perMonth;
  return { perMonth, held, months, weeks: months * 4.345 };
}

/**
 * A total is the sum of every rhythm in that currency, so naming one person for a number
 * built from four is a wrong figure wearing a right name. One name is spoken as itself.
 */
function withWhom(people) {
  const list = people ?? [];
  if (!list.length) return "people you have not named";
  const first = /^0x/i.test(list[0]) ? "an address you have not named" : list[0];
  const more = list.length - 1;
  return more ? `${first} and ${more} ${more === 1 ? "other" : "others"}` : first;
}

/**
 * One overdue line. `usual` is null for a counterparty seen only once, and reading it
 * out as a missing number is how an agent says "about null", so the amount clause is
 * dropped instead. A name that is really a truncated address is never spoken as a name.
 */
function dueLine(r, quoteNote) {
  const who = /^0x/i.test(String(r.name)) ? "An address you have not named" : r.name;
  const timing = r.state === "late" ? `past due, it was due ${when(r.expected_on)}` : "due today";
  const line = [`${who} is ${timing}`];
  if (r.usual) line.push(`about ${spoken(r.usual)}`);
  // Quoting the person's own words back is the moment this stops being a wallet, so the
  // first line gets one. Three quotes in one breath is a reading, not a brief.
  const note = quoteNote ? quote(r.note) : "";
  if (note) line.push(`your note reads "${note}"`);
  else if (who !== r.name) line.push("nothing has named it yet");
  return line.join(", ") + ".";
}

/**
 * One spoken paragraph. `now` is a Date so the test can pin the hour and the word for
 * the time of day cannot drift between the check and the screen.
 */
export function brief(state, balance, now = new Date()) {
  if (!state?.due) return "";
  const hour = now.getHours();
  const hello = hour < 12 ? "Good morning" : hour < 18 ? "Good afternoon" : "Good evening";
  const out = [`${hello}. Nothing here cost money to find out, because I already knew it.`];

  const rows = dueNow(state);
  if (rows.length) {
    // Spelled out because this sentence is read aloud, and because the count is capped at
    // three, so there is no case where the word runs out.
    out.push(`${["", "One", "Two", "Three"][rows.length]} ${rows.length === 1 ? "thing needs" : "things need"} you.`);
    for (const [i, r] of rows.entries()) out.push(dueLine(r, i === 0));
  } else {
    out.push("Nothing is overdue and nothing is due today.");
  }

  /*
   * A monthly figure is said once per breath. The runway sentence already carries the
   * USDC rate, so listing it again above it would be the same number twice in four
   * seconds, and a brief that repeats itself is a brief nobody finishes listening to.
   * Currencies the runway cannot measure keep their own line.
   */
  const fly = runway(state, balance);
  const committed = (state.due.committed ?? []).filter((c) => !fly || c.asset !== "USDC");
  if (committed.length) {
    out.push(`You have committed ${committed.map((c) => `${spoken(c.per_month)} a month with ${withWhom(c.people)}`).join(", and ")}.`);
  }

  /*
   * The runway is the one number nobody can work out from a list of transactions, and it
   * is stated against its own figure rather than "of that", because the sentence above it
   * is conditional on the wallet having committed anything at all. A pronoun that
   * sometimes has no antecedent is a bug that only shows up out loud.
   */
  if (fly) {
    const span = fly.months >= 1 ? `${fly.months.toFixed(1)} months` : `about ${Math.max(1, Math.round(fly.weeks))} weeks`;
    out.push(`You hold ${spoken(`${fly.held} USDC`)}, which is ${span} of the ${spoken(`${fly.perMonth} USDC`)} a month you have committed.`);
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
