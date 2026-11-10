/**
 * The gasless fallback only helps if the bytes handed to the wallet are the exact free
 * shape: money withdrawn from the address balance, no owned object, and no gas at all.
 * Anything else would be charged, and the wallet this path exists for has nothing to
 * pay with. These checks build that shape against a fake chain client, so the guard is
 * proved without a network call or a payment.
 */
import { Transaction } from "@mysten/sui/transactions";
import { gaslessTransfer, gaslessUsdc, isGaslessShape } from "./wallet.js";
import { throughRateLimit, USDC_COIN } from "./chain.js";

const checks: string[] = [];
function expect(label: string, ok: boolean) {
  checks.push(`${ok ? "ok  " : "FAIL"} ${label}`);
  if (!ok) throw new Error(label);
}

const sender = "0x" + "11".repeat(32);
const to = "0x" + "22".repeat(32);
const USDC = USDC_COIN.testnet;
const CHAIN = "1".repeat(32);

function node(addressBalance: string, coinBalance = "0") {
  return {
    core: {
      getBalance: async () => ({ balance: { balance: addressBalance, coinBalance, addressBalance } }),
      listCoins: async () => ({ objects: [], hasNextPage: false, cursor: null }),
      getCurrentSystemState: async () => ({ systemState: { epoch: "10" } }),
      getChainIdentifier: async () => ({ chainIdentifier: CHAIN }),
    },
  } as any;
}

const covered = await gaslessUsdc(node("20000"), sender, to, 10_000n, USDC);
expect("USDC in the address balance builds a gasless transfer", !!covered);
expect("the built transaction is the free shape", covered ? isGaslessShape(covered) : false);

const data: any = Transaction.from(covered!).getData();
expect("the money comes from the address balance", data.inputs.some((i: any) => i?.FundsWithdrawal));
expect("no owned object is touched", !data.inputs.some((i: any) => i?.Object));
expect(
  "the transaction pays no gas",
  (data.gasData.payment ?? []).length === 0 && data.gasData.price === "0" && data.gasData.budget === "0",
);
expect(
  "the free shape carries a one-epoch ValidDuring window",
  data.expiration?.$kind === "ValidDuring" &&
    data.expiration.ValidDuring.minEpoch === "10" &&
    data.expiration.ValidDuring.maxEpoch === "11",
);

expect("a balance below the amount is not attempted", (await gaslessUsdc(node("9999"), sender, to, 10_000n, USDC)) === null);
expect("an amount below 0.01 USDC is not attempted", (await gaslessUsdc(node("20000"), sender, to, 5_000n, USDC)) === null);

const charged = new Transaction();
charged.setSender(sender);
charged.setGasPayment([{ objectId: "0x" + "33".repeat(32), version: "1", digest: "1".repeat(32) }]);
charged.setGasPrice(1000);
charged.setGasBudget(1_000_000);
charged.transferObjects([charged.gas], to);
const chargedBuilt = await charged.build({ client: node("0") });
expect("a transaction with a gas budget is not mistaken for the free shape", !isGaslessShape(chargedBuilt));

const signed = await gaslessTransfer(sender, to, 10_000n, USDC, "10", CHAIN).build({ client: node("20000") });
expect("a round trip through serialized bytes still reads as the free shape", isGaslessShape(signed));

// A Sui address is hex, and the gas error names the account. An address that happens
// to contain the characters "429" used to read as an HTTP status and cost four slow
// retries before the real reason was even looked at.
let attempts = 0;
await throughRateLimit(async () => {
  attempts++;
  throw new Error(
    "Unable to perform gas selection due to insufficient SUI balance (in address balance or coins) for account 0x3ec62fbaf24ce0b0b638d1610a5a2cb03eee3db3823365b6a08b1224334296e3",
  );
}).catch(() => {});
expect("an address containing 429 is not mistaken for a rate limit", attempts === 1);

console.log(checks.join("\n"));
console.log("\nthe gasless fallback builds only the free stablecoin shape and refuses everything else");
