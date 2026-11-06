// Sui wallets publish themselves through the Wallet Standard. This page has no
// bundler, so the handshake the SDKs do is done by hand here.
//
// Three routes find a wallet, and none of them knows a vendor's name: the handshake,
// a wallet manager that answers when asked, and anything in this browser that can
// connect, name an account and sign on Sui. Whichever route found it, the same four
// adapters then read it: how to ask for accounts, where the account list lives, what
// shape the address arrived in, and which signing call that wallet exposes.
//
// The handshake has two halves, and every page runs both in an inline script in
// <head>: it answers the app-ready call a wallet makes when the wallet loaded
// first, and it listens for the register-wallet callback a wallet makes when it
// loaded after. Both push the wallet objects into window.__walletStandardEarly,
// which is what everything below reads.
//
// The order matters. A wallet that loaded before this page had said anything would
// otherwise never be seen, and the page would report "no wallet is installed" to a
// browser that has one.

const EARLY = (window.__walletStandardEarly ??= []);

/**
 * Anything in this browser that behaves like a Sui wallet, whatever it calls itself. A
 * page that matches on a vendor name works only for the wallets somebody happened to
 * list, so a wallet is recognised by what it can do: open a connection, name an
 * account, sign on Sui.
 */
function providers() {
  /* Nothing is called during this scan. A window has thousands of names in it and a
     random extension's getter may open a popup, spend a quota or throw, so a wallet is
     picked out by the methods sitting on it and only then asked for anything. */
  const found = [];
  for (const key of Object.getOwnPropertyNames(window)) {
    let w;
    try {
      w = window[key];
    } catch {
      continue;
    }
    if (!w || (typeof w !== "object" && typeof w !== "function") || found.includes(w)) continue;
    /* Every read below is guarded, because an extension is free to publish a getter
       that throws, and one of those must not take down the scan for every other wallet.
       requestPermissions is how the older Sui API opens its window, so it counts as a
       way to ask even though there is no connect() to call. */
    let canConnect = false;
    let hasAccounts = false;
    let signsSui = false;
    try {
      canConnect = !!routes(w).length;
      hasAccounts =
        Array.isArray(w.accounts) || typeof w.getAccounts === "function" || typeof w.features?.["standard:accounts"]?.getAccounts === "function";
      signsSui =
        typeof w.signAndExecuteTransaction === "function" ||
        typeof w.signAndExecuteTransactionBlock === "function" ||
        Object.keys(w.features ?? {}).some((f) => f.startsWith("sui:"));
    } catch {
      continue;
    }
    if (canConnect && hasAccounts && signsSui) found.push(w);
  }
  return found;
}

/**
 * Everything that announced itself, from the handshake, from a wallet manager that
 * answers when asked, and from anything in this browser that behaves like a Sui
 * wallet without ever introducing itself.
 */
function sources() {
  const seen = [...EARLY, ...providers()];
  try {
    const live = navigator.wallets?.get?.();
    if (Array.isArray(live)) seen.push(...live);
  } catch {
    /* nothing to take from a manager that refuses to answer */
  }
  return seen.filter((w) => w && typeof w === "object");
}

function dedupe() {
  const featureCount = (w) => Object.keys(w.features ?? {}).length;
  const byName = new Map();
  const unnamed = [];
  for (const w of sources()) {
    if (!w.name) {
      if (!unnamed.includes(w)) unnamed.push(w);
      continue;
    }
    /* A legacy provider object and the same wallet's standard registration are one
       wallet to a person, so the one publishing more of itself wins the slot rather
       than whichever was read last. */
    const held = byName.get(w.name);
    if (!held || featureCount(w) >= featureCount(held)) byName.set(w.name, w);
  }
  return [...byName.values(), ...unnamed];
}

/* Accounts a connect call returned directly. Some wallets hand the account over in the
   reply and never write it back onto themselves, so keeping the reply is the only way
   the account that just approved this page is ever seen again. */
const FRESH = new Map();

/**
 * The account list, from whichever place a wallet keeps it, the reply to this page's
 * own connect call included. A getter that throws is one more wallet that has nothing
 * to show rather than a crash.
 */
