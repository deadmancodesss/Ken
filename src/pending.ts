import type { Quote } from "./x402.js";

export type Pending = {
  id: string;
  sender: string;
  to: string;
  name: string | null;
  usdc: number;
  bytes: string;
  chain: string;
  createdAt: number;
  digest?: string;
  /** Set when the signature is buying a lookup rather than paying a person. */
  resource?: string;
  quote?: Quote;
};

// One slot, because a person should never be looking at two unsigned payments at
// once. Preparing a second replaces the first.
let current: Pending | null = null;

export function hold(p: Omit<Pending, "id" | "createdAt">): Pending {
  current = { ...p, id: Math.random().toString(36).slice(2, 8), createdAt: Date.now() };
  return current;
}

export function held(): Pending | null {
  return current;
}

export function settle(digest: string): Pending | null {
  if (!current) return null;
  current = { ...current, digest };
  return current;
}

export function release(): void {
  current = null;
}
