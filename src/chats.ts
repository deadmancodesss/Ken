import { DatabaseSync } from "node:sqlite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
import { currentSeat } from "./seat.js";
import { session } from "./session.js";

/**
 * The conversation is a thing a person keeps, not a thing the process happens to hold.
 * It is stored per wallet so a reload, a server restart or a second device reads the
 * same turns back, and it is stored in SQLite so two requests cannot interleave into a
 * half written history the way a shared array could. The demo story has no wallet of
 * its own to be shared under, so those turns are keyed to the browser seat instead and
 * two judges never read each other's conversation.
 *
 * One wallet can hold several conversations. The owner is the wallet (or the demo
 * seat), a session is a named thread inside it, and a turn belongs to exactly one
 * owner::session pair. Voice and text write to the same pair, which is what lets a
 * spoken call continue as a typed question without repeating itself.
 */
export type StoredStep = { name: string; ok: boolean; error?: string; result?: unknown };
export type ChatTurn = { id?: number; asked: string; said: string; steps: StoredStep[]; at: number };
export type ChatRecord = ChatTurn & { delta: unknown[] };
export type ChatSession = { id: string; title: string; created: number; updated: number; turns: number };
/** A form settled on a particular turn, kept so a reload does not reopen it. */
export type ClosedForm = { turn: number; kind: string; at: number };

// The plain kinds mean the box was dismissed. A _done kind means it was filled, which
// still keeps it closed but must not be reported as a dismissal in the transcript.
export const FORM_KINDS = ["address", "request", "address_done", "request_done"] as const;
export type FormKind = (typeof FORM_KINDS)[number];

export const DEFAULT_CHAT_DB = fileURLToPath(new URL("../data/chats.db", import.meta.url));

const CAPPED = Number(process.env.CHAT_MODEL_TURNS ?? 12);
const NEW_TITLE = "New chat";
const TITLE_CHARS = 52;

function parse<T>(text: string, fallback: T): T {
  try {
    return JSON.parse(text) as T;
  } catch {
    return fallback;
  }
}

/** A title read off the first sentence, because naming a chat should not be homework. */
export function autoTitle(asked: string): string {
  const clean = String(asked ?? "")
    .replace(/\s+/g, " ")
    .trim();
  if (!clean) return NEW_TITLE;
  if (clean.length <= TITLE_CHARS) return clean;
  const cut = clean.slice(0, TITLE_CHARS);
  const space = cut.lastIndexOf(" ");
  return `${(space > 24 ? cut.slice(0, space) : cut).trim()}…`;
}

