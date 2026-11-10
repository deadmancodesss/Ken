import { mkdirSync, rmSync } from "node:fs";
import { dirname, resolve } from "node:path";

/*
 * The facilitator is the one process in this build that can move somebody else's money
 * without a second signature. It holds no key, so every rule it enforces is a check on
 * the bytes a payer already signed. These checks run the real verify and settle path
 * against a stubbed chain client: signatures are real Ed25519 signatures over real
 * transaction bytes, while simulation and broadcast are values, so nothing leaves this
 * machine and no money is spent.
 */

process.env.PAY_NETWORK = "testnet";
process.env.PAY_GRAPHQL_URL = "http://127.0.0.1:9/graphql";
process.env.PAY_GRAPHQL_KEY = "facilitator-test";
const STORE = resolve("vibe_images/facilitator-test.json");
process.env.FACILITATOR_STORE = STORE;
mkdirSync(dirname(STORE), { recursive: true });
rmSync(STORE, { force: true });

const { Transaction } = await import("@mysten/sui/transactions");
const { Ed25519Keypair } = await import("@mysten/sui/keypairs/ed25519");
const { SuiGraphQLClient } = await import("@mysten/sui/graphql");
const { envelopeFromSigned, openEnvelope, requirementsFor } = await import("./x402wire.js");
type PaymentRequirements = import("./x402wire.js").PaymentRequirements;
const { USDC_COIN } = await import("./chain.js");
const { rememberSettlement, settle, supported, verify, verifyResponse } = await import("./facilitator.js");

let fails = 0;
const expect = (what: string, ok: boolean) => {
  console.log(`${ok ? "ok   " : "FAIL "} ${what}`);
  if (!ok) fails++;
};

const SELLER = `0x${"55".repeat(32)}`;
const WRONG = `0x${"66".repeat(32)}`;

const terms = (over: Partial<PaymentRequirements> = {}): PaymentRequirements => ({
  ...requirementsFor({
    resource: `profile:${SELLER}`,
    description: "fixture",
    payTo: SELLER,
    baseUnits: 10_000n,
    network: "sui:testnet",
    asset: USDC_COIN.testnet,
  }),
  ...over,
});

const change = (address: string, amount: string, coinType = USDC_COIN.testnet) => ({ address, amount, coinType });
const defaultChanges = (payer: string, payTo = SELLER, amount = "10000", coinType = USDC_COIN.testnet) => [
  change(payTo, amount, coinType),
  change(payer, `-${amount}`, coinType),
];

const successSim = (changes: { address: string; amount: string; coinType: string }[]) => ({
  $kind: "Transaction",
  Transaction: { status: { success: true }, balanceChanges: changes },
});
const successExec = () => ({
  $kind: "Transaction",
  Transaction: { digest: "SettlementDigestForTest", status: { success: true } },
});

let current = "";
let simulate: () => Promise<any> = async () => successSim(defaultChanges(current));
let execute: () => Promise<any> = async () => successExec();
let simulated = 0;
let executed = 0;
let lastSim: any = null;
let lastExec: any = null;

(SuiGraphQLClient.prototype as any).simulateTransaction = async (input: any) => {
  simulated++;
  lastSim = input;
  return simulate();
};
(SuiGraphQLClient.prototype as any).executeTransaction = async (input: any) => {
  executed++;
  lastExec = input;
  return execute();
};

/* A transaction with every object written down builds and signs with no reader. */
async function signedWith(key: ReturnType<typeof Ed25519Keypair.generate>, budget = 10_000_000) {
  const tx = new Transaction();
  tx.setSender(key.toSuiAddress());
  tx.setGasPrice(1000);
  tx.setGasBudget(budget);
  tx.setGasPayment([{ objectId: `0x${"11".repeat(32)}`, version: "1", digest: "1".repeat(32) }]);
  const bytes = await tx.build();
  const { signature } = await key.signTransaction(bytes);
  return {
    envelope: envelopeFromSigned(Buffer.from(bytes).toString("base64"), signature),
    bytes,
    signature,
    sender: key.toSuiAddress(),
  };
}

const signed = () => signedWith(Ed25519Keypair.generate());

const ask = (envelope: string, over: Partial<PaymentRequirements> = {}, version: number | string = 2) => {
  try {
    current = openEnvelope(envelope).sender;
  } catch {
    current = "";
  }
  return verify({ x402Version: version, paymentPayload: envelope, paymentRequirements: terms(over) });
};

const settleNow = (envelope: string, over: Partial<PaymentRequirements> = {}) => {
  try {
    current = openEnvelope(envelope).sender;
  } catch {
    current = "";
  }
  return settle({ x402Version: 2, paymentPayload: envelope, paymentRequirements: terms(over) });
};