function listAccounts(w) {
  const reads = [
    () => FRESH.get(w),
    () => w.accounts,
    () => w.features?.["standard:accounts"]?.getAccounts?.(),
    () => w.getAccounts?.(),
  ];
  for (const read of reads) {
    let v;
    try {
      v = read();
    } catch {
      continue;
    }
    if (Array.isArray(v) && v.length) return v;
  }
  return [];
}

/**
 * A Sui address is 32 bytes. The standard lets a wallet hand it over as a hex string
 * or as raw bytes, and a locked wallet can publish a property that throws when it is
 * read, so this is a shape check rather than a dot. A public key is not an address
 * and is never used as one, because paying a wrong address is not a mistake this
 * page gets to make twice.
 */
function hexed(text) {
  const bare = String(text).trim().replace(/^0x/i, "").toLowerCase();
  return /^[0-9a-f]{64}$/.test(bare) ? `0x${bare}` : "";
}

function asBytes(v) {
  if (v instanceof Uint8Array) return [...v];
  if (Array.isArray(v) && v.length && v.every((b) => Number.isInteger(b) && b >= 0 && b < 256)) return v;
  /* A wallet extension lives in its own world, so a byte array it hands across can be
     an object this page's Uint8Array refuses to recognise. The numbers are still in it,
     so it is read by index rather than by class. */
  const n = typeof v?.length === "number" ? v.length : typeof v?.byteLength === "number" ? v.byteLength : 0;
  if (!n || n > 64) return null;
  const bytes = [];
  for (let i = 0; i < n; i++) {
    const b = Number(v[i]);
    if (!Number.isInteger(b) || b < 0 || b > 255) return null;
    bytes.push(b);
  }
  return bytes;
}

export function addressOf(a) {
  let raw;
  try {
    raw = a?.address;
  } catch {
    return "";
  }
  const bytes = asBytes(raw);
  if (bytes?.length === 32) return hexed(bytes.map((b) => b.toString(16).padStart(2, "0")).join(""));
  if (typeof raw === "string") return hexed(raw);
  /* Every shape is checked against the 32-byte form before it is accepted, so a wallet
     that publishes something odd gets a refusal rather than a guessed address. */
  try {
    return hexed(String(raw));
  } catch {
    return "";
  }
}

/** How a value looks to this page, said plainly enough to diagnose a wallet from. */
function shape(v) {
  const bytes = asBytes(v);
  if (bytes) return `${bytes.length} bytes`;
  if (Array.isArray(v)) return `${v.length} items`;
  if (typeof v === "function") return "a function";
  if (typeof v === "string") return v.length > 24 ? `${v.slice(0, 24)}…` : v || "blank";
  if (v && typeof v === "object") {
    const n = typeof v.length === "number" ? ` ${v.length} long` : typeof v.byteLength === "number" ? ` ${v.byteLength} bytes` : "";
    const name = typeof v.constructor?.name === "string" ? v.constructor.name : "no constructor";
    return `an object of type ${name}${n}`;
  }
  return v === undefined ? "nothing there" : String(v);
}

/**
 * The field names an account actually publishes. When a wallet hands back an object
 * this page cannot read, the only honest sentence is what the object said about
 * itself, so the failure sheet lists keys instead of guessing at a cause.
 */
function keysOf(a) {
  /* The prototype chain is walked with getOwnPropertyNames, because a wallet that
     builds its account as a class hides its getters from Object.keys, and that is
     exactly the shape worth describing. */
  const names = new Set();
  for (let o = a; o && o !== Object.prototype; o = Object.getPrototypeOf(o)) {
    for (const k of Object.getOwnPropertyNames(o)) names.add(k);
  }
  const out = [];
  for (const k of [...names].sort()) {
    if (k === "constructor") continue;
    let v;
    try {
      v = a[k];
    } catch {
      out.push(`${k} (throws when read)`);
      continue;
    }
    out.push(`${k} (${shape(v)})`);
  }
  return out;
}

