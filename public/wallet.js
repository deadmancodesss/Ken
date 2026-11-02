// Sui wallets publish themselves through the Wallet Standard. This page has no
// bundler, so the handshake the SDKs do is done by hand here.
//
// Wallets dispatch their registration event as soon as the page exists, which is
// before any module runs, so index.html captures those events into a global array
// in an inline script in <head>. Everything below reads that array.

const EARLY = (window.__walletStandardEarly ??= []);

function dedupe() {
  const byName = new Map();
  for (const w of [...EARLY, ...(navigator.wallets?.get?.() ?? [])]) {
    if (w && w.name) byName.set(w.name, w);
  }
  return [...byName.values()];
}

/** Wallets that speak the standard, plus the account each one exposes. */
export function discover() {
  return dedupe().map((w) => ({
    wallet: w,
    name: w.name,
    icon: w.icon,
    accounts: (w.accounts ?? []).map((a) => ({
      address: a.address,
      chain: (a.chains ?? [])[0] ?? "sui:unknown",
      canSign: !!a.features?.["sui:signAndExecuteTransaction"],
    })),
  }));
}

export async function connect(chosenName) {
  let wallets = dedupe();
  if (!wallets.length) throw new Error("no Sui wallet found in this browser");

  // A wallet that was already connected lists accounts up front. The others only
  // reveal them after standard:connect, so ask each one once.
  for (const w of wallets) {
    if (w.accounts?.length) continue;
    if (chosenName && w.name !== chosenName) continue;
    await w.features?.["standard:connect"]?.invoke?.().catch(() => {});
  }
  wallets = dedupe();

  const withAccounts = wallets.filter((w) => w.accounts?.length);
  if (!withAccounts.length) {
    throw new Error("the wallet was found but returned no account. Open it and unlock it, then try again");
  }

  const pool = withAccounts.flatMap((w) => w.accounts.map((a) => ({ wallet: w, account: a })));
  const match = chosenName ? pool.find((p) => p.wallet.name === chosenName) : pool[0];
  const picked = match ?? pool[0];

  return {
    name: picked.wallet.name,
    address: picked.account.address,
    chain: (picked.account.chains ?? [])[0] ?? "sui:unknown",
    canSign: !!picked.account.features?.["sui:signAndExecuteTransaction"],
  };
}

/**
 * Hands an unsigned transaction to the wallet. The user approving it in the
 * wallet is the confirmation step, so nothing here needs a second dialog.
 */
export async function signAndExecute({ address, chain, bytesBase64 }) {
  const found = dedupe()
    .flatMap((w) => (w.accounts ?? []).map((a) => ({ wallet: w, account: a })))
    .find((p) => p.account.address === address);
  if (!found) throw new Error("that wallet is no longer connected");

  const feature = found.account.features?.["sui:signAndExecuteTransaction"];
  if (!feature) throw new Error("this wallet cannot sign a transaction");

  const bytes = Uint8Array.from(atob(bytesBase64), (c) => c.charCodeAt(0));
  const res = await feature.invoke({ transaction: bytes, chain, account: found.account });
  return { digest: res?.digest ?? null, effects: res?.effects ?? null };
}
