import { type Party, dueRows } from "./knowledge.js";

/*
 * Nothing here touches a chain or a model. Rhythms are arithmetic over dates, and
 * arithmetic is the part that must be exact, because a spoken "Imran is two days late"
 * is a claim about real money that the listener will check.
 */

let fails = 0;
const expect = (what: string, ok: boolean) => {
  console.log(`${ok ? "ok   " : "FAIL "} ${what}`);
  if (!ok) fails++;
};

const at = (y: number, m: number, d: number) => Date.parse(`${y}-${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")}T11:30:00Z`);
const TODAY = at(2026, 11, 2);

const party = (over: Partial<Party>): Party => ({
  address: "0x" + "1".repeat(64),
  name: null,
  note: "",
  asset: "USDC",
  flows: 2,
  net: "1",
  direction: "sent",
  firstSeen: "2026-10-01",
  lastSeen: "2026-11-01",
  usualAmount: "0.5",
  gapDays: null,
  memorised: true,
  ...over,
});

const rows = dueRows(
  [
    party({ name: "Sana", lastSeen: "2026-11-02", gapDays: 2, note: "buys groceries every couple of days" }),
    party({ name: "Imran", address: "0x" + "2".repeat(64), lastSeen: "2026-10-01", gapDays: 30, usualAmount: "40", note: "flat maintenance" }),
    party({ name: "Tara", address: "0x" + "3".repeat(64), lastSeen: "2026-10-20", gapDays: 15, usualAmount: "6.99" }),
    party({ name: "Dev", address: "0x" + "4".repeat(64), flows: 1, lastSeen: "2026-11-01", gapDays: null, asset: "SUI" }),
    party({ name: "Ravi", address: "0x" + "5".repeat(64), direction: "received", lastSeen: "2026-10-24", gapDays: 7, note: "the plumber, pays on Fridays" }),
    party({ name: "Mixed", address: "0x" + "6".repeat(64), direction: "mixed", lastSeen: "2026-11-01", gapDays: 10 }),
    party({ address: "0x" + "7".repeat(64), name: null, flows: 1, gapDays: null, memorised: false }),
  ],
  TODAY,
);

const byName = (n: string) => rows.find((r) => r.name === n)!;
const order = rows.map((r) => r.name);

expect("the past due ones are listed first", order[0] === "Imran");
expect("then what is coming up", order.slice(1, 3).join(",") === "Ravi,Tara" || order.slice(1, 3).includes("Tara"));
expect("a monthly rhythm three days past its date is late", byName("Imran").state === "late");
expect("the overrun is counted in days, not guessed", byName("Imran").line.includes("2 days overdue"));
expect("the exact date is still there as data beside the sentence", byName("Imran").expected_on === "2026-10-31");
expect("a fortnightly bill two days out is called due", byName("Tara").state === "due");
expect("a two day rhythm two days out is not yet due", byName("Sana").state === "on track");
expect("the warning window is a quarter of the rhythm, so daily noise stays quiet", byName("Sana").line.includes("another 2 days"));
expect("a single payment never invents a cadence", byName("Dev").state === "no rhythm yet");
expect("and says how many payments there were rather than a period", byName("Dev").line.includes("only 1 payment with Dev"));
expect("someone who only pays you is described as paying you", byName("Ravi").line.startsWith("Ravi pays you"));
expect("a two way relationship is not reported as a donation", byName("Mixed").who_pays === "both");
expect("a payer who has gone quiet is late too", byName("Ravi").state === "late");
expect("the amount quoted carries its own asset", byName("Imran").usual === "40 USDC" && byName("Dev").usual === "0.5 SUI");
expect("an unnamed one payment address is not offered as a person", !rows.some((r) => r.name?.startsWith("0x")));
expect("the note the user spoke travels with the row", byName("Imran").note === "flat maintenance");
expect("no sentence a model can read aloud contains an ISO date", rows.every((r) => !/\d{4}-\d{2}-\d{2}/.test(r.line)));
expect("the lines use no em dash and no semicolon", rows.every((r) => !/[—–;]/.test(r.line)));

const midnight = dueRows([party({ name: "Solo", lastSeen: "2026-10-03", gapDays: 30, flows: 2 })], Date.parse("2026-11-02T00:10:00Z"));
expect("a day that has just begun is not read as a day early", midnight[0].expected_on === "2026-11-02");
expect("and lands as due today rather than late", midnight[0].state === "due" && midnight[0].line.includes("due today"));

console.log(fails ? `\n${fails} rhythm check(s) failed` : `\n${rows.length} rhythms read, all checks green`);
process.exit(fails ? 1 : 0);
