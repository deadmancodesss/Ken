import "dotenv/config";

export type Net = "mainnet" | "testnet";

function endpoint(net: Net): { url: string; key: string } {
  return net === "testnet"
    ? { url: process.env.TATUM_SUI_GRAPHQL_URL_TESTNET!, key: process.env.TATUM_API_KEY_TESTNET! }
    : { url: process.env.TATUM_SUI_GRAPHQL_URL!, key: process.env.TATUM_API_KEY! };
}

/**
 * Which ledger money moves on, decided in exactly one place.
 *
 * Reads and memory answered on mainnet long before this, so the only thing that ever
 * pinned the build to testnet was a handful of coin addresses and network strings
 * copied between six files. PAY_NETWORK now sets all of them from the server
 * environment: the deployed app defaults to mainnet, and the recorded demo can name
 * testnet in one line without touching code.
 */
export const PAY_NET: Net = process.env.PAY_NETWORK === "testnet" ? "testnet" : "mainnet";
export const PAY_CHAIN = `sui:${PAY_NET}` as "sui:mainnet" | "sui:testnet";

/**
 * Circle's native USDC, one package per ledger. Both strings were read back from their
 * own chain rather than copied from a document: each answers coinMetadata with
 * symbol USDC and 6 decimals on its network, and each is the package the wallet that
 * pays actually holds.
 */
export const USDC_COIN: Record<Net, string> = {
  mainnet: "0xdba34672e30cb065b1f93e3ab55318768fd6fef66c15942c9f7cb846e2f900e7::usdc::USDC",
  testnet: "0xa1ec7fc00a6f40db9693ad1415d0c193ad3906494428cf252621037bd7117e29::usdc::USDC",
};

/** The coin this build prices, signs and settles in. */
export const USDC_ASSET = USDC_COIN[PAY_NET];

/** True for Circle USDC on either ledger, which is what a balance change has to be. */
export function isUsdcCoin(coinType: string): boolean {
  const t = String(coinType).toLowerCase();
  return Object.values(USDC_COIN).some((pkg) => t.includes(pkg.split("::")[0].toLowerCase()) && t.includes("usdc"));
}

/** The gateway the payment path talks through, with a PAY_ override for a relay. */
export function payGateway(net: Net = PAY_NET): { url: string; key: string } {
  const { url, key } = endpoint(net);
  return { url: process.env.PAY_GRAPHQL_URL || url, key: process.env.PAY_GRAPHQL_KEY || key };
}

export type Flow = {
  digest: string;
  timestamp: string | null;
  counterparty: string;
  coinType: string;
  amount: bigint;
};

/**
 * The transaction index does not hold the whole chain, and a listing whose walk starts
 * below what it keeps is refused for every address on it, busy or brand new. Measured on
 * mainnet 2026-11-06 with the head at 342334200: `address.transactions` and every
 * `transactions(filter:{affectedAddress})` shape without a floor answered
 * `ListTransactions: stream error OutOfRange: requested data below earliest available;
 * lowest available checkpoint is 237661232`, for a wallet that had transacted seconds
 * earlier. This build read that as an empty history, which is the worst possible failure
 * for an agent whose whole job is to answer about it.
 *
 * A document that needs a history window writes `{FLOOR}` where the checkpoint goes and
 * `gql` fills it in. The refusal names the true boundary, so one stale guess costs a
 * second request and then corrects itself for the life of the process. Testnet has no
 * boundary, and 0 means "from the start" there.
 */
const floors: Record<Net, number> = { mainnet: 237_661_233, testnet: 0 };
const BELOW_INDEX = /lowest available checkpoint is (\d+)/i;