const reason = async (envelope: string, over: Partial<PaymentRequirements> = {}) => {
  const checked = await ask(envelope, over);
  return checked.ok ? "" : checked.why;
};

const supportedNow = supported();
expect(
  "the facilitator publishes the exact scheme for both ledgers",
  supportedNow.kinds.length === 2 &&
    supportedNow.kinds.every((k: any) => k.scheme === "exact" && k.x402Version === 2) &&
    supportedNow.kinds.some((k: any) => k.network === "sui:testnet") &&
    supportedNow.kinds.some((k: any) => k.network === "sui:mainnet"),
);
expect("the facilitator advertises no signer, because it holds no key", Object.keys(supportedNow.signers ?? {}).length === 0);

/* ---------- terms a paying stranger cannot bend ---------- */

const one = await signed();
const versionRefusal = await ask(one.envelope, {}, 1);
expect("a different x402 version is refused", !versionRefusal.ok && /version 2/.test(versionRefusal.why));
expect("a different scheme is refused", /exact scheme/.test(await reason(one.envelope, { scheme: "upto" as any })));
expect("a network this build does not settle is refused", /sui:testnet and sui:mainnet/.test(await reason(one.envelope, { network: "sui:devnet" as any })));
expect("terms with no payout address are refused", /no payout address/.test(await reason(one.envelope, { payTo: "0x123" })));
expect("terms with a fractional amount are refused", /base units/.test(await reason(one.envelope, { amount: "0.01" })));
expect("terms with a zero price are refused", /price is zero/.test(await reason(one.envelope, { amount: "0" })));
expect("terms naming another coin are refused", /coin this facilitator does not settle/.test(await reason(one.envelope, { asset: "0x2::sui::SUI" })));
expect("mainnet terms cannot be paid with testnet USDC", /coin this facilitator does not settle/.test(await reason(one.envelope, { network: "sui:mainnet" })));

/* ---------- an envelope has to be the payer's own signature ---------- */

expect("an empty payload is refused", /empty/.test(await reason("")));
expect("a payload that is not a signed transaction is refused", /not a signed Sui transaction/.test(await reason("not-a-signed-transaction")));

const other = await signed();
const swapped = envelopeFromSigned(Buffer.from(one.bytes).toString("base64"), other.signature);
expect("a signature from another wallet is refused", /does not cover/.test(await reason(swapped)));

const sameKey = Ed25519Keypair.generate();
const firstBytes = await signedWith(sameKey, 10_000_000);
const secondBytes = await signedWith(sameKey, 11_000_000);
const otherBytes = envelopeFromSigned(Buffer.from(firstBytes.bytes).toString("base64"), secondBytes.signature);
expect("a signature made for different bytes is refused", /does not cover/.test(await reason(otherBytes)));

/* ---------- the simulation is the only thing that says money moved ---------- */

await ask(one.envelope);
expect("a valid payment is simulated before it is believed", simulated === 1);
expect(
  "the simulation reads effects and the exact signed bytes",
  Buffer.from(lastSim.transaction).equals(Buffer.from(one.bytes)) &&
    lastSim.include?.effects === true &&
    lastSim.include?.balanceChanges === true,
);

simulate = async () => {
  throw new Error("the node is unreachable");
};
expect("a simulation that cannot answer is refused", /would not simulate/.test(await reason((await signed()).envelope)));

simulate = async () => ({
  $kind: "FailedTransaction",
  FailedTransaction: { status: { error: { message: "move aborted in the transfer" } } },
});
expect("a simulation that fails on chain is refused with its reason", /would fail on chain: move aborted/.test(await reason((await signed()).envelope)));

simulate = async () => ({
  $kind: "Transaction",
  Transaction: { status: { success: false, error: { message: "insufficient gas" } }, balanceChanges: [] },
});
expect("a simulation reporting an unsuccessful status is refused", /insufficient gas/.test(await reason((await signed()).envelope)));

simulate = async () => successSim([change(SELLER, "9999"), change(current, "-9999")]);
expect("a payment one base unit short is refused", /does not pay 10000 base units/.test(await reason((await signed()).envelope)));

simulate = async () => successSim([change(WRONG, "10000"), change(current, "-10000")]);
expect("money sent to another address is refused", /does not pay 10000 base units/.test(await reason((await signed()).envelope)));

simulate = async () => successSim([change(SELLER, "10000")]);
expect("a credit with no matching debit is refused", /does not leave the wallet that signed/.test(await reason((await signed()).envelope)));

