import { randomBytes } from "node:crypto";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";

/**
 * A request is an ask, never a payment. It holds a recipient, an amount and a line of
 * context, and the person who opens the link signs the transfer in their own wallet.
 * Nothing here can move money, so a leaked link is a sentence rather than a key.
 */
export const DEFAULT_REQUEST_DB = fileURLToPath(new URL("../data/requests.db", import.meta.url));

const ADDRESS = /^0x[0-9a-fA-F]{64}$/;
const ID = /^[A-Za-z0-9_-]{6,16}$/;
const USDC_UNIT = 1_000_000;
export const NOTE_MAX = 90;
export const DEFAULT_MINUTES = 30;
const MIN_MINUTES = 5;
const MAX_MINUTES = 7 * 24 * 60;

export type StoredRequest = {
  id: string;
  to: string;
  note: string;
  usdc: number;
  usdc_text: string;
  owner: string;
  created: number;
  expires_at: number;
  paid_tx: string | null;
  paid_by: string | null;
  paid_at: number | null;
};

/**
 * What anyone holding the link is allowed to see. The creator and payer stay hidden.
 * The deadline is part of the link, so it is disclosed rather than enforced only at
 * the moment somebody tries to pay. A closed link still answers, because a 404 and a
 * page that says "paid" tell the person holding it two very different things.
 */
export function publicRequest(r: StoredRequest, viewer?: { wallet?: string }) {
  const now = Date.now();
  const expired = !r.paid_tx && now >= r.expires_at;
  return {
    id: r.id,
    to: r.to,
    note: r.note,
    usdc: r.usdc,
    usdc_text: r.usdc_text,
    created: r.created,
    expires_at: r.expires_at,
    expires_in: Math.max(0, Math.ceil((r.expires_at - now) / 1000)),
    expired,
    closed: r.paid_tx ? "paid" : expired ? "expired" : null,
    mine: Boolean(viewer?.wallet && viewer.wallet.toLowerCase() === r.to.toLowerCase()),
    link: `/request/${r.id}`,
    paid: r.paid_tx ? { tx: r.paid_tx, at: r.paid_at } : null,
  };
}

export function requestExpired(r: StoredRequest): boolean {
  return !r.paid_tx && Date.now() >= r.expires_at;
}

export function showUsdc(base: number): string {
  const whole = Math.floor(base / USDC_UNIT);
  const frac = String(base % USDC_UNIT).padStart(6, "0").replace(/0+$/, "");
  return frac ? `${whole}.${frac}` : String(whole);
}

/**
 * What the chat remembers after the request form is submitted. The model is not in
 * the room when the person presses the button, so the made link is written into the
 * conversation as a turn it can read on the next question. Without this the agent
 * would not know a link exists and could offer to make a second one.
 */
export function requestTurn(r: StoredRequest): {
  asked: string;
  said: string;
  steps: { name: string; ok: boolean; result: unknown }[];
  delta: { role: "user"; content: string }[];
} {
  const view = publicRequest(r);
  const whatFor = r.note ? ` for "${r.note}"` : "";
  const minutes = Math.max(1, Math.round((r.expires_at - r.created) / 60_000));
  return {
    asked: `made a payment request for ${r.usdc_text} USDC${whatFor}`,
    said: `The link is ready. It asks for ${r.usdc_text} USDC${whatFor} and closes in ${minutes} minutes.`,
    steps: [{ name: "request_money", ok: true, result: view }],
    delta: [
      {
        role: "user",
        content: `A payment request was made in the form. It asks for ${r.usdc_text} USDC${whatFor}. The link is ${view.link} and it closes in ${minutes} minutes. It has not been sent to anyone. Do not make another request unless I ask.`,
      },
    ],
  };
}

function row(r: any): StoredRequest {
  const base = Number(r.usdc_base);
  return {
    id: String(r.id),
    to: String(r.to_addr),
    note: String(r.note ?? ""),
    usdc: base / USDC_UNIT,
    usdc_text: showUsdc(base),
    owner: String(r.by_owner),
    created: Number(r.created),
    expires_at:
      r.expires_at === null || r.expires_at === undefined
        ? Number(r.created) + DEFAULT_MINUTES * 60_000
        : Number(r.expires_at),
    paid_tx: r.paid_tx ? String(r.paid_tx) : null,
    paid_by: r.paid_by ? String(r.paid_by) : null,
    paid_at: r.paid_at === null || r.paid_at === undefined ? null : Number(r.paid_at),
  };
}

let db: DatabaseSync | null | undefined;