async function gql<T>(query: string, net: Net = "mainnet"): Promise<T> {
  const { url, key } = endpoint(net);
  let refloored = false;
  for (let attempt = 1; ; attempt++) {
    const doc = query.replaceAll("{FLOOR}", String(floors[net]));
    const res = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json", "x-api-key": key },
      body: JSON.stringify({ query: doc }),
    });
    // The free tier is 3 requests per second and says so with a retry-after.
    // Without this, a 429 parses as an empty result and the agent confidently
    // reports "you have no money history" instead of failing.
    if (res.status === 429 && attempt < 4) {
      await new Promise((r) => setTimeout(r, (Number(res.headers.get("retry-after")) || 1) * 1000));
      continue;
    }
    if (!res.ok) throw new Error(`Tatum HTTP ${res.status} on ${net}`);
    const body: any = await res.json().catch(() => ({}));
    const errors: any[] = body.errors ?? [];
    if (errors.length) {
      // The detail lives under extensions, and it is the only thing that separates a
      // wallet with nothing on it from a gateway that cannot answer.
      const said = (e: any) => `${e.message}${e?.extensions?.chain?.length ? ` (${e.extensions.chain.join(", ")})` : ""}`;
      const detail = [...new Set(errors.map(said))].join(" | ");
      const boundary = doc.includes("afterCheckpoint") ? detail.match(BELOW_INDEX)?.[1] : undefined;
      if (boundary && !refloored) {
        refloored = true;
        floors[net] = Number(boundary) + 1;
        continue;
      }
      throw new Error(`Tatum GraphQL: ${detail}`);
    }
    if (!body.data) throw new Error(`Tatum returned no data (HTTP ${res.status})`);
    return body.data as T;
  }
}

/** Which checkpoint this build is willing to read history from, for tests and probes. */
export const historyFloor = (net: Net): number => floors[net];

/**
 * The free key answers 3 requests per second and says so with a 429. `gql` above waits
 * that out, but the SDK's own client is used anywhere a transaction is built, simulated
 * or sent, and it throws the provider error straight through. Measured on mainnet
 * 2026-11-06: a payment build that follows a few balance reads fails with `Too Many
 * Requests (429)` while the person is waiting to sign, which is the worst moment in the
 * product to discover a rate limit. Anything that goes through the SDK client is run
 * through this, so the wait is the same on both paths.
 */
const LIMITED = /429|too many requests|rate limit|cap on request/i;

export async function throughRateLimit<T>(work: () => Promise<T>, tries = 4): Promise<T> {
  for (let attempt = 1; ; attempt++) {
    try {
      return await work();
    } catch (err) {
      if (attempt >= tries || !LIMITED.test(String((err as Error)?.message ?? err))) throw err;
      await new Promise((r) => setTimeout(r, 1500 * attempt));
    }
  }
}

export function short(addr: string): string {
  return `${addr.slice(0, 10)}…${addr.slice(-4)}`;
}

export function coinName(type: string): string {
  const [pkg, mod, name] = type.split("::");
  if (name === "SUI") return "SUI";
  // "USDC (usdc)" is the same word twice. The module only earns its place when
  // it disagrees with the ticker, which is how you tell two USDCs apart.
  return mod.toLowerCase() === name.toLowerCase() ? name : `${name} (${mod})`;
}

type CoinMeta = { symbol: string; decimals: number };
const metaCache = new Map<string, CoinMeta>();

/**
 * Tatum counts a `coinMetadata` lookup as one or more dedicated reads against the backing
 * store and refuses a document that asks for too many ("Exceeded the maximum number (21)
 * of queries that require dedicated access to a backing store", measured on mainnet
 * 2026-11-06, where twelve aliases answered and fifteen did not). A coin whose metadata
 * lives in a dynamic field costs more than one, so the batch halves itself on that
 * refusal rather than losing the wallet's whole balance.
 */
const META_BATCH = 12;
const OVER_READ_CEILING = /maximum number \(\d+\) of queries that require dedicated access/i;

