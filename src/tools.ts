import "dotenv/config";
import { counterparties, dueRows, forgetCounterparties, monthlyTotals } from "./knowledge.js";
import { labelPerson, resolvePerson, matchPerson, canonicalNames, personForAddress, peopleRoster, memoryStats } from "./people.js";
import { remember, recallAbout, searchMemory } from "./memory.js";
import { payUsdc, prepareUsdc, paymentsEnabled, paymentCap, USDC_DECIMALS } from "./wallet.js";
import { buy, nameTheIndex, price, record, resourceId } from "./x402.js";
import { hold } from "./pending.js";
import { session } from "./session.js";
import { buildStatement } from "./report.js";

export type Tool = {
  name: string;
  description: string;
  positional: string[];
  parameters: Record<string, { type: string; description: string }>;
  required: string[];
  run: (args: Record<string, any>) => Promise<unknown>;
};

/** Words a speaker always brings along, and never a fact worth matching a memory on. */
const FILLER = new Set([
  "about", "and", "been", "did", "does", "from", "have", "her", "him", "into", "that", "the", "them", "they",
  "this", "was", "were", "what", "when", "where", "which", "who", "whom", "whose", "with", "you", "your",
]);

async function whoIs(address: string): Promise<unknown> {
  const parties = await counterparties(session().wallet, session().network);
  const party = parties.find((p) => p.address.toLowerCase() === address.toLowerCase());
  const person = await personForAddress(address);
  const facts = await recallAbout(address);
  return {
    address,
    named_as: person?.alias ?? party?.name ?? null,
    note: person?.note ?? "",
    known_from_memory: !!person || facts.length > 0,
    relationship: party
      ? {
          flows: party.flows,
          direction: party.direction,
          total: `${party.net} ${party.asset}`,
          usual_amount: party.usualAmount ? `${party.usualAmount} ${party.asset}` : null,
          first_seen: party.firstSeen,
          last_seen: party.lastSeen,
          every_about_days: party.gapDays,
        }
      : "no transactions with this wallet in the range we read",
    memories: facts.map((f) => f.text),
    blobs: facts.map((f) => f.blobId),
  };
}

