import "dotenv/config";
import { bills, commitments, counterparties, dueRows, forgetCounterparties, monthlyTotals } from "./knowledge.js";
import { labelPerson, resolvePerson, matchPerson, canonicalNames, personForAddress, peopleRoster, memoryStats } from "./people.js";
import { remember, recallAbout, searchMemory } from "./memory.js";
import { payOnce, payUsdc, prepareUsdc, paymentsEnabled, paymentCap, USDC_DECIMALS } from "./wallet.js";
import { buy, indexPayout, knownProfile, learn, nameTheIndex, overCeiling, price, priceCeiling } from "./x402.js";
import { noteResourceId, receiptResourceId, resourceId } from "./resources.js";
import { note } from "./notes.js";
import { hold } from "./pending.js";
import { capOwner, chainMismatch, session } from "./session.js";
import { currentSeat } from "./seat.js";
import { buildStatement } from "./report.js";
import { PAY_CHAIN, PAY_NET, allHoldings, formatAmount } from "./chain.js";
import { usdPrices } from "./price.js";
import { addressActivity, moneyOrigin, monthSpend } from "./history.js";
import { faucetLabel } from "./known.js";
import { capMeter, capUsdc, clearCap, setCapBase, usdcToBase } from "./cap.js";
import { DEFAULT_MINUTES, NOTE_MAX } from "./requests.js";
import { clearSpam, markSpam, spamMarkFor, spamMarks } from "./spam.js";
import { addReminder, cancelReminder, parseWhen, spokenWhen, upcomingReminders } from "./reminders.js";

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

