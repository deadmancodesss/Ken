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

export type Line = { blobId: string; text: string; namespace: string };

/**
 * Everything this wallet can read back, with the id it is stored under, so a line can
 * be put behind a price without anybody typing it out again. Recall is a search rather
 * than a dump, so at the size one person's memory reaches, the query only has to be the
 * plainest one that returns a namespace and the limit is the whole store.
 *
 * The property this list is trusted for is that every row in it is a row the store
 * really holds, because a wall that offers words the seller does not have is selling a
 * memory that cannot be delivered. So the text is passed through verbatim and never
 * rebuilt from a parsed shape, and a row with no id cannot be offered at all.
 */
export async function lines(limit = 100): Promise<Line[]> {
  const asks = [
    { namespace: scope("people"), query: "Person" },
    { namespace: scope("counterparties"), query: "who I pay and what they are to me" },
  ];
  const pages = await Promise.all(
    asks.map((a) => client(a.namespace).recall({ query: a.query, namespace: a.namespace, limit }) as Promise<any>),
  );
  const out: Line[] = [];
  const seen = new Set<string>();
  for (const [i, res] of pages.entries()) {
    for (const hit of res.results ?? []) {
      const text = String(hit.text ?? "").trim();
      const blobId = String(hit.blob_id ?? "");
      if (!text || !blobId) continue;
      // Two keys, because the relayer keeps both halves of a duplicated payment and
      // they are the same sentence under two ids. A seller picking from a list would
      // otherwise see the same line twice and price one of them.
      if (seen.has(blobId) || seen.has(text)) continue;
      seen.add(blobId);
      seen.add(text);
      out.push({ blobId, text, namespace: asks[i].namespace });
    }
  }
  return out;
}

/**
 * The one line stored under one id, or nothing. Used at the moment a link is made, so
 * the words that end up behind the wall are read out of the store by the server rather
 * than sent to it by the page that asked for the link.
 */
export async function line(blobId: string): Promise<Line | undefined> {
  return (await lines()).find((l) => l.blobId === blobId);
}
