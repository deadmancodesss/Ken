/*
 * The morning brief is the one paragraph the agent says without being asked, so every
 * number in it has to survive somebody checking it. Nothing here touches a chain, a
 * model or a wallet. A repeated transfer is described as an observed pattern and never
 * as a bill or a due date.
 */

let fails = 0;
const expect = (what: string, ok: boolean) => {
  console.log(`${ok ? "ok   " : "FAIL "} ${what}`);
  if (!ok) fails++;
};

const { patterns, brief } = await import("../public/brief.js");

const person = (over: any = {}) => ({
  name: "Sana",
  note: "buys groceries every couple of days",
  address: "0x" + "a".repeat(64),
  asset: "USDC",
  flows: 3,
  direction: "sent",
  gapDays: 2,
  usualAmount: "0.516443",
  lastSeen: "2026-11-03",
  service: false,
  faucet: false,
  ...over,
});

const state = (over: any = {}) => ({
  parties: over.parties ?? [],
  stats: over.stats ?? { total: 18 },
  spend: over.spend ?? { usdc: 0.06, lookups: 6, price: 0.01 },
});

const at = (hour: number) => new Date(2026, 10, 3, hour, 20);

expect("a state with nothing read gives no sentence rather than a wrong one", brief(null as any, {}, at(9)) === "");

const morning = brief(state(), {}, at(9));
const noon = brief(state(), {}, at(14));
const night = brief(state(), {}, at(21));
expect("before noon it says good morning", morning.startsWith("Good morning."));
expect("in the afternoon it says good afternoon", noon.startsWith("Good afternoon."));
expect("after six it says good evening", night.startsWith("Good evening."));
expect("the opening says the one thing the code can prove, that it asked nobody", morning.includes("because I already knew it"));
expect("an empty ledger says no pattern has repeated", morning.includes("No payment has repeated yet"));

const mixed = state({
  parties: [
    person({ name: "Sana", flows: 5 }),
    person({ name: "Imran", flows: 4, usualAmount: "1.5" }),
    person({ name: "Tara", flows: 3 }),
    person({ name: "Ravi", flows: 2 }),
  ],
});
expect("patterns are read busiest first", patterns(mixed)[0].name === "Sana");
expect("a brief never reads more than three people", patterns(mixed).length === 3);
expect("the fourth person is left out rather than crowding the sentence", !brief(mixed, {}, at(9)).includes("Ravi"));

const spokenText = brief(mixed, {}, at(9));
expect("a raw chain amount is rounded before it is spoken", spokenText.includes("0.52 USDC") && !spokenText.includes("0.516443"));
expect("the person's own note is quoted back to them", spokenText.includes('Your note reads "buys groceries every couple of days"'));
expect("a repeated gap is described as an observation", spokenText.includes("about every 2 days"));
expect("the pattern is past tense rather than a prediction", spokenText.includes("you paid them 5 times"));
expect("no due language survives in any sentence", !/due|overdue|bill|subscription|committed|next payment/i.test(spokenText));

const dirty = state({
  parties: [
    person({
      name: "Harbor Print Studio",
      note: "business, print and signage shop. Bought for 0.01 USDC from the paid index on 2026-11-01, tx 8tucBNY7DBfADas9BYF4BpCY6R974vgVts9MAcQxZ57J",
    }),
  ],
});
const dirtyText = brief(dirty, {}, at(9));
expect("a note holding a whole address or digest never reaches the sentence", !/0x[0-9a-f]{20,}/i.test(dirtyText) && !dirtyText.includes("8tucBNY7DBfAD9BYF4BpCY6R974vgVts9MAcQxZ57J"));
expect("no raw ISO date is ever spoken", !/\d{4}-\d{2}-\d{2}/.test(dirtyText));

const paid = brief(state({ parties: [person()] }), {}, at(9));
expect("a paid memory says what it cost", paid.includes("6 of them cost 0.06 USDC to buy"));
const free = brief(state({ parties: [person()], spend: { usdc: 0, lookups: 0, price: 0.01 } }), {}, at(9));
expect("with no lookups the brief says nothing was bought", free.includes("not one of them was bought") && !free.includes("to buy"));

expect("the brief keeps the project rule of no semicolons", !/;/.test(paid));
expect("the brief keeps the project rule of no em dashes", !/[—–]/.test(paid));
expect("the same wallet read twice says the same thing twice", brief(state({ parties: [person()] }), {}, at(9)) === paid);

const unnamed = state({
  parties: [person({ name: "0x8tucBNY7…", usualAmount: null, note: "", flows: 2 })],
});
const unnamedText = brief(unnamed, {}, at(9));
expect("a truncated address is never read out as a person's name", !unnamedText.includes("0x8tucBNY7"));
expect("an unreadable amount is left out rather than spoken as the word null", !unnamedText.includes("null") && !unnamedText.includes("undefined"));
expect("an unnamed row still reaches the brief with a plain label", unnamedText.includes("an address you have not named"));

const service = state({
  parties: [person({ name: "Paid address index", service: true, flows: 9 })],
});
expect("the paid index is a price per question, not a relationship", patterns(service).length === 0 && brief(service, {}, at(9)).includes("No payment has repeated yet"));

console.log(`\n${fails ? fails + " FAILED" : "all brief checks green, nothing was spoken by a model"}`);
if (fails) process.exit(1);
