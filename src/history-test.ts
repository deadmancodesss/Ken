import { coinRows, monthRows } from "./knowledge.js";
import { faucetLabel, isFaucet } from "./known.js";
import { activityPattern } from "./history.js";
import type { Flow } from "./chain.js";

/*
 * The read layer is arithmetic over flows, and arithmetic is the part that must be
 * exact before a single provider request is spent. Every check here runs with no
 * network and no model, so a wrong split fails in a second instead of in a demo.
 */

let fails = 0;
const expect = (what: string, ok: boolean) => {
  console.log(`${ok ? "ok   " : "FAIL "} ${what}`);
  if (!ok) fails++;
};

const USDC = "0xdba3::usdc::USDC";
const SUI = "0x2::sui::SUI";
const DECIMALS = new Map([
  [USDC, 6],
  [SUI, 9],
]);

const flow = (over: Partial<Flow>): Flow => ({
  digest: "0x" + "a".repeat(64),
  timestamp: "2026-11-01T10:00:00Z",
  counterparty: "0x" + "b".repeat(64),
  coinType: USDC,
  amount: 0n,
  ...over,
});

// A positive amount is what the counterparty gained, so the wallet sent it.
const sentUsdc = flow({ digest: "0x1", amount: 20_000_000n });
const gotSui = flow({ digest: "0x2", coinType: SUI, amount: -1_001_000_000n });
const sentSui = flow({ digest: "0x3", coinType: SUI, amount: 103_976_000n, timestamp: "2026-11-02T10:00:00Z" });

const rows = coinRows([sentUsdc, gotSui, sentSui], DECIMALS);
const usdcRow = rows.find((r) => r.asset === "USDC")!;
const suiRow = rows.find((r) => r.asset === "SUI")!;

expect("one relationship becomes one row per coin, not one dominant coin", rows.length === 2);
expect("the USDC the wallet sent is out and not in", usdcRow.out === "20" && usdcRow.in === "0");
expect("the SUI the wallet received is in and not out", suiRow.in === "1.001" && suiRow.out === "0.103976");
expect("a coin row keeps its own decimals", suiRow.flows === 2 && suiRow.out === "0.103976");
expect("the coin row keeps a usual that is the median of that coin only", suiRow.usual === "0.552488");

const months = monthRows([sentUsdc, gotSui, sentSui], DECIMALS);
const novUsdc = months.find((m) => m.month === "2026-11" && m.asset === "USDC")!;
const novSui = months.find((m) => m.month === "2026-11" && m.asset === "SUI")!;

expect("a month is split by coin instead of added across decimals", months.length === 2);
expect("November USDC counts only the USDC that left", novUsdc.out === "20" && novUsdc.in === "0");
expect("November SUI keeps its own in and out", novSui.in === "1.001" && novSui.out === "0.103976");
expect("no month row ever mixes two coins into one number", months.every((m) => ["USDC", "SUI"].includes(m.asset)));

const FAUCET = "0x059e21c19f9a8233f4fcbc11fba713c022dcf9d3632961b7ac7836a9ffa8d94f";
expect("the faucet is recognised from its published address", faucetLabel(FAUCET) === "Sui testnet faucet");
expect("the faucet match ignores case", isFaucet(FAUCET.toUpperCase().replace("0X", "0x")));
expect("an ordinary address is not called a faucet", faucetLabel("0x" + "c".repeat(64)) === null);

const onlySent = activityPattern({ count: 20, sent: 20, received: 0, addresses: 12, withYou: 2, hasNext: false });
expect("a window with only outgoing money says so", onlySent.some((l) => l.includes("only sent")));
expect("it names how many addresses were seen", onlySent.some((l) => l.includes("12 different addresses")));
expect("it counts the transactions shared with this wallet", onlySent.some((l) => l.includes("2 of those")));
expect("it may say the whole history was read when it was", onlySent.some((l) => l.includes("whole history")));
expect("a full window is not called little history", !onlySent.some((l) => l.includes("very little")));

const tiny = activityPattern({ count: 2, sent: 1, received: 1, addresses: 2, withYou: 0, hasNext: true });
expect("a two row window admits there is little to judge", tiny.some((l) => l.includes("very little public history")));
expect("a partial window never claims to be the whole history", !tiny.some((l) => l.includes("whole history")));
expect("no shared transaction in a partial window proves nothing", tiny.some((l) => l.includes("proves nothing")));
const closed = activityPattern({ count: 2, sent: 1, received: 1, addresses: 2, withYou: 0, hasNext: false });
expect("a closed window with no shared transaction says so plainly", closed.some((l) => l === "None of them were with this wallet."));
expect("no pattern line calls anyone spam", [...onlySent, ...tiny].every((l) => !/spam|scam|fraud/i.test(l)));

console.log(fails ? `\n${fails} history check(s) failed` : `\n${rows.length} coin rows and ${months.length} month rows read, all checks green`);
process.exit(fails ? 1 : 0);
