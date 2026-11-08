import { mkdirSync, rmSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";

/*
 * A request link is an ask on one ledger. The address in it exists on both, so a link
 * that does not remember which one it was written for can turn testnet dust into a
 * mainnet bill, or the other way round. This file checks that the ledger survives a
 * restart, that the two lists stay apart, and that a row written before the column
 * existed is read as testnet rather than as whatever this build happens to pay on.
 */

const scratch = resolve("vibe_images/requests-network-test.db");
mkdirSync(dirname(scratch), { recursive: true });
rmSync(scratch, { force: true });
process.env.REQUESTS_DB = scratch;

const { makeRequest, findRequest, requestsBy, publicRequest } = await import("./requests.js");

let fails = 0;
const expect = (what: string, ok: boolean) => {
  console.log(`${ok ? "ok   " : "FAIL "} ${what}`);
  if (!ok) fails++;
};

const to = "0x" + "c".repeat(64);
const owner = "wallet:0x" + "a".repeat(64);

const quiet = makeRequest({ to, usdc: 1, owner });
const main = makeRequest({ to, usdc: 2, owner, network: "mainnet" });
const test = makeRequest({ to, usdc: 3, owner, network: "testnet" });

expect("a link made without a network is a testnet link", quiet.network === "testnet");
expect("a mainnet link keeps its ledger", main.network === "mainnet");
expect("a testnet link keeps its ledger", test.network === "testnet");
expect("the ledger comes back from the store", findRequest(main.id)?.network === "mainnet");
expect("the public view names the ledger the link asks for", publicRequest(main).network === "mainnet");

const listedMain = requestsBy(owner, 12, "mainnet").map((r) => r.id);
expect("the mainnet list has the mainnet link", listedMain.includes(main.id));
expect("the mainnet list has no testnet link", !listedMain.includes(test.id) && !listedMain.includes(quiet.id));
const listedTest = requestsBy(owner, 12, "testnet").map((r) => r.id);
expect("the testnet list has both testnet links", listedTest.includes(test.id) && listedTest.includes(quiet.id));
expect("the testnet list has no mainnet link", !listedTest.includes(main.id));
expect("a list with no ledger keeps the old behaviour", requestsBy(owner).length === 3);

/* A link written before the network column existed has no ledger to consult. */
const legacyId = "Legacy001";
const db = new DatabaseSync(scratch);
db.prepare(
  "insert into requests (id, to_addr, note, usdc_base, by_owner, created, expires_at, paid_tx, paid_by, paid_at, network) values (?, ?, ?, ?, ?, ?, ?, null, null, null, null)",
).run(legacyId, to, "an old link", 500_000, owner, Date.now(), Date.now() + 30 * 60_000);
db.close();

expect("a link with no stored ledger is read as testnet", findRequest(legacyId)?.network === "testnet");
expect("and it is offered to testnet readers", requestsBy(owner, 12, "testnet").some((r) => r.id === legacyId));
expect("and never to mainnet readers", requestsBy(owner, 12, "mainnet").every((r) => r.id !== legacyId));

rmSync(scratch, { force: true });
console.log(fails ? `\n${fails} request ledger check(s) failed` : "\nrequest links stay on the ledger they were made on");
process.exit(fails ? 1 : 0);
