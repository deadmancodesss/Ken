import "dotenv/config";
import { SuiGraphQLClient } from "@mysten/sui/graphql";
import { Ed25519Keypair } from "@mysten/sui/keypairs/ed25519";
import { Transaction, coinWithBalance } from "@mysten/sui/transactions";
import { PAY_CHAIN, PAY_NET, USDC_ASSET, USDC_COIN, allHoldings, formatAmount, payGateway, throughRateLimit, type Net } from "./chain.js";

export { USDC_ASSET } from "./chain.js";

export const USDC_DECIMALS = 6;
export const SUI_DECIMALS = 9;
export const SUI_COIN = "0x2::sui::SUI";

/** The two coins this wallet can actually move. Prices and x402 stay USDC. */
export type PayAsset = "USDC" | "SUI";

/*
 * Each coin gets its own ceiling because a base unit of SUI is a billionth of a coin
 * and a base unit of USDC is a millionth. One shared number would either let a SUI
 * payment spend a thousand times what the limit reads as, or block a normal USDC
 * payment at five hundredths of a cent. The SUI ceiling of one SUI is deliberately
 * small: testnet SUI is free dust, and a mistyped zero should still be refused.
 */
const caps: Record<PayAsset, bigint> = {
  USDC: BigInt(process.env.PAY_MAX_BASE_UNITS ?? "5000000"),
  SUI: BigInt(process.env.PAY_MAX_SUI_MIST ?? "5000000000"),
};

export function decimalsFor(asset: PayAsset = "USDC"): number {
  return asset === "SUI" ? SUI_DECIMALS : USDC_DECIMALS;
}

export function baseUnitsFor(amount: number, asset: PayAsset = "USDC"): bigint {
  return BigInt(Math.round(amount * 10 ** decimalsFor(asset)));
}

// The chain travels with the payment so every receipt drawn from it can link to the
// explorer that actually saw the transfer. A payment that omitted the chain used
// to borrow whatever ledger the page happened to be reading at that moment.
export type Payment = { digest: string; to: string; amount: number; asset: PayAsset; chain: string };
export type Paid = Payment & { duplicate: boolean };
export type Prepared = { bytes: string; to: string; amount: number; asset: PayAsset; chain: string; sender: string };

function payClient(net: Net = PAY_NET) {
  const { url, key } = payGateway(net);
  return new SuiGraphQLClient({ url, network: net, headers: { "x-api-key": key } });
}

function checked(to: string, baseUnits: bigint, asset: PayAsset): void {
  if (!/^0x[0-9a-fA-F]{64}$/.test(to)) throw new Error("recipient must be a full 0x Sui address");
  if (baseUnits <= 0n) throw new Error("amount must be greater than zero");
  if (baseUnits > caps[asset]) throw new Error(`above the per-payment cap of ${paymentCap(asset)} ${asset}`);
}

/*
 * How much SUI has to stay on the gas coin beyond the amount being sent. A simple
 * transfer costs a fraction of this, and leaving it out is how a payment builds cleanly
 * and then fails in the wallet because the same coin had nothing left for the fee.
 */
const SUI_GAS_RESERVE = 5_000_000n;

/*
 * Sui waives the network fee for an allowlisted stablecoin from 0.01 USDC upward when
 * the money sits in the account's address balance. The transaction carries no gas
 * payment and a zero price and budget, and a short ValidDuring expiration because it
 * owns no object inputs.
 * Nothing is charged, so the wallet needs no SUI at all. Proved on testnet on
 * 2026-11-10: an address holding USDC and zero SUI received a transfer whose effects
 * report gasUsed all zeros.
 */
const GASLESS_MIN_BASE_UNITS = 10_000n;

export function gaslessTransfer(
  sender: string,
  to: string,
  baseUnits: bigint,
  coinType: string,
  epoch: string,
  chainIdentifier: string,
): Transaction {
  const tx = new Transaction();
  tx.setSender(sender);
  tx.setGasPayment([]);
  tx.setGasPrice(0);
  tx.setGasBudget(0);
  // A transaction with no address-owned object input has no digest anchor, so the
  // builder demands a validity window instead. One epoch past the current one is the
  // same window the SDK's own address-balance executor uses.
  tx.setExpiration({
    ValidDuring: {
      minEpoch: epoch,
      maxEpoch: String(BigInt(epoch) + 1n),
      minTimestamp: null,
      maxTimestamp: null,
      chain: chainIdentifier,
      nonce: Math.floor(Math.random() * 4294967296),
    },
  });
  const funds = tx.balance({ type: coinType, balance: baseUnits });
  tx.moveCall({
    target: "0x2::balance::send_funds",
    typeArguments: [coinType],
    arguments: [funds, tx.pure.address(to)],
  });
  return tx;
}

