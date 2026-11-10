import "dotenv/config";

/*
 * The builder is where a person's money becomes bytes, so every refusal below happens
 * before a wallet is asked to sign. The chain is a fake core behind the real Sui client:
 * it answers coin listings, balances, object references and gas estimates, while the
 * transaction bytes are built by the same SDK the server uses in production. No network
 * call is made and nothing is signed.
 *
 * The server's own key is settled on mainnet here on purpose, because that is the one
 * configuration where signUsdc and payCoin must refuse instead of spending real money.
 */

process.env.PAY_NETWORK = "mainnet";
process.env.PAY_GRAPHQL_URL = "http://127.0.0.1:9/graphql";
process.env.PAY_GRAPHQL_KEY = "builder-test";
process.env.TATUM_SUI_GRAPHQL_URL = "http://127.0.0.1:9/graphql";
process.env.TATUM_API_KEY = "builder-test";
process.env.TATUM_SUI_GRAPHQL_URL_TESTNET = "http://127.0.0.1:9/graphql";
process.env.TATUM_API_KEY_TESTNET = "builder-test";
process.env.PAY_MAX_BASE_UNITS = "5000000";
process.env.PAY_MAX_SUI_MIST = "5000000000";
delete process.env.PAY_ENABLED;

const { Transaction } = await import("@mysten/sui/transactions");
const { SuiGraphQLClient } = await import("@mysten/sui/graphql");

const SENDER = `0x${"11".repeat(32)}`;
const TO = `0x${"22".repeat(32)}`;
const SUI_COIN = "0x2::sui::SUI";
const USDC = "0xdba34672e30cb065b1f93e3ab55318768fd6fef66c15942c9f7cb846e2f900e7::usdc::USDC";

type FakeCoin = { objectId: string; version: string; digest: string; balance: string };
const coin = (fill: string, balance: string): FakeCoin => ({
  objectId: `0x${fill.repeat(64 / fill.length)}`,
  version: "1",
  digest: "1".repeat(32),
  balance,
});

let usdcCoins: FakeCoin[] = [];
let suiCoins: FakeCoin[] = [];
let addressBalance = "0";

const fakeCore = {
  async listCoins({ coinType }: any) {
    const objects = String(coinType).toLowerCase().includes("::sui::") ? suiCoins : usdcCoins;
    return { objects, hasNextPage: false, cursor: null };
  },
  async getBalance() {
    return { balance: { balance: addressBalance, coinBalance: "0", addressBalance } };
  },
  async getCurrentSystemState() {
    return { systemState: { epoch: "10", referenceGasPrice: "1000" } };
  },
  async getChainIdentifier() {
    return { chainIdentifier: "1".repeat(32) };
  },
  async getObjects({ objectIds }: any) {
    const all = [...usdcCoins, ...suiCoins];
    return {
      objects: objectIds.map((id: string) => {
        const found = all.find((c) => c.objectId === id);
        return found
          ? { objectId: id, version: found.version, digest: found.digest, owner: SENDER }
          : new Error("no such object");
      }),
    };
  },
  async simulateTransaction() {
    return {
      $kind: "Transaction",
      Transaction: { effects: { gasUsed: { computationCost: "1000", storageCost: "1000", storageRebate: "0" } } },
    };
  },
  resolveTransactionPlugin() {
    return undefined;
  },
};

Object.defineProperty(SuiGraphQLClient.prototype, "core", {
  configurable: true,
  get() {
    return fakeCore;
  },
  set(_value: unknown) {
    /* the fake core is the only reader this test process has */
  },
});

const {
  baseUnitsFor,
  decimalsFor,
  isGaslessShape,
  payCoin,
  payUsdc,
  paymentCap,
  paymentsEnabled,
  preparePayment,
  prepareUsdc,
  signUsdc,
} = await import("./wallet.js");

let fails = 0;
const expect = (what: string, ok: boolean) => {
  console.log(`${ok ? "ok   " : "FAIL "} ${what}`);
  if (!ok) fails++;
};

async function rejects(what: string, fn: () => Promise<unknown>, pattern: RegExp) {
  let said = "";
  try {
    const out = await fn();
    said = `RESOLVED ${JSON.stringify(out).slice(0, 200)}`;
  } catch (err) {
    said = String((err as Error)?.message ?? err);
  }
  const ok = pattern.test(said);
  expect(what, ok);
  if (!ok) console.log(`     said: ${said.slice(0, 320)}`);
}

