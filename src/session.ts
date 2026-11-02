import type { Net } from "./chain.js";
import { forgetCounterparties } from "./knowledge.js";
import { release } from "./pending.js";

export type Session = { wallet: string; network: Net; source: "demo" | "wallet" };

const ADDRESS = /^0x[0-9a-fA-F]{64}$/;

// The demo ships with one narrated wallet so the seeded history and the chain
// reads point at the same place. Connecting a browser wallet replaces it for
// every read that follows.
const demo: Session = {
  wallet: process.env.DEMO_WALLET ?? process.env.AGENT_ADDRESS!,
  network: process.env.DEMO_WALLET_NETWORK === "mainnet" ? "mainnet" : "testnet",
  source: "demo",
};

let current: Session = demo;

export function session(): Session {
  return current;
}

function swap(next: Session): Session {
  current = next;
  // The rail must never keep showing the previous wallet's people, and a
  // transaction built for one sender must not still be sitting there to sign
  // after the wallet has changed.
  forgetCounterparties();
  release();
  return current;
}

export function useDemoWallet(): Session {
  return swap(demo);
}

export function useWallet(address: string, chain?: string): Session {
  if (!ADDRESS.test(address)) throw new Error(`${address} is not a full Sui address`);
  const network: Net = chain === "mainnet" || chain?.includes("mainnet") ? "mainnet" : "testnet";
  return swap({ wallet: address, network, source: "wallet" });
}