async function metaFor(coinTypes: string[], net: Net): Promise<Map<string, CoinMeta>> {
  const found = new Map<string, CoinMeta>();
  const missing: string[] = [];
  for (const type of coinTypes) {
    const hit = metaCache.get(`${net}|${type}`);
    if (hit) found.set(type, hit);
    else if (!missing.includes(type)) missing.push(type);
  }
  let size = META_BATCH;
  let at = 0;
  while (at < missing.length) {
    const group = missing.slice(at, at + size);
    const doc = `{ ${group.map((type, i) => `m${i}: coinMetadata(coinType:"${type}"){ symbol decimals }`).join(" ")} }`;
    let data: Record<string, { symbol?: string; decimals?: number } | null>;
    try {
      data = await gql<Record<string, { symbol?: string; decimals?: number } | null>>(doc, net);
    } catch (err) {
      const msg = String((err as Error)?.message ?? err);
      if (!OVER_READ_CEILING.test(msg)) throw err;
      if (group.length === 1) {
        throw new Error(`the chain will not read the metadata of ${group[0]}, so its balance cannot be turned into an amount`);
      }
      size = Math.max(1, Math.floor(group.length / 2));
      continue;
    }
    group.forEach((type, i) => {
      const meta = { symbol: data?.[`m${i}`]?.symbol ?? coinName(type), decimals: data?.[`m${i}`]?.decimals ?? 0 };
      metaCache.set(`${net}|${type}`, meta);
      found.set(type, meta);
    });
    at += group.length;
  }
  return found;
}

export async function coinDecimals(coinType: string, net: Net = "mainnet"): Promise<number> {
  return (await metaFor([coinType], net)).get(coinType)?.decimals ?? 0;
}

export function formatAmount(base: bigint, decimals: number): string {
  const neg = base < 0n;
  const s = (neg ? -base : base).toString().padStart(decimals + 1, "0");
  const whole = s.slice(0, -decimals);
  const frac = decimals ? s.slice(-decimals).replace(/0+$/, "") : "";
  return `${neg ? "-" : ""}${whole}${frac ? "." + frac : ""}`;
}

export type Holding = { symbol: string; amount: number; decimals: number; type?: string; base: string };

/**
 * Every coin the chain says this wallet holds, without us naming any of them first.
 *
 * The read this replaces took a list of coin types we wrote, so a wallet holding a coin
 * that never occurred to us read as an empty wallet, and on mainnet the list was one coin
 * because nobody here had verified another. This asks the chain what is there instead.
 * Measured on the demo wallet on 2026-11-04: SUI 1.058194424 and USDC 12.631540, both
 * with their own decimals, in one request.
 *
 * The metadata is a second request rather than a field beside each balance because a
 * busy mainnet wallet holds enough distinct coins to cross the gateway's per-request read
 * ceiling, and then the whole balance read fails: measured 2026-11-06 on a wallet holding
 * 15 coins, where the nested form failed and the flat one answered.
 */
export async function allHoldings(wallet: string, net: Net = "mainnet", first = 12): Promise<Holding[]> {
  if (!/^0x[0-9a-fA-F]{1,64}$/.test(wallet)) throw new Error("that is not a Sui address");
  const data = await gql<{ address: { balances: { nodes: any[] } } }>(
    `{ address(address:"${wallet}"){ balances(first:${Math.min(50, Math.max(1, first))}){ nodes { coinType { repr } totalBalance } } } }`,
    net,
  );
  const rows = (data.address?.balances?.nodes ?? []).filter((n) => !!n.coinType?.repr);
  const meta = await metaFor(rows.map((n) => String(n.coinType.repr)), net);
  return rows.map((n) => {
    const type = String(n.coinType.repr);
    const decimals = meta.get(type)?.decimals ?? 0;
    return {
      symbol: meta.get(type)?.symbol ?? coinName(type),
      amount: Number(BigInt(n.totalBalance ?? "0")) / 10 ** decimals,
      decimals,
      type,
      // The raw base units are kept so a balance can be compared with the sum of
      // transfers exactly, without two roundings of the same coin disagreeing.
      base: String(BigInt(n.totalBalance ?? "0")),
    };
  });
}

export type ActivityPage = {
  flows: Flow[];
  /** The cursor to pass back to read the next older page. */
  cursor: string | null;
  /** Older history remains behind this page. */
  hasNext: boolean;
  count: number;
};

/** A balance change exactly as the index reports it: base units of its own coin. */
type CoinChangeRow = { address: string; coinType: string; amount: string };

