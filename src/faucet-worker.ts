import { parentPort, workerData } from "node:worker_threads";
import { argon2d } from "hash-wasm";

/**
 * One thread's slice of the nonce space. It owns nonces start, start+stride,
 * start+2*stride and so on, so no two threads ever hash the same candidate.
 * `stop` is shared with the parent: whoever finds a solution sets it and every
 * other thread drops out on its next check.
 */
const job = workerData as {
  prefix: string;
  salt: Uint8Array;
  memorySize: number;
  iterations: number;
  parallelism: number;
  hashLength: number;
  threshold: string;
  start: number;
  stride: number;
  stop: SharedArrayBuffer;
};

const port = parentPort!;
const threshold = BigInt(job.threshold);
const stop = new Int32Array(job.stop);
const stride = BigInt(job.stride);

let nonce = BigInt(job.start);
let since = 0n;
let beat = Date.now();

for (;;) {
  if ((since & 7n) === 0n && Atomics.load(stop, 0) !== 0) break;

  const out = await argon2d({
    password: job.prefix + nonce,
    salt: job.salt,
    memorySize: job.memorySize,
    iterations: job.iterations,
    parallelism: job.parallelism,
    hashLength: job.hashLength,
    outputType: "binary",
  });
  since++;

  let lead = 0n;
  for (let i = 0; i < 8; i++) lead = (lead << 8n) | BigInt(out[i]);

  if (lead < threshold) {
    Atomics.store(stop, 0, 1);
    port.postMessage({ type: "found", nonce: nonce.toString(), hashHex: Buffer.from(out).toString("hex") });
    break;
  }

  if (Date.now() - beat > 1000) {
    port.postMessage({ type: "tick", done: since.toString() });
    beat = Date.now();
  }
  nonce += stride;
}

port.postMessage({ type: "bye", done: since.toString() });
