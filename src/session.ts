import type { Net } from "./chain.js";
import { forgetCounterparties } from "./knowledge.js";
import { release } from "./pending.js";
import { currentSeat, seatId } from "./seat.js";
import { saveSession } from "./seat-store.js";

export type Session = { wallet: string; network: Net; source: "demo" | "wallet"; reported: string };

const ADDRESS = /^0x[0-9a-fA-F]{64}$/;

// The demo ships with one narrated wallet so the seeded history and the chain
// reads point at the same place. Connecting a browser wallet replaces it for
// every read that follows.
const demo: Session = {
  wallet: process.env.DEMO_WALLET ?? process.env.AGENT_ADDRESS!,
  network: process.env.DEMO_WALLET_NETWORK === "mainnet" ? "mainnet" : "testnet",
  source: "demo",
  reported: "",
};

/**
 * Scripts and tests run without a seat. A request always has one, so the fallback is
 * only ever the demo wallet seen by a command that has no browser in front of it.
 */
let fallback: Session = demo;

export function session(): Session {
  return currentSeat()?.session ?? fallback;
}

function swap(next: Session): Session {
  const seat = currentSeat();
  if (seat) {
    seat.session = next;
    saveSession(seat.id, next);
  } else fallback = next;
  // The rail must never keep showing the previous wallet's people, and a
  // transaction built for one sender must not still be sitting there to sign
  // after the wallet has changed. Both of those live in this seat, so a second
  // browser is untouched.
  forgetCounterparties();
  release();
  return next;
}

export function useDemoWallet(): Session {
  return swap(demo);
}

export function useWallet(address: string, chain?: string): Session {
  if (!ADDRESS.test(address)) throw new Error(`${address} is not a full Sui address`);
  const network: Net = chain === "mainnet" || chain?.includes("mainnet") ? "mainnet" : "testnet";
  return swap({ wallet: address, network, source: "wallet", reported: chain ?? "" });
}

/**
 * Which ledger this page reads is a separate decision from which wallet it speaks for,
 * because one address exists on both and a person with money on Mainnet should not have
 * to reconnect to see it. Reads move here. Money moves only where PAY_NETWORK says it
 * does, and a page reading the other ledger is refused before any bytes are built, so a
 * switch can never quietly point somebody's real wallet at a chain they are not on.
 */
export function useNetwork(network: string): Session {
  if (network !== "mainnet" && network !== "testnet") {
    throw new Error(`${network} is not a network this build can read`);
  }
  const net: Net = network;
  const current = session();
  if (net === current.network) return current;
  return swap({ ...current, network: net });
}

/**
 * A wallet that said mainnet at connect and a page now reading testnet would be shown
 * testnet bytes to sign, and the only honest answer to that is to refuse before the
 * bytes are built rather than after the popup appears.
 */
export function chainMismatch(): string | null {
  const current = session();
  if (current.source !== "wallet" || !current.reported) return null;
  const says = current.reported.includes("mainnet") ? "mainnet" : current.reported.includes("testnet") ? "testnet" : "";
  if (!says || says === current.network) return null;
  return `your wallet reported ${says} and this page is reading ${current.network}. Put them on the same network before anything is prepared`;
}

/**
 * The budget the person writes belongs to the wallet when one is connected and to
 * the browser seat on the demo story. Shared by the cap route and the chat tool so
 * the number the agent sets is the number the statement draws.
 */
export function capOwner(): string {
  const current = session();
  return current.source === "wallet" ? `wallet:${current.wallet.toLowerCase()}` : `seat:${seatId()}`;
}