async function whoIs(raw: string): Promise<unknown> {
  const trimmed = String(raw ?? "").trim();
  const isHex = /^0x[0-9a-fA-F]{64}$/.test(trimmed);
  const resolved = isHex ? await personForAddress(trimmed) : await resolvePerson(trimmed);
  const address = isHex ? trimmed : resolved?.address ?? "";
  if (!address) {
    return {
      needs_address: true,
      who: trimmed,
      looks_like_address: /^0x/i.test(trimmed),
      note: "No address is kept for this name yet. Ask the user to paste the full 0x Sui address in the field below.",
    };
  }
  const net = session().network;
  const parties = await counterparties(session().wallet, net);
  const party = parties.find((p) => p.address.toLowerCase() === address.toLowerCase());
  const person = resolved ?? (await personForAddress(address));
  const facts = await recallAbout(address);
  const faucet = faucetLabel(address);
  const activity = await addressActivity(address, net, session().wallet).catch(() => null);
  const spam = spamMarkFor(address);
  return {
    address,
    network: net,
    explorer_url: `https://suiscan.xyz/${net}/account/${address}`,
    named_as: person?.alias ?? party?.name ?? faucet,
    named_by: person ? "memory" : faucet ? "the faucet's own published address" : party?.service ? "this build's vendor list" : null,
    note: person?.note ?? "",
    known_from_memory: !!person || facts.length > 0,
    spam: spam ? { reason: spam.reason, marked_on: new Date(spam.at).toISOString().slice(0, 10) } : null,
    relationship: party
      ? {
          flows: party.flows,
          direction: party.direction,
          total: `${party.net} ${party.asset}`,
          usual_amount: party.usualAmount ? `${party.usualAmount} ${party.asset}` : null,
          first_seen: party.firstSeen,
          last_seen: party.lastSeen,
          every_about_days: party.gapDays,
          // The dominant coin is not the whole relationship. A funder that sent 20
          // USDC and 0.0024 SUI must read as both, or the larger fact disappears.
          coins: party.coins,
        }
      : faucet
        ? "this is the faucet address itself, so there is no relationship to read"
        : "no transactions with this wallet in the range we read",
    transactions_read: activity?.transactions_read ?? 0,
    first_seen: activity?.first_seen ?? party?.firstSeen ?? null,
    last_seen: activity?.last_seen ?? party?.lastSeen ?? null,
    in_by_coin: activity?.in_by_coin ?? [],
    out_by_coin: activity?.out_by_coin ?? [],
    counterparties: activity?.counterparties ?? [],
    transactions: activity?.transactions ?? [],
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
    description: "How much went out and came in for each month, split by coin, so the agent can answer where the money went.",
    positional: [],
    parameters: {},
    required: [],
    run: () => monthlyTotals(session().wallet, session().network),
  },
  {
    name: "wallet_balance",
    description:
      "How much money this wallet holds right now, read from the chain, one row per coin with its exact amount and dollar value when a price is available. This is the only tool for a balance. Never answer how much money someone has from money_history or monthly_summary, which describe movements, not what is left.",
    positional: [],
    parameters: {},
    required: [],
    run: async () => {
      const [holdings, usd] = await Promise.all([
        allHoldings(session().wallet, session().network),
        usdPrices(),
      ]);
      const coins = holdings
        .filter((h) => h.amount > 0)
        .sort((a, b) => b.amount - a.amount)
        .map((h) => {
          const price = usd[h.symbol] ?? null;
          return {
            asset: h.symbol,
            amount: h.amount,
            exact: formatAmount(BigInt(h.base), h.decimals),
            decimals: h.decimals,
            price_usd: price,
            value_usd: price === null ? null : Number((h.amount * price).toFixed(2)),
          };
        });
      // A total that quietly leaves out a coin with no price is a wrong total, so it is
      // absent instead. The per-coin amounts above are chain facts either way.
      const total = coins.length && coins.every((c) => c.value_usd !== null)
        ? Number(coins.reduce((sum, c) => sum + (c.value_usd ?? 0), 0).toFixed(2))
        : null;
      return {
        wallet: session().wallet,
        network: session().network,
        coins,
        total_usd: total,
        price_source: total === null ? null : "CoinGecko spot price",
        note:
          total === null
            ? "no dollar total because at least one coin has no price right now, the coin amounts are still exact"
            : "dollars are a market price from CoinGecko, not a chain fact",
        said: coins.length
          ? coins.map((c) =>
              c.value_usd === null
                ? `${c.exact} ${c.asset}`
                : `${c.exact} ${c.asset} worth about ${c.value_usd} dollars`,
            )
          : [`This wallet holds no coin on ${session().network}.`],
      };
    },
  },
  {
    name: "how_money_came",
    description:
      "Walk the wallet's public history back and say where the money came from: who funded it, how much arrived and left per coin, and whether the transfers explain the balance. Call this for questions like how did this balance get here, who funded me, or where did the money come from.",
    positional: [],
    parameters: {},
    required: [],
    run: () => moneyOrigin(session().wallet, session().network),
  },
  {
    name: "address_activity",
    description:
      "Inspect any wallet address (or saved person name) in detail: its last public transactions with clickable explorer links, what it sent and received per coin, who it dealt with, and measured patterns. Use it when the user asks to look out for a wallet, inspect an address, see its transactions/links, or check whether an address is trustworthy, spam, a person or a service.",
    positional: ["address"],
    parameters: { address: { type: "STRING", description: "Full 0x Sui address or a known person's name" } },
    required: ["address"],
    run: async (a) => {
      const raw = String(a.address ?? "").trim();
      const isHex = /^0x[0-9a-fA-F]{64}$/.test(raw);
      const person = isHex ? await personForAddress(raw) : await resolvePerson(raw);
      const address = isHex ? raw : person?.address ?? "";
      if (!address) {
        return {
          needs_address: true,
          who: raw,
          looks_like_address: /^0x/i.test(raw),
          note: "No address is kept for this name. Ask the user to paste the full 0x Sui address in the field below.",
        };
      }
      const act = await addressActivity(address, session().network, session().wallet);
      const spam = spamMarkFor(address);
      return {
        ...act,
        named_as: person?.alias ?? faucetLabel(address) ?? null,
        spam: spam ? { reason: spam.reason, marked_on: new Date(spam.at).toISOString().slice(0, 10) } : null,
      };
    },
  },
  {
    name: "mark_spam",
    description:
      "Mark an address as spam at the user's request. Every later payment to a marked address stops before any bytes are built and asks the user again. This records the user's own judgement, never a verdict the agent worked out from the chain. Pass a name or a full 0x address, and pass an empty address when the name has none yet so the page opens its address field.",
    positional: ["who", "address", "reason"],
    parameters: {
      who: { type: "STRING", description: "The person's name, or a full 0x Sui address" },
      address: { type: "STRING", description: "Full 0x address when the user typed one. Pass an empty string otherwise" },
      reason: { type: "STRING", description: "Why the user calls it spam, in their own words" },
    },
    required: ["who"],
    run: async (a) => {
      const raw = String(a.who ?? "").trim();
      if (!raw) throw new Error("who should I mark as spam?");
      const typed = String(a.address ?? "").trim();
      const full = /^0x[0-9a-fA-F]{64}$/.test(raw) ? raw : /^0x[0-9a-fA-F]{64}$/.test(typed) ? typed : null;
      const person = full ? await personForAddress(full) : await resolvePerson(raw);
      const address = full ?? person?.address ?? null;
      if (!address) {
        return {
          needs_address: true,
          who: raw,
          note: "No address is kept for this name. Ask the user for the full 0x Sui address in one short sentence. The page is showing a field for it. Do not guess an address.",
        };
      }
      const name = person?.alias ?? (/^0x/.test(raw) ? null : raw);
      const mark = markSpam(address, name, String(a.reason ?? "").trim() || null);
      return {
        marked: true,
        name: mark.name,
        address: mark.address,
        reason: mark.reason,
        said: `${mark.name ?? "that address"} is marked spam. I will stop and ask before sending any money there.`,
      };
    },
  },
  {
    name: "unmark_spam",
    description:
      "Remove a spam mark the user asked to clear. Pass the same name or full address that was marked.",
    positional: ["who", "address"],
    parameters: {
      who: { type: "STRING", description: "The person's name, or a full 0x Sui address" },
      address: { type: "STRING", description: "Full 0x address when the user typed one. Pass an empty string otherwise" },
    },
    required: ["who"],
    run: async (a) => {
      const raw = String(a.who ?? "").trim();
      if (!raw) throw new Error("who should I unmark?");
      const typed = String(a.address ?? "").trim();
      const full = /^0x[0-9a-fA-F]{64}$/.test(raw) ? raw : /^0x[0-9a-fA-F]{64}$/.test(typed) ? typed : null;
      const person = full ? await personForAddress(full) : await resolvePerson(raw);
      const address = full ?? person?.address ?? null;
      if (!address) {
        return {
          needs_address: true,
          who: raw,
          note: "No address is kept for this name. Ask the user for the full 0x Sui address in one short sentence. The page is showing a field for it.",
        };
      }
      const cleared = clearSpam(address);
      return {
        cleared,
        name: person?.alias ?? (/^0x/.test(raw) ? null : raw),
        address,
        said: cleared
          ? "The spam mark is gone. Payments to that address will work normally again."
          : "That address was not marked, so there was nothing to clear.",
      };
    },
  },
  {
    name: "spam_marks",
    description: "List every address the user has marked as spam, with the reason and when it was marked.",
    positional: [],
    parameters: {},
    required: [],
    run: async () => {
      const marks = spamMarks();
      return {
        count: marks.length,
        marks: marks.map((m) => ({
          name: m.name,
          address: m.address,
          short: `${m.address.slice(0, 8)}…${m.address.slice(-6)}`,
          reason: m.reason,
          marked_on: new Date(m.at).toISOString().slice(0, 10),
        })),
        said: marks.length
          ? marks.map((m) => `${m.name ?? m.address.slice(0, 8)}${m.reason ? `, ${m.reason}` : ""}`)
          : ["No address is marked spam."],
      };
    },
  },
  {
    name: "remind_me",
    description:
      "Set a reminder the agent will write into this conversation when the time comes. Pass the user's own time words unchanged, such as in 20 minutes, at 6pm, or tomorrow at 9. The time is parsed on the server, so never do the arithmetic yourself. This only works while the server is running.",
    positional: ["what", "when"],
    parameters: {
      what: { type: "STRING", description: "What to remind the user about, in one short sentence" },
      when: { type: "STRING", description: "The user's own time words: in 20 minutes, at 6pm, tomorrow at 9" },
    },
    required: ["what", "when"],
    run: async (a) => {
      const what = String(a.what ?? "").trim();
      const when = String(a.when ?? "").trim();
      if (!what) throw new Error("what should I remind you about?");
      const at = when ? parseWhen(when) : null;
      if (!at) {
        return {
          unclear: true,
          heard: when,
          note: "The time was not clear enough to keep, so nothing was set. Ask for a time in one short sentence, such as in 20 minutes, at 6pm, or tomorrow at 9. Never claim a reminder was set.",
        };
      }
      if (at.getTime() <= Date.now()) {
        return {
          past: true,
          heard: when,
          note: "That time is already past, so nothing was set. Ask for a future time in one short sentence.",
        };
      }
      const made = addReminder(what, at.getTime(), currentSeat()?.chat ?? null);
      return {
        set: true,
        id: made.id,
        what: made.what,
        due_at: at.toISOString(),
        said: `Reminder set for ${spokenWhen(at)}: ${made.what}`,
        note: "Say the time you kept, in the user's own timezone. The reminder appears in this conversation while the server is running.",
      };
    },
  },
  {
    name: "reminders",
    description: "List the reminders this wallet is still waiting on, soonest first.",
    positional: [],
    parameters: {},
    required: [],
    run: async () => {
      const rows = upcomingReminders();
      return {
        count: rows.length,
        reminders: rows.map((r) => ({
          id: r.id,
          what: r.what,
          due_at: new Date(r.due_at).toISOString(),
          due: spokenWhen(new Date(r.due_at)),
        })),
        said: rows.length
          ? rows.map((r) => `${spokenWhen(new Date(r.due_at))}: ${r.what}`)
          : ["Nothing is waiting on a time."],
      };
    },
  },
  {
    name: "cancel_reminder",
    description: "Cancel a reminder by the id the set result or the list gave you.",
    positional: ["id"],
    parameters: { id: { type: "STRING", description: "The short id of the reminder to cancel" } },
    required: ["id"],
    run: async (a) => {
      const id = String(a.id ?? "").trim();
      if (!id) throw new Error("which reminder should I cancel?");
      const cleared = cancelReminder(id);
      return {
        cleared,
        said: cleared ? "That reminder is gone." : "No waiting reminder has that id, so nothing was changed.",
      };
    },
  },
  {
    name: "what_is_due",
    description:
      "The rhythms the agent has measured, which of them are past their date, and what they add up to in a month. Call this for anything about a bill, a subscription, who has not been paid, what is coming up, or what the person is committed to paying. It only states a rhythm after seeing it twice.",
    positional: [],
    parameters: {},
    required: [],
    run: async () => {
      const parties = await counterparties(session().wallet, session().network);
      // The paid index is excluded because it takes a fee per question, and a fee read
      // back as a rhythm would be the agent inventing a bill it does not have.
      const rows = bills(dueRows(parties), [indexPayout()]);
      // Totalled here rather than left to the model, because a monthly figure it works
      // out in its head is a figure nobody can trace back to a transaction.
      const total = commitments(rows);
      return {
        today: new Date().toISOString().slice(0, 10),
        late: rows.filter((r) => r.state === "late").length,
        due: rows.filter((r) => r.state === "due").length,
        committed: total,
        people: rows,
        said: [
          ...total.map((c) => `${c.people.length} rhythm${c.people.length === 1 ? " adds" : "s add"} up to ${c.per_month} a month: ${c.people.join(", ")}`),
          ...rows
            .filter((r) => r.state === "late" || r.state === "due")
            .map((r) => r.line)
            .slice(0, 3),
        ],
      };
    },
  },
  {
    name: "name_a_person",
    description: "Give a wallet address a name, permanently. Call this the moment the user tells you who an address belongs to. When no full 0x address is at hand, call it with an empty address and the page opens the one field a microphone cannot fill.",
    positional: ["name", "address", "note"],
    parameters: {
      name: { type: "STRING", description: "What the user calls this person, e.g. Ravi" },
      address: { type: "STRING", description: "Full 0x Sui address. Pass an empty string when the user has not typed one, because 64 hex characters cannot survive being spoken" },
      note: { type: "STRING", description: "Anything the user added, e.g. the plumber, pays on Fridays" },
    },
    required: ["name"],
    run: async (a) => {
      const name = String(a.name ?? "").trim();
      if (!name) throw new Error("what should I call this person?");
      const typed = String(a.address ?? "").trim();
      // A spoken address is never a full one, and a guessed one pays a stranger. The
      // page already knows how to collect the 64 characters, so the miss is a result
      // that opens that field rather than an error the model answers by dictating hex.
      if (!/^0x[0-9a-fA-F]{64}$/.test(typed)) {
        // The page saves a typed address through its own route, and the model can call
        // this tool right after that save because the full string never enters its
        // history. Answering with the name that is already kept is what stops a second
        // address field opening for a person who already has one.
        const already = await resolvePerson(name);
        if (already) {
          return {
            ...already,
            already_kept: true,
            note: "This name is already kept at the address the page collected. Do not ask for an address again and do not say it has not been saved.",
          };
        }
        return {
          needs_address: true,
          who: name,
          looks_like_address: /^0x/i.test(typed),
          note: "The full address for this name has not been typed into the page yet. Ask for it in one short sentence. The page is showing a field for it. Never read a hex string out loud and never guess one.",
        };
      }
      const person = await labelPerson(name, typed, a.note ? String(a.note) : undefined);
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
      const name = String(a.name).trim();
      const m = await matchPerson(name);
      // A miss is what puts the address field on screen. The page reads this shape, so
      // the miss is a result rather than a thrown error the model would swallow.
      if (!m) {
        return {
          not_found: name,
          needs_address: true,
          who: name,
          looks_like_address: false,
          note: "No address is kept for this name. Ask the user for the full 0x Sui address in one short sentence. The page is showing a field for it. Do not guess an address.",
        };
      }
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
        direction: d.direction,
        total_out: d.totalOut,
        total_in: d.totalIn,
        other_assets: d.otherAssets || null,
        in_other_assets: d.inOtherAssets || null,
        people: d.people.map((p) => `${p.name} ${p.amount}`),
        senders: d.senders.map((p) => `${p.name} ${p.amount}`),
        remembered: d.remembered,
        bought: d.bought,
        paid_to_learn: d.paid,
        // The card is typeset from these same numbers, so the sentence and the paper
        // can never disagree, which is the whole reason the report is not generated.
        note: "the card shows the same figures you were just given, and it is a real page they can save. If total_out is zero and total_in is not, say what came in rather than reading the zero as if nothing happened.",
      };
    },
  },
  {
    name: "set_monthly_limit",
    description:
      "Read or change the monthly USDC limit this wallet draws on the statement. Call it when the person says set my monthly limit to 25, raise my budget, lift the limit, or asks how much of the limit is left. It is a budget the person writes for themselves. It never blocks a payment.",
    positional: ["usdc"],
    parameters: {
      usdc: {
        type: "NUMBER",
        description: "The monthly limit in USDC. Leave it out to read the current limit and this month's spending. Zero lifts the limit.",
      },
    },
    required: [],
    run: async (a) => {
      const asked = a.usdc;
      const changing = !(asked === undefined || asked === null || asked === "");
      const monthly = changing ? Number(asked) : null;
      if (changing && (!Number.isFinite(monthly) || monthly! < 0)) {
        throw new Error("a monthly limit has to be a number of USDC, or zero to lift it");
      }
      if (changing && monthly! > 100_000) {
        throw new Error("a monthly limit above 100,000 USDC is not a budget this page can draw");
      }
      const owner = capOwner();
      if (changing && monthly === 0) clearCap(owner);
      else if (changing) setCapBase(owner, usdcToBase(monthly!));

      const s = session();
      const spend = await monthSpend(s.wallet, s.network);
      const limit = capUsdc(owner);
      const meter = capMeter(spend.spent, limit);
      const money = (n: number) => String(Math.round(n * 100) / 100);
      const pct = meter.monthly ? Math.round((meter.spent / meter.monthly) * 100) : 0;

      const said: string[] = [];
      if (!changing) said.push(meter.monthly === null ? "There is no monthly limit set." : `The monthly limit is ${money(meter.monthly)} USDC.`);
      else if (monthly === 0) said.push("The monthly limit is lifted.");
      else said.push(`The monthly limit is now ${money(meter.monthly!)} USDC.`);

      said.push(`${money(meter.spent)} USDC has gone out this month${meter.monthly ? `, which is ${pct}% of the limit` : ""}.`);
      if (meter.monthly !== null) {
        if (meter.state === "over") said.push(`That is over the limit by ${money(Math.abs(meter.left ?? 0))} USDC.`);
        else said.push(`${money(meter.left ?? 0)} USDC of the limit is left.`);
      }
      if (!spend.complete) said.push("The history read stopped at its page limit, so this month's spending may be higher than the number above.");
      said.push("A limit never blocks a payment. The statement at /report draws it.");

      return {
        changed: changing,
        monthly: meter.monthly,
        spent: meter.spent,
        left: meter.left,
        percent_used: pct,
        state: meter.state,
        complete: spend.complete,
        where: "/report",
        said,
      };
    },
  },
  {
    name: "request_money",
    description:
      "Open the small form that makes a payment request link for this wallet, for asking someone to pay you or sending a bill. The form collects the amount, what it is for and how long the link lives. Nothing is created and nothing moves until the person presses the button in that form, so never say a link exists before the page says it was made.",
    positional: ["usdc", "what_for", "minutes"],
    parameters: {
      usdc: { type: "NUMBER", description: "The amount to ask for in USDC, if the person already said one" },
      what_for: { type: "STRING", description: "What the money is for, in the person's own words, if they said it" },
      minutes: { type: "INTEGER", description: "How long the link lives. 30, 120 or 1440 minutes. Leave unset for 30" },
    },
    required: [],
    run: async (a) => {
      const s = session();
      if (s.source !== "wallet") {
        return {
          needs_wallet: true,
          note: "A request link has to point at a wallet the person can spend from. Ask them to connect a wallet first, then call this again. Do not say a link exists.",
        };
      }

      const raw = a.usdc;
      const usdc = raw === undefined || raw === null || raw === "" ? null : Number(raw);
      if (usdc !== null && (!Number.isFinite(usdc) || usdc <= 0)) {
        throw new Error("a request needs an amount above zero");
      }
      if (usdc !== null && usdc > paymentCap()) {
        throw new Error(`the ceiling on one signature is ${paymentCap()} USDC, so a request above that could never be paid here`);
      }
      const asked = Number(a.minutes);
      const minutes = [30, 120, 1440].includes(asked) ? asked : DEFAULT_MINUTES;
      const whatFor = String(a.what_for ?? "").replace(/\s+/g, " ").trim().slice(0, NOTE_MAX) || null;

      return {
        needs_request_fields: true,
        usdc,
        what_for: whatFor,
        minutes,
        max_usdc: paymentCap(),
        note: "The page is opening a small form with the amount, what the money is for, and how long the link lives. The person presses the button there. Do not say a link exists yet, and do not call this again for that request.",
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
      confirm_spam: { type: "STRING", description: "Pass yes only after the user clearly confirms sending to an address the agent warned is marked spam. Leave it out on every other payment." },
    },
    required: ["to", "amount"],
    run: async (a) => {
      const raw = String(a.to).trim();
      const usdc = Number(a.amount);
      if (!raw) throw new Error("who should the money go to? Give a name or a full Sui address");
      if (!Number.isFinite(usdc) || usdc <= 0) throw new Error("amount must be a positive number");

      // Exact match only, on purpose. Reading memory can afford a guess about who a
      // speaker meant, moving money to the wrong person cannot.
      const full = /^0x[0-9a-fA-F]{64}$/.test(raw);
      const person = full ? await personForAddress(raw) : await resolvePerson(raw);
      if (!full && !person) {
        // The page reads this and opens the address field with the amount already in
        // hand, so the person types the one thing a microphone can never carry.
        return {
          needs_address: true,
          who: raw,
          looks_like_address: /^0x/i.test(raw),
          amount: usdc,
          note: "No address is kept for this name. Ask the user for the full 0x Sui address in one short sentence. The page is showing a field for it. Do not guess an address and do not say the money moved.",
        };
      }
      const address = full ? raw : person!.address;
      const name = full ? (person?.alias ?? null) : raw;

      // The mark the person set themselves outranks any amount on the line. Nothing is
      // built on the first attempt, because a warning that arrives after the bytes are
      // signed is a receipt, not a warning.
      const mark = spamMarkFor(address);
      if (mark && String(a.confirm_spam ?? "").toLowerCase() !== "yes") {
        return {
          marked_spam: true,
          who: name ?? `${address.slice(0, 8)}…${address.slice(-6)}`,
          amount: usdc,
          reason: mark.reason,
          marked_on: new Date(mark.at).toISOString().slice(0, 10),
          note: "This address is marked spam by the user. Nothing was built and no money moved. Say plainly that it is marked spam, repeat the reason if there is one, and ask whether they still want to send. Only call pay_usdc again with confirm_spam yes after they clearly say yes in this conversation.",
        };
      }

      // The user's own money never leaves on a sentence alone. Build the transfer,
      // hold it, and let the signature in their wallet be the approval.
      if (session().source === "wallet") {
        const crossed = chainMismatch();
        if (crossed) throw new Error(crossed);
        const p = await prepareUsdc(session().wallet, address, usdc, session().network);
        const held = hold({ sender: p.sender, to: p.to, name, usdc: p.usdc, bytes: p.bytes, chain: p.chain });
        return { awaiting_signature: true, id: held.id, to: name ?? p.to, usdc: p.usdc, where: "the ticket under this reply" };
      }

      const payment = await payOnce(session().wallet, address, BigInt(Math.round(usdc * 10 ** USDC_DECIMALS)));
      forgetCounterparties();
      // A duplicate is the same settled transfer, so writing it to Walrus again would
      // make one payment read as two in the very history that is meant to be trusted.
      if (!payment.duplicate) {
        await remember(`Paid ${payment.usdc} USDC to ${address}${name ? ` (${name})` : ""} on ${new Date().toISOString().slice(0, 10)}. tx ${payment.digest}`);
      }
      return {
        ...payment,
        named_as: name,
        note: payment.duplicate ? "this exact payment was already sent moments ago. It is the same digest, not a second transfer" : undefined,
      };
    },
  });

  TOOLS.push({
    name: "paid_lookup",
    description:
      `Buy a measured profile of a wallet from a paid chain index: how many transactions, how many distinct counterparties, who dominates them, and when the history starts. Call it only when memory has nothing about the address. Costs a small ${PAY_NET} USDC fee the first time and nothing ever again, because the answer is remembered. It refuses any quote above the agent's ceiling.`,
    positional: ["address"],
    parameters: { address: { type: "STRING", description: "Full 0x Sui address with no profile in memory yet" } },
    required: ["address"],
    run: async (a) => {
      const address = String(a.address);
      if (!/^0x[0-9a-fA-F]{64}$/.test(address)) throw new Error("address must be a full 0x Sui address");

      // The order matters and is the product. Memory is read before the index is
      // contacted, so a profile this wallet already bought is never bought twice.
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
      const remembered = await knownProfile(address);
      if (remembered) {
        return { cost_usdc: 0, from: "memory", answer: remembered, said: "I already bought this profile, so I did not pay again" };
      }

      const payer = session().wallet;
      const resource = resourceId(address);

      if (session().source === "wallet") {
        const net = session().network;
        const crossed = chainMismatch();
        if (crossed) throw new Error(crossed);
        const quoted = await price(resource, payer, net);
        if ("error" in quoted) throw new Error(quoted.error);
        if ("free" in quoted) {
          const learned = await learn(resource, quoted.fact, quoted.paid, quoted.tx, quoted.on);
          forgetCounterparties();
          return { cost_usdc: 0, from: "the index, on the earlier receipt", answer: learned.note };
        }
        const refused = overCeiling(quoted.usdc);
        if (refused) {
          return { cost_usdc: 0, refused: true, price_usdc: quoted.usdc, ceiling_usdc: priceCeiling(), saying: refused };
        }
        await nameTheIndex();
        const prepared = await prepareUsdc(payer, quoted.requirements.payTo, quoted.usdc, net);
        const held = hold({
          sender: prepared.sender,
          to: prepared.to,
          name: "Paid chain index",
          usdc: prepared.usdc,
          bytes: prepared.bytes,
          chain: prepared.chain,
          resource,
          requirements: quoted.requirements,
        });
        return {
          awaiting_signature: true,
          id: held.id,
          to: "Paid chain index",
          usdc: prepared.usdc,
          what: `a chain profile of ${address.slice(0, 8)}… that I have not bought yet`,
          where: "the ticket under this reply",
        };
      }

      await nameTheIndex();
      const bought = await buy(resource, payer);
      if ("error" in bought) {
        if (bought.refusal) return { cost_usdc: 0, refused: true, saying: bought.error };
        throw new Error(bought.error);
      }
      const learned = await learn(resource, bought.fact, bought.usdc, bought.tx, bought.on);
      forgetCounterparties();
      return {
        cost_usdc: bought.reason === "bought" ? bought.usdc : 0,
        from: bought.reason === "bought" ? "the paid chain index" : bought.reason,
        answer: learned.note,
        tx: bought.tx,
        remembered: true,
      };
    },
  });

  TOOLS.push({
    name: "verify_payment",
    description:
      `Settle whether a transaction digest really moved money by paying an index that reads the chain, because a claim of payment is not a payment. Call it when somebody says they sent you money and what you were given is a digest, or when a memory and a person disagree about a payment. Costs a small ${PAY_NET} USDC fee the first time that digest is checked and nothing ever again, because the answer is remembered.`,
    positional: ["digest"],
    parameters: { digest: { type: "STRING", description: "The base58 Sui transaction digest that was claimed, exactly as it was given" } },
    required: ["digest"],
    run: async (a) => {
      const digest = String(a.digest).trim();
      const resource = receiptResourceId(digest);
      const payer = session().wallet;

      // The same order as a name: memory is read before anything is contacted, so a
      // digest already settled once is answered from the record for nothing. Only a row
      // that *is* a receipt answer counts, because a digest turns up as the payment for
      // other lookups too, and reading one of those as "already checked" would hand
      // back somebody else's sentence as the verdict on this transaction.
      const seen = (await searchMemory(digest)).filter((m) => m.text.includes(`Chain receipt for ${digest}`));
      if (seen.length) {
        return { cost_usdc: 0, from: "memory", said: "I already paid to look this one up", answer: seen[0].text };
      }

      if (session().source === "wallet") {
        const net = session().network;
        const crossed = chainMismatch();
        if (crossed) throw new Error(crossed);
        const quoted = await price(resource, payer, net);
        if ("error" in quoted) throw new Error(quoted.error);
        if ("free" in quoted) {
          const learned = await learn(resource, quoted.fact, quoted.paid, quoted.tx, quoted.on);
          return { cost_usdc: 0, from: "the index, on the earlier receipt", answer: learned.note };
        }
        const refused = overCeiling(quoted.usdc);
        if (refused) {
          return { cost_usdc: 0, refused: true, price_usdc: quoted.usdc, ceiling_usdc: priceCeiling(), saying: refused };
        }
        await nameTheIndex();
        const prepared = await prepareUsdc(payer, quoted.requirements.payTo, quoted.usdc, net);
        const held = hold({
          sender: prepared.sender,
          to: prepared.to,
          name: "Paid receipt index",
          usdc: prepared.usdc,
          bytes: prepared.bytes,
          chain: prepared.chain,
          resource,
          requirements: quoted.requirements,
        });
        return {
          awaiting_signature: true,
          id: held.id,
          to: "Paid receipt index",
          usdc: prepared.usdc,
          what: `a chain answer about whether ${digest.slice(0, 10)}… really moved money`,
          where: "the ticket under this reply",
        };
      }

      await nameTheIndex();
      const bought = await buy(resource, payer);
      if ("error" in bought) {
        if (bought.refusal) return { cost_usdc: 0, refused: true, saying: bought.error };
        throw new Error(bought.error);
      }
      const spent = bought.reason === "bought" ? bought.usdc : 0;
      const learned = await learn(resource, bought.fact, bought.usdc, bought.tx, bought.on);
      return {
        cost_usdc: spent,
        from: bought.reason === "bought" ? "the chain, through the paid index" : bought.reason,
        answer: learned.note,
        checked: digest,
        remembered: true,
      };
    },
  });

  TOOLS.push({
    name: "open_paid_link",
    description:
      "Pay to read a link that somebody else is selling, which is the only way to buy a fact a person remembers rather than a fact a service looks up. Call it when somebody hands over a paid link or its id and asks what is behind it, or asks to buy what another wallet knows. Costs the price written on that link, once, and nothing at all when this wallet has opened it before.",
    positional: ["id"],
    parameters: { id: { type: "STRING", description: "The link id from the address, the twelve characters after /ask/, exactly as it was given" } },
    required: ["id"],
    run: async (a) => {
      const id = String(a.id).trim().toLowerCase();
      const resource = noteResourceId(id);
      const payer = session().wallet;

      // Read before the price so a link that does not exist is answered by this build
      // rather than by the index's own 404, and so the seller's name can be said out
      // loud on the ticket instead of a payout hash.
      const sold = note(id);
      if (!sold) throw new Error(`no link ${id} is open on this index, so there is nothing here to pay for`);
      const seller = (await personForAddress(sold.pay_to))?.alias ?? `${sold.pay_to.slice(0, 10)}…`;

      if (session().source === "wallet") {
        const net = session().network;
        const crossed = chainMismatch();
        if (crossed) throw new Error(crossed);
        const quoted = await price(resource, payer, net);
        if ("error" in quoted) throw new Error(quoted.error);
        if ("free" in quoted) {
          const learned = await learn(resource, quoted.fact, quoted.paid, quoted.tx, quoted.on);
          return { cost_usdc: 0, from: `${seller}, on the earlier receipt`, answer: learned.note };
        }
        const refused = overCeiling(quoted.usdc);
        if (refused) {
          return { cost_usdc: 0, refused: true, price_usdc: quoted.usdc, ceiling_usdc: priceCeiling(), saying: refused };
        }
        const prepared = await prepareUsdc(payer, quoted.requirements.payTo, quoted.usdc, net);
        const held = hold({
          sender: prepared.sender,
          to: prepared.to,
          name: seller,
          usdc: prepared.usdc,
          bytes: prepared.bytes,
          chain: prepared.chain,
          resource,
          requirements: quoted.requirements,
        });
        return {
          awaiting_signature: true,
          id: held.id,
          to: seller,
          usdc: prepared.usdc,
          what: sold.blob ? `a line out of ${seller}'s memory, "${sold.title}"` : `the words behind "${sold.title}"`,
          where: "the ticket under this reply",
        };
      }

      const bought = await buy(resource, payer);
      if ("error" in bought) {
        if (bought.refusal) return { cost_usdc: 0, refused: true, saying: bought.error };
        throw new Error(bought.error);
      }
      // A receipt the index already honoured comes back carrying the price paid the
      // first time. That number belongs in the memory, which records what the fact
      // cost, and not in cost_usdc, which records what this ask spent.
      const spent = bought.reason === "bought" ? bought.usdc : 0;
      const learned = await learn(resource, bought.fact, bought.usdc, bought.tx, bought.on);
      return {
        cost_usdc: spent,
        // The kind is what separates this from an index lookup in the sentence the model
        // builds: one answer was bought from a service, this one was bought from a person.
        kind: bought.fact.kind,
        from: bought.reason === "bought" ? `${seller}, who sells ${sold.blob ? "a line they remember" : "something they wrote"}` : bought.reason,
        paid_to: seller,
        answer: learned.note,
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