/**
 * A wallet name is written by the extension, not by us. It can be blank or absurd,
 * so it is never trusted as a label and never put into markup.
 */
function label(w) {
  let name = "";
  try {
    name = typeof w?.name === "string" ? w.name.trim() : "";
  } catch {
    /* a name is a courtesy, never a requirement */
  }
  return name || "an unnamed wallet";
}

function clean(err) {
  const text = String(err?.message ?? err ?? "").replace(/^Error:\s*/, "").trim();
  if (!text) return "no reason given";
  return text.length > 160 ? `${text.slice(0, 160)}…` : text;
}

/** A wallet error carries the page's own observations, so the person can read facts. */
function fail(message, hint, notes = []) {
  const err = new Error(message);
  err.hint = hint;
  err.notes = notes;
  err.detail = report();
  return err;
}

/**
 * What this page can see about every wallet that announced itself. This is shown
 * verbatim when connecting fails, because the alternative is a person guessing
 * which of five states their extension is actually in.
 */
export function report() {
  return sources().map((w) => {
    try {
      const features = Object.keys(w.features ?? {}).sort();
      // An extension serves its own icon, so the icon URL is the one field that says
      // which extension made this registration. A wallet named "e" is guesswork, the
      // id is not.
      const icon = typeof w.icon === "string" ? w.icon : "";
      const ext = icon.match(/extension:\/\/([^/]+)/);
      return {
        name: label(w),
        version: typeof w.version === "string" ? w.version : "",
        extension: ext ? ext[1] : "",
        canBeAsked: !!connector(w),
        keepsAccounts: features.includes("standard:accounts"),
        connectShape: shape(w.features?.["standard:connect"] ?? w.connect ?? null),
        features,
        accounts: listAccounts(w).map((a) => ({
          address: addressOf(a),
          keys: keysOf(a),
          chains: a?.chains?.length ? [...a.chains] : ["no chain named"],
          canSign: !!signerOf(w, a),
        })),
      };
    } catch (err) {
      /* One wallet that throws while being described must not take the whole sheet
         down, because the sheet is what a person has left when connecting failed. */
      return {
        name: label(w),
        version: "",
        extension: "",
        canBeAsked: false,
        keepsAccounts: false,
        connectShape: "unreadable",
        features: [],
        accounts: [],
        error: clean(err),
      };
    }
  });
}

/** Wallets this page can reach, plus the account each one exposes. */
export function discover() {
  return dedupe().map((w) => ({
    wallet: w,
    name: label(w),
    icon: w.icon,
    accounts: listAccounts(w).map((a) => ({
      address: addressOf(a),
      chain: (a.chains ?? [])[0] ?? "sui:unknown",
      canSign: !!signerOf(w, a),
    })),
  }));
}

/**
 * Things in this browser that look like a wallet and what each one is missing.
 *
 * A person with five extensions installed and nothing usable cannot tell whether none
 * of them speak this page's language or one of them is merely locked, so every
 * wallet-shaped object on window is named with the capability it failed to show. This
 * is a description of what is present, not a claim that any of it can be used.
 */
export function injections() {
  const found = [];
  for (const key of Object.getOwnPropertyNames(window)) {
    if (!/sui|wallet|chain|provider|ledger|blockchain/i.test(key)) continue;
    if (key === "__walletStandardEarly") continue;
    let w;
    try {
      w = window[key];
    } catch {
      found.push(`${key} (this page is not allowed to read it)`);
      continue;
    }
    if (!w || (typeof w !== "object" && typeof w !== "function")) continue;
    const hasAccounts = Array.isArray(w.accounts) || typeof w.getAccounts === "function" || !!w.features?.["standard:accounts"];
    const signsSui =
      typeof w.signAndExecuteTransaction === "function" ||
      typeof w.signAndExecuteTransactionBlock === "function" ||
      Object.keys(w.features ?? {}).some((k) => k.startsWith("sui:"));
    const missing = [
      !connector(w) ? "nothing to press to connect" : "",
      !hasAccounts ? "no account list" : "",
      !signsSui ? "no way to sign on Sui" : "",
    ].filter(Boolean);
    /* A browser global that has none of the three is not a wallet that went quiet, it
       is a name that happened to match, and putting it in the small print teaches a
       person to distrust the small print. */
    if (missing.length === 3) continue;
    found.push(missing.length ? `${key} (${missing.join(", ")})` : `${key} (has all three, and is counted above)`);
  }
  return found.slice(0, 14);
}

