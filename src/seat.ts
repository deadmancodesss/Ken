import { AsyncLocalStorage } from "node:async_hooks";
import type { Pending } from "./pending.js";
import type { Session } from "./session.js";

/**
 * One visitor is one seat. The wallet they connected, the ticket waiting for their
 * signature and the calls they have open all belong to that seat rather than to the
 * process, because a second browser opening this build must not change the first
 * one's wallet or clear its screen, which is what a single global session did.
 */
export type Seat = {
  id: string;
  /** Null until this seat chooses a wallet, and then it falls back to the demo story. */
  session: Session | null;
  pending: Pending | null;
  /** The owner::session key of the thread this request is reading or writing. */
  chat: string | null;
  /** Minutes east of UTC as this browser reports them, refreshed on every request. */
  tz: number | null;
  seen: number;
};

const byId = new Map<string, Seat>();
// The request handler runs inside this store, so every tool reached from that request
// reads the same seat without a session argument threaded through sixty call sites.
const als = new AsyncLocalStorage<Seat>();

export function within<T>(seat: Seat, fn: () => T): T {
  return als.run(seat, fn);
}

export function currentSeat(): Seat | null {
  return als.getStore() ?? null;
}

/** A command line script has no seat, and it should behave like one lone operator. */
export function seatId(): string {
  return currentSeat()?.id ?? "console";
}

export function seatFor(id: string, restore?: () => Session | null): Seat {
  const kept = byId.get(id);
  if (kept) {
    kept.seen = Date.now();
    return kept;
  }
  const fresh: Seat = { id, session: restore?.() ?? null, pending: null, chat: null, tz: null, seen: Date.now() };
  byId.set(id, fresh);
  return fresh;
}

/**
 * A browser that never comes back should not hold a seat forever. A day is far longer
 * than one sitting and far shorter than the process, and the rows in the chat store
 * are not touched here, because a conversation outliving its seat is the point.
 */
export function sweepSeats(maxAgeMs = 24 * 60 * 60 * 1000): number {
  const cut = Date.now() - maxAgeMs;
  let gone = 0;
  for (const [id, seat] of byId) {
    if (seat.seen < cut) {
      byId.delete(id);
      gone++;
    }
  }
  return gone;
}

export function seatsOpen(): number {
  return byId.size;
}

/**
 * The calendar day on the clock of the person using this seat. The browser reports
 * its offset in a cookie, because a person at 1 am in one country is still on
 * yesterday in UTC and the agent would date a payment a day it did not happen.
 * A command line has no seat and falls back to the machine's own clock.
 */
export function localDay(at: Date = new Date()): string {
  const east = currentSeat()?.tz;
  const shifted = typeof east === "number";
  const clock = shifted ? new Date(at.getTime() + east * 60_000) : at;
  const year = shifted ? clock.getUTCFullYear() : clock.getFullYear();
  const month = shifted ? clock.getUTCMonth() : clock.getMonth();
  const day = shifted ? clock.getUTCDate() : clock.getDate();
  return `${year}-${String(month + 1).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
}
