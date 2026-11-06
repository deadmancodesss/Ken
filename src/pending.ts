import { chatKey } from "./chats.js";
import { currentSeat } from "./seat.js";
import type { PaymentRequirements } from "./x402wire.js";

export type Pending = {
  id: string;
  sender: string;
  to: string;
  name: string | null;
  usdc: number;
  bytes: string;
  chain: string;
  /**
   * The conversation the ticket was drawn in. The signature can arrive after the seat
   * has moved on, and the receipt belongs where the person asked for the payment, not
   * in whatever wallet happens to be selected when the wallet answers.
   */
  chat: string;
  createdAt: number;
  digest?: string;
  /** Set when the signature is buying a lookup rather than paying a person. */
  resource?: string;
  /** The terms the seller published, kept so the held bytes can be checked against them. */
  requirements?: PaymentRequirements;
  /** Set when this ticket is paying a request link, so the link can be closed. */
  request?: string;
};

/**
 * One slot per seat, because a person should never be looking at two unsigned payments
 * at once, and because two visitors looking at one slot is how one of them ends up
 * signing the other's ticket. Preparing a second replaces the first for that seat only.
 */
let fallback: Pending | null = null;

export function hold(p: Omit<Pending, "id" | "createdAt" | "chat"> & { chat?: string }): Pending {
  // The request that builds a payment has already resolved its thread, and the ticket
  // belongs to that thread rather than to the wallet's newest one. A call started from
  // a chat keeps the ticket in the chat it was spoken in.
  const made = { ...p, id: Math.random().toString(36).slice(2, 8), chat: p.chat ?? currentSeat()?.chat ?? chatKey(), createdAt: Date.now() };
  const seat = currentSeat();
  if (seat) seat.pending = made;
  else fallback = made;
  return made;
}

export function held(): Pending | null {
  const seat = currentSeat();
  return seat ? seat.pending : fallback;
}

export function settle(digest: string): Pending | null {
  const waiting = held();
  if (!waiting) return null;
  const done = { ...waiting, digest };
  const seat = currentSeat();
  if (seat) seat.pending = done;
  else fallback = done;
  return done;
}

export function release(): void {
  const seat = currentSeat();
  if (seat) seat.pending = null;
  else fallback = null;
}