/**
 * The wallets a person actually keeps in their browser, and the plain reason each
 * one cannot sign here. Saying nothing about Phantom and MetaMask is the same as
 * letting them think the page is broken.
 */
const OTHERS = [
  { test: (w) => !!w.phantom?.solana || !!w.phantom?.evm, name: "Phantom", why: "it ended Sui support on 24 September 2026" },
  { test: (w) => !!w.ethereum?.isMetaMask, name: "MetaMask", why: "it only signs EVM transactions, and Sui is not EVM" },
  { test: (w) => !!w.ethereum?.isRabby, name: "Rabby", why: "it only signs EVM transactions" },
  { test: (w) => !!w.ethereum?.isCoinbaseWallet, name: "Coinbase Wallet", why: "it holds Ethereum and Solana, not Sui" },
  { test: (w) => !!w.solana, name: "a Solana wallet", why: "Sui is a different chain and a different transaction format" },
];

export function whyNoSuiWallet() {
  const seen = OTHERS.filter((o) => o.test(window)).map((o) => `${o.name} (${o.why})`);
  return seen.length
    ? `this browser has ${seen.join(" and ")}. None of them hold Sui, so none of them can pay here`
    : "no wallet in this browser told this page it holds Sui. Any Sui wallet works, whichever version of the wallet API it speaks";
}
/**
 * What a connect call handed back. The standard lets a wallet return its accounts in
 * the reply even when it never publishes them on itself, and a wallet that resolves
 * with an empty list while its window is still opening has refused nothing.
 */
function accountsIn(result) {
  let list;
  try {
    list = result?.accounts;
  } catch {
    return [];
  }
  const n = typeof list?.length === "number" ? list.length : 0;
  const out = [];
  for (let i = 0; i < n && i < 16; i++) out.push(list[i]);
  return out;
}

/**
 * A named method on a feature, whichever generation of the standard published it.
 *
 * The current standard puts the call in a method that carries the feature's own name,
 * so standard:connect is `feature.connect()` and sui:signAndExecuteTransaction is
 * `feature.signAndExecuteTransaction()`. The older standard put a single `invoke`, and
 * older wallets still publish a feature that is itself the function. The Sui docs show
 * the first shape, which is the one a current Slush speaks.
 */
function methodOf(feature, name) {
  if (!feature) return null;
  if (typeof feature[name] === "function") return (input) => feature[name](input);
  if (typeof feature.invoke === "function") return (input) => feature.invoke(input);
  if (typeof feature === "function") return (input) => feature(input);
  return null;
}

/** Every generation of this API that can open a wallet, current shape first. */
function routes(w) {
  const feature = w.features?.["standard:connect"];
  const out = [];
  /* The standard's connect takes a silent flag, and every Sui wallet that speaks it
     answers without a window when this origin is already trusted. That is the only
     arm a reloaded page may pull on its own, because opening a wallet window because
     somebody loaded a page is not a thing a page gets to do. */
  if (typeof feature?.connect === "function") {
    out.push({ what: "its standard connect, asked quietly", quiet: true, call: () => feature.connect({ silent: true }) });
    out.push({ what: "its standard connect", call: () => feature.connect() });
  }
  if (typeof feature?.invoke === "function") out.push({ what: "its older connect", call: () => feature.invoke() });
  if (typeof feature === "function") out.push({ what: "its connect feature", call: () => feature() });
  if (typeof w.connect === "function") out.push({ what: "its own connect", call: () => w.connect() });
  if (typeof w.requestPermissions === "function")
    out.push({
      what: "its permissions request",
      call: () => w.requestPermissions({ permissions: ["viewAccount", "suggestTransactions"] }),
    });
  return out;
}

