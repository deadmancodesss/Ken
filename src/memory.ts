import "dotenv/config";
import { createHash } from "node:crypto";
import { MemWal } from "@mysten-incubation/memwal";
import { scope } from "./scope.js";

const clients = new Map<string, MemWal>();

function client(namespace: string): MemWal {
  const existing = clients.get(namespace);
  if (existing) return existing;
  const made = MemWal.create({
    key: process.env.MEMWAL_KEY!,
    accountId: process.env.MEMWAL_ACCOUNT_ID!,
    serverUrl: process.env.MEMWAL_SERVER_URL!,
    namespace,
  });
  clients.set(namespace, made);
  return made;
}

export type Known = { text: string; blobId: string; distance: number };

/**
 * Two writes of the same payment are one event. The receipt is the transaction, so
 * that is the identity used to collapse rows. The relayer keeps both copies on
 * purpose and exposes no delete, so this happens on the way out rather than the
 * way in. Without it the agent reads "Paid 0.01 USDC to Sana" twice from memory and
 * tells the user it remembers two separate payments.
 */
function receiptKey(text: string): string {
  return text.match(/tx (\S+)/)?.[1] ?? text.trim();
}

function collapse(rows: Known[]): Known[] {
  const seen = new Set<string>();
  return rows.filter((r) => {
    const k = receiptKey(r.text);
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}

/**
 * Semantic recall on a hex address has a thin margin, so results are filtered
 * to those that literally mention the address. Distance alone is not trusted.
 */
export async function recallAbout(address: string, limit = 20): Promise<Known[]> {
  const res: any = await client(scope("counterparties")).recall({ query: `counterparty ${address}`, limit });
  return collapse(
    (res.results ?? [])
      .filter((hit: any) => hit.text.toLowerCase().includes(address.toLowerCase()))
      .map((hit: any) => ({ text: hit.text, blobId: hit.blob_id, distance: hit.distance })),
  );
}

export async function remember(text: string): Promise<string> {
  const namespace = scope("counterparties");
  // A receipt is the transaction, not the sentence describing it. Two writes on
  // either side of midnight would otherwise store the same payment twice.
  const digest = receiptKey(text);
  const res: any = await client(namespace).rememberAndWait(text, {
    idempotencyKey: createHash("sha256").update(digest).digest("hex").slice(0, 64),
  });
  return res.blob_id ?? res.results?.[0]?.blob_id ?? "";
}

/** Free-text search over everything this wallet has stored, not just the roster. */
export async function searchMemory(query: string, limit = 10): Promise<Known[]> {
  const res: any = await client(scope("counterparties")).recall({ query, limit });
  return collapse(
    (res.results ?? []).map((hit: any) => ({
      text: hit.text,
      blobId: hit.blob_id,
      distance: hit.distance,
    })),
  );
}
