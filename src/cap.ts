import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import type { DatabaseSync } from "node:sqlite";
import { openDatabase } from "./sqlite.js";

/**
 * A monthly limit a person sets for one wallet, kept beside the seats rather than in
 * the browser because it has to survive a reload and a second device. It is a budget
 * the person writes for themselves, not a control the server enforces: nothing here
 * blocks a payment, it only tells the truth about how much of the month is gone.
 *
 * The owner is the wallet when one is connected and the seat otherwise. A visitor
 * without a wallet setting a limit must not change the number the next visitor sees,
 * and a connected person should find their limit again on a phone.
 */
export const DEFAULT_CAP_DB = fileURLToPath(new URL("../data/caps.db", import.meta.url));

export type CapState = "none" | "under" | "close" | "over";

const USDC_UNIT = 1_000_000;

let db: DatabaseSync | null | undefined;

function open(): DatabaseSync | null {
  if (db !== undefined) return db;
  try {
    const file = process.env.CAPS_DB ?? DEFAULT_CAP_DB;
    if (file !== ":memory:") mkdirSync(dirname(file), { recursive: true });
    const made = openDatabase(file);
    made.exec(`create table if not exists caps (
      owner text primary key,
      monthly_base integer not null,
      at integer not null
    );`);
    db = made;
  } catch (err) {
    console.warn(`cap store unavailable (${(err as Error).message}), so a limit lasts for this process only`);
    db = null;
  }
  return db;
}

// A file that cannot be opened must not silently forget a limit the person sees on
// screen, so the last accepted value is kept here for the life of the process.
const memory = new Map<string, number>();

export function capBase(owner: string): number | null {
  const store = open();
  if (!store) return memory.get(owner) ?? null;
  try {
    const row = store.prepare("select monthly_base from caps where owner = ?").get(owner) as
      | { monthly_base?: number }
      | undefined;
    return typeof row?.monthly_base === "number" ? row.monthly_base : null;
  } catch {
    return memory.get(owner) ?? null;
  }
}

/** Zero means the limit was lifted, which is a thing a person is allowed to do. */
export function setCapBase(owner: string, base: number): void {
  if (base <= 0) {
    clearCap(owner);
    return;
  }
  memory.set(owner, base);
  const store = open();
  if (!store) return;
  try {
    store
      .prepare(
        "insert into caps (owner, monthly_base, at) values (?, ?, ?) on conflict(owner) do update set monthly_base = excluded.monthly_base, at = excluded.at",
      )
      .run(owner, base, Date.now());
  } catch {
    // The in-memory value above still serves this process, and the page reports the
    // limit it was given rather than a figure that was never kept.
  }
}

export function clearCap(owner: string): void {
  memory.delete(owner);
  const store = open();
  if (!store) return;
  try {
    store.prepare("delete from caps where owner = ?").run(owner);
  } catch {
    /* nothing to clear if the row never landed */
  }
}

export function capUsdc(owner: string): number | null {
  const base = capBase(owner);
  return base === null ? null : base / USDC_UNIT;
}

export function usdcToBase(usdc: number): number {
  return Math.round(usdc * USDC_UNIT);
}

/**
 * Three states, not five. Under seventy percent is a green month, seventy to the
 * limit is amber because it is the week where a person still has a choice, and at
 * or over the limit is red. Equal to the limit is over, because a budget that is
 * exactly spent has nothing left in it.
 */
export function capState(spent: number, monthly: number | null): CapState {
  if (!monthly || monthly <= 0) return "none";
  if (spent >= monthly) return "over";
  if (spent >= monthly * 0.7) return "close";
  return "under";
}

export type CapMeter = {
  monthly: number | null;
  spent: number;
  left: number | null;
  pct: number;
  state: CapState;
};

export function capMeter(spent: number, monthly: number | null): CapMeter {
  const state = capState(spent, monthly);
  const pct = monthly && monthly > 0 ? (spent / monthly) * 100 : 0;
  return {
    monthly,
    spent,
    left: monthly === null ? null : Math.round((monthly - spent) * 100) / 100,
    // The bar cannot draw past its own end. The number beside it still says 140%.
    pct: Math.min(100, Math.max(0, pct)),
    state,
  };
}
