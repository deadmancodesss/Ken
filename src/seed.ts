import "dotenv/config";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { Ed25519Keypair } from "@mysten/sui/keypairs/ed25519";
import { SuiGraphQLClient } from "@mysten/sui/graphql";
import { Transaction } from "@mysten/sui/transactions";
import { requestGas } from "./faucet.js";
import { payUsdc } from "./wallet.js";
import { labelPerson, resolvePerson } from "./people.js";

const FILE = ".personas.json";
const SUI = 1_000_000_000n;
const USDC = 1_000_000n;

/** Invented identities for the demo. They are not real people and never will be. */
const CAST: Record<string, string> = {
  Sana: "buys groceries every couple of days",
  Imran: "flat maintenance, ask for it monthly",
  Tara: "cloud storage subscription, half-monthly",
  Dev: "returns money after splitting a bill",
};

type Persona = { alias: string; address: string; secret: string };
type State = { runs: number; people: Persona[]; last?: Record<string, string> };

const testnet = new SuiGraphQLClient({
  url: process.env.TATUM_SUI_GRAPHQL_URL_TESTNET!,
  network: "testnet",
  headers: { "x-api-key": process.env.TATUM_API_KEY_TESTNET! },
});

function load(): State {
  if (existsSync(FILE)) return JSON.parse(readFileSync(FILE, "utf8"));
  const people = Object.keys(CAST).map((alias) => {
    const k = Ed25519Keypair.generate();
    return { alias, address: k.toSuiAddress(), secret: k.getSecretKey() };
  });
  const state: State = { runs: 0, people };
  save(state);
  return state;
}

function save(state: State): void {
  writeFileSync(FILE, JSON.stringify(state, null, 1), { mode: 0o600 });
}

async function retry<T>(what: () => Promise<T>, tries = 3): Promise<T> {
  for (let i = 1; ; i++) {
    try {
      return await what();
    } catch (err) {
      if (i === tries) throw err;
      await new Promise((r) => setTimeout(r, 13_000));
    }
  }
}

async function balance(address: string): Promise<{ sui: bigint; usdc: bigint }> {
  const { data } = await retry(() =>
    testnet.query({
      query: `{ address(address:"${address}"){ balances { nodes { coinType { repr } totalBalance } } } }`,
      variables: {},
    }),
  );
  const nodes: any[] = (data as any)?.address?.balances?.nodes ?? [];
  const find = (needle: string) =>
    BigInt(nodes.find((n) => String(n.coinType?.repr).includes(needle))?.totalBalance ?? "0");
  return { sui: find("::sui::SUI"), usdc: find("::usdc::USDC") };
}

function jitter(base: number, spread: number): bigint {
  return BigInt(Math.round((base + (Math.random() * 2 - 1) * spread) * 1e6));
}

/**
 * A coin-version mismatch is raised while the transaction is being *built*,
 * before anything reaches the chain, so retrying it is safe. Any other failure
 * may have already settled, and retrying that would pay twice.
 */
async function send(to: string, baseUnits: bigint) {
  for (let i = 1; ; i++) {
    try {
      return await payUsdc(to, baseUnits);
    } catch (err) {
      if (!String((err as Error).message).includes("version doesn't match") || i >= 3) throw err;
      await new Promise((r) => setTimeout(r, 12_000));
    }
  }
}

async function transferSui(from: Persona, to: string, mist: bigint): Promise<string> {
  const key = Ed25519Keypair.fromSecretKey(from.secret);
  const tx = new Transaction();
  const [split] = tx.splitCoins(tx.gas, [mist]);
  tx.transferObjects([split], to);
  const res: any = await testnet.signAndExecuteTransaction({
    transaction: tx,
    signer: key,
    include: { effects: true },
  });
  const payload: any = (res as any)?.Transaction ?? res;
  if (payload?.status?.success === false) {
    throw new Error(`${from.alias} transfer failed: ${payload.status.error}`);
  }
  const digest = payload?.digest;
  if (!digest) throw new Error(`${from.alias} transfer returned no digest`);
  return digest;
}

