process.env.CAPS_DB = ":memory:";
process.env.REQUESTS_DB = ":memory:";
process.env.SEATS_DB = ":memory:";
process.env.TATUM_SUI_GRAPHQL_URL_TESTNET = "http://stub.invalid/graphql";
process.env.TATUM_SUI_GRAPHQL_URL = "http://stub.invalid/graphql";
process.env.PAY_NETWORK ??= "testnet";

/*
 * The two actions a sentence can start that end in a form: a monthly limit and a
 * request link. Neither is allowed to touch a provider here. The chain answers with
 * one empty month, which is enough to prove the limit arithmetic without spending a
 * request, and every other check is pure.
 */
const realFetch = globalThis.fetch;
globalThis.fetch = (async () =>
  new Response(
    JSON.stringify({
      data: {
        address: {
          transactions: { pageInfo: { hasPreviousPage: false, startCursor: null }, nodes: [] },
        },
      },
    }),
    { status: 200, headers: { "content-type": "application/json" } },
  )) as typeof fetch;

const { PAY_CHAIN, PAY_NET } = await import("./chain.js");
const { runTool, TOOLS } = await import("./tools.js");
const { seatFor, within } = await import("./seat.js");
const { useNoWallet, useWallet } = await import("./session.js");
const { capUsdc } = await import("./cap.js");
const { makeRequest, requestTurn } = await import("./requests.js");
const { requestNeed } = await import("../public/format.js");

let fails = 0;
const expect = (what: string, ok: boolean) => {
  console.log(`${ok ? "ok   " : "FAIL "} ${what}`);
  if (!ok) fails++;
};

const refuses = async (what: string, fn: () => Promise<unknown>) => {
  let threw = false;
  try {
    await fn();
  } catch {
    threw = true;
  }
  expect(what, threw);
};

const names = TOOLS.map((t) => t.name);
expect("a limit can be set from a sentence", names.includes("set_monthly_limit"));
expect("a request link can be started from a sentence", names.includes("request_money"));

const A = "0x" + "a".repeat(64);
const seat = seatFor("chat-actions");

const money = async (args: Record<string, unknown>) =>
  (await within(seat, () => runTool("request_money", args))) as Record<string, any>;
const limit = async (args: Record<string, unknown>) =>
  (await within(seat, () => runTool("set_monthly_limit", args))) as Record<string, any>;

within(seat, () => useNoWallet());
const none = await money({ usdc: 2 });
expect("without a wallet the form waits for one, because nobody can pay it", none.needs_wallet === true);

const other = PAY_NET === "mainnet" ? "sui:testnet" : "sui:mainnet";
within(seat, () => useWallet(A, other));
const wrong = await money({ usdc: 2 });
expect("both testnet and mainnet can open the request form dynamically", wrong.needs_request_fields === true);

within(seat, () => useWallet(A, PAY_CHAIN));
const asked = await money({ usdc: "2.5", what_for: "  two coffees  ", minutes: 120 });
expect("the paying network opens the form instead of making anything", asked.needs_request_fields === true);
expect("the amount already said is carried into the form", asked.usdc === 2.5);
expect("the reason already said is carried once", asked.what_for === "two coffees");
expect("the lifetime already said is kept", asked.minutes === 120);
expect("the form is told the same ceiling a signature has", asked.max_usdc === 5);

const loose = await money({ minutes: 7, what_for: "x".repeat(200) });
expect("a lifetime outside the three offered falls back to thirty minutes", loose.minutes === 30);
expect("a reason that is too long is cut to the stored limit", loose.what_for.length === 90);
expect("no amount means the form opens with the amount blank", loose.usdc === null);

await refuses("a request above the signature ceiling is refused before the form opens", () => money({ usdc: 6 }));
await refuses("a request for zero is refused", () => money({ usdc: 0 }));
await refuses("a request for a negative amount is refused", () => money({ usdc: -1 }));

const set = await limit({ usdc: 25 });
expect("a spoken limit is written for this wallet", set.monthly === 25 && set.changed === true);
expect("the limit is stored where the statement reads it", within(seat, () => capUsdc(`wallet:${A}`)) === 25);
expect("an empty month is read as zero spent", set.spent === 0 && set.state === "under");
expect("the whole limit is still left", set.left === 25);
expect("the answer says the limit and the month together", Array.isArray(set.said) && set.said[0].includes("25 USDC"));
expect("the answer says plainly that a limit never blocks a payment", set.said.some((s: string) => /never blocks a payment/i.test(s)));

const read = await limit({});
expect("asking with no number only reads", read.changed === false && read.monthly === 25);
expect("the read reports the same number the write stored", read.left === 25);

const lift = await limit({ usdc: 0 });
expect("zero lifts the limit", lift.monthly === null && lift.changed === true);
expect("the stored limit is gone", within(seat, () => capUsdc(`wallet:${A}`)) === null);

await refuses("a negative limit is refused", () => limit({ usdc: -5 }));
await refuses("a limit above the page's own ceiling is refused", () => limit({ usdc: 100_001 }));

const made = makeRequest({ to: A, usdc: 2.5, note: "lunch", owner: `wallet:${A}`, minutes: 120 });
const turn = requestTurn(made);
expect("a made link is written into the conversation", turn.steps[0].name === "request_money" && turn.steps[0].ok === true);
expect("the stored turn names the amount and the reason", turn.asked.includes("2.5 USDC") && turn.asked.includes("lunch"));
expect("the stored turn states the lifetime", turn.said.includes("closes in 120 minutes"));
expect("the model is told the link exists and who has to send it", turn.delta[0].content.includes(`/request/${made.id}`) && turn.delta[0].content.includes("not been sent to anyone"));

const need = requestNeed([
  { result: { needs_request_fields: true, usdc: 2, what_for: "lunch", minutes: 120, max_usdc: 5 } },
]) as { usdc: number | null; whatFor: string; minutes: number; maxUsdc: number } | null;
expect("the page can read the form fields from the tool result", need?.usdc === 2 && need?.whatFor === "lunch" && need?.minutes === 120);
expect("the page can read the ceiling from the tool result", need?.maxUsdc === 5);
const bare = requestNeed([{ result: { needs_request_fields: true } }]) as {
  usdc: number | null;
  minutes: number;
  maxUsdc: number;
} | null;
expect("a bare form still has a lifetime and a ceiling", bare?.minutes === 30 && bare?.maxUsdc === 5 && bare?.usdc === null);
expect("an ordinary turn opens no request form", requestNeed([{ result: { rows: [] } }]) === null);
expect("a failed step opens no request form", requestNeed([{ result: undefined }]) === null);

globalThis.fetch = realFetch;

console.log(fails ? `\n${fails} chat action check(s) failed` : "\nmonthly limits and request forms are green, with no provider request spent");
process.exit(fails ? 1 : 0);
