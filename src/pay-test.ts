/**
 * On 2026-11-04 a voice call asked to send 0.5 USDC to Sana. The chain took about
 * twenty seconds to confirm, the live tool deadline was twenty seconds, and the cut
 * landed as the transfer settled. The model heard a failure and asked again, so the
 * same 0.5 moved twice while the caller was told both attempts failed. A payment is
 * the one tool result that cannot be retried safely, so the guard is tested here
 * without a network: one identical request is one transfer, in flight or just settled.
 */
import { createPayOnce, type Payment } from "./wallet.js";
import { provedPayment } from "./chain.js";

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
  return { digest: `digest-${sends}`, to, amount: Number(baseUnits) / 10 ** 6, asset: "USDC", chain: "sui:testnet" };
}, 60_000);

const first = payOnce(SENDER, TO, 500_000n);
const second = payOnce(SENDER, TO, 500_000n);
release({ digest: "digest-1", to: TO, amount: 0.5, asset: "USDC", chain: "sui:testnet" });
const [a, b] = await Promise.all([first, second]);

expect("two identical requests in flight send one transfer", sends === 1);
expect("the first caller owns the payment", !a.duplicate && a.digest === "digest-1");
expect("the second caller is told it is the first payment", b.duplicate && b.digest === "digest-1");
expect("the ledger the money moved on travels with the payment", a.chain === "sui:testnet" && b.chain === "sui:testnet");

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
  return { digest: "digest-retry", to, amount: Number(baseUnits) / 10 ** 6, asset: "USDC", chain: "sui:testnet" };
}, 60_000);
await retry(SENDER, TO, 1_000_000n).catch(() => null);
const settled = await retry(SENDER, TO, 1_000_000n);
expect("a payment that never settled can be asked for again", tries === 2 && !settled.duplicate);

let shortSends = 0;
const short = createPayOnce(async (to): Promise<Payment> => {
  shortSends += 1;
  return { digest: `short-${shortSends}`, to, amount: 0.1, asset: "USDC", chain: "sui:testnet" };
}, 20);
await short(SENDER, TO, 100_000n);
await new Promise((r) => setTimeout(r, 25));
const afterWindow = await short(SENDER, TO, 100_000n);
expect("after the window the same request is a new payment again", shortSends === 2 && !afterWindow.duplicate);

let twoSenders = 0;
const shared = createPayOnce(async (to): Promise<Payment> => {
  twoSenders += 1;
  return { digest: `sender-${twoSenders}`, to, amount: 0.1, asset: "USDC", chain: "sui:testnet" };
}, 60_000);
await shared(SENDER, TO, 100_000n);
await shared(`0x${"4".repeat(64)}`, TO, 100_000n);
expect("two wallets paying the same person are two payments", twoSenders === 2);

/*
 * One USDC and one SUI are both 1,000,000 base units, and the dedup key used to be
 * built from the number alone. A SUI request in that window would have been answered
 * with the digest of a USDC transfer to the same address, which reads as sent while
 * the SUI never moved.
 */
let crossSends = 0;
const cross = createPayOnce(async (to, baseUnits, asset): Promise<Payment> => {
  crossSends += 1;
  return {
    digest: `cross-${crossSends}`,
    to,
    amount: Number(baseUnits) / 10 ** (asset === "SUI" ? 9 : 6),
    asset,
    chain: "sui:testnet",
  };
}, 60_000);
const oneUsdc = await cross(SENDER, TO, 1_000_000n, "USDC");
const oneSui = await cross(SENDER, TO, 1_000_000n, "SUI");
expect("the same base-unit number in another coin is a different payment", crossSends === 2 && !oneSui.duplicate && oneSui.digest !== oneUsdc.digest);
expect("one amount is read in each coin's own decimals", oneUsdc.amount === 1 && oneSui.amount === 0.001);

/*
 * Measured on testnet on 2026-11-08: a 0.01 SUI transfer reports +10000000 at the
 * recipient and -11988000 at the sender, because the network fee is paid from the
 * same coin, and the framework coin type comes back padded to 64 hex. A proof that
 * looks for exactly the amount leaving the sender rejects the transfer that really
 * happened, which is what this settlement did before the proof was fixed.
 */
const SUI_FULL = `0x${"0".repeat(63)}2::sui::SUI`;
const USDC_FULL = "0xa1ec7fc00a6f40db9693ad1415d0c193ad3906494428cf252621037bd7117e29::usdc::USDC";
const suiChanges = [
  { address: TO, coinType: SUI_FULL, amount: 10_000_000n },
  { address: SENDER, coinType: SUI_FULL, amount: -11_988_000n },
];
expect("a SUI transfer whose fee came from the same coin still proves", provedPayment(suiChanges, SENDER, TO, 10_000_000n, "SUI"));
expect("a SUI transfer with the wrong amount is refused", !provedPayment(suiChanges, SENDER, TO, 20_000_000n, "SUI"));
expect("a SUI transfer to another address is refused", !provedPayment(suiChanges, SENDER, OTHER, 10_000_000n, "SUI"));
const usdcChanges = [
  { address: TO, coinType: USDC_FULL, amount: 1_000_000n },
  { address: SENDER, coinType: USDC_FULL, amount: -1_000_000n },
];
expect("USDC still needs the exact amount to leave", provedPayment(usdcChanges, SENDER, TO, 1_000_000n, "USDC"));
expect("a USDC movement cannot prove a SUI payment", !provedPayment(usdcChanges, SENDER, TO, 1_000_000n, "SUI"));

console.log(checks.join("\n"));
console.log(`\nthe payment path cannot send twice for one request, and every check above is offline`);