export const TOOLS: Tool[] = [
  {
    name: "people_you_know",
    description: "List every person the agent has a name for. Always call this before paying anyone by name.",
    positional: [],
    parameters: {},
    required: [],
    run: () => peopleRoster(),
  },
  {
    name: "who_is_this",
    description: "Everything the agent knows about one wallet address: their name, what they are usually paid, how often, and the memories about them.",
    positional: ["address"],
    parameters: { address: { type: "STRING", description: "Full 0x Sui address" } },
    required: ["address"],
    run: (a) => whoIs(String(a.address)),
  },
  {
    name: "money_history",
    description: "The people this wallet sends and receives money with, with usual amounts, cadence and last-seen dates.",
    positional: ["limit", "sort", "person"],
    parameters: {
      limit: {
        type: "INTEGER",
        description:
          "How many people to put in the answer. Leave unset to list everyone. This never shortens the history that was read, it only trims the list.",
      },
      sort: {
        type: "STRING",
        description:
          "amount for the biggest totals first, cadence for the most frequent, recent for the most recent. Leave unset to list everyone",
      },
      person: {
        type: "STRING",
        description: "One name or address to narrow the answer to. Leave unset to list everyone",
      },
    },
    required: [],
    run: async (a) => {
      // A model or a CLI caller can hand this a non number, and NaN in a query comes
      // back as a provider error string rather than a useful refusal.
      const wanted = Number(a.limit);
      const limit = Number.isFinite(wanted) ? Math.max(1, Math.min(50, Math.round(wanted))) : undefined;
      const rows = await counterparties(session().wallet, session().network, limit);
      // Answering "how much have I sent Imran" with everybody's totals is the kind of
      // wrong that reads as the agent not listening, so one name narrows the list.
      const who = String(a.person ?? "").trim().toLowerCase();
      const mine = who
        ? rows.filter(
            (r) =>
              (r.name ?? "").toLowerCase().includes(who) ||
              r.address.toLowerCase() === who ||
              r.address.toLowerCase().startsWith(who),
          )
        : rows;
      // counterparties hands back a cached array, so ranking has to copy it or the
      // people rail silently inherits whatever question was asked last.
      const by = String(a.sort ?? "");
      const ts = (d: string | null) => Date.parse(d ?? "") || 0;
      const ranked = [...mine];
      if (by === "amount") ranked.sort((x, y) => Number(y.net) - Number(x.net));
      else if (by === "cadence") ranked.sort((x, y) => y.flows - x.flows);
      else if (by === "recent") ranked.sort((x, y) => ts(y.lastSeen) - ts(x.lastSeen));
      // A number in one field and its coin in another is how the model answers
      // "0.05 USDC" about a Sui payment, so each amount leaves carrying its own unit.
      return ranked.map((r) => ({
        ...r,
        net: `${r.net} ${r.asset}`,
        usualAmount: r.usualAmount ? `${r.usualAmount} ${r.asset}` : null,
      }));
    },
  },
  {
    name: "monthly_summary",
    description: "How much went out in each month, so the agent can answer where the money went.",
    positional: [],
    parameters: {},
    required: [],
    run: () => monthlyTotals(session().wallet, session().network),
  },
  {
    name: "what_is_due",
    description:
      "The rhythms the agent has measured, and which of them are past their date. Call this for anything about a bill, a subscription, who has not been paid, or what is coming up. It only states a rhythm after seeing it twice.",
    positional: [],
    parameters: {},
    required: [],
    run: async () => {
      const parties = await counterparties(session().wallet, session().network);
      const rows = dueRows(parties);
      return {
        today: new Date().toISOString().slice(0, 10),
        late: rows.filter((r) => r.state === "late").length,
        due: rows.filter((r) => r.state === "due").length,
        people: rows,
        said: rows
          .filter((r) => r.state === "late" || r.state === "due")
          .map((r) => r.line)
          .slice(0, 3),
      };
    },
  },
  {
    name: "name_a_person",
    description: "Give a wallet address a name, permanently. Call this the moment the user tells you who an address belongs to.",
    positional: ["name", "address", "note"],
    parameters: {
      name: { type: "STRING", description: "What the user calls this person, e.g. Ravi" },
      address: { type: "STRING", description: "Full 0x Sui address" },
      note: { type: "STRING", description: "Anything the user added, e.g. the plumber, pays on Fridays" },
    },
    required: ["name", "address"],
    run: async (a) => {
      const person = await labelPerson(String(a.name), String(a.address), a.note ? String(a.note) : undefined);
      forgetCounterparties();
      return person;
    },
  },
  {
    name: "find_person",
    description: "Turn a name the user spoke into a wallet address. Names arrive from a microphone, so a near match comes back with confidence below 1 and the name it is stored as. Returns not_found if the agent has never been told.",
    positional: ["name"],
    parameters: { name: { type: "STRING", description: "The person's name as the user said it" } },
    required: ["name"],
    run: async (a) => {
      const m = await matchPerson(String(a.name));
      if (!m) return { not_found: String(a.name) };
      // When the microphone heard something other than what is stored, the agent has to
      // say the name it heard out loud, so a correction is audible instead of silent.
      return { ...m.person, heard_as: m.heard, confidence: Number(m.confidence.toFixed(2)) };
    },
  },
  {
    name: "remember_this",
    description: "Store one fact the user told you, so future sessions know it too. Facts only, no opinions.",
    positional: ["text"],
    parameters: { text: { type: "STRING", description: "A single self-contained fact" } },
    required: ["text"],
    run: (a) => remember(String(a.text)).then((blob) => ({ stored: blob })),
  },
  {
    name: "what_do_i_remember",
    description: "Search the agent's own memory for anything it has been told.",
    positional: ["query"],
    parameters: { query: { type: "STRING", description: "What to look for" } },
    required: ["query"],
    run: async (a) => {
      /*
       * A whole sentence is what arrives from a call, and no stored fact contains
       * "what do you remember about Sana" as a substring. Names are corrected first and
       * the rest is matched on the words that carry meaning, which is also the only
       * place a misspelled name is worth catching.
       */
      const spoken = String(a.query);
      const asked = await canonicalNames(spoken);
      const query = asked.toLowerCase();
      const words = [...new Set(query.split(/[^a-z0-9]+/).filter((w) => w.length > 3 && !FILLER.has(w)))];
      const [roster, hits] = await Promise.all([peopleRoster(), searchMemory(asked)]);
      const people = roster.filter((p) => query.includes(p.alias.toLowerCase()) || words.some((w) => p.note.toLowerCase().includes(w)));
      const ranked = hits
        .map((h) => ({ h, score: words.filter((w) => h.text.toLowerCase().includes(w)).length }))
        .filter((r) => !words.length || r.score > 0)
        .sort((a, b) => b.score - a.score)
        .slice(0, 8)
        .map((r) => r.h);
      return {
        asked_for: asked,
        heard_as: asked === spoken ? undefined : spoken,
        people,
        memories: ranked,
        matched: people.length + ranked.length,
      };
    },
  },
  {
    name: "memory_stats",
    description: "How much the agent has actually stored on Walrus, by namespace.",
    positional: [],
    parameters: {},
    required: [],
    run: () => memoryStats(),
  },
  {
    name: "make_report",
    description:
      "Turn what the agent already knows into a statement the person can keep, print or share. Call this when someone asks for a bill, a report, a receipt or a summary they can send to somebody.",
    positional: [],
    parameters: {},
    required: [],
    run: async () => {
      const d = await buildStatement();
      return {
        where: "/report",
        headline: d.headline,
        total_out: d.totalOut,
        other_assets: d.otherAssets || null,
        people: d.people.map((p) => `${p.name} ${p.amount}`),
        remembered: d.remembered,
        bought: d.bought,
        paid_to_learn: d.paid,
        // The card is typeset from these same numbers, so the sentence and the paper
        // can never disagree, which is the whole reason the report is not generated.
        note: "the card shows the same figures you were just given, and it is a real page they can save",
      };
    },
  },
];