type PageOfTransactions = {
  transactions: {
    pageInfo: { hasPreviousPage: boolean; startCursor: string | null };
    nodes: { digest: string; effects?: { timestamp?: string | null; balanceChangesJson?: CoinChangeRow[] } | null }[];
  } | null;
};

/** What one page of history can be. "Page size is too large: 80 > 50", mainnet 2026-11-06. */
const MAX_PAGE = 50;

/**
 * A wallet's newest transactions, turned into money moving between this address and
 * somebody else.
 *
 * `affectedAddress` is the whole difference between a wallet with a history and a wallet
 * reported as having none. The plain listing only contains transactions this address
 * signed, so a person who has ever been paid and has never paid reads as a stranger to
 * their own money. Measured on Sana's testnet wallet on 2026-11-04: 0 sent, 6 affected,
 * and all 6 were money arriving.
 *
 * The connection orders oldest first, so `last` is the newest page and older history is
 * reached with `before:startCursor`, where hasPreviousPage is the flag that says more
 * remains. The cursor is returned because a question about where a balance came from
 * walks further back than the one page every other caller reads. It is opaque, so it is
 * quoted as JSON rather than pasted into the query.
 *
 * The effects ride along in the same document. They used to cost a second request per
 * twenty digests, which on a gateway that allows three requests a second meant one
 * question about a busy wallet took three trips for fifty rows.
 */
export async function recentActivityPage(
  wallet: string,
  limit = 40,
  before: string | null = null,
  net: Net = "mainnet",
): Promise<ActivityPage> {
  if (!/^0x[0-9a-fA-F]{1,64}$/.test(wallet)) throw new Error("that is not a Sui address");
  const size = Math.min(MAX_PAGE, Math.max(1, Math.trunc(limit)));
  const cursor = before ? `, before:${JSON.stringify(before)}` : "";
  const list = await gql<PageOfTransactions>(
    `{ transactions(last:${size}${cursor}, filter:{ affectedAddress:"${wallet}", afterCheckpoint:{FLOOR} }){ pageInfo { hasPreviousPage startCursor } nodes { digest effects { timestamp balanceChangesJson } } } }`,
    net,
  );
  const nodes = list.transactions?.nodes ?? [];
  const info = list.transactions?.pageInfo;
  const flows: Flow[] = [];
  for (const tx of nodes) {
    const mine = wallet.toLowerCase();
    const seen = new Set<string>();
    for (const c of tx?.effects?.balanceChangesJson ?? []) {
      if (String(c.address).toLowerCase() === mine) continue;
      if (BigInt(c.amount) === 0n) continue;
      const k = `${c.address}|${c.coinType}`;
      if (seen.has(k)) continue;
      seen.add(k);
      flows.push({
        digest: tx.digest,
        timestamp: tx.effects?.timestamp ?? null,
        counterparty: c.address,
        coinType: c.coinType,
        amount: BigInt(c.amount),
      });
    }
  }
  return { flows, cursor: info?.startCursor ?? null, hasNext: !!info?.hasPreviousPage, count: nodes.length };
}

/** The newest page, which is what every caller that is not tracing a balance reads. */
export async function recentActivity(wallet: string, limit = 10, net: Net = "mainnet"): Promise<Flow[]> {
  return (await recentActivityPage(wallet, limit, null, net)).flows;
}

/**
 * The gateway only links a transaction to the address that *signed* it, so money
 * that arrived from someone else never shows up in your own list. An inbound
 * transfer is invisible from this side no matter how long you wait. Reading each
 * known counterparty's history recovers it: we take the coin change that landed
 * on the wallet and mirror its sign, which is exactly the convention
 * recentActivity uses.
 */
