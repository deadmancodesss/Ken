import "dotenv/config";
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { extname, join } from "node:path";
import { runTurn, modelName, brainState } from "./brain.js";
import { paymentsEnabled, prepareUsdc, USDC_DECIMALS, USDC_TESTNET } from "./wallet.js";
import { NATIVE_SUI, holdings, waitForTransaction } from "./chain.js";
import { counterparties, dueRows, forgetCounterparties } from "./knowledge.js";
import { peopleRoster, memoryStats } from "./people.js";
import { createNote, note, notes, type Note } from "./notes.js";
import { remember, searchMemory } from "./memory.js";
import { held, release, settle } from "./pending.js";
import { synthesize, ttsState } from "./speech.js";
import { type Quote, addressOf, notePayment, noteResourceId, priceUsdc, purchases, record, redeem, salesOf, sell, totalSpent } from "./x402.js";
import { session, useDemoWallet, useWallet } from "./session.js";
import { buildStatement, cardSvg } from "./report.js";
import { liveState, startLive, type LiveCall, type LiveEvent } from "./live.js";

const PORT = Number(process.env.APP_PORT ?? 8787);
const HOST = process.env.APP_HOST ?? "127.0.0.1";
const PUBLIC = new URL("../public/", import.meta.url).pathname;

// One conversation, because this is a single-seat demo. Restarting the process
// is the reset.
let history: unknown[] = [];

// Open phone calls, keyed by the id handed to the browser. The socket to the model
// lives here rather than in the page so the key never crosses the network.
const calls = new Map<string, LiveCall>();

const balanceCache = new Map<string, { at: number; body: unknown }>();

const TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
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

