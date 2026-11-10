process.env.REQUESTS_DB = ":memory:";

const { makeRequest, findRequest, requestsBy, digestTaken, markRequestPaid, publicRequest, requestExpired, showUsdc } = await import(
  "./requests.js"
);

/*
 * A request is a sentence with a price on it. The checks that matter are the ones
 * that keep it from becoming a key: a bad address is refused, the public view hides
 * both people's identities, and the first accepted digest wins forever.
 */

let fails = 0;
const expect = (what: string, ok: boolean) => {
  console.log(`${ok ? "ok   " : "FAIL "} ${what}`);
  if (!ok) fails++;
};

const to = "0x" + "c".repeat(64);
const owner = "wallet:0x" + "a".repeat(64);
const other = "wallet:0x" + "b".repeat(64);

const rejects = (what: string, fn: () => unknown) => {
  let threw = false;
  try {
    fn();
  } catch {
    threw = true;
  }
  expect(what, threw);
};

rejects("a short address cannot receive a request", () => makeRequest({ to: "0x123", usdc: 1, owner }));
rejects("a zero amount is not a request", () => makeRequest({ to, usdc: 0, owner }));
rejects("a negative amount is not a request", () => makeRequest({ to, usdc: -2, owner }));
rejects("an amount below one base unit is refused instead of rounding to zero", () =>
  makeRequest({ to, usdc: 0.0000001, owner }),
);
rejects("a request without an owner is refused", () => makeRequest({ to, usdc: 1, owner: "  " }));

const made = makeRequest({ to, usdc: 0.95, note: "  dinner on friday  ", owner });
expect("a valid request comes back with a link shaped id", /^[A-Za-z0-9_-]{6,16}$/.test(made.id));
expect("the amount is stored in USDC", made.usdc === 0.95 && made.usdc_text === "0.95");
expect("the note is trimmed once", made.note === "dinner on friday");
expect("a new request is unpaid", made.paid_tx === null && made.paid_by === null);
expect("a new request is open for thirty minutes", made.expires_at - made.created === 30 * 60_000);

const longLife = makeRequest({ to, usdc: 1, owner, minutes: 120 });
expect("a chosen lifetime is kept", longLife.expires_at - longLife.created === 120 * 60_000);
const tinyLife = makeRequest({ to, usdc: 1, owner, minutes: 1 });
expect("a lifetime under five minutes is lifted to five", tinyLife.expires_at - tinyLife.created === 5 * 60_000);
const hugeLife = makeRequest({ to, usdc: 1, owner, minutes: 999999 });
expect("a lifetime over a week is capped", hugeLife.expires_at - hugeLife.created === 7 * 24 * 60 * 60_000);

const long = makeRequest({ to, usdc: 1, note: "x".repeat(140), owner });
expect("a long note is cut to the stated limit", long.note.length === 90);

const view = publicRequest(made);
expect("the public view carries the amount and the line", view.usdc === 0.95 && view.note === "dinner on friday");
expect("the public view does not name the owner", !("owner" in view) && !JSON.stringify(view).includes(owner));
expect("an unpaid public request shows no payer", view.paid === null);
expect("a fresh link is open", view.expired === false && view.closed === null);
expect("a fresh link has time left", view.expires_in > 29 * 60 && view.expires_in <= 30 * 60);
expect("the wallet the link points at is told it is theirs", publicRequest(made, { wallet: to }).mine === true);
expect("another wallet is not the owner", publicRequest(made, { wallet: "0x" + "b".repeat(64) }).mine === false);

const late = publicRequest({ ...made, expires_at: Date.now() - 1 });
expect("a link past its deadline is closed", late.expired === true && late.closed === "expired");
expect("a closed link has no time left", late.expires_in === 0);
expect("the expiry rule agrees with the public view", requestExpired(made) === false && requestExpired({ ...made, expires_at: Date.now() - 1 }) === true);

expect("a malformed id is not looked up", findRequest("../../etc/passwd") === null);
expect("a missing id is not invented", findRequest("AbCdEf123") === null);
expect("the saved request comes back by its link", findRequest(made.id)?.id === made.id);

expect("the owner sees their own links", requestsBy(owner).some((r) => r.id === made.id));
expect("another wallet does not see them", requestsBy(other).every((r) => r.id !== made.id));
expect("the newest link is listed first", requestsBy(owner)[0].id === long.id);

const tx = "0x" + "d".repeat(64);
const paid = markRequestPaid(made.id, tx, other);
expect("a paid request keeps the digest and the payer", paid?.paid_tx === tx && paid?.paid_by === other);
expect("the public view shows the payment", publicRequest(paid!).paid?.tx === tx);
const paidLate = publicRequest({ ...paid!, expires_at: Date.now() - 1 });
expect("a paid link stays paid after its deadline", paidLate.closed === "paid" && paidLate.expired === false);

const second = "0x" + "e".repeat(64);
const again = markRequestPaid(made.id, second, owner);
expect("a second digest cannot overwrite the first settlement", again?.paid_tx === tx);
expect("a digest already used on another request is spotted", digestTaken(tx, long.id));
expect("the same request is allowed to keep its own digest", !digestTaken(tx, made.id));

const missing = markRequestPaid("NoSuchLink", tx, owner);
expect("marking a link that does not exist changes nothing", missing === null);

expect("one USDC prints without a trailing point", showUsdc(1_000_000) === "1");
expect("six decimals print in full", showUsdc(1) === "0.000001");
expect("trailing zeroes do not pad the number", showUsdc(950_000) === "0.95");
expect("a whole amount and a fraction print together", showUsdc(20_500_000) === "20.5");

console.log(fails ? `\n${fails} request check(s) failed` : "\nrequest links, public view and settlement are all green");
process.exit(fails ? 1 : 0);
