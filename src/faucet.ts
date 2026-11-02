import "dotenv/config";
import { argon2d } from "hash-wasm";

const BASE = "https://faucet.testnet.sui.io";

type Challenge = {
  version: number; domain: string; algorithm: string; argon2Version: number;
  memorySize: number; iterations: number; parallelism: number; hashLength: number;
  salt: string; network: string; chainId: string; checkpointSeq: string;
  checkpointDigest: string; randomBytes: string; faucetAddress: string;
  recipient: string; difficulty: string; threshold: string;
};

/** Testnet gas costs a proof of work, not money. Takes 15-55s per wallet. */
export async function requestGas(recipient: string, verbose = false): Promise<string> {
  const c: Challenge = await (await fetch(`${BASE}/v3/challenge?recipient=${recipient}`)).json();
  if (!c.threshold) throw new Error("faucet returned no challenge");

  const threshold = BigInt(c.threshold);
  const saltBytes = new TextEncoder().encode(c.salt);
  const t0 = Date.now();
  let nonce = 0n;

  for (;;) {
    const preimage =
      `${c.domain}\n${c.chainId}\n${c.checkpointSeq}\n${c.checkpointDigest}\n` +
      `${c.randomBytes}\n${c.faucetAddress}\n${c.recipient}\n${nonce}`;

    const out = await argon2d({
      password: preimage,
      salt: saltBytes,
      memorySize: c.memorySize,
      iterations: c.iterations,
      parallelism: c.parallelism,
      hashLength: c.hashLength,
      outputType: "binary",
    });

    let lead = 0n;
    for (let i = 0; i < 8; i++) lead = (lead << 8n) | BigInt(out[i]);

    if (lead < threshold) {
      const hashHex = Buffer.from(out).toString("hex");
      const post = await fetch(`${BASE}/v3/gas`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          recipient: c.recipient,
          checkpointSeq: c.checkpointSeq,
          nonce: nonce.toString(),
          hashHex,
        }),
      });
      const text = await post.text();
      // A 200 can still carry an error, so the body decides, not the status.
      if (!post.ok || text.includes('"error"')) {
        throw new Error(`faucet rejected the proof: ${post.status} ${text.slice(0, 160)}`);
      }
      if (verbose) {
        console.log(`gas received after ${((Date.now() - t0) / 1000).toFixed(1)}s (nonce ${nonce})`);
      }
      return c.checkpointSeq;
    }

    nonce++;
    if (Date.now() - t0 > 55_000) throw new Error("PoW not solved inside the 60s challenge window");
  }
}

if (process.argv[1]?.includes("/src/faucet")) {
  const wallet = process.argv[2];
  if (!wallet?.startsWith("0x")) {
    console.error("usage: npm run faucet -- 0x<testnet-address>");
    process.exit(1);
  }
  console.log(`solving PoW for ${wallet.slice(0, 10)}…`);
  await requestGas(wallet, true);
}
