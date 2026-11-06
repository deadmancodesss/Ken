import "dotenv/config";
import { createServer } from "node:http";
import { randomBytes } from "node:crypto";
import { readFile } from "node:fs/promises";
import { extname, join } from "node:path";
import { runTurn, modelName, brainState, fallbackNote } from "./brain.js";
import { paymentCap, paymentsEnabled, prepareUsdc, USDC_DECIMALS } from "./wallet.js";
import { spamMarkFor } from "./spam.js";
import { dueReminders, markReminderFired } from "./reminders.js";
import { PAY_CHAIN, PAY_NET, allHoldings, isUsdcCoin, type Holding, type Net, waitForTransaction } from "./chain.js";
import { usdPrices } from "./price.js";
import { bills, commitments, counterparties, dueRows, forgetCounterparties } from "./knowledge.js";
import { peopleRoster, memoryStats, personForAddress, labelPerson, resolvePerson } from "./people.js";
import { runTool } from "./tools.js";
import { keepAddress, keptTurn } from "./address.js";
import { BLOB_ID, createNote, note, notes, titleFor, type Note } from "./notes.js";
import { line as memoryLine, lines as memoryLines, remember, searchMemory } from "./memory.js";
import { held, hold, release, settle, type Pending } from "./pending.js";
import { forgetAudio, synthesize, ttsState } from "./speech.js";
import { type Fact, canonical, noteResourceId, receiptResourceId } from "./resources.js";
import { learn, indexPayout, overCeiling, price, priceCeiling, priceUsdc, purchases, retryStuck, settleSigned, totalSpent } from "./x402.js";
import { salesOf } from "./catalog.js";
import { openEnvelope } from "./x402wire.js";
import { capOwner, chainMismatch, session, useDemoWallet, useNetwork, useWallet } from "./session.js";
import { tally } from "./earn.js";
import { buildStatement, cardSvg } from "./report.js";
import { liveState, startLive, type LiveCall, type LiveEvent } from "./live.js";
import { chatKey, DEFAULT_CHAT_DB, openChats } from "./chats.js";
import { currentSeat, seatId, seatFor, seatsOpen, sweepSeats, within } from "./seat.js";
import { savedSession } from "./seat-store.js";
import { forgetTransfers, monthSpend, recentTransfers } from "./history.js";
import { capMeter, capUsdc, clearCap, setCapBase, usdcToBase } from "./cap.js";
import {
  digestTaken,
  findRequest,
  makeRequest,
  markRequestPaid,
  publicRequest,
  requestExpired,
  requestsBy,
  requestTurn,
} from "./requests.js";

const PORT = Number(process.env.PORT ?? process.env.APP_PORT ?? 8787);
const HOST = process.env.HOST ?? process.env.APP_HOST ?? "0.0.0.0";
const PUBLIC = new URL("../public/", import.meta.url).pathname;

/*
 * The chat store is the one thing that survives a restart, because it is the only
 * thing written on a person's behalf. If the file cannot be opened the server still
 * runs, and says plainly that the conversation will be lost with the process rather
 * than quietly pretending it was saved.
 */
const chats = (() => {
  try {
    return openChats(process.env.CHATS_DB ?? DEFAULT_CHAT_DB);
  } catch (err) {
    console.warn(`chat store unavailable (${(err as Error).message}), so chats live in memory only`);
    return openChats(":memory:");
  }
})();

/*
 * Open phone calls, keyed by the id handed to the browser. Each one records the seat
 * that opened it, so hanging up or pushing a microphone chunk from a second browser
 * cannot reach another person's call. The socket to the model lives here rather than
 * in the page so the key never crosses the network.
 */
const calls = new Map<string, { call: LiveCall; seat: string }>();

const balanceCache = new Map<string, { at: number; body: unknown }>();

/* An open call is a model conversation started under the previous wallet's name,
   and it goes on speaking that person's money until the socket closes. Ending this
   seat's calls is part of letting go rather than a separate favour, and closing
   from this side still reaches the browser, because the socket's own close event is
   what tells the page the call is over. Another visitor's call is left alone. */
function dropDerived() {
  balanceCache.clear();
  forgetAudio();
  const mine = currentSeat()?.id;
  for (const [id, open] of [...calls]) {
    if (mine && open.seat !== mine) continue;
    open.call.stop();
    calls.delete(id);
  }
}

/**
 * A seat is a browser, not an account. The cookie is random and has no relation to a
 * wallet, so it can only ever group one visitor's tabs together. Two different browsers
 * get two different seats even when both are reading the demo story.
 */
function seatFromCookie(req: any): { id: string; fresh: boolean } {
  const hit = String(req.headers.cookie ?? "").match(/(?:^|;\s*)tr_seat=([A-Za-z0-9_-]{10,64})/);
  if (hit) return { id: hit[1], fresh: false };
  return { id: randomBytes(12).toString("base64url"), fresh: true };
}

const TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".svg": "image/svg+xml; charset=utf-8",
  ".png": "image/png",
  ".webp": "image/webp",
};

async function json(res: any, code: number, body: unknown) {
  const text = JSON.stringify(body);
  res.writeHead(code, { "content-type": "application/json; charset=utf-8" });
  res.end(text);
}

/**
 * Everything a link can say about itself before money moves. The body is left out here
 * rather than hidden by whichever page asks, because a paywall that leaks through its
 * own list endpoint is not a paywall.
 */
function offered(n: Note) {
  return {
    id: n.id,
    title: n.title,
    usdc: n.usdc,
    pay_to: n.pay_to,
    created: n.created,
    link: `/ask/${n.id}`,
    // Counted from the receipts rather than from a number stored beside the note, so
    // "opened three times" and "paid for three times" can never be different claims.
    opened: salesOf(`note:${n.id}`).length,
    // Which of the two kinds of wall this is: words written for the link, or a line
    // that was already sitting in somebody's memory before the price existed. The blob
    // id itself stays out of a list that anybody holding the link can read, since the
    // words behind it are encrypted to the store that holds them and an id published
    // here would only invite somebody to go looking.
    from_memory: !!n.blob,
  };
}

