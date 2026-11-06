import { randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";
import { ownerKey } from "./owner.js";

/**
 * A reminder is the one thing here that has to happen without a question first. The
 * time is parsed and stored on the server, not left to the model to work out, because
 * "in twenty minutes" turned into a timestamp by a language model is an answer nobody
 * can check. A ticker in the server writes the reminder into the conversation it was
 * asked in. The honest limit is the process: a reminder cannot fire while the server
 * is stopped.
 */
export const DEFAULT_REMINDER_DB = fileURLToPath(new URL("../data/reminders.db", import.meta.url));

export type Reminder = {
  id: string;
  owner: string;
  chat: string | null;
  what: string;
  due_at: number;
  created_at: number;
};

const SECOND = 1_000;
const MINUTE = 60 * SECOND;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

let db: DatabaseSync | null | undefined;

function open(): DatabaseSync | null {
  if (db !== undefined) return db;
  try {
    const file = process.env.REMINDER_DB ?? DEFAULT_REMINDER_DB;
    if (file !== ":memory:") mkdirSync(dirname(file), { recursive: true });
    const made = new DatabaseSync(file);
    made.exec(`
      create table if not exists reminders (
        id text primary key,
        owner text not null,
        chat text,
        what text not null,
        due_at integer not null,
        created_at integer not null,
        fired_at integer
      );
      create index if not exists reminders_due on reminders(fired_at, due_at);
      create index if not exists reminders_owner on reminders(owner, fired_at, due_at);
    `);
    db = made;
  } catch (err) {
    console.warn(`reminder store unavailable (${(err as Error).message}), so nothing can be reminded`);
    db = null;
  }
  return db;
}

function rowToReminder(row: any): Reminder {
  return {
    id: String(row.id),
    owner: String(row.owner),
    chat: row.chat ? String(row.chat) : null,
    what: String(row.what),
    due_at: Number(row.due_at),
    created_at: Number(row.created_at),
  };
}

function clock(hourText: string, minuteText: string | undefined, ampm: string | undefined, now: Date): Date | null {
  let hour = Number(hourText);
  const minute = minuteText ? Number(minuteText) : 0;
  if (minute > 59) return null;
  if (ampm) {
    if (hour < 1 || hour > 12) return null;
    if (ampm === "pm" && hour < 12) hour += 12;
    if (ampm === "am" && hour === 12) hour = 0;
  } else if (hour > 23) {
    return null;
  }
  const at = new Date(now);
  at.setHours(hour, minute, 0, 0);
  return at;
}

/**
 * The phrases people actually use, parsed here so the same words always mean the same
 * instant. A full ISO time is accepted from a caller that already has one. A bare hour
 * with no am or pm is read on a 24 hour clock, and "at 6" in the evening must be said
 * as 6pm rather than guessed.
 */
export function parseWhen(input: string, now = new Date()): Date | null {
  const text = input.trim().toLowerCase();
  if (!text) return null;

  if (/^\d{4}-\d{2}-\d{2}t\d{2}:\d{2}(:\d{2})?(\.\d+)?(z|[+-]\d{2}:?\d{2})?$/.test(text)) {
    const at = new Date(input.trim());
    return Number.isNaN(at.getTime()) ? null : at;
  }

  const relative = text.match(/^in\s+(\d+(?:\.\d+)?)\s*(seconds?|secs?|s|minutes?|mins?|m|hours?|hrs?|h|days?|d)$/);
  if (relative) {
    const n = Number(relative[1]);
    const unit = relative[2];
    const span = /^s/.test(unit) ? SECOND : /^d/.test(unit) ? DAY : /^h/.test(unit) ? HOUR : MINUTE;
    return new Date(now.getTime() + Math.round(n * span));
  }

  const tomorrow = text.match(/^tomorrow(?:\s+at)?\s+(\d{1,2})(?::(\d{2}))?\s*(am|pm)?$/);
  if (tomorrow) {
    const at = clock(tomorrow[1], tomorrow[2], tomorrow[3], now);
    if (!at) return null;
    at.setDate(at.getDate() + 1);
    return at;
  }

  const today = text.match(/^(?:today\s+)?(?:at\s+)?(\d{1,2})(?::(\d{2}))?\s*(am|pm)?$/);
  if (today) {
    const at = clock(today[1], today[2], today[3], now);
    if (!at) return null;
    if (at.getTime() <= now.getTime()) at.setDate(at.getDate() + 1);
    return at;
  }

  return null;
}

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/** The time as a person says it, with a day word only when the day is not today. */
export function spokenWhen(at: Date, now = new Date()): string {
  const hour = at.getHours();
  const minute = String(at.getMinutes()).padStart(2, "0");
  const time = `${hour % 12 || 12}:${minute} ${hour >= 12 ? "pm" : "am"}`;
  const day = new Date(at);
  day.setHours(0, 0, 0, 0);
  const base = new Date(now);
  base.setHours(0, 0, 0, 0);
  const days = Math.round((day.getTime() - base.getTime()) / DAY);
  if (days === 0) return `at ${time}`;
  if (days === 1) return `tomorrow at ${time}`;
  return `on ${at.getDate()} ${MONTHS[at.getMonth()]} at ${time}`;
}

export function addReminder(what: string, dueAt: number, chat: string | null): Reminder {
  const store = open();
  if (!store) throw new Error("the reminder store is unavailable on this machine, so nothing was set");
  const made: Reminder = {
    id: randomUUID().slice(0, 8),
    owner: ownerKey(),
    chat,
    what,
    due_at: dueAt,
    created_at: Date.now(),
  };
  store
    .prepare("insert into reminders (id, owner, chat, what, due_at, created_at) values (?, ?, ?, ?, ?, ?)")
    .run(made.id, made.owner, made.chat, made.what, made.due_at, made.created_at);
  return made;
}

export function upcomingReminders(): Reminder[] {
  const store = open();
  if (!store) return [];
  const rows = store
    .prepare("select id, owner, chat, what, due_at, created_at from reminders where owner = ? and fired_at is null order by due_at asc")
    .all(ownerKey()) as any[];
  return rows.map(rowToReminder);
}

export function cancelReminder(id: string): boolean {
  const store = open();
  if (!store) throw new Error("the reminder store is unavailable on this machine, so nothing was changed");
  const res = store.prepare("delete from reminders where owner = ? and id = ? and fired_at is null").run(ownerKey(), id);
  return Number(res.changes ?? 0) > 0;
}

/** Every wallet's due reminders, because the ticker is the one caller with no seat. */
export function dueReminders(now: number): Reminder[] {
  const store = open();
  if (!store) return [];
  const rows = store
    .prepare("select id, owner, chat, what, due_at, created_at from reminders where fired_at is null and due_at <= ? order by due_at asc")
    .all(now) as any[];
  return rows.map(rowToReminder);
}

export function markReminderFired(id: string): void {
  const store = open();
  if (!store) return;
  try {
    store.prepare("update reminders set fired_at = ? where id = ?").run(Date.now(), id);
  } catch {
    // A failed write repeats the reminder, which is better than losing it silently.
  }
}