export function openChats(file: string) {
  if (file !== ":memory:") mkdirSync(dirname(file), { recursive: true });
  const db = new DatabaseSync(file);
  db.exec(`
    create table if not exists turns (
      id integer primary key autoincrement,
      chat text not null,
      asked text not null,
      said text not null,
      steps text not null,
      delta text not null,
      at integer not null
    );
    create index if not exists turns_by_chat on turns(chat, id);
    create table if not exists sessions (
      id text not null,
      owner text not null,
      title text not null,
      created integer not null,
      updated integer not null,
      primary key (owner, id)
    );
    create index if not exists sessions_by_owner on sessions(owner, updated desc);
    create table if not exists closed_forms (
      chat text not null,
      turn integer not null,
      kind text not null,
      at integer not null,
      primary key (chat, turn, kind)
    );
  `);

  /*
   * The first build keyed a session by its id alone, so every wallet's "main" thread
   * collided with every other wallet's and the second visitor got a 500. An id only
   * names a thread inside its owner, so the key is rebuilt as (owner, id) once, with
   * the rows carried across rather than dropped.
   */
  const columns = db.prepare("pragma table_info(sessions)").all() as { name: string; pk: number }[];
  const keyed = columns.filter((c) => Number(c.pk) > 0).map((c) => c.name);
  if (!(keyed.includes("owner") && keyed.includes("id"))) {
    db.exec(`
      drop index if exists sessions_by_owner;
      alter table sessions rename to sessions_single_key;
      create table sessions (
        id text not null,
        owner text not null,
        title text not null,
        created integer not null,
        updated integer not null,
        primary key (owner, id)
      );
      insert into sessions (id, owner, title, created, updated)
        select id, owner, title, created, updated from sessions_single_key;
      drop table sessions_single_key;
      create index sessions_by_owner on sessions(owner, updated desc);
    `);
  }

  const insert = db.prepare("insert into turns (chat, asked, said, steps, delta, at) values (?, ?, ?, ?, ?, ?)");
  const recent = db.prepare("select id, asked, said, steps, at from turns where chat = ? order by id desc limit ?");
  const deltas = db.prepare("select delta from turns where chat = ? order by id desc limit ?");
  const count = db.prepare("select count(*) as n from turns where chat = ?");
  const wipe = db.prepare("delete from turns where chat = ?");
  const firstAsked = db.prepare("select asked from turns where chat = ? order by id asc limit 1");
  const anyTurns = db.prepare("select count(*) as n from turns where chat = ?");
  const moveTurns = db.prepare("update turns set chat = ? where chat = ?");
  const closeTurn = db.prepare(
    "insert into closed_forms (chat, turn, kind, at) values (?, ?, ?, ?) on conflict(chat, turn, kind) do update set at = excluded.at",
  );
  const closedOf = db.prepare("select turn, kind, at from closed_forms where chat = ? order by at desc limit 200");
  const wipeClosed = db.prepare("delete from closed_forms where chat = ?");

  const list = db.prepare(`
    select s.id, s.title, s.created, s.updated,
      (select count(*) from turns t where t.chat = s.owner || '::' || s.id) as turns
    from sessions s
    where s.owner = ?
    order by s.updated desc, s.created desc, s.rowid desc
  `);
  const latest = db.prepare("select id, title, created, updated from sessions where owner = ? order by updated desc, created desc, rowid desc limit 1");
  const owned = db.prepare("select id, title, created, updated from sessions where owner = ? and id = ?");
  const make = db.prepare("insert into sessions (id, owner, title, created, updated) values (?, ?, ?, ?, ?)");
  const retitle = db.prepare("update sessions set title = ?, updated = ? where owner = ? and id = ?");
  const touch = db.prepare("update sessions set updated = ? where owner = ? and id = ?");
  const drop = db.prepare("delete from sessions where owner = ? and id = ?");

  const row = (r: { id: string; title: string; created: number; updated: number }): ChatSession => ({
    id: String(r.id),
    title: String(r.title),
    created: Number(r.created),
    updated: Number(r.updated),
    turns: 0,
  });

  const store = {
    /** Appends one turn and returns its row id, which is what a closed form refers to. */
    append(chat: string, turn: ChatRecord): number {
      const out = insert.run(
        chat,
        turn.asked,
        turn.said,
        JSON.stringify(turn.steps ?? []),
        JSON.stringify(turn.delta ?? []),
        turn.at || Date.now(),
      );
      return Number(out.lastInsertRowid);
    },

    /** What the screen shows, oldest first. Storage keeps everything, the page may cap. */
    turns(chat: string, limit = 200): ChatTurn[] {
      const rows = recent.all(chat, limit) as { id: number; asked: string; said: string; steps: string; at: number }[];
      return rows
        .slice()
        .reverse()
        .map((r) => ({
          id: Number(r.id),
          asked: String(r.asked),
          said: String(r.said),
          steps: parse<StoredStep[]>(String(r.steps), []),
          at: Number(r.at),
        }));
    },

    /**
     * The model sees the last few turns only. One long conversation should not spend
     * the whole context window on the morning, and the display above keeps every turn
     * regardless, so cutting here never deletes what the person can read.
     */
    history(chat: string, maxTurns = CAPPED): unknown[] {
      const rows = deltas.all(chat, Math.max(1, maxTurns)) as { delta: string }[];
      return rows
        .slice()
        .reverse()
        .flatMap((r) => parse<unknown[]>(String(r.delta), []));
    },

    count(chat: string): number {
      const row = count.get(chat) as { n: number } | undefined;
      return Number(row?.n ?? 0);
    },

    clear(chat: string): number {
      const out = wipe.run(chat);
      wipeClosed.run(chat);
      return Number(out.changes ?? 0);
    },

    /**
     * A form a person closed is remembered against the turn that opened it, so coming
     * back to the page shows the transcript rather than the same unanswered question.
     */
    closeForm(chat: string, turn: number, kind: string, at = Date.now()): void {
      closeTurn.run(chat, turn, kind, at);
    },

    closedForms(chat: string): ClosedForm[] {
      const rows = closedOf.all(chat) as { turn: number; kind: string; at: number }[];
      return rows.map((r) => ({ turn: Number(r.turn), kind: String(r.kind), at: Number(r.at) }));
    },

    /** The storage key for one thread inside one owner. */
    key(owner: string, id: string): string {
      return `${owner}::${id}`;
    },

    /**
     * Every owner has at least one thread. The first visit creates "main", and the
     * first visit after this build migrates the old wallet-wide rows into it instead
     * of pretending the conversation never happened.
     */
    ensure(owner: string, wanted?: string, at = Date.now()): ChatSession {
      if (wanted) {
        const hit = owned.get(owner, wanted) as { id: string; title: string; created: number; updated: number } | undefined;
        if (hit) {
          const found = row(hit);
          const rows = list.all(owner) as { id: string; title: string; created: number; updated: number; turns: number }[];
          const match = rows.find((r) => String(r.id) === found.id);
          return { ...found, turns: Number(match?.turns ?? 0) };
        }
      }
      const existing = latest.get(owner) as { id: string; title: string; created: number; updated: number } | undefined;
      if (existing) {
        const rows = list.all(owner) as { id: string; title: string; created: number; updated: number; turns: number }[];
        const match = rows.find((r) => String(r.id) === String(existing.id));
        return { ...row(existing), turns: Number(match?.turns ?? 0) };
      }
      const legacy = Number((anyTurns.get(owner) as { n: number } | undefined)?.n ?? 0);
      const first = firstAsked.get(owner) as { asked: string } | undefined;
      const id = "main";
      const title = legacy > 0 ? autoTitle(String(first?.asked ?? "")) : NEW_TITLE;
      make.run(id, owner, title, at, at);
      if (legacy > 0) moveTurns.run(store.key(owner, id), owner);
      return { id, title, created: at, updated: at, turns: legacy };
    },

    create(owner: string, title = NEW_TITLE, at = Date.now()): ChatSession {
      const id = randomUUID().slice(0, 8);
      make.run(id, owner, title || NEW_TITLE, at, at);
      return { id, title: title || NEW_TITLE, created: at, updated: at, turns: 0 };
    },

    sessions(owner: string): ChatSession[] {
      return (list.all(owner) as { id: string; title: string; created: number; updated: number; turns: number }[]).map(
        (r) => ({ ...row(r), turns: Number(r.turns ?? 0) }),
      );
    },

    rename(owner: string, id: string, title: string, at = Date.now()): ChatSession | null {
      const clean = String(title ?? "").replace(/\s+/g, " ").trim().slice(0, 80);
      if (!clean) return null;
      retitle.run(clean, at, owner, id);
      const hit = owned.get(owner, id) as { id: string; title: string; created: number; updated: number } | undefined;
      return hit ? row(hit) : null;
    },

    /** A turn is when a thread becomes recent and, on its first question, gets a name. */
    touch(owner: string, id: string, asked?: string, at = Date.now()): void {
      const hit = owned.get(owner, id) as { title: string } | undefined;
      if (!hit) return;
      if ((hit.title === NEW_TITLE || !hit.title) && asked?.trim()) retitle.run(autoTitle(asked), at, owner, id);
      else touch.run(at, owner, id);
    },

    remove(owner: string, id: string): number {
      const out = wipe.run(store.key(owner, id));
      wipeClosed.run(store.key(owner, id));
      drop.run(owner, id);
      return Number(out.changes ?? 0);
    },

    close(): void {
      db.close();
    },
  };

  return store;
}

export type ChatStore = ReturnType<typeof openChats>;

/**
 * A demo conversation belongs to one browser, because every visitor shares the demo
 * wallet and a wallet key would hand one judge another judge's transcript. A connected
 * wallet is the opposite: the address is the identity, so the same person on a phone
 * reads what they typed on a laptop.
 */
export function chatKey(): string {
  const s = session();
  if (s.source === "demo") return `demo:${currentSeat()?.id ?? "console"}:${s.network}`;
  return `wallet:${s.wallet.toLowerCase()}:${s.network}`;
}
