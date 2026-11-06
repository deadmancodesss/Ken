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

export type Person = { alias: string; address: string; note: string; blobId: string };

// Two shapes are in the store. Records written before the migration separate the
// note with a spaced em dash, and everything since uses a comma with no space
// before it. A pattern that insisted on the space silently hid every new name.
const LINE = /^Person "(.+?)" = (0x[0-9a-fA-F]{64})(?:\s*[—,–]\s*(.*))?$/;

function parse(text: string, blobId: string): Person | null {
  const m = LINE.exec(text.trim());
  return m ? { alias: m[1], address: m[2], note: m[3] ?? "", blobId } : null;
}

/**
 * A full idempotency key has to identify the whole line. Truncating it meant two
 * different records, one with a receipt and one without, could collide on the same
 * key and the second write was refused.
 */
const keyFor = (text: string) => createHash("sha256").update(text).digest("hex").slice(0, 64);

export async function labelPerson(alias: string, address: string, note?: string): Promise<Person> {
  const name = alias.trim();
  if (!name) throw new Error("a name is required");
  if (!/^0x[0-9a-fA-F]{64}$/.test(address)) throw new Error(`${address} is not a full Sui address`);

  const namespace = scope("people");
  const text = `Person "${name}" = ${address}${note?.trim() ? `, ${note.trim()}` : ""}`;
  const res: any = await client(namespace).rememberAndWait(text, { idempotencyKey: keyFor(text) });
  cached = null;
  return { alias: name, address, note: note?.trim() ?? "", blobId: res.blob_id ?? "" };
}

let cached: { namespace: string; at: number; rows: Person[] } | null = null;
let loading: { namespace: string; read: Promise<Person[]> } | null = null;
/* One recall measured 3.7 seconds against the live store, and a call that reads it
   again every thirty seconds makes every later name lookup feel broken. Names only
   change when this process writes one, and that clears the cache below, so five
   minutes is the staleness a person can actually notice. */
const TTL_MS = 5 * 60_000;

/**
 * Recall answers a 64-character hex query badly, and that used to mean an address
 * the agent had already paid for looked unknown seconds later. So the roster is
 * read once, in one query that is known to work, and every lookup is a literal
 * match over what came back.
 *
 * A second caller joins the read already in flight instead of paying for another
 * one. That is what the call prefetch and the first spoken name do at the same
 * moment, and two 3.7 second reads where one would do is most of a slow answer.
 */
async function roster(): Promise<Person[]> {
  const namespace = scope("people");
  if (cached && cached.namespace === namespace && Date.now() - cached.at < TTL_MS) return cached.rows;
  if (loading && loading.namespace === namespace) return loading.read;
  const read = client(namespace)
    .recall({ query: "Person", namespace, limit: 100 })
    .then((res: any) => {
      const seen = new Map<string, Person>();
      for (const hit of res.results ?? []) {
        const p = parse(hit.text, hit.blob_id);
        if (p && !seen.has(p.address.toLowerCase())) seen.set(p.address.toLowerCase(), p);
      }
      cached = { namespace, at: Date.now(), rows: [...seen.values()] };
      return cached.rows;
    })
    .catch((err: any) => {
      console.warn(`walrus recall unavailable (${(err as Error).message}), using cached or empty roster`);
      return cached?.rows ?? [];
    })
    .finally(() => {
      if (loading?.read === read) loading = null;
    });
  loading = { namespace, read };
  return read;
}

/** Case, spaces and punctuation are not what a microphone produces, so they are not compared. */
const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, "");

/**
 * Names reach this code from a microphone, so "Sana" arrives as "Sanna" and "Zana".
 * Two short strings are close when one edit separates them, and one edit is what a
 * dropped or doubled letter looks like.
 */
