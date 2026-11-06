process.env.REMINDER_DB = ":memory:";
process.env.SEATS_DB = ":memory:";

const { addReminder, cancelReminder, dueReminders, markReminderFired, parseWhen, spokenWhen, upcomingReminders } = await import("./reminders.js");
const { seatFor, within } = await import("./seat.js");
const { useWallet } = await import("./session.js");
const { runTool } = await import("./tools.js");

/*
 * A reminder is the one promise that has to keep itself. The parser is tested against
 * a fixed clock, because a test that depends on what time it is run cannot tell a real
 * bug from a late afternoon. The store is tested under two wallets, because a reminder
 * for one person must never surface in another person's conversation.
 */

let fails = 0;
const expect = (what: string, ok: boolean) => {
  console.log(`${ok ? "ok   " : "FAIL "} ${what}`);
  if (!ok) fails++;
};

const at = (y: number, m: number, d: number, h: number, min: number) => new Date(y, m - 1, d, h, min, 0, 0);
const clock = at(2026, 11, 7, 10, 0);
const same = (a: Date | null, b: Date) => !!a && a.getTime() === b.getTime();

expect("in 30 seconds is thirty seconds from now", same(parseWhen("in 30 seconds", clock), new Date(clock.getTime() + 30_000)));
expect("in 20 minutes is twenty minutes from now", same(parseWhen("in 20 minutes", clock), at(2026, 11, 7, 10, 20)));
expect("in 1.5 hours is ninety minutes from now", same(parseWhen("in 1.5 hours", clock), at(2026, 11, 7, 11, 30)));
expect("in 2 days keeps the clock time", same(parseWhen("in 2 days", clock), at(2026, 11, 9, 10, 0)));
expect("at 6pm today is today when six is still ahead", same(parseWhen("at 6pm", clock), at(2026, 11, 7, 18, 0)));
expect("18:30 reads on the twenty four hour clock", same(parseWhen("18:30", clock), at(2026, 11, 7, 18, 30)));
expect("at 9am is tomorrow when nine has passed", same(parseWhen("at 9am", clock), at(2026, 11, 8, 9, 0)));
expect("tomorrow at 9 is tomorrow morning", same(parseWhen("tomorrow at 9", clock), at(2026, 11, 8, 9, 0)));
expect("tomorrow at 9:30 pm is tomorrow night", same(parseWhen("tomorrow at 9:30 pm", clock), at(2026, 11, 8, 21, 30)));
expect("a full ISO time is taken as given", same(parseWhen("2026-11-08T04:30:00.000Z", clock), new Date("2026-11-08T04:30:00.000Z")));
expect("words with no time in them are refused", parseWhen("sometime soon", clock) === null);
expect("an impossible hour is refused", parseWhen("at 25:00", clock) === null);

expect("a time today is said without a day word", spokenWhen(at(2026, 11, 7, 18, 0), clock) === "at 6:00 pm");
expect("tomorrow gets its own word", spokenWhen(at(2026, 11, 8, 9, 0), clock) === "tomorrow at 9:00 am");
expect("a later day gets a date", spokenWhen(at(2026, 11, 9, 9, 0), clock) === "on 9 Nov at 9:00 am");

const A = `0x${"a".repeat(64)}`;
const B = `0x${"b".repeat(64)}`;

const set = await within(seatFor("remind-one"), async () => {
  useWallet(A, "testnet");
  seatFor("remind-one").chat = `wallet:${A}::main`;
  return runTool("remind_me", { what: "call Sana", when: "in 20 minutes" });
});
expect("a clear future time sets a reminder", (set as any).set === true);
expect("the set result carries an id", typeof (set as any).id === "string" && (set as any).id.length > 0);
expect("the set result speaks the thing it kept", /Reminder set for .*: call Sana/.test((set as any).said));

const listed = await within(seatFor("remind-one"), () => runTool("reminders", {}));
expect("the reminder is listed for the wallet that set it", (listed as any).count === 1 && (listed as any).reminders[0].what === "call Sana");

const unclear = await within(seatFor("remind-one"), () => runTool("remind_me", { what: "call Sana", when: "whenever" }));
expect("an unclear time sets nothing", (unclear as any).unclear === true);
const past = await within(seatFor("remind-one"), () => runTool("remind_me", { what: "call Sana", when: "2020-01-01T00:00:00.000Z" }));
expect("a past time sets nothing", (past as any).past === true);

const other = await within(seatFor("remind-two"), () => {
  useWallet(B, "testnet");
  return runTool("reminders", {});
});
expect("a second wallet does not inherit the reminder", (other as any).count === 0);

{
  const cleared = await within(seatFor("remind-one"), () => runTool("cancel_reminder", { id: (set as any).id }));
  expect("cancel removes the reminder", (cleared as any).cleared === true);
  const after = await within(seatFor("remind-one"), () => runTool("reminders", {}));
  expect("the list is empty after the cancel", (after as any).count === 0);
  expect("cancelling again reports nothing changed", cancelReminder((set as any).id) === false);
}

const due = addReminder("drink water", Date.now() - 1_000, "wallet:due::main");
expect("a due reminder is returned by the ticker query", dueReminders(Date.now()).some((r) => r.id === due.id));
markReminderFired(due.id);
expect("a fired reminder is not returned again", !dueReminders(Date.now()).some((r) => r.id === due.id));
const later = addReminder("stretch", Date.now() + 60 * 60 * 1000, "wallet:due::main");
expect("a future reminder is not due", !dueReminders(Date.now()).some((r) => r.id === later.id));
expect("upcomingReminders still holds the future one", upcomingReminders().some((r) => r.id === later.id));

console.log(fails ? `\n${fails} failed` : "\nall reminder checks passed");
if (fails) process.exit(1);
