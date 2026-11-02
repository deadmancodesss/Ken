import "dotenv/config";
import { readFileSync } from "node:fs";
import { USDC_DECIMALS, USDC_TESTNET } from "./wallet.js";
import { type Quote, addressOf, priceUsdc, purchases, resourceId, sell, totalSpent, verdict } from "./x402.js";

/*
 * The money half of this product is a paywall that has to survive a lying client, so
 * the checks are written against forged transactions rather than against real ones.
 * Nothing here sends money, reads the chain or touches memory: every transfer below is
 * a fixture handed straight to the rule that judges one.
 */

let fails = 0;
const expect = (what: string, ok: boolean) => {
  console.log(`${ok ? "ok   " : "FAIL "} ${what}`);
  if (!ok) fails++;
};

/* A fresh clone has bought nothing and has no journal, so the journal is read if it
 * exists and the checks that need a receipt are skipped rather than faked. */
const LEDGER = (() => {
  try {
    return JSON.parse(readFileSync(new URL("../.paid.json", import.meta.url), "utf8")) as {
      sold: Record<string, { resource: string; payer: string; digest: string; usdc: number; at: string }>;
    };
  } catch {
    return { sold: {} };
  }
})();
const sales = Object.values(LEDGER.sold ?? {});
const sold = sales[0];
const PAY_TO = process.env.SELLER_WALLET ?? "";
const UNSEEN = "0x1111111111111111111111111111111111111111111111111111111111111111";

const quote: Quote = {
  id: "test0001",
  resource: resourceId(sold?.resource.split(":")[1] ?? UNSEEN),
  payer: sold?.payer ?? UNSEEN,
  usdc: priceUsdc(),
  baseUnits: String(BigInt(Math.round(priceUsdc() * 10 ** USDC_DECIMALS))),
  asset: USDC_TESTNET,
  payTo: PAY_TO,
  network: "sui:testnet",
  issued: Date.now(),
  expires: Date.now() + 60_000,
};

const usdc = USDC_TESTNET;
const units = BigInt(quote.baseUnits);
const indexWallet = /^0x[0-9a-f]{64}$/.test(PAY_TO.toLowerCase());
const deal = (changes: { address: string; amount: bigint; coinType?: string }[], status = "SUCCESS") => ({
  digest: "ATestDigestNeverSent",
  status,
  timestamp: "2026-11-02T00:00:00Z",
  changes: changes.map((c) => ({ address: c.address, amount: c.amount, coinType: c.coinType ?? usdc })),
});
const spent = { ATestDigestNeverSent: { resource: "", payer: "", digest: "ATestDigestNeverSent", usdc: 0, at: "" } };

expect("a real payment to the index from the asking wallet releases the fact", verdict(quote, deal([{ address: quote.payTo, amount: units }, { address: quote.payer, amount: -units }]), {}).ok);
expect("a failed transaction is refused", !verdict(quote, deal([{ address: quote.payTo, amount: units }, { address: quote.payer, amount: -units }], "FAILURE_EXECUTE_TRANSACTION"), {}).ok);
expect("less than the quoted price is refused", !verdict(quote, deal([{ address: quote.payTo, amount: units - 1n }, { address: quote.payer, amount: 1n - units }]), {}).ok);
expect("money that never reached the index is refused", !verdict(quote, deal([{ address: quote.payer, amount: -units }, { address: UNSEEN, amount: units }]), {}).ok);
expect("an overpayment from a different wallet is refused", !verdict(quote, deal([{ address: quote.payTo, amount: units * 5n }]), {}).ok);
expect("a payment in the wrong coin is refused", !verdict(quote, deal([{ address: quote.payTo, amount: units, coinType: "0x2::sui::SUI" }, { address: quote.payer, amount: -units, coinType: "0x2::sui::SUI" }]), {}).ok);
expect("a debit one cent short of the credit is refused", !verdict(quote, deal([{ address: quote.payTo, amount: units }, { address: quote.payer, amount: 1n - units }]), {}).ok);

/* The partial-credit case is the one a sloppy seller reads as paid: money arrived at
 * the right address in the right coin, but from a wallet that never asked. */
expect("a credit with no matching debit is refused", !verdict(quote, deal([{ address: quote.payTo, amount: units }]), {}).ok);

expect("a receipt already spent on another lookup is refused", !verdict(quote, deal([{ address: quote.payTo, amount: units }, { address: quote.payer, amount: -units }]), spent).ok);

expect("an address round trips through the resource name", addressOf(resourceId(UNSEEN)) === UNSEEN);
expect("a resource built from a short name is refused", (() => { try { resourceId("0xabc"); return false } catch { return true } })());
expect("a resource that is not an identity is refused", (() => { try { addressOf("invoice:0x1"); return false } catch { return true } })());

const ask = (body: Record<string, unknown>) => sell(body);

const run = async () => {
  if (!indexWallet) {
    console.log("skip  the HTTP half, because SELLER_WALLET is not set so the index has no payout address");
  } else if (!sold) {
    console.log("skip  the receipt half, because nothing has been bought from the index yet");
  } else {
    const free = await ask({ resource: sold.resource, payer: sold.payer });
    expect("an address this wallet already bought answers without a price", free.http === 200);
    expect("the released fact carries a name", typeof (free.body as any).fact?.name === "string");
    expect("this ask costs nothing", Number((free.body as any).charged) === 0);
    expect("the price that moved earlier is still stated", Number((free.body as any).paid_then) === sold.usdc);
    expect("the day the money moved is stated, not today", (free.body as any).paid_on === sold.at);
    expect("the receipt named is the one that was paid", (free.body as any).tx === sold.digest);

    const priced = await ask({ resource: resourceId(sold.resource.split(":")[1]), payer: UNSEEN });
    expect("a wallet that has never bought is asked to pay", priced.http === 402);
    const acc = (priced.body as any).accepts?.[0];
    expect("the price names the scheme", acc?.scheme === "sui-usdc");
    expect("the price names the network", acc?.network === "sui:testnet");
    expect("the price is the quote in base units", acc?.amount === quote.baseUnits);
    expect("the payout address is the index", String(acc?.payTo).toLowerCase() === PAY_TO.toLowerCase());
    expect("the asset is USDC, not a lookalike", String(acc?.asset) === USDC_TESTNET);
    expect("a quote expires instead of hanging open", (priced.body as any).expires > new Date().toISOString());

    const junk = await ask({ resource: "not-a-resource", payer: UNSEEN });
    expect("a request for something the index does not sell is refused", junk.http === 400);
    const half = await ask({ resource: "identity:not-an-address", payer: UNSEEN });
    expect("a resource shaped like an identity but holding junk is refused", half.http === 400);
    const nobody = await ask({ resource: resourceId(UNSEEN), payer: UNSEEN });
    expect("an address with nothing on it is a 404, not a price", nobody.http === 404);
    const walletless = await ask({ resource: sold.resource });
    expect("a request that names no payer is refused", walletless.http === 400);

    const rows = purchases(sold.payer);
    expect("the wallet's own bill matches the journal", rows.length === sales.length);
    expect("the running total matches the journal", totalSpent(sold.payer) === sales.reduce((n, s) => n + s.usdc, 0));
    expect("a different wallet is billed nothing", totalSpent(UNSEEN) === 0);
  }
  console.log(fails ? `\n${fails} x402 check(s) failed` : `\nall x402 checks green, no money moved`);
  process.exit(fails ? 1 : 0);
};

run();