simulate = async () => successSim([change(SELLER, "10000", "0x2::sui::SUI"), change(current, "-10000", "0x2::sui::SUI")]);
expect("a payment in the wrong coin is refused", /does not pay 10000 base units/.test(await reason((await signed()).envelope)));

/* ---------- one envelope settles once, and only the bytes that were signed ---------- */

simulate = async () => successSim(defaultChanges(current));
const good = await signed();
const checked = await ask(good.envelope);
expect("a payment that passes every rule is verified", checked.ok === true && checked.payer === good.sender);
expect("the verified bytes are the bytes the wallet signed", checked.ok && Buffer.from(checked.transaction).equals(Buffer.from(good.bytes)));
expect("the verified envelope keeps its signature", checked.ok && checked.signatures[0] === good.signature);
expect("the envelope fingerprint is a sha256", checked.ok && /^[0-9a-f]{64}$/.test(checked.fingerprint));
const accepted = verifyResponse(checked);
expect("a valid payment answers isValid true with its payer", accepted.isValid === true && accepted.payer === good.sender);
const refused = verifyResponse({ ok: false, why: "fixture refusal" });
expect("an invalid payment answers isValid false with its reason", refused.isValid === false && refused.invalidReason === "fixture refusal");

const replay = openEnvelope(good.envelope);
rememberSettlement(replay.fingerprint, "AlreadySettledDigest");
const beforeReplay = simulated;
expect("a settled envelope is refused when it appears again", /already settled once/.test(await reason(good.envelope)));
expect("a replay is refused before the chain is touched again", simulated === beforeReplay);

const beforeBadSettle = executed;
simulate = async () => successSim(defaultChanges(current));
const badSettle = await settleNow((await signed()).envelope, { amount: "0" });
expect("settle refuses terms it would not verify", badSettle.success === false && /price is zero/.test(badSettle.errorReason ?? ""));
expect("settle never broadcasts a payment it refused", executed === beforeBadSettle);

simulate = async () => successSim(defaultChanges(current));
const payable = await signed();
const beforeExec = executed;
const settled = await settleNow(payable.envelope);
expect("a valid payment settles", settled.success === true && settled.transaction === "SettlementDigestForTest");
expect("the settlement names the ledger it happened on", settled.network === "sui:testnet");
expect("the settlement names the wallet that paid", settled.payer === payable.sender);
expect("the settlement states the amount that was priced", settled.amount === "10000");
expect("settle broadcasts exactly once", executed === beforeExec + 1);
expect(
  "settle broadcasts the payer's own bytes and signature",
  Buffer.from(lastExec.transaction).equals(Buffer.from(payable.bytes)) &&
    lastExec.signatures.length === 1 &&
    lastExec.signatures[0] === payable.signature,
);

simulate = async () => successSim(defaultChanges(current));
execute = async () => ({
  $kind: "FailedTransaction",
  FailedTransaction: { status: { error: { message: "object version mismatch" } } },
});
const failedExecEnvelope = await signed();
const refusedExec = await settleNow(failedExecEnvelope.envelope);
expect("a broadcast the node refuses is reported as a failed settlement", refusedExec.success === false && /object version mismatch/.test(refusedExec.errorReason ?? ""));

simulate = async () => successSim(defaultChanges(current));
execute = async () => ({
  $kind: "Transaction",
  Transaction: { digest: "FailedOnChain", status: { success: false, error: "gas smashing failed" } },
});
const unsuccessfulExec = await signed();
const notSuccessful = await settleNow(unsuccessfulExec.envelope);
expect("a broadcast that lands unsuccessfully is not called a settlement", notSuccessful.success === false && /gas smashing failed/.test(notSuccessful.errorReason ?? ""));

simulate = async () => successSim(defaultChanges(current));
execute = async () => {
  throw new Error("the gateway closed the connection");
};
const thrownExec = await signed();
const thrown = await settleNow(thrownExec.envelope);
expect("a broadcast that throws is reported without claiming success", thrown.success === false && /would not settle it/.test(thrown.errorReason ?? ""));

/* ---------- the same rules stand on mainnet ---------- */

simulate = async () => successSim(defaultChanges(current, SELLER, "10000", USDC_COIN.mainnet));
const mainnet = await signed();
const onMainnet = await ask(mainnet.envelope, {
  network: "sui:mainnet",
  asset: USDC_COIN.mainnet,
  resource: `profile:${mainnet.sender}`,
});
expect("a mainnet payment is verified against mainnet USDC", onMainnet.ok === true);

console.log(fails ? `\n${fails} facilitator check(s) failed` : "\nall facilitator checks green, no key held and no money moved");
rmSync(STORE, { force: true });
process.exit(fails ? 1 : 0);