if (paymentsEnabled()) {
  TOOLS.push({
    name: "pay_usdc",
    description: "Send USDC to a person already named, or to a full address. Never invent an address.",
    positional: ["to", "amount"],
    parameters: {
      to: { type: "STRING", description: "A person's name, or a full 0x Sui address" },
      amount: { type: "NUMBER", description: `USDC amount, maximum ${paymentCap()}` },
    },
    required: ["to", "amount"],
    run: async (a) => {
      const raw = String(a.to);
      // Exact match only, on purpose. Reading memory can afford a guess about who a
      // speaker meant, moving money to the wrong person cannot.
      const address = raw.startsWith("0x") ? raw : (await resolvePerson(raw))?.address;
      if (!address) throw new Error(`I have never been told who "${raw}" is. Ask the user for the address first`);
      const usdc = Number(a.amount);
      if (!Number.isFinite(usdc) || usdc <= 0) throw new Error("amount must be a positive number");
      const name = raw.startsWith("0x") ? null : raw;

      // The user's own money never leaves on a sentence alone. Build the transfer,
      // hold it, and let the signature in their wallet be the approval.
      if (session().source === "wallet") {
        // The unsigned transaction can only be built against testnet USDC, so a
        // mainnet wallet must be told that instead of being shown testnet bytes.
        if (session().network !== "testnet") {
          throw new Error(
            "this agent only prepares testnet USDC transfers and you are connected to mainnet. Switch the wallet to testnet, or use the demo story",
          );
        }
        const p = await prepareUsdc(session().wallet, address, usdc);
        const held = hold({ sender: p.sender, to: p.to, name, usdc: p.usdc, bytes: p.bytes, chain: p.chain });
        return { awaiting_signature: true, id: held.id, to: name ?? p.to, usdc: p.usdc, where: "the Pay page" };
      }

      const payment = await payUsdc(address, BigInt(Math.round(usdc * 10 ** USDC_DECIMALS)));
      forgetCounterparties();
      await remember(`Paid ${payment.usdc} USDC to ${address}${name ? ` (${name})` : ""} on ${new Date().toISOString().slice(0, 10)}. tx ${payment.digest}`);
      return { ...payment, named_as: name };
    },
  });

  TOOLS.push({
    name: "paid_lookup",
    description:
      "Ask a paid address index who owns a wallet, but only when memory has nothing on it. Costs a small testnet USDC fee the first time and nothing ever again, because the answer is remembered.",
    positional: ["address"],
    parameters: { address: { type: "STRING", description: "Full 0x Sui address with no name attached yet" } },
    required: ["address"],
    run: async (a) => {
      const address = String(a.address);
      if (!/^0x[0-9a-fA-F]{64}$/.test(address)) throw new Error("address must be a full 0x Sui address");

      // The order matters and is the product. Memory is read before the index is
      // contacted, so an address the user already explained is never charged for.
      const known = await personForAddress(address);
      if (known) {
        return {
          cost_usdc: 0,
          from: "memory",
          name: known.alias,
          note: known.note,
          said: "I already know this one, so I did not pay for it",
        };
      }

      const payer = session().wallet;
      const resource = resourceId(address);

      if (session().source === "wallet") {
        if (session().network !== "testnet") {
          throw new Error(
            "the paid index only takes testnet USDC and you are connected to mainnet. Switch the wallet to testnet, or use the demo story",
          );
        }
        const quoted = await price(resource, payer);
        if ("error" in quoted) throw new Error(quoted.error);
        if ("free" in quoted) {
          // This branch is a receipt the index already honoured, so the memory is
          // written with the price that was paid then rather than the 0 of this ask.
          const person = await record(quoted.fact, address, quoted.paid, quoted.tx, quoted.on);
          forgetCounterparties();
          return { cost_usdc: 0, from: "the index, on the earlier receipt", name: person.alias, note: person.note };
        }
        const q = quoted.quote;
        await nameTheIndex();
        const prepared = await prepareUsdc(payer, q.payTo, q.usdc);
        const held = hold({
          sender: prepared.sender,
          to: prepared.to,
          name: "Paid address index",
          usdc: prepared.usdc,
          bytes: prepared.bytes,
          chain: prepared.chain,
          resource,
          quote: q,
        });
        return {
          awaiting_signature: true,
          id: held.id,
          to: "Paid address index",
          usdc: prepared.usdc,
          what: `a name for ${address.slice(0, 8)}… that I have never seen`,
          where: "the Pay page",
        };
      }

      await nameTheIndex();
      const bought = await buy(resource, payer, (q) => payUsdc(q.payTo, BigInt(q.baseUnits)));
      if ("error" in bought) throw new Error(bought.error);
      const person = await record(bought.fact, address, bought.usdc, bought.tx, bought.on);
      forgetCounterparties();
      return {
        cost_usdc: bought.usdc,
        from: bought.reason === "bought" ? "the paid index" : bought.reason,
        name: person.alias,
        note: person.note,
        tx: bought.tx,
        remembered: true,
      };
    },
  });
}

export const TOOL_NAMES = TOOLS.map((t) => t.name);

export async function runTool(name: string, args: Record<string, any>): Promise<unknown> {
  const tool = TOOLS.find((t) => t.name === name);
  if (!tool) throw new Error(`unknown tool "${name}". available: ${TOOL_NAMES.join(", ")}`);
  return tool.run(args);
}

const isCli = process.argv[1]?.includes("/src/tools");
if (isCli) {
  const [name, ...rest] = process.argv.slice(2);
  if (!name) {
    console.error(`usage: npm run tools -- <tool> ${TOOL_NAMES.join("|")}\ne.g. npm run tools -- who_is 0x…`);
    process.exit(1);
  }
  const tool = TOOLS.find((t) => t.name === name);
  if (!tool) {
    console.error(`unknown tool "${name}". available: ${TOOL_NAMES.join(", ")}`);
    process.exit(1);
  }
  const args = Object.fromEntries(tool.positional.map((key, i) => [key, rest[i]]).filter(([, v]) => v !== undefined));
  try {
    console.log(JSON.stringify(await tool.run(args), null, 1).slice(0, 4000));
  } catch (err) {
    console.error("FAILED:", (err as Error).message);
    process.exit(1);
  }
}
