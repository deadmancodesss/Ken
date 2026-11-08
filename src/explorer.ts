/**
 * SuiVision names the network in the host, not the path. The mainnet host answers
 * "Invalid Transaction digest" for a testnet digest, so the host carries the network
 * and every receipt and dossier link in this build is built here once.
 */
const host = (net: string): string =>
  net === "mainnet" ? "https://suivision.xyz" : "https://testnet.suivision.xyz";

export const explorerTx = (net: string, digest: string): string =>
  `${host(net)}/txblock/${encodeURIComponent(String(digest))}`;

export const explorerAccount = (net: string, address: string): string =>
  `${host(net)}/account/${encodeURIComponent(String(address))}`;