function open(): DatabaseSync | null {
  if (db !== undefined) return db;
  try {
    const file = process.env.REQUESTS_DB ?? DEFAULT_REQUEST_DB;
    if (file !== ":memory:") mkdirSync(dirname(file), { recursive: true });
    const made = new DatabaseSync(file);
    made.exec(`create table if not exists requests (
      id text primary key,
      to_addr text not null,
      note text not null,
      usdc_base integer not null,
      by_owner text not null,
      created integer not null,
      expires_at integer,
      paid_tx text,
      paid_by text,
      paid_at integer
    );`);
    /* Links made before the deadline existed had no promised lifetime, so the
       migration gives each one the default it would have been born with. */
    const cols = made.prepare("pragma table_info(requests)").all() as { name?: string }[];
    if (!cols.some((c) => c.name === "expires_at")) {
      made.exec("alter table requests add column expires_at integer");
      made.exec(`update requests set expires_at = created + ${DEFAULT_MINUTES * 60_000} where expires_at is null`);
    }
    db = made;
  } catch (err) {
    console.warn(`request store unavailable (${(err as Error).message}), so links last for this process only`);
    db = null;
  }
  return db;
}

// A link is the one thing that must not evaporate because a disk was read only, so a
// process that cannot write still keeps the requests it made in this map.
const memory = new Map<string, StoredRequest>();

export function makeRequest(input: {
  to: string;
  note?: string;
  usdc: number;
  owner: string;
  minutes?: number;
}): StoredRequest {
  const to = String(input.to ?? "").trim();
  if (!ADDRESS.test(to)) throw new Error("a request needs a full Sui address to land in");
  const usdc = Number(input.usdc);
  if (!Number.isFinite(usdc) || usdc <= 0) throw new Error("a request needs an amount above zero");
  const base = Math.round(usdc * USDC_UNIT);
  if (base <= 0) throw new Error("that amount is smaller than the smallest USDC unit");
  const note = String(input.note ?? "").trim().slice(0, NOTE_MAX);
  const owner = String(input.owner ?? "").trim();
  if (!owner) throw new Error("a request has to belong to a browser or a wallet");

  const asked = Number(input.minutes);
  const minutes = Number.isFinite(asked)
    ? Math.min(MAX_MINUTES, Math.max(MIN_MINUTES, Math.round(asked)))
    : DEFAULT_MINUTES;
  let id = randomBytes(8).toString("base64url");
  for (let tries = 0; tries < 4 && findRequest(id); tries++) id = randomBytes(8).toString("base64url");
  const created = Date.now();
  const made: StoredRequest = {
    id,
    to,
    note,
    usdc: base / USDC_UNIT,
    usdc_text: showUsdc(base),
    owner,
    created,
    expires_at: created + minutes * 60_000,
    paid_tx: null,
    paid_by: null,
    paid_at: null,
  };
  memory.set(id, made);
  const store = open();
  if (store) {
    try {
      store
        .prepare(
          "insert into requests (id, to_addr, note, usdc_base, by_owner, created, expires_at, paid_tx, paid_by, paid_at) values (?, ?, ?, ?, ?, ?, ?, null, null, null)",
        )
        .run(id, to, note, base, owner, made.created, made.expires_at);
    } catch {
      // The map above still answers this link for the life of the process.
    }
  }
  return made;
}

export function findRequest(id: string): StoredRequest | null {
  if (!ID.test(id)) return null;
  const store = open();
  if (!store) return memory.get(id) ?? null;
  try {
    const r = store.prepare("select * from requests where id = ?").get(id);
    return r ? row(r) : (memory.get(id) ?? null);
  } catch {
    return memory.get(id) ?? null;
  }
}

export function requestsBy(owner: string, limit = 12): StoredRequest[] {
  const store = open();
  if (!store) {
    return [...memory.values()]
      .reverse()
      .sort((a, b) => b.created - a.created)
      .filter((r) => r.owner === owner)
      .slice(0, limit);
  }
  try {
    const rows = store
      .prepare("select * from requests where by_owner = ? order by created desc, rowid desc limit ?")
      .all(owner, limit);
    return rows.map(row);
  } catch {
    return [];
  }
}

/**
 * Only the first accepted digest is kept. The wallet can report the same payment
 * twice, and a request that flipped from paid back to open would ask for the money
 * a second time.
 */
export function digestTaken(digest: string, exceptId: string): boolean {
  const store = open();
  if (!store) return [...memory.values()].some((r) => r.paid_tx === digest && r.id !== exceptId);
  try {
    const hit = store.prepare("select id from requests where paid_tx = ? and id != ? limit 1").get(digest, exceptId);
    return !!hit;
  } catch {
    return false;
  }
}

export function markRequestPaid(id: string, digest: string, payer: string): StoredRequest | null {
  const found = findRequest(id);
  if (!found) return null;
  if (found.paid_tx) return found;
  const paidAt = Date.now();
  found.paid_tx = digest;
  found.paid_by = payer;
  found.paid_at = paidAt;
  memory.set(id, found);
  const store = open();
  if (store) {
    try {
      store
        .prepare("update requests set paid_tx = ?, paid_by = ?, paid_at = ? where id = ? and paid_tx is null")
        .run(digest, payer, paidAt, id);
    } catch {
      /* the map still answers, and the chain remains the proof that money moved */
    }
  }
  return found;
}