function distance(a: string, b: string): number {
  if (Math.abs(a.length - b.length) > 2) return 99;
  let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    const row = [i];
    for (let j = 1; j <= b.length; j++) {
      row[j] = Math.min(prev[j] + 1, row[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    }
    prev = row;
  }
  return prev[b.length];
}

export type Match = { person: Person; confidence: number; heard: string };

/**
 * Reading memory can afford to guess, because a wrong guess costs one question. This
 * is deliberately NOT the function the payment path uses.
 */
export async function matchPerson(alias: string): Promise<Match | null> {
  const want = norm(alias);
  if (want.length < 2) return null;
  const rows = await roster();
  const exact = rows.find((p) => norm(p.alias) === want);
  if (exact) return { person: exact, confidence: 1, heard: alias };
  const allow = want.length >= 7 ? 2 : 1;
  const near = rows
    .map((p) => ({ p, d: distance(want, norm(p.alias)) }))
    .filter((r) => r.d <= allow && r.p.alias.length >= 3)
    .sort((a, b) => a.d - b.d);
  // Two people who sound alike is not a coin flip. A tie is reported as no match, so
  // the agent asks which one rather than picking a stranger.
  if (!near.length || (near[1] && near[1].d === near[0].d)) return null;
  return { person: near[0].p, confidence: 1 - near[0].d / Math.max(3, want.length), heard: alias };
}

/**
 * Rewrites any word in a spoken sentence that is one edit from a known name, so a
 * memory search asks for the person the speaker meant. No extra round trip and no
 * silent invention, it can only replace a word with a name that is already stored.
 */
export async function canonicalNames(text: string): Promise<string> {
  const rows = await roster();
  if (!rows.length) return text;
  return text
    .split(/(\s+)/)
    .map((token) => {
      const want = norm(token);
      if (want.length < 4 || rows.some((p) => norm(p.alias) === want)) return token;
      const near = rows.filter((p) => distance(want, norm(p.alias)) === 1 && p.alias.length >= 3);
      return near.length === 1 ? token.replace(new RegExp(want, "i"), near[0].alias) : token;
    })
    .join("");
}

export async function resolvePerson(alias: string): Promise<Person | null> {
  const want = norm(alias);
  return (await roster()).find((p) => norm(p.alias) === want) ?? null;
}

export async function personForAddress(address: string): Promise<Person | null> {
  const want = address.toLowerCase();
  return (await roster()).find((p) => p.address.toLowerCase() === want) ?? null;
}

export async function peopleRoster(): Promise<Person[]> {
  return roster();
}

export type NamespaceCount = { name: string; memories: number };

/**
 * Counts only what the wallet being narrated owns. The account's other namespaces
 * belong to other people and would make the header read like a shared database.
 */
export async function memoryStats(): Promise<{ total: number; namespaces: NamespaceCount[] }> {
  const scopes = [scope("people"), scope("counterparties")];
  const namespaces: NamespaceCount[] = [];
  for (const name of scopes) {
    let count = 0;
    let cursor: string | undefined;
    try {
      for (;;) {
        const page: any = await client(name).listMemories({ cursor, namespace: name, limit: 100 });
        count += page.memories?.length ?? 0;
        cursor = page.next_cursor ?? undefined;
        if (!cursor || !page.has_more) break;
      }
    } catch (err: any) {
      console.warn(`walrus listMemories unavailable (${(err as Error).message}), returning 0`);
    }
    namespaces.push({ name, memories: count });
  }
  return { total: namespaces.reduce((s, n) => s + n.memories, 0), namespaces };
}

/** Raw read of one namespace by exact name, used by the migration and nothing else. */
export async function listNamespace(name: string): Promise<Person[]> {
  const res: any = await client(name).recall({ query: "Person", namespace: name, limit: 100 });
  const seen = new Map<string, Person>();
  for (const hit of res.results ?? []) {
    const p = parse(hit.text, hit.blob_id);
    if (p && !seen.has(p.address.toLowerCase())) seen.set(p.address.toLowerCase(), p);
  }
  return [...seen.values()];
}