/** Asks one wallet to open its accounts, in whichever shape that wallet publishes. */
function connector(w) {
  return (routes(w).find((r) => !r.quiet) ?? routes(w)[0])?.call ?? null;
}

/* The older Sui API answers getAccounts() with a promise, so a synchronous read sees
   a promise and calls it an empty list. One await is all that separates that wallet
   from being usable, so the reply is kept like any other account list. */
async function readLegacy(w) {
  try {
    const got = await w.getAccounts?.();
    if (Array.isArray(got) && got.length) FRESH.set(w, got);
  } catch {
    /* an older reader that refuses is one more wallet with nothing to show */
  }
}

async function poll(asked, ms) {
  const end = Date.now() + ms;
  for (;;) {
    if (asked.some((w) => listAccounts(w).length)) return true;
    if (Date.now() >= end) return false;
    await new Promise((r) => setTimeout(r, 300));
  }
}

/** The one next action, chosen from what the wallets actually did. */
function hintFor(asked, notes) {
  if (notes.some((n) => /closed/.test(n))) return "press Connect again and approve the popup your extension opens";
  if (asked.some((w) => !connector(w)))
    return "this extension registers itself to pages but leaves a page nothing to press. Reloading once the extension is open and unlocked is what usually fixes that";
  return "open the extension, unlock it, switch it to the Sui network this page is reading, then press Connect again";
}

/**
 * `chosen` is the wallet object a person clicked, not its name, because a name can
 * be blank, duplicated or written by an extension that does not expect to be read.
 *
 * `control` is how the dialogue talks back to a connect that is still running. The
 * sheet offers a button that asks the wallet again, because a window that opened
 * behind the browser is the most common reason a person sees nothing happen.
 */