export async function flowsFromOthers(
  wallet: string,
  others: string[],
  perAddress = 8,
  net: Net = "mainnet",
): Promise<Flow[]> {
  if (others.length === 0) return [];
  /*
   * One alias per person is what makes this document grow past the gateway's 5000 byte
   * cap on a busy wallet: every address a person has ever paid is added to the roster
   * above. The list is therefore read in capped batches, which is two requests instead
   * of one on a small wallet and a working answer instead of an error on a large one.
   * Sixteen people measured 3.4 KB of document with the effects inline (2026-11-06).
   */
  const flows: Flow[] = [];
  const PER_PERSON_BATCH = 16;
  for (let start = 0; start < others.length; start += PER_PERSON_BATCH) {
    const group = others.slice(start, start + PER_PERSON_BATCH);
    const aliases = group
      .map(
        (a, i) =>
          `p${i}: transactions(last:${Math.min(MAX_PAGE, Math.max(1, Math.trunc(perAddress)))}, filter:{ affectedAddress:"${a}", afterCheckpoint:{FLOOR} }){ nodes { digest effects { timestamp balanceChangesJson } } }`,
      )
      .join(" ");
    const batch = await gql<Record<string, any>>(`{ ${aliases} }`, net);

    for (const [alias, entry] of Object.entries(batch)) {
      const person = group[Number(alias.slice(1))];
      for (const tx of entry?.nodes ?? []) {
        const changes: { address: string; coinType: string; amount: string }[] =
          tx.effects?.balanceChangesJson ?? [];
        const byCoin = new Map<string, bigint>();
        for (const c of changes) {
          if (c.address.toLowerCase() !== wallet.toLowerCase()) continue;
          byCoin.set(c.coinType, (byCoin.get(c.coinType) ?? 0n) + BigInt(c.amount));
        }
        for (const [coinType, mine] of byCoin) {
          // Only money that arrived here is news. A negative change on our side is a
          // payment we already read from our own history, and most of it is the gas we
          // paid for the transaction. Mirroring that negative back would book gas as a
          // transfer to the person and show every recipient a second time.
          if (mine <= 0n) continue;
          flows.push({
            digest: tx.digest,
            timestamp: tx.effects?.timestamp ?? null,
            counterparty: person,
            coinType,
            amount: -mine,
          });
        }
      }
    }
  }
  return flows;
}

export type CoinChange = { address: string; coinType: string; amount: bigint };
export type Settled = { digest: string; status: string; timestamp: string | null; changes: CoinChange[] };

// A Sui digest is base58 over 32 bytes, so it is 43 or 44 characters. Checking the
// shape here keeps a typo from becoming a chain call and a provider error string.
// Case is part of the identity, so anything that keys on a digest has to preserve it.
export const DIGEST = /^[1-9A-HJ-NP-Za-km-z]{43,44}$/;

/**
 * One settled transaction, read back from the chain. A payment only becomes a
 * memory after this shows the money arriving, because the thing reporting the
 * digest is a browser, and a browser is allowed to lie.
 */
export async function transactionAt(digest: string, net: Net = "mainnet"): Promise<Settled | null> {
  if (!DIGEST.test(digest)) throw new Error(`${digest} is not a Sui transaction digest`);
  const res = await gql<{ transaction: any }>(
    `{ transaction(digest:"${digest}"){ digest effects { status timestamp balanceChangesJson } } }`,
    net,
  );
  const tx = res.transaction;
  if (!tx) return null;
  const changes: CoinChange[] = (tx.effects?.balanceChangesJson ?? []).map((c: any) => ({
    address: c.address,
    coinType: c.coinType,
    amount: BigInt(c.amount),
  }));
  return { digest, status: tx.effects?.status ?? "UNKNOWN", timestamp: tx.effects?.timestamp ?? null, changes };
}

/**
 * A transaction the node has already accepted is not in the read index a second
 * later, and a seller that refuses that fast strands money that has really left.
 * So the reader gets a few seconds to catch up before anyone is told no.
 */
export async function waitForTransaction(
  digest: string,
  net: Net = "mainnet",
  tries = 15,
  everyMs = 1000,
): Promise<Settled | null> {
  let found: Settled | null = null;
  for (let i = 1; i <= tries; i++) {
    try {
      found = await transactionAt(digest, net);
      if (found) return found;
    } catch {
      /* Temporary indexing delay or network hiccup; retry next tick */
    }
    if (i < tries) await new Promise((r) => setTimeout(r, everyMs));
  }
  return found;
}
