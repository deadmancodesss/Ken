import "dotenv/config";
import { MemWal } from "@mysten-incubation/memwal";

type Status = "pass" | "fail" | "skip";
const rows: { step: string; status: Status; detail: string }[] = [];

function record(step: string, status: Status, detail: string) {
  rows.push({ step, status, detail });
  console.log(`${status.toUpperCase().padEnd(4)} | ${step}\n     ${detail}\n`);
}

const key = process.env.MEMWAL_KEY?.trim() ?? "";
const accountId = process.env.MEMWAL_ACCOUNT_ID?.trim() ?? "";
const namespace = process.env.MEMWAL_NAMESPACE?.trim() || "plumbing";
const serverUrl = process.env.MEMWAL_SERVER_URL?.trim() || "https://relayer.memory.walrus.xyz";
const tatumKey = process.env.TATUM_API_KEY?.trim() ?? "";
const gqlUrl = process.env.TATUM_SUI_GRAPHQL_URL?.trim() || "https://sui-mainnet.gateway.tatum.io/graphql";

console.log(`network target: Mainnet | namespace: ${namespace}\n`);

// Tatum exposes Sui as GraphQL only. JSON-RPC POSTs to the gateway return 404, and Sui's own
// public fullnodes no longer serve JSON-RPC at all, so there is no fallback to reach for.
async function gql(query: string) {
  const res = await fetch(gqlUrl, {
    method: "POST",
    headers: { "content-type": "application/json", "x-api-key": tatumKey },
    body: JSON.stringify({ query }),
  });
  const text = await res.text();
  let body: { data?: Record<string, any>; errors?: { message: string }[] } = {};
  try {
    body = JSON.parse(text);
  } catch {
    body = {};
  }
  const message = body.errors?.map((e) => e.message).join(" | ") ?? text.slice(0, 180);
  return { http: res.status, data: body.data, message };
}

// 1. Chain is reachable and the key is accepted.
if (!tatumKey) {
  record("tatum graphql reachable", "skip", "TATUM_API_KEY empty");
} else {
  try {
    const r = await gql("{ checkpoint { sequenceNumber } }");
    const n = r.data?.checkpoint?.sequenceNumber;
    record(
      "tatum graphql reachable",
      n ? "pass" : "fail",
      n ? `mainnet checkpoint ${n} at ${gqlUrl}` : `HTTP ${r.http}: ${r.message}`,
    );
  } catch (err) {
    record("tatum graphql reachable", "fail", (err as Error).message);
  }
}

// 2. The capability the product actually depends on: reading other people's onchain history
// with no balance of our own.
if (!tatumKey) {
  record("mainnet history read", "skip", "blocked on API key");
} else {
  try {
    const r = await gql("{ transactions(first: 3) { nodes { digest sender { address } } } }");
    const nodes = r.data?.transactions?.nodes ?? [];
    const withSender = nodes.find((n: any) => n.sender?.address);
    record(
      "mainnet history read",
      nodes.length ? "pass" : "fail",
      nodes.length
        ? `${nodes.length} live transactions, e.g. ${String(nodes[0].digest).slice(0, 16)}… from ${String(withSender?.sender?.address ?? "unknown").slice(0, 14)}…`
        : `HTTP ${r.http}: ${r.message}`,
    );
  } catch (err) {
    record("mainnet history read", "fail", (err as Error).message);
  }
}

// 3-5. Walrus Memory: health, write, read back. Writes cost no SUI and no gas.
if (!key || !accountId) {
  const missing = !key && !accountId ? "MEMWAL_KEY and MEMWAL_ACCOUNT_ID" : !key ? "MEMWAL_KEY" : "MEMWAL_ACCOUNT_ID";
  record("memwal health", "skip", `${missing} empty`);
  record("memwal write", "skip", "blocked on credentials");
  record("memwal read back", "skip", "blocked on credentials");
} else {
  const memwal = MemWal.create({ key, accountId, serverUrl, namespace });

  try {
    const health = await memwal.health();
    const healthy = health.status === "ok" || health.status === "healthy";
    record(
      "memwal health",
      healthy && health.write_ready !== false ? "pass" : "fail",
      `status=${health.status} mode=${health.mode ?? "?"} write_ready=${String(health.write_ready)} at ${serverUrl}`,
    );
  } catch (err) {
    record("memwal health", "fail", (err as Error).message);
  }

  const marker = `PLUMBING ${new Date().toISOString()} ${Math.random().toString(36).slice(2, 8)}`;
  let blobId = "";

  try {
    const written = await memwal.rememberAndWait(
      `Plumbing check ${marker}. Written by npm run plumb to prove a Mainnet memory write works from this machine.`,
      namespace,
    );
    blobId = written.blob_id;
    record("memwal write", "pass", `blob ${blobId} stored in namespace "${written.namespace}"`);
  } catch (err) {
    record("memwal write", "fail", (err as Error).message);
  }

  try {
    const found = await memwal.recall({ query: marker });
    const recovered = JSON.stringify(found.results).includes(marker);
    record(
      "memwal read back",
      recovered ? "pass" : found.results.length > 0 ? "fail" : "skip",
      recovered
        ? `recall returned the marker just written${blobId ? ` (blob ${blobId})` : ""}, ${found.total} hit(s)`
        : `recall returned ${found.total} hit(s) without our marker. Indexing may lag, so re-run in a minute`,
    );
  } catch (err) {
    record("memwal read back", "fail", (err as Error).message);
  }
}

const failed = rows.filter((r) => r.status === "fail").length;
const skipped = rows.filter((r) => r.status === "skip").length;
console.log(`${rows.length - failed - skipped} pass / ${failed} fail / ${skipped} skip`);
if (failed > 0) process.exitCode = 1;
