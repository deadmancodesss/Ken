import "dotenv/config";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { SuiGraphQLClient } from "@mysten/sui/graphql";
import { verifyTransactionSignature } from "@mysten/sui/verify";
import {
  openEnvelope,
  sameVersion,
  type PaymentRequirements,
  type SettlementResponse,
  type VerifyRequest,
  type VerifyResponse,
} from "./x402wire.js";
import { PAY_CHAIN, PAY_NET, USDC_ASSET, isUsdcCoin, payGateway, throughRateLimit } from "./chain.js";

/**
 * A self-hosted x402 facilitator for Sui.
 *
 * The facilitator holds no key and never chooses who gets paid. It reads the terms the
 * resource server published, checks that the signed transaction obeys them, simulates it
 * against the chain, and only then broadcasts the exact bytes the payer signed. That is
 * the whole reason a server can accept a payment it did not build itself.
 *
 * The API shape is the one the standard publishes: /supported, /verify, /settle. A
 * different facilitator can replace this one by setting FACILITATOR_URL.
 */

const STORE_FILE = process.env.FACILITATOR_STORE ?? new URL("../.facilitator.json", import.meta.url).pathname;

type Used = { envelopes: string[]; digests: { at: string; digest: string }[]; max?: number };

function used(): Used {
  if (!existsSync(STORE_FILE)) return { envelopes: [], digests: [] };
  try {
    const raw = JSON.parse(readFileSync(STORE_FILE, "utf8")) as Used;
    return { envelopes: raw.envelopes ?? [], digests: raw.digests ?? [] };
  } catch {
    return { envelopes: [], digests: [] };
  }
}

function save(u: Used): void {
  const keep = Number(process.env.FACILITATOR_REMEMBER ?? 2000);
  u.envelopes = u.envelopes.slice(-keep);
  u.digests = u.digests.slice(-keep);
  writeFileSync(STORE_FILE, JSON.stringify(u, null, 1));
}

export function rememberSettlement(fingerprint: string, digest: string): void {
  const u = used();
  if (!u.envelopes.includes(fingerprint)) u.envelopes.push(fingerprint);
  if (!u.digests.some((d) => d.digest === digest)) u.digests.push({ at: new Date().toISOString(), digest });
  save(u);
}

function client(): SuiGraphQLClient {
  const { url, key } = payGateway();
  return new SuiGraphQLClient({ url, network: PAY_NET, headers: { "x-api-key": key } });
}

export function supported() {
  return {
    kinds: [{ x402Version: 2, scheme: "exact", network: PAY_CHAIN }],
    extensions: [],
    signers: {},
  };
}

const ADDRESS = /^0x[0-9a-fA-F]{64}$/;

function termsOk(req: PaymentRequirements): string | null {
  if (req?.scheme !== "exact") return `this facilitator settles the exact scheme, not ${req?.scheme}`;
  if (req?.network !== PAY_CHAIN) return `this facilitator settles ${PAY_CHAIN}, not ${req?.network}`;
  if (!ADDRESS.test(String(req?.payTo ?? ""))) return "the terms name no payout address";
  if (!/^\d+$/.test(String(req?.amount ?? ""))) return "the terms name no amount in base units";
  if (BigInt(req.amount) <= 0n) return "the price is zero";
  if (String(req.asset) !== USDC_ASSET) return "the terms name a coin this facilitator does not settle";
  return null;
}

export type Verified = {
  ok: true;
  payer: string;
  transaction: Uint8Array;
  signatures: string[];
  fingerprint: string;
} | { ok: false; why: string };

/**
 * Verify never moves money. It checks the signature against the exact bytes, simulates
 * the transfer, and reads the balance changes the chain would produce. A payment that
 * passes here is safe to broadcast, and a payment that would overdraw or pay the wrong
 * address is refused before it is ever sent.
 */
