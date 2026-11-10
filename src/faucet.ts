import "dotenv/config";
import { availableParallelism } from "node:os";
import { Worker } from "node:worker_threads";

const BASE = "https://faucet.testnet.sui.io";

/** A challenge dies after 60s, and the faucet throttles by IP, so extra tries are spaced, never hammered. */
const MAX_TRIES = 4;

type Challenge = {
  version: number; domain: string; algorithm: string; argon2Version: number;
  memorySize: number; iterations: number; parallelism: number; hashLength: number;
  salt: string; network: string; chainId: string; checkpointSeq: string;
  checkpointDigest: string; randomBytes: string; faucetAddress: string;
  recipient: string; difficulty: string; threshold: string;
  expectedAttempts?: number; windowSeconds?: number;
};

/**
 * One hash costs about 10ms wherever it is computed, so more threads buy a
 * little speed and then stop helping. Measured on this machine: 1 thread 90/s,
 * 3 threads 140/s, 6 threads no faster than 3. Three it is, because the host
 * machine also needs cores for the server and the browser.
 */
function threadCount(): number {
  const wanted = Number(process.env.FAUCET_WORKERS ?? Math.min(3, availableParallelism() - 1));
  return Math.max(1, Math.min(8, Number.isFinite(wanted) ? wanted : 1));
}

async function fetchChallenge(recipient: string): Promise<Challenge> {
  const res = await fetch(`${BASE}/v3/challenge?recipient=${recipient}`);
  const text = await res.text();
  const c = JSON.parse(text) as Challenge;
  // A 200 carrying an error body is how the faucet says this address is not
  // eligible, so the text has to reach the person rather than become "no challenge".
  if (!c.threshold) throw new Error(`faucet challenge refused (HTTP ${res.status}): ${text.slice(0, 200)}`);
  return c;
}

/**
 * Grinds one challenge across N threads until one of them lands under the
 * threshold or the window runs out. Reports the running attempt count so the
 * caller can show progress instead of silence.
 */
function grind(c: Challenge, ms: number, onProgress: (attempts: bigint) => void) {
  const size = threadCount();
  const stop = new Int32Array(new SharedArrayBuffer(4));
  const prefix =
    `${c.domain}\n${c.chainId}\n${c.checkpointSeq}\n${c.checkpointDigest}\n` +
    `${c.randomBytes}\n${c.faucetAddress}\n${c.recipient}\n`;

  return new Promise<{ nonce: string; hashHex: string; attempts: bigint }>((resolve, reject) => {
    const pool: Worker[] = [];
    let attempts = 0n;
    let settled = false;

    // Every thread reports its own running total, so the count worth showing is
    // the sum of the latest figure from each of them.
    const perThread = new Array<bigint>(size).fill(0n);
    const total = () => perThread.reduce((a, b) => a + b, 0n);

    const close = () => {
      Atomics.store(stop, 0, 1);
      for (const w of pool) void w.terminate();
    };
    const settle = (err: Error | null, proof?: { nonce: string; hashHex: string }) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      close();
      attempts = total();
      if (err) reject(err);
      else resolve({ ...proof!, attempts });
    };
    const timer = setTimeout(() => {
      const tried = total();
      settle(new Error(
        `no solution in ${(ms / 1000).toFixed(0)}s: tried ${tried} nonces on ${size} threads ` +
          `against a challenge expecting ${c.expectedAttempts ?? "?"}`,
      ));
    }, ms);

    for (let i = 0; i < size; i++) {
      // A worker is spawned by file path, which the tsx loader does not rewrite,
      // so this points at the source file that is really on disk.
      const w = new Worker(new URL("./faucet-worker.ts", import.meta.url), {
        workerData: {
          prefix,
          salt: new TextEncoder().encode(c.salt),
          memorySize: c.memorySize,
          iterations: c.iterations,
          parallelism: c.parallelism,
          hashLength: c.hashLength,
          threshold: c.threshold,
          start: i,
          stride: size,
          stop: stop.buffer,
        },
      });
      w.on("message", (m: { type: string; nonce?: string; hashHex?: string; done?: string }) => {
        if (m.type === "found") {
          settle(null, { nonce: m.nonce!, hashHex: m.hashHex! });
          return;
        }
        perThread[i] = BigInt(m.done ?? "0");
        onProgress(total());
      });
      w.on("error", (err: unknown) => settle(new Error(`PoW thread died: ${(err as Error)?.message ?? String(err)}`)));
      pool.push(w);
    }
  });
}

