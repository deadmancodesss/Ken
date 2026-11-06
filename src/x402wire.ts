import { createHash } from "node:crypto";
import { bcs } from "@mysten/sui/bcs";
import { USDC_DECIMALS } from "./wallet.js";
import { PAY_CHAIN, USDC_ASSET, isUsdcCoin } from "./chain.js";

/**
 * x402 v2 on Sui.
 *
 * The standard is an HTTP handshake, not a JSON body with a 402 status. A server that
 * wants money answers with the price in a `PAYMENT-REQUIRED` header, the client comes
 * back with a signed payment in `PAYMENT-SIGNATURE`, and the reply carries the settled
 * transaction in `PAYMENT-RESPONSE`. The body is still human-readable on purpose, so a
 * person reading curl sees the same price the header carries.
 *
 * Sui's `exact` scheme pays with a signed transaction. The envelope below is Sui's own
 * SenderSignedTransaction, base64 encoded, which is the shape a Sui facilitator can
 * verify and broadcast without holding a key. The server never takes a digest on trust.
 */

export const HEADER_REQUIRED = "payment-required";
export const HEADER_SIGNATURE = "payment-signature";
export const HEADER_RESPONSE = "payment-response";
/* The first version of the protocol shipped these names. An older client that still
   sends them is understood rather than told its money is not welcome. */
export const HEADER_SIGNATURE_V1 = "x-payment";
export const HEADER_RESPONSE_V1 = "x-payment-response";

export type Network = "sui:testnet" | "sui:mainnet";

export type PaymentRequirements = {
  scheme: "exact";
  network: Network;
  asset: string;
  payTo: string;
  amount: string;
  maxTimeoutSeconds: number;
  resource: string;
  description: string;
  mimeType: string;
  extra: {
    /** The quote this price belongs to, so a retry cannot be judged against another. */
    quote?: string;
    /** What the resource server calls itself, for a client that shows the seller. */
    name?: string;
    /** Sui coin metadata a wallet needs before it can display the asset. */
    symbol?: string;
    decimals?: number;
    /** Set when the payment settles at the client, which no standard client should see. */
    settlement?: "facilitator" | "client";
  };
};

export type PaymentRequired = {
  x402Version: 2;
  error: string;
  resource: { url: string; description: string; mimeType: string };
  accepts: PaymentRequirements[];
};

export type PaymentPayload = {
  x402Version: 2;
  scheme: "exact";
  network: Network;
  payload: { transaction: string };
};

export type SettlementResponse = {
  success: boolean;
  transaction: string;
  network: Network;
  payer?: string;
  amount?: string;
  errorReason?: string;
};

export type VerifyRequest = {
  x402Version: number | string;
  paymentPayload: string;
  paymentRequirements: PaymentRequirements;
};

export type VerifyResponse = { isValid: boolean; invalidReason?: string; payer?: string };

const b64 = (text: string) => Buffer.from(text, "utf8").toString("base64");
const unb64 = (text: string) => Buffer.from(text, "base64").toString("utf8");

export function encodeHeader(value: unknown): string {
  return b64(JSON.stringify(value));
}

export function decodeHeader<T>(value: string): T {
  return JSON.parse(unb64(String(value).trim())) as T;
}

export function sameVersion(v: unknown): boolean {
  return v === 2 || v === "2" || v === "v2";
}

export function requirementsFor(input: {
  resource: string;
  description: string;
  payTo: string;
  baseUnits: bigint;
  quote?: string;
  network?: Network;
  asset?: string;
  timeoutSeconds?: number;
  name?: string;
}): PaymentRequirements {
  return {
    scheme: "exact",
    network: input.network ?? PAY_CHAIN,
    asset: input.asset ?? USDC_ASSET,
    payTo: input.payTo,
    amount: String(input.baseUnits),
    maxTimeoutSeconds: input.timeoutSeconds ?? 600,
    resource: input.resource,
    description: input.description,
    mimeType: "application/json",
    extra: {
      quote: input.quote,
      name: input.name ?? "Ken paid index",
      symbol: "USDC",
      decimals: USDC_DECIMALS,
    },
  };
}

export function paymentRequired(input: {
  error: string;
  url: string;
  description: string;
  accepts: PaymentRequirements[];
}): PaymentRequired {
  return {
    x402Version: 2,
    error: input.error,
    resource: { url: input.url, description: input.description, mimeType: "application/json" },
    accepts: input.accepts,
  };
}

/**
 * A Sui signature covers TransactionData bytes, and the envelope wraps those bytes with
 * the intent a Sui validator expects. Building the envelope here rather than on the page
 * means the browser only has to hand over what its wallet returned, and a wallet that
 * cannot sign without executing cannot pretend it did.
 */
export function envelopeFromSigned(bytesBase64: string, signature: string): string {
  const data = bcs.TransactionData.parse(Buffer.from(bytesBase64, "base64"));
  const envelope = bcs.SenderSignedTransaction.serialize({
    intentMessage: {
      intent: { scope: { TransactionData: true }, version: { V0: true }, appId: { Sui: true } },
      value: data,
    },
    txSignatures: [signature],
  }).toBytes();
  return Buffer.from(envelope).toString("base64");
}

export type OpenEnvelope = {
  /** The TransactionData bytes the signature covers. */
  transaction: Uint8Array;
  sender: string;
  signatures: string[];
  /** Hash of the whole envelope, used to stop one payment being settled twice. */
  fingerprint: string;
};

export function openEnvelope(envelopeBase64: string): OpenEnvelope {
  const raw = Buffer.from(String(envelopeBase64), "base64");
  if (!raw.length) throw new Error("the payment payload is empty");
  let parsed;
  try {
    parsed = bcs.SenderSignedTransaction.parse(raw);
  } catch {
    throw new Error("the payment payload is not a signed Sui transaction");
  }
  const data = parsed.intentMessage.value;
  const transaction = bcs.TransactionData.serialize(data).toBytes();
  const sender = String((data as any)?.V1?.sender ?? "");
  if (!/^0x[0-9a-fA-F]{64}$/.test(sender)) throw new Error("the signed transaction has no sender");
  const signatures = (parsed.txSignatures ?? []).map(String);
  if (!signatures.length) throw new Error("the signed transaction carries no signature");
  return {
    transaction,
    sender,
    signatures,
    fingerprint: createHash("sha256").update(raw).digest("hex"),
  };
}

export function amountToBase(usdc: number): bigint {
  return BigInt(Math.round(usdc * 10 ** USDC_DECIMALS));
}

export function baseToAmount(base: string | bigint): number {
  return Number(BigInt(base)) / 10 ** USDC_DECIMALS;
}

export function isUsdc(coinType: string): boolean {
  return isUsdcCoin(coinType);
}

/** The body a person sees beside the headers. It never hides the price in a header only. */
export function withPayment(
  body: Record<string, unknown>,
  required: PaymentRequired,
  response?: SettlementResponse,
): { headers: Record<string, string>; body: Record<string, unknown> } {
  const headers: Record<string, string> = {
    [HEADER_REQUIRED]: encodeHeader(required),
  };
  if (response) headers[HEADER_RESPONSE] = encodeHeader(response);
  return { headers, body: { ...body, x402Version: 2, accepts: required.accepts } };
}
