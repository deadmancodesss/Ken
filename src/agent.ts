import "dotenv/config";
import { recentActivity, coinDecimals, formatAmount, short, coinName } from "./chain.js";
import { recallAbout, remember } from "./memory.js";

const wallet = process.argv[2];
if (!wallet?.startsWith("0x")) {
  console.error("usage: npm run agent -- 0x<wallet-address>");
  process.exit(1);
}

const flows = await recentActivity(wallet, 12);
console.log(`\nwallet ${short(wallet)} · mainnet · ${flows.length} counterparty flows\n`);
if (flows.length === 0) process.exit(0);

type Group = { address: string; count: number; coinType: string; net: bigint; last: string | null; digest: string };
const groups = new Map<string, Group>();
for (const f of flows) {
  const g =
    groups.get(f.counterparty) ??
    { address: f.counterparty, count: 0, coinType: f.coinType, net: 0n, last: null, digest: f.digest };
  g.count++;
  if (f.coinType === g.coinType) g.net += f.amount;
  if (f.timestamp && (!g.last || f.timestamp > g.last)) {
    g.last = f.timestamp;
    g.digest = f.digest;
  }
  groups.set(f.counterparty, g);
}

const ordered = [...groups.values()].sort((a, b) => b.count - a.count);
let learned = 0;

for (const g of ordered) {
  const decimals = await coinDecimals(g.coinType);
  const amount = formatAmount(g.net < 0n ? -g.net : g.net, decimals);
  const verb = g.net < 0n ? "received from" : "paid to";
  const day = g.last ? new Date(g.last).toISOString().slice(0, 10) : "unknown date";

  console.log(`${short(g.address)}   ${g.count} flow(s) · last ${day}`);
  console.log(`   chain : you ${verb} them ${amount} ${coinName(g.coinType)}`);

  const known = await recallAbout(g.address);
  if (known.length > 0) {
    console.log(`   memory: ${known[0].text.slice(0, 110)}`);
    console.log(`           blob ${known[0].blobId}`);
  } else {
    console.log("   memory: nothing, this counterparty is new to the agent");
    const fact =
      `Counterparty ${g.address}. First seen ${day} (tx ${g.digest}). ` +
      `${g.count} transaction(s), you ${verb} them ${amount} ${coinName(g.coinType)}. ` +
      `Not yet labelled by the user.`;
    const blob = await remember(fact);
    learned++;
    console.log(`   wrote : blob ${blob}`);
  }
  console.log();
}

console.log(`${ordered.length - learned} known · ${learned} newly learned · all facts on Walrus`);