async function submitProof(c: Challenge, proof: { nonce: string; hashHex: string }): Promise<void> {
  const post = await fetch(`${BASE}/v3/gas`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      recipient: c.recipient,
      checkpointSeq: c.checkpointSeq,
      nonce: proof.nonce,
      hashHex: proof.hashHex,
    }),
  });
  const text = await post.text();
  // A 200 can still carry an error, so the body decides, not the status.
  if (!post.ok || text.includes('"error"')) {
    throw new Error(`faucet rejected the proof: ${post.status} ${text.slice(0, 200)}`);
  }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Anything saying this address is the problem rather than this minute is not worth four more challenges. */
const PERMANENT = /already|eligible|limit|too many|denied|forbidden|invalid/i;

/**
 * Testnet gas costs a proof of work, not money. The work is short but not
 * certain, so a missed window is answered with a brand new challenge instead of
 * grinding on one that has already expired. Four challenges is roughly a 99.9%
 * chance of landing at least one on this machine.
 */
export async function requestGas(recipient: string, verbose = false): Promise<string> {
  let last = "";

  for (let tryNo = 1; tryNo <= MAX_TRIES; tryNo++) {
    const t0 = Date.now();
    let attempts = 0n;
    let show: ReturnType<typeof setInterval> | null = null;

    try {
      const c = await fetchChallenge(recipient);
      const window = Math.max(10_000, ((c.windowSeconds ?? 60) - 10) * 1000);
      const size = threadCount();
      if (verbose) {
        console.log(`challenge ${tryNo}/${MAX_TRIES}: ${c.expectedAttempts ?? "?"} hashes expected, grinding on ${size} threads`);
      }
      show = verbose
        ? setInterval(() => {
            const secs = (Date.now() - t0) / 1000;
            console.log(
              `  grind ${secs.toFixed(0)}s of ${(window / 1000).toFixed(0)}s · ` +
                `${attempts} nonces at ${(Number(attempts) / Math.max(secs, 0.001)).toFixed(0)}/s`,
            );
          }, 5000)
        : null;

      const proof = await grind(c, window, (n) => { attempts = n; });
      await submitProof(c, proof);
      if (verbose) {
        console.log(`gas received after ${((Date.now() - t0) / 1000).toFixed(1)}s (${proof.attempts} nonces, nonce ${proof.nonce})`);
      }
      return c.checkpointSeq;
    } catch (err) {
      last = String((err as Error).message);
      if (verbose) console.log(`  attempt ${tryNo}/${MAX_TRIES} failed: ${last}`);
      if (PERMANENT.test(last)) throw new Error(last);
      // A solved proof that gets rejected is the faucet saying it is busy with
      // this IP. Grinding another challenge immediately would only dig deeper.
      await sleep(/rejected|busy|too many|rate|later|429/i.test(last) ? 15_000 : 2_000);
    } finally {
      if (show) clearInterval(show);
    }
  }

  throw new Error(`no testnet gas for ${recipient.slice(0, 10)}… after ${MAX_TRIES} challenges. Last error: ${last}`);
}

if (process.argv[1]?.includes("/src/faucet")) {
  const wallet = process.argv[2];
  if (!wallet?.startsWith("0x")) {
    console.error("usage: npm run faucet -- 0x<testnet-address>");
    process.exit(1);
  }
  console.log(`solving PoW for ${wallet.slice(0, 10)}… on ${threadCount()} threads`);
  await requestGas(wallet, true);
}
