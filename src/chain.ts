import "dotenv/config";

export type Net = "mainnet" | "testnet";

function endpoint(net: Net): { url: string; key: string } {
  return net === "testnet"
    ? { url: process.env.TATUM_SUI_GRAPHQL_URL_TESTNET!, key: process.env.TATUM_API_KEY_TESTNET! }
    : { url: process.env.TATUM_SUI_GRAPHQL_URL!, key: process.env.TATUM_API_KEY! };
}

export type Flow = {
  digest: string;
  timestamp: string | null;
  counterparty: string;
  coinType: string;
  amount: bigint;
};

async function gql<T>(query: string, net: Net = "mainnet"): Promise<T> {
  const { url, key } = endpoint(net);
  for (let attempt = 1; ; attempt++) {
    const res = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json", "x-api-key": key },
      body: JSON.stringify({ query }),
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
    if (body.errors?.length) {
      throw new Error(`Tatum GraphQL: ${body.errors.map((e: any) => e.message).join(" | ")}`);
    }
    if (!body.data) throw new Error(`Tatum returned no data (HTTP ${res.status})`);
    return body.data as T;
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

const decimalsCache = new Map<string, number>();

export async function coinDecimals(coinType: string, net: Net = "mainnet"): Promise<number> {
  const cached = decimalsCache.get(coinType);
  if (cached !== undefined) return cached;
  const d = await gql<{ coinMetadata: { decimals: number } | null }>(
    `{ coinMetadata(coinType:"${coinType}"){ decimals } }`,
    net,
  );
  const n = d.coinMetadata?.decimals ?? 0;
  decimalsCache.set(coinType, n);
  return n;
}

export function formatAmount(base: bigint, decimals: number): string {  const neg = base < 0n;
  const s = (neg ? -base : base).toString().padStart(decimals + 1, "0");
  const whole = s.slice(0, -decimals);
  const frac = decimals ? s.slice(-decimals).replace(/0+$/, "") : "";
  return `${neg ? "-" : ""}${whole}${frac ? "." + frac : ""}`;
}

export const NATIVE_SUI = "0x0000000000000000000000000000000000000000000000000000000000000002::sui::SUI";

export type Holding = { symbol: string; amount: number; decimals: number };

const COIN_TYPE = /^0x[0-9a-fA-F]{1,64}::[a-zA-Z0-9_]+::[a-zA-Z0-9_]+$/;

/**
 * Every consumer money screen leads with a balance, so the agent has to be able to
 * name one without a transaction crawl. One request, one alias per coin type.
 */
export async function holdings(wallet: string, coinTypes: string[], net: Net = "mainnet"): Promise<Holding[]> {
  if (!/^0x[0-9a-fA-F]{1,64}$/.test(wallet)) throw new Error("that is not a Sui address");
  const wanted = coinTypes.filter((t) => COIN_TYPE.test(t));
  if (!wanted.length) return [];
  const sel = wanted.map((t, i) => `c${i}: balance(coinType:"${t}"){ totalBalance coinMetadata { symbol decimals } }`).join(" ");
  const data = await gql<{ address: { balance: Record<string, any> | null }[] }>(
    `{ address(address:"${wallet}"){ ${sel} } }`,
    net,
  );
  const node = data.address as unknown as Record<string, any>;
  return wanted
    .map((t, i) => {
      const b = node?.[`c${i}`];
      if (!b) return null;
      const decimals = b.coinMetadata?.decimals ?? 0;
      return {
        symbol: b.coinMetadata?.symbol ?? coinName(t),
        amount: Number(BigInt(b.totalBalance ?? "0")) / 10 ** decimals,
        decimals,
      };
    })
    .filter((h): h is Holding => !!h);
}

export async function recentActivity(wallet: string, limit = 10, net: Net = "mainnet"): Promise<Flow[]> {
  const list = await gql<{ address: { transactions: { nodes: { digest: string }[] } } }>(
    `{ address(address:"${wallet}"){ transactions(first:${limit}){ nodes { digest } } } }`,
    net,
  );
  const digests = list.address?.transactions?.nodes?.map((n) => n.digest) ?? [];
  if (digests.length === 0) return [];

  // One HTTP request for every transaction. The free tier is 3 requests/second,
  // which is survivable, but each round trip costs a second, so a per-transaction
  // loop would turn one question into fifteen.
  const aliases = digests
    .map(
      (d, i) =>
        `t${i}: transaction(digest:"${d}"){ effects { timestamp balanceChangesJson } }`,
    )
    .join(" ");

  const batch = await gql<Record<string, any>>(`{ ${aliases} }`, net);

  const flows: Flow[] = [];
  for (const [alias, tx] of Object.entries(batch)) {
    if (!tx?.effects) continue;
    const changes: { address: string; coinType: string; amount: string }[] =
      tx.effects.balanceChangesJson ?? [];
    const seen = new Set<string>();
    for (const c of changes) {
      if (c.address === wallet) continue;
      if (BigInt(c.amount) === 0n) continue;
      const k = `${c.address}|${c.coinType}`;
      if (seen.has(k)) continue;
      seen.add(k);
      flows.push({
        digest: digests[Number(alias.slice(1))],
        timestamp: tx.effects.timestamp ?? null,
        counterparty: c.address,
        coinType: c.coinType,
        amount: BigInt(c.amount),
      });
    }
  }
  return flows;
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
  const aliases = others
    .map(
      (a, i) =>
        `p${i}: address(address:"${a}"){ transactions(first:${perAddress}){ nodes { digest effects { timestamp balanceChangesJson } } } }`,
    )
    .join(" ");
  const batch = await gql<Record<string, any>>(`{ ${aliases} }`, net);

  const flows: Flow[] = [];
  for (const [alias, entry] of Object.entries(batch)) {
    const person = others[Number(alias.slice(1))];
    for (const tx of entry?.transactions?.nodes ?? []) {
      const changes: { address: string; coinType: string; amount: string }[] =
        tx.effects?.balanceChangesJson ?? [];
      const byCoin = new Map<string, bigint>();
      for (const c of changes) {
        if (c.address.toLowerCase() !== wallet.toLowerCase()) continue;
        byCoin.set(c.coinType, (byCoin.get(c.coinType) ?? 0n) + BigInt(c.amount));
      }
      for (const [coinType, mine] of byCoin) {
        if (mine === 0n) continue;
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
  return flows;
}

export type CoinChange = { address: string; coinType: string; amount: bigint };
export type Settled = { digest: string; status: string; timestamp: string | null; changes: CoinChange[] };

// A Sui digest is base58 over 32 bytes, so it is 43 or 44 characters. Checking the
// shape here keeps a typo from becoming a chain call and a provider error string.
const DIGEST = /^[1-9A-HJ-NP-Za-km-z]{43,44}$/;

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
  tries = 6,
  everyMs = 2500,
): Promise<Settled | null> {
  let found: Settled | null = null;
  for (let i = 1; i <= tries; i++) {
    found = await transactionAt(digest, net);
    if (found) return found;
    if (i < tries) await new Promise((r) => setTimeout(r, everyMs));
  }
  return found;
}
