import { spendableCoins } from "./wallet.js";

/*
 * The gateway answers one page at a time, and a wallet that has been paid more than
 * a hundred times holds coins on the next page. This test drives the shipped page
 * loop with a fake client, so the cursor, the early stop, the sort and the zero
 * filter are proved without needing a funded wallet. The live endpoint's shape is
 * already exercised by the payment page. What is proved here is the arithmetic on
 * top of it.
 */

let fails = 0;
const expect = (what: string, ok: boolean) => {
  console.log(`${ok ? "ok   " : "FAIL "} ${what}`);
  if (!ok) fails++;
};

type Coin = { objectId: string; version: string; digest: string; balance: string };

function coin(index: number, balance: bigint): Coin {
  return {
    objectId: "0x" + index.toString(16).padStart(64, "0"),
    version: "1",
    digest: "digest",
    balance: String(balance),
  };
}

/** Pages keyed by the cursor the previous page returned. Cursors are p1, p2, and so on. */
function pager(pages: Coin[][], endless = false) {
  const calls: (string | null)[] = [];
  const client = {
    core: {
      listCoins: async ({ cursor }: { cursor?: string | null }) => {
        calls.push(cursor ?? null);
        const index = cursor ? Number(String(cursor).slice(1)) : 0;
        const objects = pages[index] ?? [];
        const last = endless ? false : index >= pages.length - 1;
        return {
          objects,
          hasNextPage: !last,
          cursor: last ? null : `p${index + 1}`,
        };
      },
    },
  };
  return { calls, client };
}

const USDC = 1_000_000n;
const SUI = 1_000_000_000n;

/* A need larger than the first page has to cross the cursor and never read page three. */
{
  const page = Array.from({ length: 100 }, (_, i) => coin(i, USDC));
  const { calls, client } = pager([page, page, page]);
  const picked = await spendableCoins(client as any, "0xowner", "0xusdc", 150n * USDC, false);
  expect("a need over one page reads the next page", calls.length === 2 && calls[0] === null && calls[1] === "p1");
  expect("it stops as soon as the held total covers the need", picked.length === 150);
  expect("the picked coins add up to the need exactly", picked.reduce((sum, c) => sum + BigInt(c.balance), 0n) === 150n * USDC);
}

/* A single-coin payment (SUI, where the fee comes from the same coin) may need page two. */
{
  const small = Array.from({ length: 100 }, (_, i) => coin(i, SUI));
  const big = coin(1000, 20n * SUI);
  const { calls, client } = pager([small, [big]]);
  const picked = await spendableCoins(client as any, "0xowner", "0x2::sui::SUI", 10n * SUI, true);
  expect("a single payment reads past a page of coins too small to cover it", calls.length === 2);
  expect("it returns only the one coin that covers the amount", picked.length === 1 && picked[0].objectId === big.objectId);
}

/* A coin on the first page that already covers the amount stops the walk. */
{
  const big = coin(0, 20n * SUI);
  const small = Array.from({ length: 99 }, (_, i) => coin(i + 1, SUI));
  const { calls, client } = pager([[big, ...small], [coin(1000, 50n * SUI)]]);
  const picked = await spendableCoins(client as any, "0xowner", "0x2::sui::SUI", 10n * SUI, true);
  expect("a covering coin on page one ends the read there", calls.length === 1);
  expect("the covering coin is the one returned", picked.length === 1 && picked[0].objectId === big.objectId);
}

/* More need than the wallet holds returns nothing, after every page has been seen. */
{
  const one = Array.from({ length: 100 }, (_, i) => coin(i, SUI));
  const two = Array.from({ length: 100 }, (_, i) => coin(100 + i, SUI));
  const { calls, client } = pager([one, two]);
  const picked = await spendableCoins(client as any, "0xowner", "0x2::sui::SUI", 500n * SUI, false);
  expect("an unpayable amount returns no coins", picked.length === 0);
  expect("it still reads every page before deciding", calls.length === 2);
}

/* Zero balances are dust rows, not money, and cannot find their way into a payment. */
{
  const zero = coin(0, 0n);
  const real = coin(1, 2n * USDC);
  const { client } = pager([[zero, real]]);
  const picked = await spendableCoins(client as any, "0xowner", "0xusdc", USDC, false);
  expect("a zero-balance coin is never picked", picked.length === 1 && picked[0].objectId === real.objectId);
  expect("the whole balance of the picked coin is available", picked[0].balance === String(2n * USDC));
}

/* The page cap is a guard, so a gateway that never says last cannot loop forever. */
{
  const one = [coin(0, 1n)];
  const { calls, client } = pager([one], true);
  const picked = await spendableCoins(client as any, "0xowner", "0xusdc", 10n * USDC, false);
  expect("a gateway that never ends is read ten pages at most", calls.length === 10);
  expect("the capped walk still returns no false coin", picked.length === 0);
}

/* Sorting is largest first, so a payment uses the fewest coins it can. */
{
  const small = Array.from({ length: 100 }, (_, i) => coin(i, USDC));
  const large = coin(500, 60n * USDC);
  const { client } = pager([small, [large]]);
  const picked = await spendableCoins(client as any, "0xowner", "0xusdc", 120n * USDC, false);
  expect("the largest coin is taken first across pages", picked[0].objectId === large.objectId);
  expect("it takes the small coins only to cover the rest", picked.length === 61);
}

if (fails) {
  console.error(`${fails} coin paging checks failed`);
  process.exitCode = 1;
} else {
  console.log("all coin paging checks passed");
}
