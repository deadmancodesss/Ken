/**
 * A statement that only counts money leaving prints a zero and an empty page for a wallet
 * whose whole history is money arriving. These checks hold the card to the other direction
 * too, without a chain, a wallet or a model.
 */
import { cardSvg, summarise, type Statement, type Totals } from "./report.js";
import type { Party } from "./knowledge.js";

const checks: string[] = [];
function expect(label: string, ok: boolean) {
  checks.push(`${ok ? "ok  " : "FAIL"} ${label}`);
  if (!ok) throw new Error(label);
}

const A = (n: string) => "0x" + n.repeat(64);

function coin(over: Partial<Party["coins"][number]> & { asset: string }) {
  return {
    type: `0x${over.asset.toLowerCase()}`,
    in: "0",
    out: "0",
    net: "0",
    flows: 1,
    usual: null,
    ...over,
  };
}

function party(over: Partial<Party> & { address: string; coins: Party["coins"] }): Party {
  return {
    name: null,
    note: "",
    asset: "USDC",
    flows: 1,
    net: "0",
    direction: "received",
    firstSeen: "2026-11-04",
    lastSeen: "2026-11-04",
    usualAmount: null,
    gapDays: null,
    memorised: false,
    service: false,
    faucet: false,
    ...over,
  };
}

/** His wallet on 2026-11-05: four transfers arriving, none leaving. */
const funder = party({
  address: A("e"),
  flows: 2,
  coins: [coin({ asset: "SUI", in: "0.002422631" }), coin({ asset: "USDC", in: "20" })],
});
const john = party({
  address: A("f"),
  name: "John Doe",
  memorised: true,
  coins: [coin({ asset: "SUI", in: "1.001988099" })],
});
const faucet = party({
  address: A("c"),
  flows: 2,
  faucet: true,
  coins: [coin({ asset: "SUI", in: "2.002" })],
});
const service = party({
  address: A("d"),
  service: true,
  coins: [coin({ asset: "USDC", in: "5" })],
});
const payee = party({
  address: A("a"),
  name: "Sana",
  memorised: true,
  direction: "sent",
  coins: [coin({ asset: "USDC", out: "12" })],
});

const arriving = summarise([funder, john, faucet, service]);
expect("a wallet that only received reads as inbound", arriving.direction === "in");
expect("the inbound total is the largest coin received", arriving.totalIn === "20.00 USDC");
expect("the spend total stays zero rather than borrowing the incoming money", arriving.totalOut === "0.00 USDC");
expect("the paid index is not called a person who sent money", arriving.sendCount === 3);
expect("the sender list is sorted by what each sent", arriving.senders[0].name === "0xeeee…eeee");
expect("a named person keeps their name on the card", arriving.senders.some((s) => s.name === "John Doe"));
expect("a faucet is named as a machine", arriving.senders.some((s) => s.name === "testnet faucet"));
expect("every sender carries the coin they sent", arriving.senders.find((s) => s.name === "John Doe")?.amount === "1.00 SUI");
expect("the other coin received is measured beside the main one", arriving.inOtherAssets === "3.01 SUI in");
expect("nobody was paid, so the outbound list is empty", arriving.ranked.length === 0);

const spending = summarise([funder, john, faucet, service, payee]);
expect("money leaving wins the headline when both directions exist", spending.direction === "out");
expect("the outbound total is the largest coin paid", spending.totalOut === "12.00 USDC");
expect("the inbound total is still measured", spending.totalIn === "20.00 USDC" && spending.sendCount === 3);
expect("the paid person is the only outbound row", spending.ranked.length === 1 && spending.ranked[0].name === "Sana");

const quiet = summarise([]);
expect("a wallet with no history has no direction", quiet.direction === "none");
expect("a quiet wallet prints zeroes rather than an empty string", quiet.totalOut === "0.00 USDC" && quiet.totalIn === "0.00 USDC");
expect("a quiet wallet has no senders", quiet.sendCount === 0 && quiet.senders.length === 0);

function statement(t: Totals, over: Partial<Statement> = {}): Statement {
  return {
    wallet: A("1"),
    network: "testnet",
    isDemo: false,
    period: "2026-11",
    headline: "Your week, as the agent remembers it",
    direction: t.direction,
    totalOut: t.totalOut,
    otherAssets: t.otherAssets,
    asset: t.asset,
    totalIn: t.totalIn,
    inAsset: t.inAsset,
    inOtherAssets: t.inOtherAssets,
    sendCount: t.sendCount,
    senders: t.senders,
    months: [{ month: "2026-11", amount: 20, label: "Nov" }],
    people: t.ranked.map((p) => {
      const paid = [...p.coins].filter((c) => Number(c.out) > 0).sort((a, b) => Number(b.out) - Number(a.out))[0];
      return {
        name: p.name ?? "unnamed",
        amount: paid ? `${Number(paid.out).toFixed(2)} ${paid.asset}` : "0.00 USDC",
        flows: p.flows,
        cadence: null,
        state: null,
        lastSeen: p.lastSeen,
        memorised: p.memorised,
      };
    }),
    overdue: 0,
    dueNow: 0,
    remembered: 1,
    bought: 0,
    paid: "0.00 USDC",
    price: "0.01 USDC",
    generatedAt: "2026-11-05 08:31",
    ...over,
  };
}

const inCard = cardSvg(statement(arriving));
expect("the inbound card leads with what arrived", inCard.includes(">20.00<") && inCard.includes("USDC in, from the people below"));
expect("the inbound card says plainly that nothing left", inCard.includes("nothing left this wallet in this period"));
expect("the inbound card lists who sent the money", inCard.includes("WHO SENT IT") && inCard.includes("RECEIVED"));
expect("the inbound card shows the named sender", inCard.includes("John Doe"));
expect("the inbound card shows the faucet without pretending it is a person", inCard.includes("testnet faucet"));
expect("the inbound card shows the other coin received", inCard.includes("3.01 SUI in"));
expect("the inbound card does not claim anyone got paid", !inCard.includes("WHO GOT WHAT"));
expect("one memory is written as one thing", inCard.includes("thing kept on Walrus") && !inCard.includes("things kept on Walrus"));

const outCard = cardSvg(statement(spending));
expect("the outbound card keeps the spend headline", outCard.includes(">12.00<") && outCard.includes("USDC out, across the people below"));
expect("the outbound card lists who got paid", outCard.includes("WHO GOT WHAT") && outCard.includes("Sana"));
expect("the outbound card states what came in rather than hiding it", outCard.includes("20.00 USDC in from 3 addresses"));
expect("the outbound card does not switch to the sender table", !outCard.includes("WHO SENT IT"));

const zeroCard = cardSvg(statement(quiet));
expect("the zero card still prints a zero, not an empty page", zeroCard.includes(">0.00<") && zeroCard.includes("USDC out, across the people below"));

const hostile = summarise([
  party({ address: A("b"), name: "John <Doe>", memorised: true, coins: [coin({ asset: "SUI", in: "1" })] }),
]);
const hostileCard = cardSvg(statement(hostile));
expect("a name from memory cannot inject markup into the card", hostileCard.includes("John &lt;Doe&gt;") && !hostileCard.includes("<Doe>"));

console.log(checks.join("\n"));
console.log(`${checks.length} checks`);
