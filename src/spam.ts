import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import type { DatabaseSync } from "node:sqlite";
import { ownerKey } from "./owner.js";
import { openDatabase } from "./sqlite.js";

/**
 * A mark is a person's own judgement about an address, so it has to outlive the tab
 * that wrote it. It belongs to the wallet, not the browser and not the ledger, because
 * the same address is the same counterparty on Mainnet and on testnet. A visitor with
 * no wallet has none to hang it on, so the seat is the owner instead.
 *
 * Reads and writes are guarded separately from the seat store. A mark that silently
 * failed to save would be worse than no mark at all, because the warning that never
 * comes is the one the person believed they had switched on.
 */
export const DEFAULT_SPAM_DB = fileURLToPath(new URL("../data/marks.db", import.meta.url));

export type SpamMark = { address: string; name: string | null; reason: string | null; at: number };

let db: DatabaseSync | null | undefined;

function open(): DatabaseSync | null {
  if (db !== undefined) return db;
  try {
    const file = process.env.SPAM_DB ?? DEFAULT_SPAM_DB;
    if (file !== ":memory:") mkdirSync(dirname(file), { recursive: true });
    const made = openDatabase(file);
    made.exec(`create table if not exists marks (
      owner text not null,
      address text not null,
      name text,
      reason text,
      at integer not null,
      primary key (owner, address)
    );`);
    db = made;
  } catch (err) {
    console.warn(`mark store unavailable (${(err as Error).message}), so a spam warning would not be saved`);
    db = null;
  }
  return db;
}

function rowToMark(row: any): SpamMark {
  return {
    address: String(row.address),
    name: row.name ? String(row.name) : null,
    reason: row.reason ? String(row.reason) : null,
    at: Number(row.at),
  };
}

export function markSpam(address: string, name: string | null, reason: string | null): SpamMark {
  const wanted = address.toLowerCase();
  const mark: SpamMark = { address: wanted, name, reason, at: Date.now() };
  const store = open();
  if (!store) throw new Error("the mark store is unavailable on this machine, so nothing was marked");
  store
    .prepare(
      "insert into marks (owner, address, name, reason, at) values (?, ?, ?, ?, ?) on conflict(owner, address) do update set name = excluded.name, reason = excluded.reason, at = excluded.at",
    )
    .run(ownerKey(), wanted, name, reason, mark.at);
  return mark;
}

export function clearSpam(address: string): boolean {
  const store = open();
  if (!store) throw new Error("the mark store is unavailable on this machine, so nothing was changed");
  const res = store.prepare("delete from marks where owner = ? and address = ?").run(ownerKey(), address.toLowerCase());
  return Number(res.changes ?? 0) > 0;
}

export function spamMarkFor(address: string): SpamMark | null {
  const store = open();
  if (!store) return null;
  const row = store.prepare("select address, name, reason, at from marks where owner = ? and address = ?").get(ownerKey(), address.toLowerCase());
  return row ? rowToMark(row) : null;
}

export function spamMarks(): SpamMark[] {
  const store = open();
  if (!store) return [];
  const rows = store.prepare("select address, name, reason, at from marks where owner = ? order by at desc").all(ownerKey()) as any[];
  return rows.map(rowToMark);
}
