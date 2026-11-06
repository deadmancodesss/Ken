/*
 * The morning brief is the one sentence the agent says without being asked, so every
 * number in it has to survive somebody checking it. Nothing here touches a chain, a
 * model or a wallet. These are the arithmetic and wording rules of public/brief.js,
 * the same file app.html imports, so a sentence that fails here is a sentence the
 * agent would have spoken wrong on stage.
 */

let fails = 0;
const expect = (what: string, ok: boolean) => {
  console.log(`${ok ? "ok   " : "FAIL "} ${what}`);
  if (!ok) fails++;
};

const { dueNow, runway, brief } = await import("../public/brief.js");

const row = (over: any = {}) => ({
  name: "Sana",
  note: "buys groceries every couple of days",
  asset: "USDC",
  usual: "0.516443 USDC",
  expected_on: "2026-11-03",
  state: "due",
  ...over,
});

const state = (over: any = {}) => ({
  due: { rows: [], committed: [], ...(over.due ?? {}) },
  stats: over.stats ?? { total: 18 },
  spend: over.spend ?? { usdc: 0.06, lookups: 6, price: 0.01 },
  ...over,
});

const balance = (amount: number) => ({ holdings: [{ symbol: "USDC", amount }, { symbol: "SUI", amount: 3 }] });
const at = (hour: number) => new Date(2026, 10, 3, hour, 20);

expect("a state with nothing read gives no sentence rather than a wrong one", brief(state({ due: null }) as any, balance(10), at(9)) === "");

const morning = brief(state(), balance(10), at(9));
const noon = brief(state(), balance(10), at(14));
const night = brief(state(), balance(10), at(21));
expect("before noon it says good morning", morning.startsWith("Good morning."));
expect("in the afternoon it says good afternoon", noon.startsWith("Good afternoon."));
expect("after six it says good evening", night.startsWith("Good evening."));
expect("the opening says the one thing the code can prove, that it asked nobody", morning.includes("because I already knew it"));
expect("the opening does not claim a daily cost figure that no field in the payload carries", !morning.includes("cost money today"));
expect("an empty ledger is answered honestly rather than cheerfully", morning.includes("Nothing is overdue and nothing is due today."));

const mixed = state({
  due: {
    rows: [row({ name: "Sana" }), row({ name: "Imran", state: "late", expected_on: "2026-10-04", usual: "1.5 USDC" }), row({ name: "Tara" }), row({ name: "Dev" }), row({ name: "Ravi" })],
  },
});
expect("an overdue line is read before one that merely lands today", dueNow(mixed)[0].name === "Imran");
expect("a brief never reads more than three names", dueNow(mixed).length === 3);
expect("the fourth and fifth people are left out rather than crowding the sentence", !brief(mixed, balance(10), at(9)).includes("Ravi"));

const spokenText = brief(mixed, balance(12.63), at(9));
expect("a raw chain amount is rounded before it is spoken", spokenText.includes("0.52 USDC") && !spokenText.includes("0.516443"));
expect("the person's own note is quoted back to them", spokenText.includes('your note reads "buys groceries every couple of days"'));
expect("an overdue line says when it was due", spokenText.includes("Imran is past due, it was due"));

const dirty = state({
  due: {
    rows: [
      row({
        name: "Harbor Print Studio",
        note: "business, print and signage shop. Bought for 0.01 USDC from the paid index on 2026-11-01, tx 8tucBNY7DBfADas9BYF4BpCY6R974vgVts9MAcQxZ57J",
      }),
    ],
  },
});
const dirtyText = brief(dirty, balance(10), at(9));
expect("a note holding a whole address or digest never reaches the sentence", !/0x[0-9a-f]{20,}/i.test(dirtyText) && !dirtyText.includes("8tucBNY7DBfADas9BYF4BpCY6R974vgVts9MAcQxZ57J"));
expect("no raw ISO date is ever spoken", !/\d{4}-\d{2}-\d{2}/.test(dirtyText));