// Only this shape is free. A build that pulled in an owned object or fell back to a
// gas coin would be charged, and this wallet has no SUI to charge, so such a build is
// dropped instead of handed over.
export function isGaslessShape(built: Uint8Array): boolean {
  const data: any = Transaction.from(built).getData();
  const inputs: any[] = data.inputs ?? [];
  const gas: any = data.gasData ?? {};
  if (!inputs.some((i) => i?.FundsWithdrawal)) return false;
  if (inputs.some((i) => i?.Object)) return false;
  if ((gas.payment ?? []).length || String(gas.price) !== "0" || String(gas.budget) !== "0") return false;
  return true;
}

export async function gaslessUsdc(
  client: ReturnType<typeof payClient>,
  sender: string,
  to: string,
  baseUnits: bigint,
  coinType: string,
): Promise<Uint8Array | null> {
  if (baseUnits < GASLESS_MIN_BASE_UNITS) return null;
  const held: any = await client.core.getBalance({ owner: sender, coinType });
  if (BigInt(held?.balance?.addressBalance ?? 0n) < baseUnits) return null;
  const [{ systemState }, { chainIdentifier }] = await Promise.all([
    client.core.getCurrentSystemState(),
    client.core.getChainIdentifier(),
  ]);
  const built = await gaslessTransfer(sender, to, baseUnits, coinType, String(systemState.epoch), chainIdentifier).build({ client });
  return isGaslessShape(built) ? built : null;
}

/* The coin listing is paged by the gateway. The cap is a guard against reading a
   dust wallet forever, not an expectation: a normal wallet finishes on page one.
   Sui GraphQL limits page sizes to 50 items maximum. */
const COIN_PAGE = 50;
const COIN_PAGES = 10;

/*
 * A wallet transaction is read back by the extension with whichever Sui SDK that
 * extension shipped. The newest SDK now builds a SUI transfer from the address balance,
 * a new input kind the older SDK reading path cannot encode, and the wallet answers
 * "Invalid input" before showing anyone a popup. Ordinary coin objects are the shape
 * every generation reads, so a payment spends those whenever they cover it.
 */
export async function spendableCoins(
  client: ReturnType<typeof payClient>,
  owner: string,
  coinType: string,
  need: bigint,
  single = false,
): Promise<{ objectId: string; version: string; digest: string; balance: string }[]> {
  // Coins come back one page at a time, and a wallet that has been paid a few times
  // holds more than one page. Reading only the first page made the rest invisible,
  // which showed up as a wallet that could not spend a balance it clearly held.
  const seen: any[] = [];
  let cursor: string | null = null;
  for (let page = 0; page < COIN_PAGES; page++) {
    const listed: any = await client.core.listCoins({ owner, coinType, limit: COIN_PAGE, cursor });
    seen.push(...(listed?.objects ?? []));
    if (!listed?.hasNextPage || !listed.cursor) break;
    cursor = listed.cursor;
    if (single && seen.some((c: any) => BigInt(c?.balance ?? 0n) >= need)) break;
    if (!single && seen.reduce((sum: bigint, c: any) => sum + BigInt(c?.balance ?? 0n), 0n) >= need) break;
  }
  const coins = seen
    .filter((c: any) => c?.objectId && BigInt(c.balance ?? 0) > 0n)
    .sort((a: any, b: any) => (BigInt(b.balance) > BigInt(a.balance) ? 1 : -1));
  if (single) return coins[0] && BigInt(coins[0].balance) >= need ? [coins[0]] : [];
  const picked: any[] = [];
  let sum = 0n;
  for (const coin of coins) {
    picked.push(coin);
    sum += BigInt(coin.balance);
    if (sum >= need) return picked;
  }
  return [];
}

/**
 * Builds the transfer and stops before anyone signs it. The bytes go to a browser
 * wallet so the person who owns the money is the one who approves it.
 *
 * SUI is built differently in one way that matters: the network fee comes out of the
 * same coin being sent. The builder does the arithmetic, and a send that leaves nothing
 * for gas is refused here before the wallet is ever asked to sign.
 *
 * USDC that sits in the account's address balance can still move with no SUI, because
 * Sui waives the fee for that shape. When the ordinary build fails for want of the fee,
 * the payment is rebuilt that way before the wallet is told to find some SUI.
 */