function readBody(req: any): Promise<string> {
  const chunks: Buffer[] = [];
  return new Promise((resolve, reject) => {
    req.on("data", (c: Buffer) => {
      chunks.push(c);
      // A browser only sends a sentence. Anything large is someone probing this box.
      if (chunks.reduce((n, b) => n + b.length, 0) > 20_000) reject(new Error("body too large"));
    });
    // Joined as one buffer so a multi-byte character split across chunks survives.
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

/** Microphone bytes rather than text, so the same guard applies at a larger size. */
function readBytes(req: any, limit: number): Promise<Buffer> {
  const chunks: Buffer[] = [];
  return new Promise((resolve, reject) => {
    req.on("data", (c: Buffer) => {
      chunks.push(c);
      if (chunks.reduce((n, b) => n + b.length, 0) > limit) reject(new Error("audio chunk too large"));
    });
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}

/**
 * A limit belongs to one wallet when one is connected and to one browser seat on the
 * demo story, so a visitor trying the demo cannot move the number under the next
 * visitor's meter. The rule lives in session.ts because the chat tool writes the
 * same budget the route below reads.
 */
async function capSnapshot() {
  const s = session();
  const spend = await monthSpend(s.wallet, s.network);
  return {
    ...capMeter(spend.spent, capUsdc(capOwner())),
    month: spend.month,
    spent_text: spend.spent_text,
    transactions: spend.transactions,
    complete: spend.complete,
    wallet: s.wallet,
    network: s.network,
  };
}

/**
 * The chain, not the browser, decides whether a payment happened. Both the ordinary
 * ticket and a request link go through this one check, so a route added later cannot
 * accept a digest on a different standard than the one the product already trusts.
 */
async function usdcProof(digest: string, waiting: Pending, net: Net): Promise<string | null> {
  const proof = await waitForTransaction(digest, net);
  if (!proof) return `no such transaction on ${net}, so nothing was recorded`;
  if (proof.status !== "SUCCESS") return `that transaction ended ${proof.status}, so nothing was recorded`;
  const expected = BigInt(Math.round(waiting.usdc * 10 ** USDC_DECIMALS));
  const isUsdc = isUsdcCoin;
  const left = proof.changes.find(
    (c) => c.amount === -expected && isUsdc(c.coinType) && c.address.toLowerCase() === waiting.sender.toLowerCase(),
  );
  const arrived = proof.changes.find(
    (c) => c.amount === expected && isUsdc(c.coinType) && c.address.toLowerCase() === waiting.to.toLowerCase(),
  );
  if (!left || !arrived) return `that transaction is not ${waiting.usdc} USDC from your wallet to ${waiting.to}`;
  return null;
}

const server = createServer((req, res) => {
  const found = seatFromCookie(req);
  if (found.fresh) {
    res.setHeader("set-cookie", `tr_seat=${found.id}; Path=/; HttpOnly; SameSite=Lax; Max-Age=31536000`);
  }
  const seat = seatFor(found.id, () => savedSession(found.id));
  // The seat travels with the request through every await, so a tool three calls deep
  // still reads the wallet of the browser that asked rather than whichever one spoke
  // last. The catch is here because a rejected promise must still answer the browser.
  within(seat, () => handle(req, res)).catch((err) => {
    if (res.headersSent) return res.end();
    json(res, 500, { error: (err as Error).message });
  });
});

async function handle(req: any, res: any) {
  const url = new URL(req.url!, `http://${req.headers.host}`);

  /*
   * A browser can ask for a thread by id, and an id it does not own resolves to its
   * newest thread instead. The owner comes from this request's wallet or seat, never
   * from the body, so one visitor cannot read or write another visitor's sessions.
   */
  const threadFor = (owner: string, wanted?: unknown) => {
    const made = chats.ensure(owner, typeof wanted === "string" && wanted ? wanted : undefined);
    const at = { id: made.id, key: chats.key(owner, made.id), title: made.title };
    // Tools reached from this request (a payment, a request link, a named address) write
    // their row into the thread the person is actually looking at.
    const seat = currentSeat();
    if (seat) seat.chat = at.key;
    return at;
  };

  /** A ticket written before sessions existed carries the bare owner, so it lands in the current thread. */
  const threadKeyFor = (owner: string, stored?: string) =>
    stored && stored.includes("::") ? stored : threadFor(owner).key;

  const GATED_PREFIXES = [
    "/turn",
    "/sessions",
    "/chats",
    "/live/",
    "/memories",
    "/pending",
    "/transfers",
    "/cap",
    "/requests",
    "/address",
    "/ask",
    "/sellable",
    "/earned",
    "/send",
    "/verify",
    "/speak",
    "/reset",
    "/report.json",
  ];
  const isGatedApi =
    GATED_PREFIXES.some((p) => url.pathname === p || url.pathname.startsWith(p + "/")) &&
    !(req.method === "GET" && (url.pathname === "/ask" || /^\/ask\/[A-Za-z0-9_-]{1,16}$/.test(url.pathname)));

  try {
    if (isGatedApi && session().source !== "wallet") {
      return json(res, 401, {
        error: "Connect your Sui wallet first. Demo mode has been disabled so every action belongs strictly to your connected wallet.",
        needs: "wallet",
      });
    }

    if (req.method === "POST" && url.pathname === "/turn") {
      const { text, session: wanted } = JSON.parse((await readBody(req)) || "{}");
      if (typeof text !== "string" || !text.trim()) return json(res, 400, { error: "text required" });
      const asked = text.trim();
      const owner = chatKey();
      const thread = threadFor(owner, wanted);
      const key = thread.key;
      const past = chats.history(key);
      const turn = await runTurn(asked, past);
      // A demo payment moves coins in the same wallet the page reads, and the balance
      // answer is held for twenty seconds. Without this, the rail refreshed after the
      // turn still prints the number from before the money moved.
      if (turn.steps.some((s) => s.name === "pay_usdc" && s.ok)) {
        balanceCache.clear();
        forgetTransfers();
      }
      // The delta is what this turn added to the model's own history, kept beside the
      // words on screen so a later turn can be given the tool results it needs. Storing
      // the whole history per row would make the file grow quadratically, and storing
      // only the words would let the agent pay twice for one forgotten address.
      chats.append(key, {
        asked,
        said: turn.text,
        steps: turn.steps,
        delta: turn.history.slice(past.length),
        at: Date.now(),
      });
      chats.touch(owner, thread.id, asked);
      return json(res, 200, {
        text: turn.text,
        steps: turn.steps,
        session: thread.id,
        rounds: chats.count(key),
        model: modelName(),
        fallback: fallbackNote(),
      });
    }

    /*
     * Sessions are the list on the left edge of the chat page. A wallet may hold many,
     * voice and text share one, and every response returns the whole list so a create,
     * rename or delete never leaves the sidebar guessing what the store now holds.
     */
    if (req.method === "GET" && url.pathname === "/sessions") {
      const owner = chatKey();
      const thread = threadFor(owner, url.searchParams.get("session"));
      return json(res, 200, {
        key: owner,
        active: thread.id,
        seats: seatsOpen(),
        sessions: chats.sessions(owner),
      });
    }

    if (req.method === "POST" && url.pathname === "/sessions") {
      const { title } = JSON.parse((await readBody(req)) || "{}");
      const owner = chatKey();
      const made = chats.create(owner, typeof title === "string" ? title : undefined);
      return json(res, 200, { session: made, active: made.id, sessions: chats.sessions(owner) });
    }

    if (req.method === "POST" && url.pathname === "/sessions/rename") {
      const { id, title } = JSON.parse((await readBody(req)) || "{}");
      if (typeof id !== "string" || typeof title !== "string") return json(res, 400, { error: "id and title required" });
      const owner = chatKey();
      const renamed = chats.rename(owner, id, title);
      if (!renamed) return json(res, 400, { error: "a chat needs a name" });
      return json(res, 200, { session: renamed, active: id, sessions: chats.sessions(owner) });
    }

    if (req.method === "POST" && url.pathname === "/sessions/delete") {
      const { id } = JSON.parse((await readBody(req)) || "{}");
      if (typeof id !== "string") return json(res, 400, { error: "id required" });
      const owner = chatKey();
      const removed = chats.remove(owner, id);
      const next = chats.ensure(owner);
      return json(res, 200, {
        removed,
        active: next.id,
        sessions: chats.sessions(owner),
      });
    }

    /*
     * The transcript is read back from the store rather than replayed from a global,
     * because a narrow screen closing its tab must not be the moment a conversation
     * ends. Demo turns are keyed by this browser's seat and wallet turns by the address,
     * so the same wallet on a phone reads the same rows as on a laptop.
     */
    if (req.method === "GET" && url.pathname === "/chats") {
      const owner = chatKey();
      const thread = threadFor(owner, url.searchParams.get("session"));
      return json(res, 200, {
        key: owner,
        session: thread.id,
        seats: seatsOpen(),
        turns: chats.turns(thread.key),
      });
    }

    if (req.method === "POST" && url.pathname === "/chats/clear") {
      const body = JSON.parse((await readBody(req)) || "{}");
      const owner = chatKey();
      const thread = threadFor(owner, body.session);
      const cleared = chats.clear(thread.key);
      release();
      return json(res, 200, { cleared, session: thread.id });
    }

    /*
     * A completed live turn arrives here after the call page has already heard both
     * sides. It joins the same thread the typed page reads, with a small delta so a
     * later typed question can build on what was said out loud. The steps are kept for
     * the trace under the message, and nothing from the audio itself is stored.
     */
    if (req.method === "POST" && url.pathname === "/live/turn") {
      const body = JSON.parse((await readBody(req)) || "{}");
      const asked = typeof body.asked === "string" ? body.asked.trim().slice(0, 4000) : "";
      const said = typeof body.said === "string" ? body.said.trim().slice(0, 8000) : "";
      if (!asked && !said) return json(res, 400, { error: "nothing was said" });
      const owner = chatKey();
      const thread = threadFor(owner, body.session);
      const steps = Array.isArray(body.steps)
        ? body.steps
            .filter((s: any) => s && typeof s.name === "string")
            .slice(-20)
            .map((s: any) => ({ name: s.name, ok: !!s.ok, ...(s.error ? { error: String(s.error).slice(0, 300) } : {}), ...(s.result !== undefined ? { result: s.result } : {}) }))
        : [];
      chats.append(thread.key, {
        asked,
        said,
        steps,
        delta: [
          ...(asked ? [{ role: "user", content: asked }] : []),
          ...(said ? [{ role: "assistant", content: said }] : []),
        ],
        at: Date.now(),
      });
      chats.touch(owner, thread.id, asked);
      const after = chats.ensure(owner, thread.id);
      return json(res, 200, { saved: true, session: thread.id, title: after.title, turns: after.turns });
    }

    if (req.method === "POST" && url.pathname === "/wallet") {
      const { address, chain, demo } = JSON.parse((await readBody(req)) || "{}");
      /*
       * Whoever this page speaks for can change, and everything derived from the previous
       * wallet has to change with it. The balance read is cached under the address, the
       * audio cache holds sentences spoken about their people, and this seat's open calls
       * talk about the old wallet until they close, so a switch that left any of those
       * behind would go on answering from a wallet the reader believes they have already
       * let go of. The conversation is not dropped any more: it is stored under the wallet
       * it belongs to, and this seat reads the other one back from its own key.
       */
      const next = demo ? useDemoWallet() : useWallet(String(address), chain ? String(chain) : undefined);
      dropDerived();
      return json(res, 200, next);
    }

    /*
     * The same clearing, for a smaller change. Which ledger is being read is decided by
     * one field, but every answer above it was drawn from the other one, so a reader who
     * moves from testnet to Mainnet is answered from Mainnet from the next sentence, not
     * from a cached testnet balance and a model that still remembers yesterday's numbers.
     */
    if (req.method === "POST" && url.pathname === "/network") {
      const { network } = JSON.parse((await readBody(req)) || "{}");
      try {
        const next = useNetwork(String(network));
        dropDerived();
        return json(res, 200, next);
      } catch (err) {
        return json(res, 400, { error: (err as Error).message });
      }
    }

    // Kept apart from /state because a masthead on every page must not wait on a
    // chain read, and cached because Tatum answers three requests a second.
    if (url.pathname === "/balance") {
      const s = session();
      if (s.source !== "wallet") {
        return json(res, 200, {
          holdings: [],
          network: s.network,
          address: "",
          source: "none",
          price_source: "",
        });
      }
      const key = `${s.wallet}:${s.network}`;
      const hit = balanceCache.get(key);
      if (hit && hit.at + 20_000 > Date.now()) return json(res, 200, hit.body);
      /* The chain is asked which coins exist here rather than being handed the two we
         thought of, and the dollar figure comes from a price feed in the same breath,
         because a wallet screen that lists 3 SUI next to a wallet popup saying $2.82 asks
         the reader to do arithmetic on a number we are the only ones able to check. */
      const [coins, usd] = await Promise.all([allHoldings(s.wallet, s.network), usdPrices()]);
      const priced: (Holding & { usd?: number; unit?: number })[] = coins.map((h) => {
        const unit = usd[h.symbol.toUpperCase()];
        return unit ? { ...h, usd: Math.round(h.amount * unit * 100) / 100, unit } : h;
      });
      const body = {
        holdings: priced,
        network: s.network,
        // Which account this answer is about, printed beside the amount so a wallet
        // showing another account's USDC cannot look like the same balance.
        address: s.wallet,
        source: s.source,
        price_source: priced.some((h) => h.usd !== undefined) ? "CoinGecko" : "",
      };
      balanceCache.set(key, { at: Date.now(), body });
      return json(res, 200, body);
    }

    if (url.pathname === "/state") {
      const s = session();
      if (s.source !== "wallet") {
        return json(res, 200, {
          roster: [],
          parties: [],
          due: { rows: [], committed: [] },
          stats: { total: 0, namespaces: [] },
          session: { wallet: "", network: s.network, source: "none", reported: "" },
          payments: paymentsEnabled(),
          pay_network: PAY_NET,
          spend: {
            usdc: 0,
            lookups: 0,
            price: priceUsdc(),
          },
          model: modelName(),
          brain: brainState(),
          tts: ttsState(),
          live: liveState(),
        });
      }
      // The roster is held for the whole session so a warm question never pays
      // Tatum for it, which means the page needs one explicit way to re-read.
      if (url.searchParams.get("refresh")) forgetCounterparties();
      const [roster, parties, stats] = await Promise.all([
        peopleRoster(),
        counterparties(s.wallet, s.network),
        memoryStats(),
      ]);
      const owed = bills(dueRows(parties), [indexPayout()]);
      return json(res, 200, {
        roster,
        parties,
        // Measured from the same read, so the rhythm on the page and the rhythm the
        // agent speaks are the same arithmetic and can never disagree out loud. The
        // monthly total is added here for the same reason: a page that did its own
        // sums would be a second sum to get wrong.
        due: { rows: owed, committed: commitments(owed) },
        stats,
        session: s,
        payments: paymentsEnabled(),
        pay_network: PAY_NET,
        spend: {
          usdc: totalSpent(s.wallet),
          lookups: purchases(s.wallet).length,
          price: priceUsdc(),
        },
        model: modelName(),
        brain: brainState(),
        tts: ttsState(),
        live: liveState(),
      });
    }

    if (url.pathname === "/memories") {
      const q = (url.searchParams.get("q") ?? "").trim();
      const [roster, hits] = await Promise.all([
        peopleRoster(),
        searchMemory(q || "who I pay and what they are to me", 24),
      ]);
      return json(res, 200, { query: q, roster, hits });
    }

    if (url.pathname === "/pending") {
      return json(res, 200, { pending: held() });
    }

    if (req.method === "POST" && url.pathname === "/pending/cancel") {
      release();
      return json(res, 200, { cancelled: true });
    }

    if (req.method === "POST" && url.pathname === "/pending/settle") {
      const body = JSON.parse((await readBody(req)) || "{}");
      const waiting = held();
      if (!waiting) return json(res, 409, { error: "nothing is waiting for a signature" });

      /*
       * A ticket that buys a fact is settled by handing the seller the bytes this wallet
       * signed, never by executing the transfer here. The seller's facilitator broadcasts
       * the exact bytes after checking them against the published terms, which is the
       * whole point of the exact scheme: the money moves for the thing that was agreed.
       */
      if (waiting.resource) {
        const bytes = String(body.bytes ?? "");
        const signature = String(body.signature ?? "");
        if (!bytes || !signature) {
          return json(res, 400, {
            error: "this ticket buys a fact. Sign the prepared transfer in the wallet and send the signed bytes and signature. A digest means the transfer was executed before the terms were settled, which the index cannot accept",
          });
        }
        try {
          const released = await settleSigned(waiting.resource, waiting.sender, bytes, signature);
          if ("error" in released) return json(res, 402, { error: released.error, pending: waiting });          const learned = await learn(waiting.resource, released.fact, released.usdc, released.tx, released.on);
          const done = settle(released.tx);
          balanceCache.clear();
          forgetCounterparties();
          forgetTransfers();
          if (done) {
            const tool = waiting.resource.startsWith("receipt:") ? "verify_payment" : "paid_lookup";
            const line = `${released.usdc} USDC was signed in the wallet and settled on chain for an answer from the paid index.`;
            chats.append(threadKeyFor(chatKey(), waiting.chat), {
              asked: "signed the payment for a paid lookup",
              said: line,
              steps: [{ name: tool, ok: true, result: { digest: released.tx, resource: waiting.resource, usdc: released.usdc } }],
              delta: [{ role: "user", content: `I signed the payment for the paid lookup in my wallet. ${line} Do not pay for this lookup again.` }],
              at: Date.now(),
            });
          }
          return json(res, 200, { pending: done, learned, fact: released.fact, tx: released.tx, usdc: released.usdc });
        } catch (err) {
          return json(res, 400, { error: `that signature could not be read as a Sui payment: ${(err as Error).message}` });
        }
      }

      const { digest } = body;
      if (typeof digest !== "string" || !digest) return json(res, 400, { error: "digest required" });

      // The digest arrives from a browser, so the chain decides whether it is a
      // payment at all. Nothing is written to memory on a claim alone.
      const bad = await usdcProof(digest, waiting, session().network);
      if (bad) return json(res, 400, { error: bad });

      const done = settle(digest);
      // Writing the memory only after a real digest keeps the record honest about
      // payments that were prepared and then refused in the wallet.
      if (done) {
        await remember(
          `Paid ${done.usdc} USDC to ${done.to}${done.name ? ` (${done.name})` : ""} on ${new Date().toISOString().slice(0, 10)}. tx ${done.digest}`,
        );
        forgetCounterparties();
      }
      if (done) {
        // The signature changed this wallet's coins, so the next page to ask must not be
        // handed a balance read from before the transfer.
        balanceCache.clear();
        forgetTransfers();
        // A signature happens between turns, so without a row here the next sentence from
        // the model would still describe this payment as waiting. The row is also the
        // receipt a person reads back: the digest rides in the step, which the transcript
        // turns into an explorer link instead of a string nobody can check by eye.
        const who = done.name ?? `${done.to.slice(0, 6)}…${done.to.slice(-4)}`;
        const line = `${done.usdc} USDC to ${who} was signed in the wallet and settled on chain.`;
        chats.append(threadKeyFor(chatKey(), waiting.chat), {
          asked: `signed the payment to ${who}`,
          said: line,
          steps: [{ name: "pay_usdc", ok: true, result: { digest, to: done.to, usdc: done.usdc } }],
          delta: [{ role: "user", content: `I signed the payment to ${who} in my wallet. ${line} Do not call pay_usdc again for this payment.` }],
          at: Date.now(),
        });
      }
      return json(res, 200, { pending: done });
    }

    /*
     * The ledger under the statement card. It reads one page of the same history the
     * card is built from, so the rows carry the same digests and cannot describe a
     * different month than the headline above them.
     */
    if (url.pathname === "/transfers") {
      if (url.searchParams.get("refresh")) forgetTransfers();
      const s = session();
      const body = await recentTransfers(s.wallet, s.network, 14);
      return json(res, 200, { ...body, wallet: s.wallet, network: s.network });
    }

    /*
     * A budget the person writes for their own wallet. It never blocks a payment,
     * because a limit that silently refuses money is a worse surprise than a red
     * month, and the balance is the only authority on what can be spent.
     */
    if (url.pathname === "/cap") {
      if (req.method === "GET" && url.searchParams.get("refresh")) forgetTransfers();
      if (req.method === "POST") {
        const { monthly } = JSON.parse((await readBody(req)) || "{}");
        const n = monthly === null || monthly === undefined || monthly === "" ? 0 : Number(monthly);
        if (!Number.isFinite(n) || n < 0) {
          return json(res, 400, { error: "a monthly limit has to be a number of USDC, or zero to clear it" });
        }
        if (n > 100_000) return json(res, 400, { error: "a monthly limit above 100,000 USDC is not a budget this page can draw" });
        if (n === 0) clearCap(capOwner());
        else setCapBase(capOwner(), usdcToBase(n));
        return json(res, 200, await capSnapshot());
      }
      return json(res, 200, await capSnapshot());
    }

    const requestPath = url.pathname.match(/^\/requests\/([A-Za-z0-9_-]{6,16})(\/prepare|\/settle)?$/);

    /*
     * A request points at the wallet that is connected, never at a typed address.
     * That is the same rule the agent's payment ticket follows, and it matters more
     * here because the link outlives the page: a typo would send a stranger's money
     * somewhere nobody can fix it from.
     */
    if (req.method === "POST" && url.pathname === "/requests") {
      const s = session();
      if (s.source !== "wallet") {
        return json(res, 400, { error: "connect your wallet first. A request has to point at an address you can spend from" });
      }
      if (s.network !== PAY_NET) {
        return json(res, 400, { error: `request links are paid on ${PAY_CHAIN}, and this page is reading ${s.network}. Move the network switch to ${PAY_NET} first` });
      }
      const input = JSON.parse((await readBody(req)) || "{}");
      const usdc = Number(input.usdc);
      if (!Number.isFinite(usdc) || usdc <= 0) return json(res, 400, { error: "a request needs an amount above zero" });
      if (usdc > paymentCap()) {
        return json(res, 400, { error: `the ceiling on one signature is ${paymentCap()} USDC, so a request above that could never be paid here` });
      }
      try {
        const made = makeRequest({
          to: s.wallet,
          note: typeof input.note === "string" ? input.note : "",
          usdc,
          owner: capOwner(),
          minutes: Number(input.minutes),
        });
        const view = publicRequest(made);
        // A request made from the chat form happened outside the model's turn, so it is
        // written into the conversation it belongs to. The request page and the call
        // form do not pass this flag, because they are not part of a chat.
        if (input.from === "chat") {
          const owner = chatKey();
          chats.append(threadFor(owner, input.session).key, { ...requestTurn(made), at: Date.now() });
        }
        return json(res, 200, { request: view });
      } catch (err) {
        return json(res, 400, { error: (err as Error).message });
      }
    }

    if (req.method === "GET" && url.pathname === "/requests") {
      return json(res, 200, { requests: requestsBy(capOwner()).map((r) => publicRequest(r)), network: session().network });
    }

    if (req.method === "GET" && requestPath && !requestPath[2]) {
      /* A link is opened by a person, not by a browser. Without a wallet there is no
         identity to show the request to, and the page would only be a price with no
         way to agree to it. The refusal is explicit so the page can offer Connect. */
      const s = session();
      if (s.source !== "wallet") {
        return json(res, 401, {
          error: "connect a wallet to open this link. The request is addressed to whoever opens it, and this page has to know who that is",
          needs: "wallet",
        });
      }
      const found = findRequest(requestPath[1]);
      if (!found) return json(res, 404, { error: "that request does not exist. Check the link, it may have been typed short" });
      return json(res, 200, { request: publicRequest(found, { wallet: s.wallet }) });
    }

    if (req.method === "POST" && requestPath?.[2] === "/prepare") {
      const found = findRequest(requestPath[1]);
      if (!found) return json(res, 404, { error: "that request does not exist" });
      if (found.paid_tx) return json(res, 409, { error: "this request has already been paid", request: publicRequest(found) });
      if (requestExpired(found)) {
        return json(res, 409, {
          error: "this link expired before it was paid, so it can no longer take money. Ask the person who sent it for a fresh one",
          request: publicRequest(found),
        });
      }
      const s = session();
      if (s.source !== "wallet") {
        return json(res, 400, { error: "connect a wallet first. A request is paid by the person opening it, from their own account" });
      }
      if (s.network !== PAY_NET) {
        return json(res, 400, { error: `this request is a ${PAY_CHAIN} payment, and this page is reading ${s.network}. Move the network switch to ${PAY_NET} first` });
      }
      if (found.to.toLowerCase() === s.wallet.toLowerCase()) {
        return json(res, 400, { error: "this request points at the wallet you have connected, so there is nothing here to pay" });
      }
      const crossed = chainMismatch();
      if (crossed) return json(res, 400, { error: crossed });
      try {
        const p = await prepareUsdc(s.wallet, found.to, found.usdc);
        return json(res, 200, {
          pending: hold({ sender: p.sender, to: p.to, name: null, usdc: p.usdc, bytes: p.bytes, chain: p.chain, request: found.id }),
          request: publicRequest(found),
        });
      } catch (err) {
        return json(res, 400, { error: (err as Error).message });
      }
    }

    if (req.method === "POST" && requestPath?.[2] === "/settle") {
      const found = findRequest(requestPath[1]);
      if (!found) return json(res, 404, { error: "that request does not exist" });
      if (found.paid_tx) return json(res, 200, { request: publicRequest(found), already: true });
      const { digest } = JSON.parse((await readBody(req)) || "{}");
      if (typeof digest !== "string" || !digest) return json(res, 400, { error: "digest required" });
      const s = session();
      if (s.source !== "wallet") return json(res, 400, { error: "connect a wallet first" });
      const waiting = held();
      if (!waiting || waiting.request !== found.id) {
        return json(res, 409, { error: "nothing is waiting for this request in this browser. Press pay again" });
      }
      const bad = await usdcProof(digest, waiting, s.network);
      if (bad) return json(res, 400, { error: bad });
      if (digestTaken(digest, found.id)) {
        return json(res, 409, { error: "that transaction already settled a different request, so this one is still open" });
      }
      settle(digest);
      const paid = markRequestPaid(found.id, digest, waiting.sender) ?? found;
      await remember(
        `Paid ${found.usdc_text} USDC to ${found.to}${found.note ? ` for "${found.note}"` : ""} on ${new Date().toISOString().slice(0, 10)}. tx ${digest}`,
      );
      forgetCounterparties();
      forgetTransfers();
      balanceCache.clear();
      return json(res, 200, { request: publicRequest(paid) });
    }

    /*
     * The one field a microphone cannot fill. A name and an amount can be spoken, a
     * 64 character address cannot, so the page collects it and this route does the two
     * things the sentence was already asking for: keep the name and, when an amount
     * travelled with it, prepare the payment. The browser never gets to choose either
     * the label or the address resolution, which is what stops a mistyped name from
     * silently paying the person who used to own it.
     */
    if (req.method === "POST" && url.pathname === "/address") {
      const input = JSON.parse((await readBody(req)) || "{}");
      try {
        const kept = await keepAddress(input, {
          byName: (name) => resolvePerson(name),
          byAddress: (address) => personForAddress(address),
          label: (name, address) => labelPerson(name, address),
          pay: async (to, usdc) => {
            const result = await runTool("pay_usdc", { to, amount: usdc });
            // A settled demo payment changed the coins this wallet holds, and the page
            // asks for the balance the moment this answer lands.
            if (!(result as { awaiting_signature?: boolean })?.awaiting_signature) {
              balanceCache.clear();
              forgetTransfers();
            }
            return result;
          },
        });
        const row = keptTurn(kept);
        chats.append(threadFor(chatKey(), input.session).key, { ...row, at: Date.now() });
        forgetCounterparties();
        return json(res, 200, {
          named: kept.person,
          payment: kept.payment,
          payment_error: kept.payment_error || undefined,
          note: row.said,
        });
      } catch (err) {
        return json(res, 400, { error: (err as Error).message });
      }
    }

    /*
     * The paid index itself lives in its own process on SELLER_PORT, because a wall the
     * buyer can call as a local function is not a wall. The app only ever sees it as an
     * HTTP counterparty: it asks for a price here and settles a signed envelope there.
     */

    /*
     * The other side of the same protocol. Everything above this block was the index
     * writing what sat behind its wall and setting its own price, and these routes hand
     * both of those to a person: their words or the lines they already keep, their
     * price, their payout wallet. The judgement path was not touched to get here, which
     * is the only honest reason to build this over 402 instead of bolting a pay button
     * onto a form.
     */
    /*
     * The stateless half of the same settlement, for a link opened by a visitor who is
     * not the session wallet. The page signs, this route hands the seller the signed
     * bytes, and no seat state is involved. The journal is still written first, so a
     * lost answer is retried with the same signature instead of a second transfer.
     */
    if (req.method === "POST" && url.pathname === "/x402/settle") {
      const { resource, payer, bytes, signature } = JSON.parse((await readBody(req)) || "{}");
      let canon: string;
      try {
        canon = canonical(String(resource ?? ""));
      } catch (err) {
        return json(res, 400, { error: (err as Error).message });
      }
      const who = String(payer ?? "");
      if (!/^0x[0-9a-fA-F]{64}$/.test(who)) return json(res, 400, { error: "payer must be a full 0x Sui address" });
      if (typeof bytes !== "string" || !bytes || typeof signature !== "string" || !signature) {
        return json(res, 400, { error: "bytes and signature required" });
      }
      const released = await settleSigned(canon, who, bytes, signature);
      if ("error" in released) return json(res, 402, { error: released.error });
      return json(res, 200, { fact: released.fact, charged: released.usdc, tx: released.tx, reason: released.reason });
    }

    if (req.method === "POST" && url.pathname === "/ask") {
      const input = JSON.parse((await readBody(req)) || "{}");
      try {
        const made = createNote({
          title: input.title,
          body: input.body,
          usdc: input.usdc,
          payTo: input.pay_to ?? session().wallet,
        });
        return json(res, 200, { note: made, link: `/ask/${made.id}` });
      } catch (err) {
        return json(res, 400, { error: (err as Error).message });
      }
    }

    if (url.pathname === "/sellable") {
      // The store is the list. A page that held its own copy of what somebody remembers
      // would be selling sentences the memory may not even contain, so every row here is
      // read back out of Walrus at the moment the page asks.
      const priced = new Map(notes().filter((n) => n.blob).map((n) => [n.blob as string, n.id]));
      const rows = (await memoryLines()).map((l) => ({
        blob: l.blobId,
        namespace: l.namespace.split("-")[0],
        characters: l.text.length,
        // These words are the seller's own, read back to them rather than handed to a
        // stranger. A wall goes up around what somebody else asks to read.
        text: l.text,
        title: titleFor(l.text),
        link: priced.has(l.blobId) ? `/ask/${priced.get(l.blobId)}` : null,
      }));
      return json(res, 200, { lines: rows });
    }

    if (req.method === "POST" && url.pathname === "/ask/from-memory") {
      const input = JSON.parse((await readBody(req)) || "{}");
      const blob = String(input.blob ?? "").trim();
      try {
        if (!BLOB_ID.test(blob)) throw new Error(`${blob || "that"} is not a Walrus blob id`);
        // The body is resolved from the store rather than taken from the request, so a
        // link cannot be made to claim it holds a memory while really selling words
        // somebody typed into the same call.
        const found = await memoryLine(blob);
        if (!found) throw new Error(`nothing in this wallet's memory is stored under ${blob}`);
        const made = createNote({
          title: titleFor(found.text),
          body: found.text,
          usdc: input.usdc,
          payTo: input.pay_to ?? session().wallet,
          blob: found.blobId,
        });
        return json(res, 200, { note: made, link: `/ask/${made.id}` });
      } catch (err) {
        return json(res, 400, { error: (err as Error).message });
      }
    }

    if (url.pathname === "/notes") {
      // Metadata only. A list that carried the bodies would give the words away for
      // nothing, including to the very page that prints the links.
      const id = url.searchParams.get("id");
      if (id) {
        const one = note(id);
        if (!one) return json(res, 404, { error: `no link ${id} is open here` });
        return json(res, 200, { note: offered(one) });
      }
      return json(res, 200, { notes: notes().map(offered) });
    }

    if (url.pathname === "/earned") {
      /*
       * The receipts are the only numbers here, for the same reason the "opened" count
       * uses them: a figure written beside the link would be a second record of one
       * payment, and two records of one payment is how a receipt gets invented. Every
       * judgement that reaches this list already checked on chain that the money landed
       * at this link's payout address, so a row here is settled money rather than money
       * promised. The arithmetic itself is in earn.ts so it can be tested one fake
       * transfer at a time instead of by moving real USDC.
       */
      const all = notes();
      const paid = new Map<string, string>();
      for (const n of all) {
        for (const s of salesOf(`note:${n.id}`)) {
          const key = s.payer.toLowerCase();
          if (paid.has(key)) continue;
          // Named where this wallet already knows the buyer, because a stranger's address
          // in a list of who paid you is the same unreadable line the whole product exists
          // to get rid of.
          paid.set(key, (await personForAddress(s.payer))?.alias ?? `${s.payer.slice(0, 10)}…`);
        }
      }
      const s = session();
      return json(res, 200, tally(all, salesOf, s.wallet, (a) => paid.get(a.toLowerCase()) ?? `${a.slice(0, 10)}…`));
    }

    if (req.method === "POST" && url.pathname === "/ask/sign") {
      const { id, payer } = JSON.parse((await readBody(req)) || "{}");
      let resource: string;
      try {
        resource = noteResourceId(String(id));
      } catch (err) {
        return json(res, 400, { error: (err as Error).message });
      }

      // A signature from an earlier ask that never got its answer is retried before a
      // new transfer is built, so a lost response cannot become a second payment.
      const retried = await retryStuck(resource, String(payer ?? ""));
      if (retried) {
        if ("error" in retried) return json(res, 502, { error: retried.error });
        return json(res, 200, { opened: true, fact: retried.fact, reason: retried.reason, tx: retried.tx, charged: retried.usdc });
      }

      // The seller publishes the terms and this route only turns them into something a
      // wallet can sign. A link this address already opened comes back without a ticket.
      const quoted = await price(resource, String(payer ?? ""));
      if ("error" in quoted) return json(res, 400, { error: quoted.error });
      if ("free" in quoted) return json(res, 200, { opened: true, fact: quoted.fact, reason: quoted.reason, tx: quoted.tx });

      const refused = overCeiling(quoted.usdc);
      if (refused) return json(res, 200, { refused: true, price_usdc: quoted.usdc, ceiling_usdc: priceCeiling(), saying: refused });

      try {
        const prepared = await prepareUsdc(String(payer), quoted.requirements.payTo, quoted.usdc);
        return json(res, 200, { requirements: quoted.requirements, price_usdc: quoted.usdc, prepared });
      } catch (err) {
        // A wallet with nothing in it is the buyer's problem to solve, not a reason to
        // pretend the link is broken, so the terms come back with the plain words.
        return json(res, 400, { error: (err as Error).message, requirements: quoted.requirements });
      }
    }

    if (req.method === "POST" && url.pathname === "/send") {
      // The same ticket the voice agent fills, reached without a model. A person
      // typing an amount is no more allowed to skip their own signature than a
      // sentence is, so this prepares and holds and never sends.
      const { to, usdc, confirm_spam } = JSON.parse((await readBody(req)) || "{}");
      const s = session();
      if (s.source !== "wallet") {
        return json(res, 400, { error: "connect a wallet first. The demo story has no key in this browser, so there is nothing to sign" });
      }
      if (s.network !== PAY_NET) {
        return json(res, 400, { error: `this prepares ${PAY_CHAIN} transfers, and this page is reading ${s.network}. Move the network switch to ${PAY_NET} first` });
      }
      const crossed = chainMismatch();
      if (crossed) return json(res, 400, { error: crossed });

      const typed = String(to ?? "").trim();
      let address = typed;
      let name: string | null = null;
      if (!/^0x[0-9a-fA-F]{64}$/.test(address)) {
        // Exact match, on purpose. A wrong guess in an answer is a shrug; a wrong
        // guess in a payout is money that never comes back.
        const person = (await peopleRoster()).find((p) => p.alias.toLowerCase() === address.toLowerCase());
        if (!person) return json(res, 400, { error: `nothing is remembered under "${address}". Pick a name you have already taught or paste the full 0x address` });
        address = person.address;
        name = person.alias;
      }

      const amount = Number(usdc);
      if (!Number.isFinite(amount) || amount <= 0) return json(res, 400, { error: "the amount has to be a number of USDC above zero" });
      if (amount > paymentCap()) return json(res, 400, { error: `the ceiling on one signature is ${paymentCap()} USDC. Raise PAY_MAX_BASE_UNITS in .env if you mean it` });

      // The mark stops the bytes before they exist. Sending a warning after a signed
      // transfer would be a receipt, not a warning.
      const mark = spamMarkFor(address);
      if (mark && confirm_spam !== true) {
        return json(res, 409, {
          marked_spam: true,
          name: mark.name,
          reason: mark.reason,
          error: `${mark.name ?? "that address"} is marked spam${mark.reason ? `: ${mark.reason}` : ""}. Nothing was built. Confirm to send anyway.`,
        });
      }

      try {
        const p = await prepareUsdc(s.wallet, address, amount);
        return json(res, 200, { pending: hold({ sender: p.sender, to: p.to, name, usdc: p.usdc, bytes: p.bytes, chain: p.chain }) });
      } catch (err) {
        return json(res, 400, { error: (err as Error).message });
      }
    }

    if (req.method === "POST" && url.pathname === "/verify") {
      // The other thing this index sells, reached without a model: somebody claims they
      // paid and hands over a digest, and the answer can only come from reading that
      // transaction back. The cent goes to the index because the index is the one that
      // pays a provider for the read.
      const { digest } = JSON.parse((await readBody(req)) || "{}");
      const s = session();
      if (s.source !== "wallet") {
        return json(res, 400, { error: "connect a wallet first. On the demo story the agent pays for this itself, on the Talk page" });
      }
      if (s.network !== PAY_NET) {
        return json(res, 400, { error: `this index only sells ${PAY_CHAIN} reads, and this page is reading ${s.network}. Move the network switch to ${PAY_NET} first` });
      }
      const crossed = chainMismatch();
      if (crossed) return json(res, 400, { error: crossed });

      let resource: string;
      try {
        resource = receiptResourceId(String(digest ?? "").trim());
      } catch (err) {
        return json(res, 400, { error: (err as Error).message });
      }

      // The index sets the terms and this route only turns them into something a wallet
      // can sign, so a digest already settled is answered here without a ticket at all.
      const quoted = await price(resource, s.wallet);
      if ("error" in quoted) return json(res, 400, { error: quoted.error });
      if ("free" in quoted) {
        return json(res, 200, { answered: quoted.fact, charged: 0, reason: quoted.reason, tx: quoted.tx });
      }

      const refused = overCeiling(quoted.usdc);
      if (refused) return json(res, 200, { refused: true, price_usdc: quoted.usdc, ceiling_usdc: priceCeiling(), saying: refused });

      // A signed envelope from an earlier ask that never got its answer is retried
      // before anything new is prepared, so a lost response cannot cost a second payment.
      const retried = await retryStuck(resource, s.wallet);
      if (retried) {
        if ("error" in retried) return json(res, 502, { error: retried.error });
        const learned = await learn(resource, retried.fact, retried.usdc, retried.tx, retried.on);
        forgetCounterparties();
        forgetTransfers();
        balanceCache.clear();
        return json(res, 200, { answered: retried.fact, charged: retried.usdc, reason: retried.reason, tx: retried.tx, learned });
      }

      try {
        const p = await prepareUsdc(s.wallet, quoted.requirements.payTo, quoted.usdc);
        return json(res, 200, {
          pending: hold({
            sender: p.sender,
            to: p.to,
            name: "Paid chain index",
            usdc: p.usdc,
            bytes: p.bytes,
            chain: p.chain,
            resource,
            requirements: quoted.requirements,
          }),
          requirements: quoted.requirements,
        });
      } catch (err) {
        return json(res, 400, { error: (err as Error).message });
      }
    }

    if (req.method === "POST" && url.pathname === "/speak") {
      // Audio is bytes rather than JSON so the page can decode it straight into a
      // buffer and drive the ribbon from the sound itself.
      const { text, voice } = JSON.parse((await readBody(req)) || "{}");
      if (typeof text !== "string" || !text.trim()) return json(res, 400, { error: "text required" });
      if (!ttsState().enabled) return json(res, 503, { error: "no model voice key, so this browser speaks" });
      try {
        const said = await synthesize(text, typeof voice === "string" ? voice : undefined);
        // The page names whichever vendor actually answered rather than the one it
        // asked for, because the two differ the moment a quota runs out.
        res.writeHead(200, {
          "content-type": "audio/wav",
          "content-length": said.bytes.length,
          "cache-control": "no-store",
          "x-voice": said.voice.id,
          "x-voice-ms": String(said.ms),
        });
        return res.end(said.bytes);
      } catch (err) {
        return json(res, 503, { error: (err as Error).message });
      }
    }

    if (req.method === "POST" && url.pathname === "/reset") {
      const body = JSON.parse((await readBody(req)) || "{}");
      const thread = threadFor(chatKey(), body.session);
      chats.clear(thread.key);
      release();
      return json(res, 200, { reset: true, session: thread.id });
    }

    // A call is one event stream out and a stream of small posts in, because this
    // server has no WebSocket library and a demo does not need one for two-way audio.
    if (url.pathname === "/live/stream") {
      // The call was opened from a chat, and any ticket it builds during the call
      // belongs to that same chat rather than to whatever thread is newest later.
      threadFor(chatKey(), url.searchParams.get("session"));
      res.writeHead(200, {
        "content-type": "text/event-stream; charset=utf-8",
        "cache-control": "no-store",
        connection: "keep-alive",
      });
      /*
       * Anything still holding this function after the caller closed the tab writes to a
       * dead response. Node raises that as an error on a stream with no listener, which
       * takes the process down and every other page with it, so the write is dropped
       * instead. The call itself is stopped by the close listener below.
       */
      let closed = false;
      const push = (e: LiveEvent) => {
        if (closed || res.writableEnded || res.destroyed) return;
        res.write(`data: ${JSON.stringify(e)}\n\n`);
      };
      /*
       * The abort listener is registered before the socket is opened rather than after it.
       * Hanging up during a slow handshake used to leave a Gemini call running with nothing
       * attached to it, because the only code that would stop it had not been installed yet,
       * and the sole thing that ever closed that orphan was its own ninety second idle
       * timer. A person who already pressed hang up should not be billed for ninety seconds
       * of a model they stopped asking for.
       */
      let call: LiveCall | null = null;
      let beat: ReturnType<typeof setInterval> | null = null;
      res.on("close", () => {
        closed = true;
        if (beat) clearInterval(beat);
        if (call) {
          calls.delete(call.id);
          call.stop();
        }
      });
      const opened = await startLive(push, url.searchParams.get("voice") || undefined).catch((err) => {
        push({ kind: "error", message: (err as Error).message });
        // A stream that ends without saying close is reopened by the browser, and every
        // reopening asks Google for a whole new call. The page has to be told this one is
        // over, not only that it went wrong.
        push({ kind: "close", reason: "the live socket could not open" });
        res.end();
        return null;
      });
      if (!opened) return;
      call = opened;
      if (closed) {
        opened.stop();
        return res.end();
      }
      /*
       * A browser that reopens the event stream, or a second tab in the same seat,
       * used to leave the previous socket alive for its whole idle window. Two live
       * calls on one wallet can answer the same room in two voices, so the newest
       * call owns the seat and the older one is stopped before it speaks again.
       */
      const mine = seatId();
      for (const [otherId, other] of calls) {
        if (other.seat === mine && otherId !== opened.id) {
          console.log(`live ${otherId} stopped: seat ${mine.slice(0, 8)} opened ${opened.id}`);
          other.call.stop();
          calls.delete(otherId);
        }
      }
      calls.set(opened.id, { call: opened, seat: mine });
      console.log(
        `live ${opened.id} open for seat ${mine.slice(0, 8)} · ${opened.model} · voice ${opened.voice}`
      );
      // Proxies and idle timers drop a quiet stream, so something has to keep moving
      // even when nobody is talking.
      beat = setInterval(() => {
        if (closed || res.writableEnded || res.destroyed) return;
        res.write(": keep-alive\n\n");
      }, 15_000);
      return;
    }

    if (req.method === "POST" && url.pathname === "/live/mic") {
      const open = calls.get(url.searchParams.get("id") ?? "");
      if (!open || open.seat !== seatId()) {
        return json(res, 404, { error: "that call is not open in this browser, so hang up and start again" });
      }
      const pcm = await readBytes(req, 64_000);
      if (!pcm.length) return json(res, 400, { error: "no audio in that chunk" });
      open.call.send(pcm);
      return json(res, 200, { heard: true });
    }

    /*
     * A typed address cannot go through the microphone path, because that path is what
     * turns a room into text. The page hands this route the sentence instead, without a
     * hex string in it, and the live model is told what happened so it stops asking for
     * an address it already has. The 400 character ceiling is there because this is a
     * note about one thing, not a second chat window.
     */
    if (req.method === "POST" && url.pathname === "/live/text") {
      const open = calls.get(url.searchParams.get("id") ?? "");
      if (!open || open.seat !== seatId()) {
        return json(res, 404, { error: "that call is not open in this browser, so there is nothing to tell it" });
      }
      const { text } = JSON.parse((await readBody(req)) || "{}");
      const note = String(text ?? "").trim();
      if (!note) return json(res, 400, { error: "text required" });
      if (note.length > 400) return json(res, 400, { error: "that note is too long" });
      open.call.say(note);
      return json(res, 200, { told: true });
    }

    if (req.method === "POST" && url.pathname === "/live/hangup") {
      const open = calls.get(url.searchParams.get("id") ?? "");
      const mine = open && open.seat === seatId();
      if (open && mine) {
        open.call.stop();
        calls.delete(open.call.id);
      }
      return json(res, 200, { hungUp: !!mine });
    }

    // The same statement in three shapes: numbers to print, vector to share, page to look at.
    if (url.pathname === "/report.json") {
      return json(res, 200, await buildStatement());
    }

    if (url.pathname === "/report.svg") {
      if (session().source !== "wallet") {
        const preview = cardSvg({
          wallet: "0x0000000000000000000000000000000000000000000000000000000000000000",
          network: PAY_NET,
          isDemo: false,
          period: "Connect wallet for live statement",
          headline: "0.00 USDC",
          direction: "none",
          totalOut: "0.00 USDC",
          otherAssets: "",
          asset: "USDC",
          totalIn: "0.00 USDC",
          inAsset: "USDC",
          inOtherAssets: "",
          sendCount: 0,
          senders: [],
          months: [
            { month: "2026-09", amount: 0, label: "Sep" },
            { month: "2026-10", amount: 0, label: "Oct" },
            { month: "2026-11", amount: 0, label: "Nov" },
          ],
          people: [],
          overdue: 0,
          dueNow: 0,
          remembered: 0,
          bought: 0,
          paid: "0.00 USDC",
          price: `${priceUsdc().toFixed(2)} USDC`,
          generatedAt: new Date().toISOString().slice(0, 10),
        });
        res.writeHead(200, { "content-type": "image/svg+xml; charset=utf-8", "cache-control": "no-store" });
        return res.end(preview);
      }
      const svg = cardSvg(await buildStatement());
      res.writeHead(200, { "content-type": "image/svg+xml; charset=utf-8", "cache-control": "no-store" });
      return res.end(svg);
    }

    // Clean paths so the nav reads like a product instead of a file listing.
    const PAGES: Record<string, string> = {
      "/": "index.html",
      "/app": "app.html",
      "/memory": "memory.html",
      "/call": "call.html",
      "/pay": "pay.html",
      "/request": "request.html",
      "/ask": "ask.html",
      "/features": "features.html",
      "/how": "how.html",
      "/life": "life.html",
      "/report": "report.html",
    };
    // One page serves every link, because the id belongs in the URL the person sends
    // rather than in a file per note. A request is the same shape as a paid note.
    const file =
      PAGES[url.pathname] ??
      (/^\/ask\/[A-Za-z0-9_-]{1,16}$/.test(url.pathname)
        ? "open.html"
        : /^\/request\/[A-Za-z0-9_-]{6,16}$/.test(url.pathname)
          ? "request.html"
          : url.pathname.replace(/^\/+/, ""));
    const body = file && !file.includes("..") ? await readFile(join(PUBLIC, file)).catch(() => null) : null;
    if (!body) return json(res, 404, { error: "not found" });
    // A demo recording must never show a stale theme, so nothing is cached at all.
    res.writeHead(200, {
      "content-type": TYPES[extname(file)] ?? "application/octet-stream",
      "cache-control": "no-store",
    });
    res.end(body);
  } catch (err) {
    json(res, 500, { error: (err as Error).message });
  }
}

const sweeper = setInterval(() => sweepSeats(), 60 * 60 * 1000);
sweeper.unref();

/*
 * A reminder is written into the same store the page reads, so it lands in the thread
 * where it was asked for and survives a reload. This ticker is the one caller with no
 * request and no seat, which is why dueReminders reads every wallet. A server that is
 * not running cannot wake anyone, and the spoken copy says so plainly.
 */
const reminders = setInterval(() => {
  for (const r of dueReminders(Date.now())) {
    markReminderFired(r.id);
    if (!r.chat) continue;
    chats.append(r.chat, {
      asked: "",
      said: `Reminder: ${r.what}`,
      steps: [],
      delta: [],
      at: Date.now(),
    });
    const cut = r.chat.indexOf("::");
    if (cut > 0) chats.touch(r.chat.slice(0, cut), r.chat.slice(cut + 2));
  }
}, 5_000);
reminders.unref();

server.listen(PORT, HOST, () => {
  const voice = ttsState();
  const ready = voice.providers.filter((p) => p.ready).map((p) => p.id);
  const b = brainState();
  // Naming the decider only when it is a different model keeps one honest line rather
  // than two that appear to promise a second brain the build does not have.
  const decide = b.decide === b.answer ? "" : ` · picks tools with ${b.decide}`;
  console.log(
    `agent on http://${HOST}:${PORT} · model ${b.answer}${decide} · voice ${ready.length ? ready.join(" then ") : "this browser's, no model voice key"}`
  );
});