const dataOf = (bytes: string) => Transaction.from(Buffer.from(bytes, "base64")).getData() as any;
const objectInputs = (data: any) => (data.inputs ?? []).filter((i: any) => i?.$kind === "Object");
const withdrawalInputs = (data: any) => (data.inputs ?? []).filter((i: any) => i?.$kind === "FundsWithdrawal");
const pureInputs = (data: any): Buffer[] =>
  (data.inputs ?? [])
    .filter((i: any) => i?.$kind === "Pure")
    .map((i: any) => Buffer.from(i.Pure.bytes, "base64"));

/* ---------- units and ceilings ---------- */

expect("USDC has six decimals", decimalsFor("USDC") === 6);
expect("SUI has nine decimals", decimalsFor("SUI") === 9);
expect("one USDC is a million base units", baseUnitsFor(1) === 1_000_000n);
expect("a fractional USDC amount keeps its six places", baseUnitsFor(1.234567) === 1_234_567n);
expect("one SUI is a billion mist", baseUnitsFor(1, "SUI") === 1_000_000_000n);
expect("half a SUI is five hundred million mist", baseUnitsFor(0.5, "SUI") === 500_000_000n);
expect("a sub-unit USDC amount rounds to one unit", baseUnitsFor(0.0000005) === 1n);
expect("a sub-unit SUI amount rounds to nothing", baseUnitsFor(0.0000000004, "SUI") === 0n);
expect("the USDC cap reads as five coins", paymentCap("USDC") === 5);
expect("the SUI cap reads as five coins", paymentCap("SUI") === 5);
expect("payments are off unless the server says otherwise", paymentsEnabled() === false);
process.env.PAY_ENABLED = "1";
expect("one line in the environment turns payments on", paymentsEnabled() === true);
delete process.env.PAY_ENABLED;
expect("removing the line turns payments off again", paymentsEnabled() === false);

/* ---------- a bad payment is refused before the chain or a key is touched ---------- */

await rejects("a short sender address is refused", () => preparePayment("0x123", TO, 0.01, "USDC"), /sender must be a full 0x Sui address/);
await rejects("a short recipient address is refused", () => preparePayment(SENDER, "0x123", 0.01, "USDC"), /recipient must be a full 0x Sui address/);
await rejects("a zero amount is refused", () => preparePayment(SENDER, TO, 0, "USDC"), /amount must be greater than zero/);
await rejects("a negative amount is refused", () => preparePayment(SENDER, TO, -1, "USDC"), /amount must be greater than zero/);
await rejects("a USDC payment above the cap is refused", () => preparePayment(SENDER, TO, 5.000001, "USDC"), /above the per-payment cap of 5 USDC/);
await rejects("a SUI payment above the cap is refused", () => preparePayment(SENDER, TO, 5.000000001, "SUI"), /above the per-payment cap of 5 SUI/);
await rejects("the USDC shorthand inherits the same recipient check", () => prepareUsdc(SENDER, "0x123", 0.01), /recipient must be a full/);
await rejects("the agent's key will not sign while payments are disabled", () => signUsdc(TO, 10_000n), /payments disabled/);
await rejects("the agent's key will not send while payments are disabled", () => payCoin(TO, 10_000n, "USDC"), /payments disabled/);

process.env.PAY_ENABLED = "1";
await rejects("a bad recipient is refused before the mainnet key gate", () => payCoin("0x123", 10_000n, "USDC"), /recipient must be a full/);
await rejects("a zero amount is refused before the mainnet key gate", () => payCoin(TO, 0n, "USDC"), /amount must be greater than zero/);
await rejects("an amount above the USDC cap is refused", () => payCoin(TO, 5_000_001n, "USDC"), /above the per-payment cap of 5 USDC/);
await rejects("an amount above the SUI cap is refused", () => payCoin(TO, 5_000_000_001n, "SUI"), /above the per-payment cap of 5 SUI/);
await rejects("the agent's key refuses to sign real USDC", () => signUsdc(TO, 10_000n), /will not sign a payment nobody approved/);
await rejects("the agent's key refuses to send real USDC", () => payCoin(TO, 10_000n, "USDC"), /will not sign a payment nobody approved/);
await rejects("the same refusal covers SUI", () => payCoin(TO, 1_000_000_000n, "SUI"), /Connect a wallet/);
await rejects("the USDC shorthand shares the gate", () => payUsdc(TO, 10_000n), /will not sign a payment nobody approved/);
delete process.env.PAY_ENABLED;

