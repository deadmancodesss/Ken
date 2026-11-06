import "dotenv/config";
import { PAY_CHAIN } from "./chain.js";
import { payUsdc, paymentsEnabled, paymentCap } from "./wallet.js";

const to = process.argv[2];
const amount = Number(process.argv[3] ?? "0.5");

if (!to?.startsWith("0x")) {
  console.error("usage: npm run pay -- 0x<recipient> <usdc-amount>   (cap: " + paymentCap() + ")");
  process.exit(1);
}
if (!paymentsEnabled()) {
  console.error(`payments are disabled. Set PAY_ENABLED=1 in .env to move ${PAY_CHAIN} money`);
  process.exit(1);
}

console.log(`paying ${amount} USDC to ${to.slice(0, 10)}…`);
console.log(JSON.stringify(await payUsdc(to, BigInt(Math.round(amount * 1e6))), null, 1));
