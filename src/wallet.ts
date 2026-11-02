import "dotenv/config";
import { SuiGraphQLClient } from "@mysten/sui/graphql";
import { Ed25519Keypair } from "@mysten/sui/keypairs/ed25519";
import { Transaction, coinWithBalance } from "@mysten/sui/transactions";

export const USDC_TESTNET =
  "0xa1ec7fc00a6f40db9693ad1415d0c193ad3906494428cf252621037bd7117e29::usdc::USDC";

export const USDC_DECIMALS = 6;
const cap = BigInt(process.env.PAY_MAX_BASE_UNITS ?? "5000000");

export type Payment = { digest: string; to: string; usdc: number };
export type Prepared = { bytes: string; to: string; usdc: number; chain: string; sender: string };

function payClient() {
  return new SuiGraphQLClient({
    url: process.env.PAY_GRAPHQL_URL || process.env.TATUM_SUI_GRAPHQL_URL_TESTNET!,
    network: "testnet",
    headers: { "x-api-key": process.env.TATUM_API_KEY_TESTNET! },
  });
}

function checked(to: string, baseUnits: bigint): void {
  if (!/^0x[0-9a-fA-F]{64}$/.test(to)) throw new Error("recipient must be a full 0x Sui address");
  if (baseUnits <= 0n) throw new Error("amount must be greater than zero");
  if (baseUnits > cap) throw new Error(`above the per-payment cap of ${paymentCap()} USDC`);
}

/**
 * Builds the transfer and stops before anyone signs it. The bytes go to a browser
 * wallet so the person who owns the money is the one who approves it.
 */
export async function prepareUsdc(sender: string, to: string, usdc: number): Promise<Prepared> {
  if (!/^0x[0-9a-fA-F]{64}$/.test(sender)) throw new Error("sender must be a full 0x Sui address");
  const baseUnits = BigInt(Math.round(usdc * 10 ** USDC_DECIMALS));
  checked(to, baseUnits);

  const tx = new Transaction();
  tx.setSender(sender);
  tx.transferObjects([coinWithBalance({ type: USDC_TESTNET, balance: baseUnits })], to);

  // build() hands back serialized TransactionData bytes, which is exactly what a
  // browser wallet wants to be shown. Nothing here signs anything.
  let built: Uint8Array;
  try {
    built = await tx.build({ client: payClient() });
  } catch (err) {
    // The SDK answers this in coin type hashes and base units. What the person
    // needs to hear is that the wallet they connected cannot cover the amount.
    const msg = String((err as Error)?.message ?? err);
    if (/insufficient balance/i.test(msg)) {
      throw new Error(`that wallet holds no testnet USDC, so there is nothing to sign. Put some in it and ask again`);
    }
    throw new Error(msg.slice(0, 200));
  }
  return { bytes: Buffer.from(built).toString("base64"), to, usdc, chain: "sui:testnet", sender };
}

export function paymentsEnabled(): boolean {
  return process.env.PAY_ENABLED === "1";
}

export function paymentCap(): number {
  return Number(cap) / 10 ** USDC_DECIMALS;
}

export async function payUsdc(to: string, baseUnits: bigint): Promise<Payment> {
  if (!paymentsEnabled()) {
    throw new Error("payments disabled. Set PAY_ENABLED=1 in the server environment");
  }
  if (!/^0x[0-9a-fA-F]{64}$/.test(to)) throw new Error("recipient must be a full 0x Sui address");
  if (baseUnits <= 0n) throw new Error("amount must be greater than zero");
  if (baseUnits > cap) throw new Error(`above the per-payment cap of ${paymentCap()} USDC`);

  const client = new SuiGraphQLClient({
    url: process.env.PAY_GRAPHQL_URL || process.env.TATUM_SUI_GRAPHQL_URL_TESTNET!,
    network: "testnet",
    headers: { "x-api-key": process.env.TATUM_API_KEY_TESTNET! },
  });
  const key = Ed25519Keypair.fromSecretKey(process.env.AGENT_SECRET_KEY!);

  const tx = new Transaction();
  tx.transferObjects([coinWithBalance({ type: USDC_TESTNET, balance: baseUnits })], to);

  const res: any = await client.signAndExecuteTransaction({
    transaction: tx,
    signer: key,
    include: { effects: true },
  });

  if (process.env.PAY_DEBUG === "1") {
    console.log("RAW RESPONSE:", JSON.stringify(res, null, 1).slice(0, 1800));
  }
  // The client returns a kind-tagged object: { $kind: "Transaction", Transaction: { digest, status } }
  // where status is { success, error }, not a string. Reading either one wrong
  // reports a settled payment as a failure, which is how double payments happen.
  const payload: any = res?.Transaction ?? res?.signAndExecuteTransaction ?? res?.data?.signAndExecuteTransaction ?? res;
  const digest: string | undefined = payload?.digest ?? payload?.transaction?.digest;
  const status = payload?.status;

  if (!digest) throw new Error(`no digest in response: ${JSON.stringify(res).slice(0, 400)}`);
  if (status && status.success === false) {
    throw new Error(`transaction failed on chain: ${status.error ?? "unknown error"}`);
  }

  return { digest, to, usdc: Number(baseUnits) / 10 ** USDC_DECIMALS };
}