const committed = state({
  due: {
    rows: [row()],
    committed: [
      { asset: "USDC", per_month: "15.49 USDC", people: ["Sana"] },
      { asset: "SUI", per_month: "1.50 SUI", people: ["Dev"] },
    ],
  },
});
const committedText = brief(committed, balance(12.63), at(9));
expect("the monthly figure is spoken, tied to the runway it pays for", committedText.includes("4 weeks of the 15.49 USDC a month you have committed"));
expect("a second currency is not silently dropped", committedText.includes("1.5 SUI a month with Dev"));
expect("a number is said once per breath, so the same rate never appears in two sentences", committedText.split("15.49").length - 1 === 1);

expect("runway is null when nothing has been committed", runway(state(), balance(12.63)) === null);
expect("runway is null when the wallet holds nothing", runway(committed, balance(0)) === null);
expect("runway is null when the balance could not be read", runway(committed, { holdings: [] }) === null);
const short = runway(committed, balance(12.63));
expect("eighty one percent of a month is measured in weeks, not in a decimal nobody says", !!short && short.months < 1 && committedText.includes("weeks of the 15.49 USDC") && !committedText.includes("0.8 months"));
const long = runway(committed, balance(62));
expect("a runway over a month is spoken in months", !!long && long.months > 1 && brief(committed, balance(62), at(9)).includes("4.0 months of the 15.49 USDC"));

const paid = brief(committed, balance(62), at(9));
expect("a paid memory says what it cost and an unpaid one refuses to imply a saving", paid.includes("6 of them cost 0.06 USDC to buy"));
const free = brief(state({ spend: { usdc: 0, lookups: 0, price: 0.01 }, due: { rows: [row()], committed: [] } }), balance(62), at(9));
expect("with no lookups the brief says nothing was bought", free.includes("not one of them was bought") && !free.includes("to buy"));

expect("the brief keeps the project rule of no semicolons", !/;/.test(paid));
expect("the brief keeps the project rule of no em dashes", !/[—–]/.test(paid));
expect("the same wallet read twice says the same thing twice", brief(committed, balance(62), at(9)) === paid);

const unnamed = state({
  due: {
    rows: [row({ name: "0x8tucBNY7…", usual: null, note: "" }), row({ name: "Sana", state: "late", expected_on: "2026-11-02" })],
  },
});
const unnamedText = brief(unnamed, balance(10), at(9));
expect("a truncated address is never read out as a person's name", !unnamedText.includes("0x8tucBNY7"));
expect("an unreadable amount is left out rather than spoken as the word null", !unnamedText.includes("null"));
expect("an unnamed row still reaches the brief, because hiding a bill is worse than naming it badly", unnamedText.includes("An address you have not named"));

const crowd = state({
  due: { rows: [row()], committed: [{ asset: "SUI", per_month: "62.00 SUI", people: ["Sana", "Tara", "Imran"] }] },
});
expect("a monthly total built from three rhythms does not claim to belong to one person", brief(crowd, balance(10), at(9)).includes("62 SUI a month with Sana and 2 others"));
const pair = state({ due: { rows: [], committed: [{ asset: "SUI", per_month: "62.00 SUI", people: ["Sana", "Tara"] }] } });
expect("one other person is other, not others", brief(pair, balance(10), at(9)).includes("with Sana and 1 other"));

const twice = state({ due: { rows: [row()], committed: [{ asset: "USDC", per_month: "15.49 USDC", people: ["Sana"] }] } });
expect("a person named once in a breath is not named again in the next sentence", brief(twice, balance(12.63), at(9)).split("Sana").length - 1 === 1);
expect("with no balance read the committed line still names who the money goes to", brief(twice, { holdings: [] }, at(9)).includes("15.49 USDC a month with Sana"));

console.log(`\n${fails ? fails + " FAILED" : "all brief checks green, nothing was spoken by a model"}`);
if (fails) process.exit(1);