export async function preparePayment(
  sender: string,
  to: string,
  amount: number,
  asset: PayAsset,
  net: Net = PAY_NET,
): Promise<Prepared> {
  if (!/^0x[0-9a-fA-F]{64}$/.test(sender)) throw new Error("sender must be a full 0x Sui address");
  const baseUnits = baseUnitsFor(amount, asset);
  checked(to, baseUnits, asset);

  // A transaction object is rebuilt per attempt because the builder resolves coins
  // into it. A 502 from the gateway is transient and safe to retry: nothing has been
  // signed, so a second build cannot move money twice.
  const build = async () => {
    const client = payClient(net);
    const tx = new Transaction();
    tx.setSender(sender);
    const coin = asset === "SUI" ? SUI_COIN : USDC_COIN[net];
    const coins = await spendableCoins(
      client,
      sender,
      coin,
      asset === "SUI" ? baseUnits + SUI_GAS_RESERVE : baseUnits,
      asset === "SUI",
    );
    if (coins.length && asset === "SUI") {
      // The gas coin is the one being spent, so the amount and the fee come from the
      // same object and the wallet is handed a plain split rather than address balance.
      tx.setGasPayment([{ objectId: coins[0].objectId, version: coins[0].version, digest: coins[0].digest }]);
      tx.transferObjects([tx.splitCoins(tx.gas, [baseUnits])], to);
    } else if (coins.length) {
      const refs = coins.map((c) => tx.object(c.objectId));
      if (refs.length > 1) tx.mergeCoins(refs[0], refs.slice(1));
      tx.transferObjects([tx.splitCoins(refs[0], [baseUnits])], to);
    } else {
      // Nothing in coin objects covers this, so the balance must be withdrawn from the
      // address balance. That is a newer input and only a newer wallet can sign it.
      tx.transferObjects([coinWithBalance({ type: coin, balance: baseUnits })], to);
    }
    return tx.build({ client });
  };

  // build() hands back serialized TransactionData bytes, which is exactly what a
  // browser wallet wants to be shown. Nothing here signs anything.
  let built: Uint8Array;
  try {
    built = await throughRateLimit(async () => {
      for (let attempt = 1; ; attempt++) {
        try {
          return await build();
        } catch (err) {
          const said = String((err as Error)?.message ?? err);
          const transient = /bad gateway|\b50[234]\b|fetch failed|econnreset|timed out|network/i.test(said);
          if (!transient || attempt >= 3) throw err;
          await new Promise((r) => setTimeout(r, 700 * attempt));
        }
      }
    });
  } catch (err) {
    // The SDK answers this in coin type hashes and base units. What the person
    // needs to hear is that the wallet they connected cannot cover the amount.
    const msg = String((err as Error)?.message ?? err);
    if (/\b429\b|too many requests|rate limit/i.test(msg)) {
      throw new Error(`the ledger gateway is busy and refused to look up the coins for this payment, so nothing was built and nothing was signed. Try again in a few seconds`);
    }
    if (/bad gateway|\b50[234]\b/i.test(msg)) {
      throw new Error(`the Tatum gateway returned a transient ${msg.match(/\b50[234]\b/)?.[0] ?? "502"} while building this payment, so nothing was built and nothing was signed. This is an upstream failure, not a problem with your wallet. Try again in a moment`);
    }
    if (/no valid gas coins|insufficient SUI balance/i.test(msg)) {
      // A wallet holding USDC in its address balance can still send it with no SUI,
      // because Sui waives the fee for the gasless stablecoin shape. This is tried
      // only after the ordinary build has already failed for want of the fee, and it
      // is checked against the address balance, which is the only source that shape
      // can spend. Coin objects cannot be converted into it here.
      if (asset === "USDC") {
        try {
          const gasless = await throughRateLimit(() =>
            gaslessUsdc(payClient(net), sender, to, baseUnits, USDC_COIN[net]),
          );
          if (gasless) {
            return { bytes: Buffer.from(gasless).toString("base64"), to, amount, asset, chain: `sui:${net}`, sender };
          }
        } catch {
          /* the message below is still true */
        }
      }
      // The SDK reaches this when the account holds no SUI the builder can use as gas.
      // It reads as a builder failure, but the person needs to know the wallet is short
      // one specific coin, and that nothing was signed.
      const short = `${sender.slice(0, 8)}…${sender.slice(-6)}`;
      const fee =
        asset !== "USDC"
          ? "A SUI payment pays the fee from the same balance, so leave a little SUI unspent"
          : net === "mainnet"
            ? "USDC on Sui does not pay its own network fee. Send a little SUI to that account and press again, or switch the page to testnet"
            : "USDC on Sui does not pay its own network fee. Get a little testnet SUI into that account and press again";
      throw new Error(
        `the connected account ${short} has no SUI available on ${net} for the network fee, so this payment was not built and nothing was signed. ${fee}`,
      );
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
        const coins = await allHoldings(sender, net);
        holds = coins.length
          ? ` That account holds ${coins.map((h) => `${formatAmount(BigInt(h.base), h.decimals)} ${h.symbol}`).join(", ")}.`
          : " That account holds no coins at all.";
      } catch {
        /* the message below is already true without the balance */
      }
      const gas =
        asset === "SUI"
          ? " A SUI payment also pays the network fee from this same balance, so leave a little SUI unspent."
          : "";
      throw new Error(
        `the transfer builder found less than ${amount} ${asset} at the connected account ${short}, so there is nothing to sign yet.${holds}${gas} A locked wallet cannot cause this. If your wallet app shows ${asset}, check that the account and network are the same ones, then press Connect again`,
      );
    }
    throw new Error(msg.slice(0, 200));
  }
  return { bytes: Buffer.from(built).toString("base64"), to, amount, asset, chain: `sui:${net}`, sender };
}