const state = load();
state.runs += 1;
const log: string[] = [`run ${state.runs}`];

for (const p of state.people) {
  const bal = await balance(p.address);
  if (bal.sui < SUI / 2n) {
    await requestGas(p.address, true);
    log.push(`topped up gas for ${p.alias}`);
  }
  if (!(await resolvePerson(p.alias))) {
    await labelPerson(p.alias, p.address, CAST[p.alias]);
    log.push(`named ${p.alias} on Walrus (mainnet)`);
  }
}

const agent = process.env.AGENT_ADDRESS!;

// The agent pays the gas for every send, so it needs topping up too. Otherwise
// a run fails halfway with a balance error and half the schedule has fired.
if ((await balance(agent)).sui < SUI / 2n) {
  await requestGas(agent, true);
  log.push("topped up gas for the agent");
}

// Sana is the everyday one: small, slightly varied, every couple of days.
const today = new Date().toISOString().slice(0, 10);
const last = (state.last ??= {});
const daysSince = (alias: string) =>
  last[alias] ? Math.round((Date.parse(today) - Date.parse(last[alias])) / 86_400_000) : 999;

/**
 * Every branch is gated on the UTC day it last fired, so running the seeder
 * twice in one day cannot manufacture a second payment on the same date. That
 * would flatten the gap the demo is supposed to detect.
 */
if (daysSince("Sana") >= 2) {
  const amount = jitter(0.4, 0.15);
  const pay = await send(state.people[0].address, amount);
  last.Sana = today;
  log.push(`paid Sana ${pay.amount} USDC (${pay.digest.slice(0, 8)}…)`);
} else {
  log.push(`Sana has no payment today`);
}

// Imran is the recurring payment: a larger, identical amount every third day.
if (daysSince("Imran") >= 3) {
  const pay = await send(state.people[1].address, 1_500_000n);
  last.Imran = today;
  log.push(`paid Imran ${pay.amount} USDC exactly`);
} else {
  log.push(`Imran has no payment today`);
}

// Tara is a subscription. The 1st and the 15th are the story, and every fourth
// day is the fallback that lets a gap appear between two demo runs instead of
// leaving her with a single payment and no rhythm to detect.
const day = new Date().getUTCDate();
if ((day === 1 || day === 15 || daysSince("Tara") >= 4) && daysSince("Tara") >= 1) {
  const pay = await send(state.people[2].address, 950_000n);
  last.Tara = today;
  log.push(`paid Tara ${pay.amount} USDC (subscription)`);
}

// Dev pays back, so the agent learns a two-way relationship, not a donation.
if (state.runs > 1 && daysSince("Dev") >= 1 && (await balance(state.people[3].address)).sui > SUI / 4n) {
  const digest = await transferSui(state.people[3], agent, SUI / 20n);
  last.Dev = today;
  log.push(`Dev returned 0.05 SUI (${digest.slice(0, 8)}…)`);
}

save(state);

const agentBal = await balance(agent);
const due = (alias: string, every: number) =>
  new Date(Date.parse(last[alias] ?? today) + every * 86_400_000).toISOString().slice(0, 10);
console.log(log.join("\n"));
console.log(
  `\nagent holds ${Number(agentBal.sui) / 1e9} SUI and ${Number(agentBal.usdc) / 1e6} USDC · ` +
    `run this once a day: npm run seed (a second run on the same day pays nobody)`,
);
// A rhythm only exists once the same person has been paid on two different days,
// so the next likely demo date is printed rather than left to guesswork.
console.log(
  `next likely demo payment · Sana ${due("Sana", 2)} · Imran ${due("Imran", 3)} · Tara ${due("Tara", 4)} · Dev ${due("Dev", 1)}`,
);