export async function verify(input: VerifyRequest): Promise<Verified> {
  if (!sameVersion(input?.x402Version)) return { ok: false, why: "this facilitator speaks x402 version 2" };
  const req = input?.paymentRequirements;
  const bad = termsOk(req);
  if (bad) return { ok: false, why: bad };

  let opened;
  try {
    opened = openEnvelope(String(input.paymentPayload ?? ""));
  } catch (err) {
    return { ok: false, why: (err as Error).message };
  }

  if (used().envelopes.includes(opened.fingerprint)) {
    return { ok: false, why: "that payment was already settled once and cannot be settled again" };
  }

  for (const signature of opened.signatures) {
    try {
      const key = await verifyTransactionSignature(opened.transaction, signature, { address: opened.sender });
      if (key.toSuiAddress().toLowerCase() !== opened.sender.toLowerCase()) {
        return { ok: false, why: "the signature belongs to a different wallet than the transaction sender" };
      }
    } catch {
      return { ok: false, why: "the signature does not cover this transaction" };
    }
  }

  let sim;
  try {
    sim = await throughRateLimit(() =>
      client().simulateTransaction({
        transaction: opened.transaction,
        include: { effects: true, balanceChanges: true },
      }),
    );
  } catch (err) {
    return { ok: false, why: `the chain would not simulate this payment: ${String((err as Error)?.message ?? err).slice(0, 200)}` };
  }

  const result = sim.$kind === "Transaction" ? sim.Transaction : null;
  if (!result) return { ok: false, why: `the payment would fail on chain: ${String((sim as any)?.FailedTransaction?.status?.error?.message ?? "unknown reason")}` };
  if (!result.status?.success) {
    const why = (result.status as any)?.error?.message ?? (result.status as any)?.error ?? "unknown reason";
    return { ok: false, why: `the payment would fail on chain: ${String(why).slice(0, 200)}` };
  }

  const badTransfer = coversTerms(req, opened.sender, (result.balanceChanges ?? []) as Change[]);
  if (badTransfer) return { ok: false, why: badTransfer };

  return {
    ok: true,
    payer: opened.sender,
    transaction: opened.transaction,
    signatures: opened.signatures,
    fingerprint: opened.fingerprint,
  };
}

export function verifyResponse(v: Verified): VerifyResponse {
  return v.ok ? { isValid: true, payer: v.payer } : { isValid: false, invalidReason: v.why };
}

export type Change = { coinType: string; address: string; amount: string | bigint };

/**
 * The one rule about money in the payment, written apart from the simulation so it can
 * be tried against a forged set of balance changes without a chain. A credit at the
 * quoted address that is not funded by the wallet that signed is somebody else's money,
 * and an amount below the published price is not the price.
 */
export function coversTerms(req: PaymentRequirements, sender: string, changes: Change[]): string | null {
  const need = BigInt(req.amount);
  const arrived = changes.find(
    (c) => isUsdcCoin(c.coinType) && c.address.toLowerCase() === req.payTo.toLowerCase() && BigInt(c.amount) >= need,
  );
  if (!arrived) return `the transaction does not pay ${req.amount} base units of USDC to the quoted address`;

  const left = changes.find(
    (c) => isUsdcCoin(c.coinType) && c.address.toLowerCase() === sender.toLowerCase() && BigInt(c.amount) <= -need,
  );
  if (!left) return "the money does not leave the wallet that signed the transaction";
  return null;
}

/**
 * Settle re-runs verification, then broadcasts the payer's own signed bytes. There is
 * no second signature and no key on this side, so the transaction that lands on chain
 * is exactly the one the wallet showed its owner.
 */
export async function settle(input: VerifyRequest): Promise<SettlementResponse> {
  const checked = await verify(input);
  if (!checked.ok) {
    return { success: false, transaction: "", network: PAY_CHAIN, errorReason: checked.why };
  }

  try {
    const sent = await client().executeTransaction({
      transaction: checked.transaction,
      signatures: checked.signatures,
      include: { effects: true },
    });
    const done = sent.$kind === "Transaction" ? sent.Transaction : null;
    if (!done) {
      const why = String((sent as any)?.FailedTransaction?.status?.error?.message ?? "the node refused it");
      return { success: false, transaction: "", network: PAY_CHAIN, payer: checked.payer, errorReason: why.slice(0, 240) };
    }
    if (!done.status?.success) {
      const why = (done.status as any)?.error?.message ?? (done.status as any)?.error ?? "the transaction failed";
      return { success: false, transaction: "", network: PAY_CHAIN, payer: checked.payer, errorReason: String(why).slice(0, 240) };
    }
    rememberSettlement(checked.fingerprint, done.digest);
    return {
      success: true,
      transaction: done.digest,
      network: PAY_CHAIN,
      payer: checked.payer,
      amount: input.paymentRequirements.amount,
    };
  } catch (err) {
    return {
      success: false,
      transaction: "",
      network: PAY_CHAIN,
      payer: checked.payer,
      errorReason: `the chain would not settle it: ${String((err as Error)?.message ?? err).slice(0, 240)}`,
    };
  }
}
