import "dotenv/config";
import { SuiGraphQLClient } from "@mysten/sui/graphql";
import { Ed25519Keypair } from "@mysten/sui/keypairs/ed25519";
import { Transaction, coinWithBalance } from "@mysten/sui/transactions";
import { PAY_CHAIN, PAY_NET, USDC_ASSET, allHoldings, formatAmount, payGateway, throughRateLimit } from "./chain.js";

export { USDC_ASSET } from "./chain.js";

export const USDC_DECIMALS = 6;
const cap = BigInt(process.env.PAY_MAX_BASE_UNITS ?? "5000000");

export type Payment = { digest: string; to: string; usdc: number };
export type Paid = Payment & { duplicate: boolean };
export type Prepared = { bytes: string; to: string; usdc: number; chain: string; sender: string };

function payClient() {
  const { url, key } = payGateway();
  return new SuiGraphQLClient({ url, network: PAY_NET, headers: { "x-api-key": key } });
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
  tx.transferObjects([coinWithBalance({ type: USDC_ASSET, balance: baseUnits })], to);

  // build() hands back serialized TransactionData bytes, which is exactly what a
  // browser wallet wants to be shown. Nothing here signs anything.
  let built: Uint8Array;
  try {
    built = await throughRateLimit(() => tx.build({ client: payClient() }));
  } catch (err) {
    // The SDK answers this in coin type hashes and base units. What the person
    // needs to hear is that the wallet they connected cannot cover the amount.
    const msg = String((err as Error)?.message ?? err);
    if (/429|too many requests|rate limit/i.test(msg)) {
      throw new Error(`the ledger gateway is busy and refused to look up the coins for this payment, so nothing was built and nothing was signed. Try again in a few seconds`);
    }
    if (/insufficient balance/i.test(msg)) {
      // The builder reads coins from the chain, so a locked wallet cannot cause this.
      // Name the address it read, or a different account in the same extension is
      // invisible and the message blames a balance the person can see in the wallet.
      const short = `${sender.slice(0, 8)}…${sender.slice(-6)}`;
      // Only paid on the failure path, because what the account does hold is the one
      // fact that separates a wrong account from a wallet showing a stale balance.
      let holds = "";
      try {
        const coins = await allHoldings(sender, PAY_NET);
        holds = coins.length
          ? ` That account holds ${coins.map((h) => `${formatAmount(BigInt(h.base), h.decimals)} ${h.symbol}`).join(", ")}.`
          : " That account holds no coins at all.";
      } catch {
        /* the message below is already true without the balance */
      }
      throw new Error(
        `the transfer builder found less than ${usdc} ${PAY_NET} USDC at the connected account ${short}, so there is nothing to sign yet.${holds} A locked wallet cannot cause this. If your wallet app shows USDC, check that the account and network are the same ones, then press Connect again`,
      );
    }
    throw new Error(msg.slice(0, 200));
  }
  return { bytes: Buffer.from(built).toString("base64"), to, usdc, chain: PAY_CHAIN, sender };
}

export function paymentsEnabled(): boolean {
  return process.env.PAY_ENABLED === "1";
}

export function paymentCap(): number {
  return Number(cap) / 10 ** USDC_DECIMALS;
}

export type SignedPayment = {
  bytes: string;
  signature: string;
  sender: string;
  to: string;
  usdc: number;
  chain: string;
};

/**
 * Both of these functions sign with the server's own key, which means money leaves a
 * wallet without anyone watching a popup. That is only defensible while the money is
 * worthless testnet dust, so the demo story refuses to spend the moment the build
 * settles where USDC is real. A person's own wallet is never touched by this: those
 * transfers are built unsigned and the signature in their extension is the approval.
 *
 * Recorded demos that need the agent to pay keep running with PAY_NETWORK=testnet, and
 * nothing here stops a later build from spending mainnet money on purpose.
 */
