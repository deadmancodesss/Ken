process.env.SPAM_DB = ":memory:";
process.env.PAY_ENABLED = "1";

const { clearSpam, markSpam, spamMarkFor, spamMarks } = await import("./spam.js");
const { seatFor, within } = await import("./seat.js");
const { useWallet } = await import("./session.js");
const { TOOLS, TOOL_NAMES, runTool } = await import("./tools.js");

/*
 * A mark is a promise the person made to themselves: warn me before this address
 * gets money again. The checks below prove the mark survives a second read, stays
 * inside the wallet that wrote it, can be lifted, and stops pay_usdc before any
 * bytes exist. No network is touched.
 */

let fails = 0;
const expect = (what: string, ok: boolean) => {
  console.log(`${ok ? "ok   " : "FAIL "} ${what}`);
  if (!ok) fails++;
};

const A = `0x${"a".repeat(64)}`;
const B = `0x${"b".repeat(64)}`;
const C = `0x${"c".repeat(64)}`;

expect("all three mark tools are registered", ["mark_spam", "unmark_spam", "spam_marks"].every((n) => TOOL_NAMES.includes(n)));

expect("an unmarked address has no mark", spamMarkFor(B) === null);
expect("the list starts empty", spamMarks().length === 0);

const made = markSpam(B, "Maya", "asked twice for money");
expect("marking returns the stored address", made.address === B.toLowerCase());
expect("the name is kept", spamMarkFor(B)?.name === "Maya");
expect("the reason is kept", spamMarkFor(B)?.reason === "asked twice for money");
expect("a lookup ignores the case of the address", spamMarkFor(B.toUpperCase().replace("0X", "0x")) !== null);

markSpam(B, "Maya", "changed the story about the refund");
expect("marking again replaces instead of adding a row", spamMarks().length === 1);
expect("the newer reason wins", spamMarkFor(B)?.reason === "changed the story about the refund");

expect("another address is still unmarked", spamMarkFor(C) === null);
clearSpam(C);
expect("clearing an unmarked address reports nothing changed", clearSpam(C) === false);
expect("clearing the real mark reports a change", clearSpam(B) === true);
expect("the lifted mark is gone", spamMarkFor(B) === null);

// Two wallets are two people, so one wallet's warning list is not the other's.
within(seatFor("mark-one"), () => {
  useWallet(A, "testnet");
  markSpam(B, "Maya", "spam");
  expect("the mark belongs to the wallet that wrote it", spamMarkFor(B) !== null);
});
within(seatFor("mark-two"), () => {
  useWallet(C, "testnet");
  expect("a second wallet does not inherit the mark", spamMarkFor(B) === null);
  expect("and its list is empty", spamMarks().length === 0);
});

await within(seatFor("mark-three"), async () => {
  useWallet(A, "testnet");
  markSpam(B, "Maya", "asks for money then vanishes");
  const guarded = await runTool("pay_usdc", { to: B, amount: 0.01 });
  expect("pay_usdc stops when the address is marked", (guarded as any).marked_spam === true);
  expect("the reason travels with the stop", (guarded as any).reason === "asks for money then vanishes");
  expect("nothing was built", !("digest" in (guarded as any)) && !("awaiting_signature" in (guarded as any)) && !("id" in (guarded as any)));
  const listed = await runTool("spam_marks", {});
  expect("the listed mark reads back", (listed as any).count === 1 && (listed as any).marks[0].name === "Maya");
  const lifted = await runTool("unmark_spam", { who: B });
  expect("unmark_spam lifts it by address", (lifted as any).cleared === true);
  expect("the guard is gone after the lift", spamMarkFor(B) === null);
});

console.log(fails ? `\n${fails} failed` : "\nall spam mark checks passed");
if (fails) process.exit(1);
