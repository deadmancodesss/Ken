import { session } from "./session.js";
import { currentSeat } from "./seat.js";

/**
 * Things the person told the agent to keep about themselves belong to the wallet, not
 * the browser and not one ledger. A seat with no wallet has no address to hang them on,
 * so the seat is the owner instead. This is the chat key without the network, because a
 * spam mark or a reminder is about a person and a time, and neither changes with the
 * ledger switch.
 */
export function ownerKey(): string {
  const s = session();
  if (!s.wallet) return `seat:${currentSeat()?.id ?? "console"}`;
  return `wallet:${s.wallet.toLowerCase()}`;
}