function keySpendAllowed(): void {
  if (PAY_NET === "testnet") return;
  throw new Error(
    `this build settles ${PAY_CHAIN}, where the demo wallet's USDC would be real money, so the agent will not sign a payment nobody approved. Record the paying demo with PAY_NETWORK=testnet, or connect a wallet and sign it yourself`,
  );
}

/**
 * Signs a transfer and hands back the bytes and the signature without broadcasting it.
 * This is the buyer half of the x402 exact scheme: the server that sells the fact, not
 * the wallet that owns the money, decides when the signed transaction is sent. A buyer
 * that broadcast first would have no way to refuse terms it had not checked yet.
 */
export async function signUsdc(to: string, baseUnits: bigint): Promise<SignedPayment> {
  if (!paymentsEnabled()) {
    throw new Error("payments disabled. Set PAY_ENABLED=1 in the server environment");
  }
  keySpendAllowed();
  checked(to, baseUnits);
  const key = Ed25519Keypair.fromSecretKey(process.env.AGENT_SECRET_KEY!);
  const sender = key.toSuiAddress();

  const tx = new Transaction();
  tx.setSender(sender);
  tx.transferObjects([coinWithBalance({ type: USDC_ASSET, balance: baseUnits })], to);

  const built = await throughRateLimit(() => tx.build({ client: payClient() }));
  const { signature } = await key.signTransaction(built);
  return {
    bytes: Buffer.from(built).toString("base64"),
    signature,
    sender,
    to,
    usdc: Number(baseUnits) / 10 ** USDC_DECIMALS,
    chain: PAY_CHAIN,
  };
}

export async function payUsdc(to: string, baseUnits: bigint): Promise<Payment> {
  if (!paymentsEnabled()) {
    throw new Error("payments disabled. Set PAY_ENABLED=1 in the server environment");
  }
  if (!/^0x[0-9a-fA-F]{64}$/.test(to)) throw new Error("recipient must be a full 0x Sui address");
  if (baseUnits <= 0n) throw new Error("amount must be greater than zero");
  if (baseUnits > cap) throw new Error(`above the per-payment cap of ${paymentCap()} USDC`);
  keySpendAllowed();

  const client = payClient();
  const key = Ed25519Keypair.fromSecretKey(process.env.AGENT_SECRET_KEY!);

  const tx = new Transaction();
  tx.transferObjects([coinWithBalance({ type: USDC_ASSET, balance: baseUnits })], to);

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

/**
 * A payment is not a lookup. Its promise can outlive the turn that asked for it, and a
 * caller that times out while the chain is finalising will ask again. On 2026-11-04
 * exactly that sent 0.5 USDC to Sana twice, twenty seconds apart, while the voice agent
 * told the caller both had failed. One key is one payment: an identical request arriving
 * while the first is still in flight waits on the same promise, and one arriving shortly
 * after it settles gets the same digest back instead of a second transfer.
 */
export function createPayOnce(send: (to: string, baseUnits: bigint) => Promise<Payment>, windowMs = Number(process.env.PAY_DEDUP_MS ?? 120_000)) {
  const recent = new Map<string, { at: number; payment: Payment }>();
  const inFlight = new Map<string, Promise<Payment>>();

  return async function payOnce(sender: string, to: string, baseUnits: bigint): Promise<Paid> {
    const key = `${sender.toLowerCase()}:${to.toLowerCase()}:${baseUnits}`;
    const now = Date.now();
    const kept = recent.get(key);
    if (kept && now - kept.at < windowMs) return { ...kept.payment, duplicate: true };

    const running = inFlight.get(key);
    if (running) return { ...(await running), duplicate: true };

    const work = send(to, baseUnits)
      .then((payment) => {
        recent.set(key, { at: Date.now(), payment });
        for (const [k, v] of recent) if (Date.now() - v.at >= windowMs) recent.delete(k);
        return payment;
      })
      .finally(() => {
        inFlight.delete(key);
      });
    inFlight.set(key, work);
    return { ...(await work), duplicate: false };
  };
}

export const payOnce = createPayOnce(payUsdc);
