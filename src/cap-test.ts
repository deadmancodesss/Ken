process.env.CAPS_DB = ":memory:";

const { capBase, setCapBase, clearCap, capUsdc, capState, capMeter, usdcToBase } = await import("./cap.js");

/*
 * A budget is arithmetic a person checks against their own bank. The three-state
 * split has one edge that must not drift: exactly at the limit is red, because a
 * month that is exactly spent has nothing left in it. No network is touched here.
 */

let fails = 0;
const expect = (what: string, ok: boolean) => {
  console.log(`${ok ? "ok   " : "FAIL "} ${what}`);
  if (!ok) fails++;
};

const me = "wallet:0x" + "a".repeat(64);
const other = "wallet:0x" + "b".repeat(64);

expect("a wallet starts with no limit", capBase(me) === null);
expect("no limit reads as no USDC limit either", capUsdc(me) === null);

setCapBase(me, 25_000_000);
expect("a limit is kept for the wallet that wrote it", capBase(me) === 25_000_000);
expect("the limit comes back in whole USDC", capUsdc(me) === 25);
expect("a second wallet does not inherit the first limit", capBase(other) === null);

setCapBase(me, 40_000_000);
expect("writing again replaces the limit instead of adding a second one", capBase(me) === 40_000_000);

setCapBase(me, 0);
expect("zero lifts the limit", capBase(me) === null);

setCapBase(me, 25_000_000);
clearCap(me);
expect("clear removes the limit", capBase(me) === null);
expect("clearing one wallet leaves another intact", (() => {
  setCapBase(other, 10_000_000);
  clearCap(me);
  return capBase(other) === 10_000_000;
})());

expect("no limit is the none state even with spending", capState(50, null) === "none");
expect("an empty month under a limit is green", capState(0, 25) === "under");
expect("just below seventy percent is still green", capState(17.49, 25) === "under");
expect("seventy percent is amber", capState(17.5, 25) === "close");
expect("just below the limit is still amber", capState(24.99, 25) === "close");
expect("exactly the limit is red, not amber", capState(25, 25) === "over");
expect("past the limit is red", capState(31, 25) === "over");

const half = capMeter(12.5, 25);
expect("the meter reports half the month", half.pct === 50 && half.left === 12.5);
expect("the meter keeps the state beside the numbers", half.state === "under");

const blown = capMeter(40, 25);
expect("a blown budget draws a full bar", blown.pct === 100);
expect("a blown budget still reports the real overspend", blown.left === -15 && blown.state === "over");

const none = capMeter(40, null);
expect("no limit draws no bar and claims no money left", none.pct === 0 && none.left === null && none.state === "none");

expect("USDC is converted at six decimals", usdcToBase(0.95) === 950_000);
expect("a fractional unit rounds to the nearest base unit", usdcToBase(0.0000004) === 0 && usdcToBase(0.0000016) === 2);

console.log(fails ? `\n${fails} cap check(s) failed` : "\ncap states, storage and meter are all green");
process.exit(fails ? 1 : 0);