export async function connect(chosen, onStatus, control = {}) {
  const all = dedupe();
  if (!all.length) throw fail(whyNoSuiWallet(), "install a Sui wallet, reload this page, then press Connect again");

  if (!chosen) chosen = all[0];
  /* One wallet can announce itself twice, once through the standard and once as an
     older window object, and a name is the only thing the two share. Asking both is
     how a stale registration stops being a dead end. */
  const asked = [chosen];
  if (typeof chosen.name === "string" && chosen.name) {
    for (const w of sources()) if (w !== chosen && w.name === chosen.name && !asked.includes(w)) asked.push(w);
  }

  const waitMs = Number(control.waitMs) > 0 ? Number(control.waitMs) : 90000;
  const notes = [];
  let heard = false;
  let nudges = 0;
  let turns = 0;
  control.again = () => {
    nudges++;
  };

  /* The first ask happens inside the click, so the wallet is allowed to open a window.
     A wallet that resolves with nothing has not refused: its window may still be
     opening, so this waits rather than calling it a failure. */
  const openAll = async () => {
    for (const w of asked) {
      if (listAccounts(w).length) return;
      const list = routes(w);
      for (const [i, r] of list.entries()) {
        let refused = false;
        try {
          const got = accountsIn(await r.call());
          /* The wallet answered, even when the answer was an empty list. That is the
             difference between "it said no" and "it never spoke", and the failure sheet
             is not allowed to confuse the two. */
          heard = true;
          if (got.length) FRESH.set(w, got);
        } catch (err) {
          refused = true;
          const text = clean(err);
          const closed = /denied|dismiss|reject|cancel|abort|closed/i.test(text);
          if (closed) heard = true;
          notes.push(`${label(w)} ${closed ? "had its window closed, so nothing was shared" : text}`);
        }
        await readLegacy(w);
        /* Six seconds is a person reading a wallet window, not a hang. Changing route
           sooner opens a second window over somebody who was already halfway through
           approving the first. A refusal is different and moves on at once, and a quiet
           ask never opened a window, so there is nothing to wait for before the real one. */
        if (await poll(asked, refused || r.quiet ? 300 : list.length > 1 && i === 0 ? 6000 : 2500)) return;
      }
    }
  };

  onStatus?.(`opening ${label(asked[0])}`);
  await openAll();

  const started = Date.now();
  let lastTick = 0;
  for (;;) {
    if (asked.some((w) => listAccounts(w).length)) break;
    if (Date.now() - started > waitMs) break;
    if (nudges > turns) {
      turns = nudges;
      onStatus?.(`asking ${label(asked[0])} again`);
      await openAll();
      continue;
    }
    const secs = Math.round((Date.now() - started) / 1000);
    const tick = [4, 12, 30, 60].find((t) => secs >= t && t > lastTick);
    if (tick) {
      lastTick = tick;
      /* The sentence carries the real elapsed seconds rather than the threshold it
         crossed, because a throttled background tab can cross 4 seconds at 7. */
      onStatus?.(`${secs} seconds, and ${label(asked[0])} still shows this page no account`);
    }
    await poll(asked, 400);
  }

  const ready = [];
  for (const w of asked) {
    const accounts = listAccounts(w);
    if (accounts.length) ready.push({ wallet: w, accounts });
  }

  if (!ready.length) {
    const err = fail(
      asked.length === 1 ? `${label(asked[0])} did not show this page an account` : "none of your wallets showed this page an account",
      hintFor(asked, notes),
      notes,
    );
    err.answered = heard;
    throw err;
  }

  const chainOf = (a) => String((a.chains ?? [])[0] ?? "sui:unknown");
  /* An address shaped like a Sui one is not enough. MetaMask, Rabby and Coinbase all
     hand over 0x plus 64 hex on EVM, and setting one of those as this page's wallet
     would spend against an account that does not exist on Sui. */
  const onSui = (c) => c === "sui:unknown" || c.toLowerCase().startsWith("sui:");
  const pool = ready.flatMap(({ wallet, accounts }) =>
    accounts.map((account) => ({ wallet, account, chain: chainOf(account), address: addressOf(account) })),
  );
  const usable = pool.filter((p) => p.address && onSui(p.chain));
  if (!usable.length) {
    /* An account this page cannot use is not a connect. Posting it would blame the
       server for a thing the wallet never handed over, so the page says which fields
       the account did publish and which chain it named. */
    const readable = pool.filter((p) => p.address);
    const allWrongChain = readable.length > 0 && readable.every((p) => !onSui(p.chain));
    const seen = pool.map((p) => {
      const why = p.address ? `its chain is ${p.chain}, which is not Sui` : `its fields are ${keysOf(p.account).slice(0, 8).join(", ") || "nothing at all"}`;
      return `${label(p.wallet)} shared an account that cannot be used here because ${why}`;
    });
    throw fail(
      allWrongChain
        ? "every account in this browser sits on a chain this page cannot pay on"
        : `${label(ready[0].wallet)} shared an account with no address this page can read`,
      allWrongChain
        ? "add a Sui network to that wallet, then press try again"
        : "open the wallet and check it is unlocked and on Sui, then press try again",
      seen,
    );
  }

  const picked = (chosen ? usable.find((p) => p.wallet === chosen) : usable[0]) ?? usable[0];

  return {
    name: label(picked.wallet),
    address: picked.address,
    chain: picked.chain,
    canSign: !!signerOf(picked.wallet, picked.account),
  };
}

/**
 * The thing this page can call to get one transaction signed and executed, found by
 * what it is rather than by who shipped it. Two generations of the Sui wallet API are
 * installed in real browsers at the moment of writing: the standard puts a feature on
 * the account, the older one puts a method on the provider and takes the transaction
 * as base64 instead of bytes. Each is called the way its own name says to call it.
 *
 * The standard does not take bytes. A wallet asks the transaction to serialize itself
 * before the extension ever sees it, so the object handed over has to be the SDK's
 * Transaction rather than the bytes it was rebuilt from.
 */
function signerOf(w, account) {
  const onAccount = methodOf(account?.features?.["sui:signAndExecuteTransaction"], "signAndExecuteTransaction");
  if (onAccount) return { wants: "transaction", call: (tx, chain) => onAccount({ transaction: tx, chain, account }) };
  const onWallet = methodOf(w.features?.["sui:signAndExecuteTransaction"], "signAndExecuteTransaction");
  if (onWallet) return { wants: "transaction", call: (tx, chain) => onWallet({ transaction: tx, chain, account }) };
  if (typeof w.signAndExecuteTransaction === "function") {
    return { wants: "transaction", call: (tx) => w.signAndExecuteTransaction({ transaction: tx }) };
  }
  if (typeof w.signAndExecuteTransactionBlock === "function") {
    return { wants: "base64", call: (_tx, chain, base64) => w.signAndExecuteTransactionBlock({ transactionBlock: base64, account, chain }) };
  }
  return null;
}

