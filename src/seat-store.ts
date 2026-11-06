import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";
import type { Session } from "./session.js";

/**
 * A seat lives in memory while the browser is open, so every server restart used to
 * drop the wallet and quietly fall back to the demo story. The page could still say
 * "Disconnect" while the next call read a different wallet's memory. The address is
 * public and the cookie already outlives the process, so it is kept beside the chats
 * and cleared by the same Disconnect that clears the seat.
 */
export const DEFAULT_SEAT_DB = fileURLToPath(new URL("../data/seats.db", import.meta.url));

let db: DatabaseSync | null | undefined;

function open(): DatabaseSync | null {
  if (db !== undefined) return db;
  try {
    const file = process.env.SEATS_DB ?? DEFAULT_SEAT_DB;
    if (file !== ":memory:") mkdirSync(dirname(file), { recursive: true });
    const made = new DatabaseSync(file);
    made.exec(`create table if not exists seats (
      id text primary key,
      session text not null,
      at integer not null
    );`);
    db = made;
  } catch (err) {
    console.warn(`seat store unavailable (${(err as Error).message}), so a restart will ask for the wallet again`);
    db = null;
  }
  return db;
}

export function savedSession(id: string): Session | null {
  const store = open();
  if (!store) return null;
  try {
    const row = store.prepare("select session from seats where id = ?").get(id) as { session?: string } | undefined;
    if (!row?.session) return null;
    const parsed = JSON.parse(String(row.session)) as Session;
    const ok =
      parsed &&
      typeof parsed.wallet === "string" &&
      (parsed.source === "demo" || parsed.source === "wallet") &&
      (parsed.network === "testnet" || parsed.network === "mainnet");
    return ok ? parsed : null;
  } catch {
    return null;
  }
}

export function saveSession(id: string, session: Session | null): void {
  const store = open();
  if (!store || id === "console") return;
  try {
    if (!session) {
      store.prepare("delete from seats where id = ?").run(id);
      return;
    }
    store
      .prepare(
        "insert into seats (id, session, at) values (?, ?, ?) on conflict(id) do update set session = excluded.session, at = excluded.at",
      )
      .run(id, JSON.stringify(session), Date.now());
  } catch {
    // A failed write costs one reconnect, never a wrong wallet.
  }
}