const server = createServer(async (req, res) => {
  const url = new URL(req.url!, `http://${req.headers.host}`);

  try {
    if (req.method === "POST" && url.pathname === "/turn") {
      const { text } = JSON.parse((await readBody(req)) || "{}");
      if (typeof text !== "string" || !text.trim()) return json(res, 400, { error: "text required" });
      const turn = await runTurn(text.trim(), history);
      history = turn.history;
      return json(res, 200, { text: turn.text, steps: turn.steps, rounds: history.length });
    }

    if (req.method === "POST" && url.pathname === "/wallet") {
      const { address, chain, demo } = JSON.parse((await readBody(req)) || "{}");
      const next = demo ? useDemoWallet() : useWallet(String(address), chain ? String(chain) : undefined);
      return json(res, 200, next);
    }

    // Kept apart from /state because a masthead on every page must not wait on a
    // chain read, and cached because Tatum answers three requests a second.
    if (url.pathname === "/balance") {
      const s = session();
      const coins = s.network === "testnet" ? [NATIVE_SUI, USDC_TESTNET] : [NATIVE_SUI];
      const key = `${s.wallet}:${s.network}`;
      const hit = balanceCache.get(key);
      if (hit && hit.at + 20_000 > Date.now()) return json(res, 200, hit.body);
      const body = { holdings: await holdings(s.wallet, coins, s.network), network: s.network };
      balanceCache.set(key, { at: Date.now(), body });
      return json(res, 200, body);
    }

    if (url.pathname === "/state") {
      // The roster is held for the whole session so a warm question never pays
      // Tatum for it, which means the page needs one explicit way to re-read.
      if (url.searchParams.get("refresh")) forgetCounterparties();
      const [roster, parties, stats] = await Promise.all([
        peopleRoster(),
        counterparties(session().wallet, session().network),
        memoryStats(),
      ]);
      return json(res, 200, {
        roster,
        parties,
        // Measured from the same read, so the rhythm on the page and the rhythm the
        // agent speaks are the same arithmetic and can never disagree out loud.
        due: dueRows(parties),
        stats,
        session: session(),
        payments: paymentsEnabled(),
        spend: {
          usdc: totalSpent(session().wallet),
          lookups: purchases(session().wallet).length,
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
      const { digest } = JSON.parse((await readBody(req)) || "{}");
      if (typeof digest !== "string" || !digest) return json(res, 400, { error: "digest required" });
      const waiting = held();
      if (!waiting) return json(res, 409, { error: "nothing is waiting for a signature" });

      // The digest arrives from a browser, so the chain decides whether it is a
      // payment at all. Nothing is written to memory on a claim alone.
      const proof = await waitForTransaction(digest, session().network);
      if (!proof) return json(res, 400, { error: `no such transaction on ${session().network}, so nothing was recorded` });
      if (proof.status !== "SUCCESS") return json(res, 400, { error: `that transaction ended ${proof.status}, so nothing was recorded` });
      const expected = BigInt(Math.round(waiting.usdc * 10 ** USDC_DECIMALS));
      const isUsdc = (t: string) => /usdc/i.test(t);
      const left = proof.changes.find(
        (c) => c.amount === -expected && isUsdc(c.coinType) && c.address.toLowerCase() === waiting.sender.toLowerCase(),
      );
      const arrived = proof.changes.find(
        (c) => c.amount === expected && isUsdc(c.coinType) && c.address.toLowerCase() === waiting.to.toLowerCase(),
      );
      if (!left || !arrived) {
        return json(res, 400, { error: `that transaction is not ${waiting.usdc} USDC from your wallet to ${waiting.to}` });
      }

      const done = settle(digest);
      // Writing the memory only after a real digest keeps the record honest about
      // payments that were prepared and then refused in the wallet.
      let learned: { name: string; note: string } | null = null;
      if (done && waiting.resource && waiting.quote) {
        // The receipt is journalled the instant the money is proven, before the index
        // is asked for the fact. If that ask fails or the process dies, the next one
        // replays this digest instead of sending the wallet after a second payment.
        notePayment(waiting.quote, digest);
        const released = await redeem(waiting.resource, waiting.sender, waiting.quote.id, digest);
        if ("error" in released) {
          // The hold is dropped even though the money is stranded, because the journal
          // above is what rescues it. Keeping an unsigned-looking payment on screen
          // would invite a second one.
          release();
          return json(res, 402, { error: `${released.error}. The ${waiting.usdc} USDC did move as ${digest}, so tell the user the index took the money and gave nothing` });
        }
        const person = await record(released.fact, addressOf(waiting.resource), released.usdc, digest, released.on);
        learned = { name: person.alias, note: person.note };
        forgetCounterparties();
      } else if (done) {
        await remember(
          `Paid ${done.usdc} USDC to ${done.to}${done.name ? ` (${done.name})` : ""} on ${new Date().toISOString().slice(0, 10)}. tx ${done.digest}`,
        );
        forgetCounterparties();
      }
      return json(res, 200, { pending: done, learned });
    }

    if (req.method === "POST" && url.pathname === "/paid") {
      // The paid index is a normal HTTP endpoint on purpose. It answers 402 with a
      // price and only releases the fact once the money has been seen on chain.
      const answer = await sell(JSON.parse((await readBody(req)) || "{}"));
      return json(res, answer.http, answer.body);
    }

    /*
     * The other side of the same protocol. Everything above this block was the index
     * writing what sat behind its wall and setting its own price, and these routes hand
     * both of those to a person: their words, their price, their payout wallet. The
     * judgement path was not touched to get here, which is the only honest reason to
     * build this over 402 instead of bolting a pay button onto a form.
     */
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

    if (req.method === "POST" && url.pathname === "/ask/sign") {
      const { id, payer } = JSON.parse((await readBody(req)) || "{}");
      let resource: string;
      try {
        resource = noteResourceId(String(id));
      } catch (err) {
        return json(res, 400, { error: (err as Error).message });
      }

      // The index sets the terms and this route only turns them into something a wallet
      // can sign, so a link this address already opened is answered without a ticket.
      const ask = await sell({ resource, payer: String(payer ?? "") });
      if (ask.http === 200) return json(res, 200, { opened: true, ...(ask.body as object) });
      if (ask.http !== 402) return json(res, ask.http, ask.body);

      const quote = (ask.body as { quote: Quote }).quote;
      try {
        const prepared = await prepareUsdc(quote.payer, quote.payTo, quote.usdc);
        return json(res, 200, { quote, prepared });
      } catch (err) {
        // A wallet with nothing in it is the buyer's problem to solve, not a reason to
        // pretend the link is broken, so the terms come back with the plain words.
        return json(res, 400, { error: (err as Error).message, quote });
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
      history = [];
      return json(res, 200, { reset: true });
    }

    // A call is one event stream out and a stream of small posts in, because this
    // server has no WebSocket library and a demo does not need one for two-way audio.
    if (url.pathname === "/live/stream") {
      res.writeHead(200, {
        "content-type": "text/event-stream; charset=utf-8",
        "cache-control": "no-store",
        connection: "keep-alive",
      });
      const push = (e: LiveEvent) => res.write(`data: ${JSON.stringify(e)}\n\n`);
      let call: LiveCall;
      try {
        call = await startLive(push, url.searchParams.get("voice") || undefined);
      } catch (err) {
        push({ kind: "error", message: (err as Error).message });
        return res.end();
      }
      calls.set(call.id, call);
      // Proxies and idle timers drop a quiet stream, so something has to keep moving
      // even when nobody is talking.
      const beat = setInterval(() => res.write(": keep-alive\n\n"), 15_000);
      res.on("close", () => {
        clearInterval(beat);
        calls.delete(call.id);
        call.stop();
      });
      return;
    }

    if (req.method === "POST" && url.pathname === "/live/mic") {
      const call = calls.get(url.searchParams.get("id") ?? "");
      if (!call) return json(res, 404, { error: "that call is not open, so hang up and start again" });
      const pcm = await readBytes(req, 64_000);
      if (!pcm.length) return json(res, 400, { error: "no audio in that chunk" });
      call.send(pcm);
      return json(res, 200, { heard: true });
    }

    if (req.method === "POST" && url.pathname === "/live/hangup") {
      const call = calls.get(url.searchParams.get("id") ?? "");
      call?.stop();
      if (call) calls.delete(call.id);
      return json(res, 200, { hungUp: !!call });
    }

    // The same statement in three shapes: numbers to print, vector to share, page to look at.
    if (url.pathname === "/report.json") {
      return json(res, 200, await buildStatement());
    }

    if (url.pathname === "/report.svg") {
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
      "/ask": "ask.html",
      "/features": "features.html",
      "/how": "how.html",
      "/life": "life.html",
      "/report": "report.html",
    };
    // One page serves every link, because the id belongs in the URL the person sends
    // rather than in a file per note.
    const file = PAGES[url.pathname] ?? (/^\/ask\/[A-Za-z0-9_-]{1,16}$/.test(url.pathname) ? "open.html" : url.pathname.replace(/^\/+/, ""));
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
});

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
