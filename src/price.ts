/**
 * What a coin is worth in dollars, from a public price feed rather than from the chain.
 *
 * The chain only ever answers how many of a coin a wallet holds, so a dollar figure on a
 * money screen is a third-party quote and has to be treated as one. It is cached because
 * the feed is rate limited, it is never retried into a zero, and when it does not answer
 * the caller gets an empty map and prints no dollar figure at all. A screen that says
 * "0.00 dollars" because a price request failed is the same lie this build already removed
 * from the balance itself.
 */
const FEED = "https://api.coingecko.com/api/v3/simple/price";

/** Our coin tickers to the feed's own ids, so a new coin is a line here rather than a guess. */
const IDS: Record<string, string> = { SUI: "sui", USDC: "usd-coin" };

let cache: { at: number; usd: Record<string, number> } = { at: 0, usd: {} };
const FRESH_MS = 60_000;

export async function usdPrices(): Promise<Record<string, number>> {
  if (cache.usd.SUI && Date.now() - cache.at < FRESH_MS) return cache.usd;
  try {
    const res = await fetch(`${FEED}?ids=${encodeURIComponent(Object.values(IDS).join(","))}&vs_currencies=usd`, {
      signal: AbortSignal.timeout(4000),
    });
    if (!res.ok) return cache.usd;
    const body = (await res.json()) as Record<string, { usd?: number }>;
    const usd: Record<string, number> = {};
    for (const [ticker, id] of Object.entries(IDS)) {
      const price = body[id]?.usd;
      if (typeof price === "number" && price > 0) usd[ticker] = price;
    }
    if (Object.keys(usd).length) cache = { at: Date.now(), usd };
  } catch {
    /* a feed that is down leaves the amounts honest and the dollars absent */
  }
  return cache.usd;
}
