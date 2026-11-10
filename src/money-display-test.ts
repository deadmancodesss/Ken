/*
 * Two things on a money screen are quotes rather than chain facts: the dollar value
 * beside a coin, and the explorer link beside a receipt. A failed price feed must leave
 * the dollar figure off, never print zero, and a receipt from one ledger must never link
 * to the explorer for the other. Both are checked here without a network call.
 */

let calls = 0;
let seenUrl = "";
let seenSignal = false;
let reply: () => Promise<Response> = async () => {
  throw new Error("offline");
};

globalThis.fetch = (async (input: any, init: any) => {
  calls++;
  seenUrl = String(input);
  seenSignal = !!init?.signal;
  return reply();
}) as typeof fetch;

const realNow = Date.now;
let offset = 0;
Date.now = () => realNow() + offset;

const { usdPrices } = await import("./price.js");
const { explorerAccount, explorerTx } = await import("./explorer.js");

let fails = 0;
const expect = (what: string, ok: boolean) => {
  console.log(`${ok ? "ok   " : "FAIL "} ${what}`);
  if (!ok) fails++;
};
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

/* ---------- a price feed that does not answer prints no dollars ---------- */

const offline = await usdPrices();
expect("a feed that throws produces no prices", Object.keys(offline).length === 0);

reply = async () => new Response("down", { status: 503 });
const refused = await usdPrices();
expect("a feed that answers with an error produces no prices", Object.keys(refused).length === 0);

reply = async () => json({ sui: { usd: 2.5 }, "usd-coin": { usd: 1 } });
const quoted = await usdPrices();
expect("a working feed quotes both coins this build knows", quoted.SUI === 2.5 && quoted.USDC === 1);
expect("the feed is asked for our tickers by the feed's own ids", /ids=sui%2Cusd-coin/.test(seenUrl) && /vs_currencies=usd/.test(seenUrl));
expect("the price request carries a timeout signal", seenSignal);
const callsAfterQuote = calls;
await usdPrices();
expect("a fresh quote is reused instead of spending a second request", calls === callsAfterQuote);

offset += 61_000;
reply = async () => {
  throw new Error("the feed is down");
};
const stale = await usdPrices();
expect("a stale quote survives a feed that goes down", stale.SUI === 2.5 && stale.USDC === 1);
expect("the stale quote keeps both coins rather than replacing them", Object.keys(stale).length === 2);

offset += 61_000;
reply = async () => json({ sui: { usd: 0 }, "usd-coin": { usd: -1 } });
const nonsense = await usdPrices();
expect("a zero price is not printed as a real quote", nonsense.SUI === 2.5 && nonsense.USDC === 1);
expect("no price in the result is zero or negative", Object.values(nonsense).every((v) => v > 0));

offset += 61_000;
reply = async () => json({ sui: { usd: 3 } });
const partial = await usdPrices();
expect("a coin the feed omitted is left out, not shown as zero", partial.SUI === 3 && !("USDC" in partial));

offset += 61_000;
reply = async () => {
  throw new Error("the feed is down again");
};
const stillPartial = await usdPrices();
expect("the last good quote survives one more failure", stillPartial.SUI === 3 && !("USDC" in stillPartial));

/* ---------- a receipt links to the ledger that actually saw it ---------- */

const DIGEST = "8tucBNY7DBfADas9BYF4BpCY6R974vgVts9MAcQxZ57J";
const ACCOUNT = `0x${"7a".repeat(32)}`;
expect("a mainnet transaction links to the mainnet explorer", explorerTx("mainnet", DIGEST) === `https://suivision.xyz/txblock/${DIGEST}`);
expect("a testnet transaction links to the testnet explorer", explorerTx("testnet", DIGEST) === `https://testnet.suivision.xyz/txblock/${DIGEST}`);
expect("a mainnet account links to the mainnet explorer", explorerAccount("mainnet", ACCOUNT) === `https://suivision.xyz/account/${ACCOUNT}`);
expect("a testnet account links to the testnet explorer", explorerAccount("testnet", ACCOUNT) === `https://testnet.suivision.xyz/account/${ACCOUNT}`);
expect("an unknown network falls back to the testnet host", explorerTx("devnet", DIGEST).startsWith("https://testnet.suivision.xyz/"));
expect("a digest is encoded as one path segment", explorerTx("mainnet", "a/b?c") === "https://suivision.xyz/txblock/a%2Fb%3Fc");
expect("an address is encoded as one path segment", explorerAccount("mainnet", "0x1/2") === "https://suivision.xyz/account/0x1%2F2");

console.log(fails ? `\n${fails} money display check(s) failed` : "\nall money display checks green, no feed was called and no link was guessed");
process.exit(fails ? 1 : 0);