/**
 * The same wallet, asked to sign and stop. The x402 exact scheme is settled by the
 * seller's facilitator from the bytes the wallet signed, so the wallet that owns the
 * money must never execute the transfer itself. A page that executed first would be
 * paying before the seller had a chance to check the terms.
 */
function signerOnlyOf(w, account) {
  const onAccount = methodOf(account?.features?.["sui:signTransaction"], "signTransaction");
  if (onAccount) return { wants: "transaction", call: (tx, chain) => onAccount({ transaction: tx, account, chain }) };
  const onWallet = methodOf(w.features?.["sui:signTransaction"], "signTransaction");
  if (onWallet) return { wants: "transaction", call: (tx, chain) => onWallet({ transaction: tx, account, chain }) };
  if (typeof w.signTransactionBlock === "function") {
    return { wants: "base64", call: (_tx, chain, base64) => w.signTransactionBlock({ transactionBlock: base64, account, chain }) };
  }
  return null;
}

/**
 * The one piece of the Sui SDK this page needs, fetched the first time somebody signs.
 * It is 33 KB gzipped, which no page should pay for just to show a wallet name.
 */
let SuiTransaction = null;

async function transactionFrom(bytesBase64) {
  SuiTransaction ??= (await import("/vendor/sui-transaction.js")).Transaction;
  const tx = SuiTransaction.from(bytesBase64);
  /* Wallet generations disagree on which JSON version they parse. The first version
     is the one both generations read, and it rebuilds these exact bytes, so a wallet
     is handed that whichever SDK it shipped with. */
  tx.toJSON = () => tx.serialize();
  return tx;
}

/** The first and last few characters, which is what a person recognises in a sentence. */
function short(address) {
  const text = String(address || "");
  return text.length > 14 ? `${text.slice(0, 6)}…${text.slice(-4)}` : text;
}

/**
 * The seat outlives the tab, so a reloaded page still says "Slush" in the masthead
 * while the wallet itself has not been asked anything in this load and may be
 * publishing no accounts at all. That is not a disconnection, it is an unasked
 * question, and the difference is the whole bug: a signature has no way to find an
 * account nobody asked for. This asks every wallet quietly, never opens a window, and
 * keeps whatever answers. A wallet that refuses quietly is left alone until somebody
 * presses something.
 */
export async function resume() {
  for (const w of dedupe()) {
    if (listAccounts(w).length) continue;
    /* Asked before any connect route, because a wallet old enough to have no connect
       feature is usually old enough to publish getAccounts, and that is the only door
       it leaves open to a page that is not allowed to open a window. */
    await readLegacy(w);
    if (listAccounts(w).length) continue;
    for (const r of routes(w)) {
      if (!r.quiet) break;
      try {
        const got = accountsIn(await r.call());
        if (got.length) FRESH.set(w, got);
      } catch {
        /* a locked wallet answers nothing quietly, which is not an error */
      }
      if (listAccounts(w).length) break;
    }
  }
  return holders();
}

/** Every account a wallet is willing to show this page right now, by address. */
function holders() {
  return dedupe().flatMap((w) =>
    listAccounts(w).map((account) => ({
      wallet: w,
      account,
      at: addressOf(account),
      chain: String((account?.chains ?? [])[0] ?? "sui:unknown"),
    })),
  );
}

/**
 * The wallet this page connected as, remembered by name beside its address. It is only
 * ever used to pick which wallet to ask, and only when the address matches, because a
 * name from storage is not an identity.
 */
