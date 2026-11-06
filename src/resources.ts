import { DIGEST } from "./chain.js";
import { NOTE_ID } from "./notes.js";

/*
 * One spelling for one thing behind a paywall, shared by the seller that publishes a
 * price and the buyer that pays it. This file has no network and no money in it on
 * purpose: both processes import the same parsing rules, so a resource cannot mean one
 * thing to the party asking and another to the party charging.
 */

export type Fact = { name: string; kind: string; note: string };

export const ADDRESS = /^0x[0-9a-fA-F]{64}$/;

/** A profile is the chain's own arithmetic over one address, not a directory entry. */
export function resourceId(address: string): string {
  if (!ADDRESS.test(address)) throw new Error(`${address} is not a full 0x Sui address`);
  return `profile:${address.toLowerCase()}`;
}

export function noteResourceId(id: string): string {
  if (!NOTE_ID.test(id)) throw new Error(`${id} is not one of the link ids this index issues`);
  return `note:${id}`;
}

export function receiptResourceId(digest: string): string {
  if (!DIGEST.test(digest)) throw new Error(`${digest} is not a Sui transaction digest`);
  return `receipt:${digest}`;
}

export type Resource =
  | { kind: "profile"; address: string }
  | { kind: "note"; id: string }
  | { kind: "receipt"; digest: string };

/**
 * `identity:` was the name this paywall used before the paid fact became a chain read.
 * It is still parsed as a profile because links and ledgers in the wild carry it, and a
 * public URL is not allowed to stop meaning what it meant when somebody wrote it down.
 */
export function parseResource(resource: string): Resource {
  const [kind, ...rest] = String(resource).trim().split(":");
  const value = rest.join(":");
  if ((kind === "profile" || kind === "identity") && ADDRESS.test(value)) {
    return { kind: "profile", address: value.toLowerCase() };
  }
  if (kind === "note" && NOTE_ID.test(value)) return { kind: "note", id: value };
  if (kind === "receipt" && DIGEST.test(value)) return { kind: "receipt", digest: value };
  throw new Error(
    `this index sells profile:<0x address> chain reads, note:<id> links and receipt:<digest> chain checks, and "${resource}" is none of them`,
  );
}

/**
 * Addresses and link ids fold case because neither distinguishes it. A digest is
 * base58, where two strings that differ only by case are two different transactions,
 * so the value is left exactly as it was given.
 */
export function canonical(resource: string): string {
  const parsed = parseResource(resource);
  if (parsed.kind === "profile") return `profile:${parsed.address}`;
  if (parsed.kind === "note") return `note:${parsed.id}`;
  return `receipt:${parsed.digest}`;
}

export function addressOf(resource: string): string {
  const parsed = parseResource(resource);
  if (parsed.kind !== "profile") throw new Error(`${resource} is not an address profile`);
  return parsed.address;
}
