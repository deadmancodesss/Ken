import { session } from "./session.js";

/**
 * One delegate key serves every visitor, so without this the person who connects
 * their own wallet would read and write everyone else's memories, and two strangers
 * would share one brain. Each namespace is derived from the wallet being narrated.
 */
export function scope(kind: "people" | "counterparties"): string {
  const { wallet, network } = session();
  return `${kind}-${network}-${wallet.slice(2, 14).toLowerCase()}`;
}

/** The namespace the app wrote into before memory was scoped per wallet. */
export const LEGACY = { people: "people", counterparties: "counterparties" } as const;
