/**
 * On 2026-11-04 a voice call asked to send 0.5 USDC to Sana. The chain took about
 * twenty seconds to confirm, the live tool deadline was twenty seconds, and the cut
 * landed as the transfer settled. The model heard a failure and asked again, so the
 * same 0.5 moved twice while the caller was told both attempts failed. A payment is
 * the one tool result that cannot be retried safely, so the guard is tested here
 * without a network: one identical request is one transfer, in flight or just settled.
 */
import { createPayOnce, type Payment } from "./wallet.js";

const checks: string[] = [];
function expect(label: string, ok: boolean) {
  checks.push(`${ok ? "ok  " : "FAIL"} ${label}`);
  if (!ok) throw new Error(label);
}

const SENDER = `0x${"1".repeat(64)}`;
const TO = `0x${"2".repeat(64)}`;
const OTHER = `0x${"3".repeat(64)}`;

let sends = 0;
let release!: (p: Payment) => void;
const gate = new Promise<Payment>((resolve) => {
  release = resolve;
});
const payOnce = createPayOnce(async (to, baseUnits) => {
  sends += 1;
  if (sends === 1) return gate;
  return { digest: `digest-${sends}`, to, usdc: Number(baseUnits) / 10 ** 6 };
}, 60_000);

const first = payOnce(SENDER, TO, 500_000n);
const second = payOnce(SENDER, TO, 500_000n);
release({ digest: "digest-1", to: TO, usdc: 0.5 });
const [a, b] = await Promise.all([first, second]);

expect("two identical requests in flight send one transfer", sends === 1);
expect("the first caller owns the payment", !a.duplicate && a.digest === "digest-1");
expect("the second caller is told it is the first payment", b.duplicate && b.digest === "digest-1");

const third = await payOnce(SENDER, TO, 500_000n);
expect("an identical request moments after it settled does not send again", sends === 1 && third.duplicate && third.digest === "digest-1");

const larger = await payOnce(SENDER, TO, 600_000n);
expect("a different amount is a different payment", sends === 2 && !larger.duplicate);
expect("and it gets its own digest", larger.digest === "digest-2");

const again = await payOnce(SENDER, TO, 600_000n);
expect("the larger amount is then deduplicated too", sends === 2 && again.duplicate && again.digest === "digest-2");

const other = await payOnce(SENDER, OTHER, 600_000n);
expect("a different recipient is a different payment", sends === 3 && !other.duplicate);

let tries = 0;
const retry = createPayOnce(async (to, baseUnits): Promise<Payment> => {
  tries += 1;
  if (tries === 1) throw new Error("version doesn't match");
  return { digest: "digest-retry", to, usdc: Number(baseUnits) / 10 ** 6 };
}, 60_000);
await retry(SENDER, TO, 1_000_000n).catch(() => null);
const settled = await retry(SENDER, TO, 1_000_000n);
expect("a payment that never settled can be asked for again", tries === 2 && !settled.duplicate);

let shortSends = 0;
const short = createPayOnce(async (to): Promise<Payment> => {
  shortSends += 1;
  return { digest: `short-${shortSends}`, to, usdc: 0.1 };
}, 20);
await short(SENDER, TO, 100_000n);
await new Promise((r) => setTimeout(r, 25));
const afterWindow = await short(SENDER, TO, 100_000n);
expect("after the window the same request is a new payment again", shortSends === 2 && !afterWindow.duplicate);

let twoSenders = 0;
const shared = createPayOnce(async (to): Promise<Payment> => {
  twoSenders += 1;
  return { digest: `sender-${twoSenders}`, to, usdc: 0.1 };
}, 60_000);
await shared(SENDER, TO, 100_000n);
await shared(`0x${"4".repeat(64)}`, TO, 100_000n);
expect("two wallets paying the same person are two payments", twoSenders === 2);

console.log(checks.join("\n"));
console.log(`\nthe payment path cannot send twice for one request, and every check above is offline`);