/** The USDC path x402 and request links depend on, kept as one name. */
export function prepareUsdc(sender: string, to: string, usdc: number, net: Net = PAY_NET): Promise<Prepared> {
  return preparePayment(sender, to, usdc, "USDC", net);
}

export function paymentsEnabled(): boolean {
  return process.env.PAY_ENABLED === "1";
}

export function paymentCap(asset: PayAsset = "USDC"): number {
  return Number(caps[asset]) / 10 ** decimalsFor(asset);
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
 * worthless testnet dust, so the key refuses to spend the moment the build settles
 * where USDC is real. A person's own wallet is never touched by this: those transfers
 * are built unsigned and the signature in their extension is the approval.
 */
function keySpendAllowed(): void {
  if (PAY_NET === "testnet") return;
  throw new Error(
    `this build settles ${PAY_CHAIN}, where the agent's own USDC would be real money, so the agent will not sign a payment nobody approved. Connect a wallet and sign it yourself, or run the build on testnet`,
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
  checked(to, baseUnits, "USDC");
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

export async function payCoin(to: string, baseUnits: bigint, asset: PayAsset): Promise<Payment> {
  if (!paymentsEnabled()) {
    throw new Error("payments disabled. Set PAY_ENABLED=1 in the server environment");
  }
  if (!/^0x[0-9a-fA-F]{64}$/.test(to)) throw new Error("recipient must be a full 0x Sui address");
  if (baseUnits <= 0n) throw new Error("amount must be greater than zero");
  if (baseUnits > caps[asset]) throw new Error(`above the per-payment cap of ${paymentCap(asset)} ${asset}`);
  keySpendAllowed();

  const client = payClient();
  const key = Ed25519Keypair.fromSecretKey(process.env.AGENT_SECRET_KEY!);

  const tx = new Transaction();
  tx.transferObjects([coinWithBalance({ type: asset === "SUI" ? SUI_COIN : USDC_ASSET, balance: baseUnits })], to);

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

  return { digest, to, amount: Number(baseUnits) / 10 ** decimalsFor(asset), asset, chain: PAY_CHAIN };
}

export function payUsdc(to: string, baseUnits: bigint): Promise<Payment> {
  return payCoin(to, baseUnits, "USDC");
}

/**
 * A payment is not a lookup. Its promise can outlive the turn that asked for it, and a
 * caller that times out while the chain is finalising will ask again. On 2026-11-04
 * exactly that sent 0.5 USDC to Sana twice, twenty seconds apart, while the voice agent
 * told the caller both had failed. One key is one payment: an identical request arriving
 * while the first is still in flight waits on the same promise, and one arriving shortly
 * after it settles gets the same digest back instead of a second transfer.
 */
export function createPayOnce(send: (to: string, baseUnits: bigint, asset: PayAsset) => Promise<Payment>, windowMs = Number(process.env.PAY_DEDUP_MS ?? 120_000)) {
  const recent = new Map<string, { at: number; payment: Payment }>();
  const inFlight = new Map<string, Promise<Payment>>();

  return async function payOnce(sender: string, to: string, baseUnits: bigint, asset: PayAsset = "USDC"): Promise<Paid> {
    // The coin is part of the identity, not a decoration on it. One USDC and one SUI
    // are both 1,000,000 base units, and a key that ignored the asset would answer a
    // SUI payment with the digest of yesterday's USDC transfer.
    const key = `${sender.toLowerCase()}:${asset}:${to.toLowerCase()}:${baseUnits}`;
    const now = Date.now();
    const kept = recent.get(key);
    if (kept && now - kept.at < windowMs) return { ...kept.payment, duplicate: true };

    const running = inFlight.get(key);
    if (running) return { ...(await running), duplicate: true };

    const work = send(to, baseUnits, asset)
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

export const payOnce = createPayOnce(payCoin);