/* ---------- the built bytes are the payment, not a description of one ---------- */

const GAS_FILL = "55";
const USDC_A = "33";
const USDC_B = "44";

usdcCoins = [coin(USDC_A, "6000"), coin(USDC_B, "5000")];
suiCoins = [coin(GAS_FILL, "2000000000")];
addressBalance = "0";
const merged = await preparePayment(SENDER, TO, 0.01, "USDC");
const mergedData = dataOf(merged.bytes);
expect("the prepared payment names the ledger it was built for", merged.chain === "sui:mainnet");
expect("the prepared payment keeps the amount and the coin", merged.amount === 0.01 && merged.asset === "USDC");
expect("the prepared payment names both parties", merged.sender === SENDER && merged.to === TO);
expect("the prepared payment is unsigned", !("signature" in merged));
expect("two USDC coins that together cover the price are both spent", objectInputs(mergedData).length === 2);
expect("a coin payment does not withdraw from the address balance", withdrawalInputs(mergedData).length === 0);
expect("the fee is paid by a SUI coin", mergedData.gasData.payment.length === 1 && mergedData.gasData.payment[0].objectId === coin(GAS_FILL, "0").objectId);
expect("the price is written into the transaction as base units", pureInputs(mergedData).some((b) => b.length === 8 && b.readBigUInt64LE(0) === 10_000n));
expect(
  "the recipient is written into the transaction",
  pureInputs(mergedData).some((b) => b.length === 32 && b.toString("hex") === TO.slice(2).toLowerCase()),
);

usdcCoins = [coin(USDC_A, "50000")];
const single = await preparePayment(SENDER, TO, 0.02, "USDC");
const singleData = dataOf(single.bytes);
expect("one coin that covers the price is spent alone", objectInputs(singleData).length === 1);
expect("the single coin payment still pays the fee from SUI", singleData.gasData.payment.length === 1);

usdcCoins = [];
suiCoins = [coin(GAS_FILL, "2000000000")];
const sui = await preparePayment(SENDER, TO, 0.5, "SUI");
const suiData = dataOf(sui.bytes);
expect("a SUI payment keeps its own coin and decimals", sui.asset === "SUI" && sui.amount === 0.5);
expect("a SUI payment pays the fee from the same coin it spends", suiData.gasData.payment.length === 1 && suiData.gasData.payment[0].objectId === coin(GAS_FILL, "0").objectId);
expect("a SUI payment does not use the address-balance shape", withdrawalInputs(suiData).length === 0);
expect("the SUI amount is written in mist", pureInputs(suiData).some((b) => b.length === 8 && b.readBigUInt64LE(0) === 500_000_000n));

/* ---------- a stablecoin wallet with no SUI still gets the free shape ---------- */

usdcCoins = [];
suiCoins = [];
addressBalance = "20000";
const gasless = await preparePayment(SENDER, TO, 0.01, "USDC");
const gaslessData = dataOf(gasless.bytes);
expect("USDC in the address balance is sent when no coin object covers it", isGaslessShape(Buffer.from(gasless.bytes, "base64")));
expect("the free shape withdraws from the address balance", withdrawalInputs(gaslessData).length === 1);
expect("the free shape owns no object inputs", objectInputs(gaslessData).length === 0);
expect(
  "the free shape pays no fee at all",
  gaslessData.gasData.payment.length === 0 && gaslessData.gasData.price === "0" && gaslessData.gasData.budget === "0",
);

usdcCoins = [coin(USDC_A, "50000")];
suiCoins = [];
addressBalance = "0";
await rejects(
  "USDC with no SUI for the fee is refused with a fee explanation",
  () => preparePayment(SENDER, TO, 0.01, "USDC"),
  /USDC on Sui does not pay its own network fee[\s\S]*switch the page to testnet/,
);
usdcCoins = [];
suiCoins = [];
addressBalance = "0";
await rejects(
  "a SUI payment with nothing for the fee names the missing coin",
  () => preparePayment(SENDER, TO, 0.5, "SUI"),
  /has no SUI available on mainnet[\s\S]*leave a little SUI unspent/,
);

console.log(fails ? `\n${fails} payment build check(s) failed` : "\nall payment build checks green, no key signed and no chain was called");
process.exit(fails ? 1 : 0);