function namedFor(address) {
  try {
    const saved = JSON.parse(localStorage.getItem("walletName") || "null");
    if (saved?.name && String(saved.address).toLowerCase() === String(address).toLowerCase()) {
      return dedupe().find((w) => label(w) === saved.name) ?? null;
    }
  } catch {
    /* private windows refuse storage, and the address alone still finds the account */
  }
  return null;
}

/**
 * The account that owns an address, asked for three times before this gives up: as it
 * stands, after a quiet ask, and after asking the wallet in the open. A page that was
 * reloaded has lost nothing, it simply has not asked yet, and telling that person
 * their wallet is "no longer connected" sends them to reconnect a wallet that never
 * left.
 */
async function holderFor(address, onStatus) {
  const wanted = String(address || "").toLowerCase();
  const find = () => holders().find((p) => p.at.toLowerCase() === wanted);

  let found = find();
  if (!found) {
    await resume();
    found = find();
  }

  if (!found) {
    let asked = null;
    try {
      onStatus?.("asking the wallet for this account");
      asked = await connect(namedFor(address) ?? undefined, onStatus, { waitMs: 25000 });
    } catch (err) {
      throw new Error(
        `this page had not asked the wallet for an account yet, and asking now got nothing back. ${clean(err) || "Open the wallet, unlock it, then press try again."}`,
      );
    }
    found = find();
    if (!found && asked?.address && asked.address.toLowerCase() !== wanted) {
      throw new Error(
        `the wallet came back as ${short(asked.address)}, and this payment was written for ${short(address)}. Switch the wallet to the account that started it, then press try again`,
      );
    }
  }

  if (!found) {
    throw new Error(
      `the wallet holding ${short(address)} did not hand that account to this page, so there was nothing to sign. Open it, check that account is unlocked, then press try again`,
    );
  }
  return found;
}

/**
 * Hands an unsigned transaction to the wallet. The user approving it in the
 * wallet is the confirmation step, so nothing here needs a second dialog.
 */
export async function signAndExecute({ address, chain, bytesBase64, onStatus }) {
  const found = await holderFor(address, onStatus);

  const sign = signerOf(found.wallet, found.account);
  if (!sign) throw new Error(`${label(found.wallet)} can show accounts but publishes no way to sign a Sui transaction`);

  let tx = null;
  if (sign.wants === "transaction") {
    try {
      onStatus?.("rebuilding the payment for the wallet");
      tx = await transactionFrom(bytesBase64);
    } catch (err) {
      throw new Error(`this payment could not be rebuilt for ${label(found.wallet)}: ${clean(err)}`);
    }
  }
  const res = await sign.call(tx, chain ?? found.chain, bytesBase64);
  return { digest: res?.digest ?? res?.txResult?.digest ?? null, effects: res?.effects ?? res?.txResult ?? null };
}

/**
 * The x402 half: the wallet signs the transfer and sends nothing. The returned bytes
 * and signature are the Sui envelope the seller's facilitator checks and broadcasts,
 * so the money moves for the terms that were published before the signature.
 */
export async function signX402({ address, chain, bytesBase64, onStatus }) {
  const found = await holderFor(address, onStatus);

  const sign = signerOnlyOf(found.wallet, found.account);
  if (!sign) {
    throw new Error(
      `${label(found.wallet)} publishes no way to sign a Sui transaction without sending it, and a paid answer has to be settled by the seller accepting the signed transfer. Try a wallet that supports signing a transaction without executing it`,
    );
  }

  let tx = null;
  if (sign.wants === "transaction") {
    try {
      onStatus?.("rebuilding the payment for the wallet");
      tx = await transactionFrom(bytesBase64);
    } catch (err) {
      throw new Error(`this payment could not be rebuilt for ${label(found.wallet)}: ${clean(err)}`);
    }
  }
  const res = await sign.call(tx, chain ?? found.chain, bytesBase64);
  const bytes = res?.bytes ?? res?.transactionBlockBytes ?? "";
  const signature = res?.signature ?? "";
  if (!bytes || !signature) {
    throw new Error(`${label(found.wallet)} returned no signed transaction, so there is nothing the seller could settle`);
  }
  return { bytes: String(bytes), signature: String(signature) };
}
