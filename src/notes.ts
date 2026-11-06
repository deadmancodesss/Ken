import { randomBytes } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { PAY_NET } from "./chain.js";
import { USDC_DECIMALS, paymentCap } from "./wallet.js";

/**
 * The index sells facts it can derive from the chain: a measured profile and a
 * transaction receipt. This file is the other half of the protocol, where a person
 * writes the thing behind the wall, sets the price and names the wallet the money has
 * to reach. The handshake does not change at all, which is the point of doing it over
 * 402 rather than inventing a payments page.
 */
export type Note = {
  id: string;
  title: string;
  body: string;
  usdc: number;
  pay_to: string;
  created: string;
  /**
   * Set when the words were not written for the link but copied out of this wallet's
   * own Walrus store. A link with a blob id beside it is a claim about memory rather
   * than a claim about writing, so the id is kept in the record: it is the thing that
   * lets a reader check the sentence against the store instead of taking the page's
   * word for it.
   */
  blob?: string;
};

/**
 * A note is somebody's writing, so the checks are run against a scratch file rather
 * than against the links on this machine. The demo's own notes are never a test fixture.
 */
const FILE = process.env.NOTES_FILE ?? new URL("../data/notes.json", import.meta.url).pathname;
const ADDRESS = /^0x[0-9a-fA-F]{64}$/;

/**
 * Twelve lowercase characters from six random bytes. The alphabet is lowercase on
 * purpose: the index folds every resource name to lower case before it looks anything
 * up, so a link id that could be written two ways is a link that pays for an answer it
 * can never be given. Long enough that nobody walks the links by guessing.
 */
export const NOTE_ID = /^[a-z0-9]{12}$/;

/**
 * Walrus blob ids as the MemWal relayer returns them: a thirty two byte hash written
 * in unpadded base64url, which is exactly forty three characters of letters, digits,
 * a dash and an underscore. Measured rather than guessed, because the relayer also
 * hands out a twelve character memory_id beside it and mistaking one for the other
 * produces a link that can never read the line it names.
 */
export const BLOB_ID = /^[A-Za-z0-9_-]{43}$/;

const MAX_TITLE = 90;
const MAX_BODY = 6000;

/**
 * A memory line has no title, because it was written to be read back rather than to be
 * sold, so one has to be given before the line can be offered. Naming happens in this
 * file rather than in the page so a link always carries the same words over the same
 * line, and a person reading a list of links can tell a name from a payment from a
 * chain check without opening any of them. A Person line is titled with the person and
 * not the record, because the name is what the buyer is deciding about.
 */
export function titleFor(text: string): string {
  const person = /^Person "(.+?)" = /.exec(text)?.[1];
  if (person) return `what I know about ${person}`;

  const counterparty = /^Counterparty (0x[0-9a-fA-F]{64})/.exec(text)?.[1];
  if (counterparty) return `what I know about ${counterparty.slice(0, 10)}…`;

  const paid = /^Paid \S+ \S+ to (.+?) on (\d{4}-\d{2}-\d{2})/.exec(text);
  if (paid) {
    // The amount is left out of the title on purpose. A buyer decides whether the
    // sentence is worth a cent, and a number that turns out to be the payment rather
    // than the price is a number that gets read twice.
    const named = paid[1].match(/\(([^)]+)\)/)?.[1] ?? paid[1];
    const who = /^0x[0-9a-fA-F]{64}$/.test(named) ? named.slice(0, 10) + "…" : named;
    return `the payment to ${who} on ${paid[2]}`;
  }

  const receipt = /^Chain receipt for (\S+)/.exec(text)?.[1];
  if (receipt) return `a chain check of ${receipt.slice(0, 10)}…`;

  return text.split(". ")[0];
}

function read(): Record<string, Note> {
  if (!existsSync(FILE)) return {};
  try {
    const raw = JSON.parse(readFileSync(FILE, "utf8")) as { notes?: Record<string, Note> };
    return raw.notes ?? {};
  } catch {
    return {};
  }
}

function write(all: Record<string, Note>): void {
  writeFileSync(FILE, JSON.stringify({ notes: all }, null, 1));
}

export function notes(): Note[] {
  return Object.values(read()).sort((a, b) => b.created.localeCompare(a.created));
}

export function note(id: string): Note | undefined {
  return NOTE_ID.test(String(id)) ? read()[String(id)] : undefined;
}

/**
 * The limits here are the ones that keep a link usable rather than ones that keep
 * anybody safe: a title that fits a card, words that fit a page, and an amount the
 * wallet is allowed to be asked to sign at all. A price above the payment ceiling
 * would produce a link that pays itself into an error, so it is refused at writing.
 */
export function createNote(input: {
  title?: unknown;
  body?: unknown;
  usdc?: unknown;
  payTo?: unknown;
  blob?: unknown;
}): Note {
  const title = String(input.title ?? "").replace(/\s+/g, " ").trim().slice(0, MAX_TITLE);
  const body = String(input.body ?? "").replace(/\r\n/g, "\n").trim().slice(0, MAX_BODY);
  const payTo = String(input.payTo ?? "").trim().toLowerCase();
  const usdc = Number(input.usdc);
  const units = Math.round(usdc * 10 ** USDC_DECIMALS);
  // Absent rather than empty, because a stored link that carries a blank blob field
  // would read as a memory line whose memory cannot be found.
  const blob = input.blob === undefined || input.blob === null || input.blob === "" ? "" : String(input.blob).trim();

  if (!title) throw new Error("a link needs a title, or the person on the other side has nothing to decide about");
  if (blob && !BLOB_ID.test(blob)) throw new Error(`${blob} is not a Walrus blob id, so this link cannot claim to be a line out of your memory`);
  if (body.length < 20) {
    throw new Error(
      blob
        ? `that line is ${body.length} characters, and a memory that short is not worth a stranger's cent`
        : "there has to be something behind the wall. Write at least a couple of sentences",
    );
  }
  if (!ADDRESS.test(payTo)) throw new Error(`the money needs a full 0x Sui ${PAY_NET} address to arrive at`);
  if (!Number.isFinite(usdc) || !Number.isInteger(units) || units <= 0) {
    throw new Error(`the price has to be a whole number of USDC cents above zero, and ${input.usdc} is not`);
  }
  if (usdc > paymentCap()) throw new Error(`the ceiling on one signature is ${paymentCap()} USDC, so a link cannot ask for ${usdc}`);

  const all = read();
  let id = "";
  do id = randomBytes(6).toString("hex");
  while (all[id]);

  const made: Note = { id, title, body, usdc: units / 10 ** USDC_DECIMALS, pay_to: payTo, created: new Date().toISOString() };
  if (blob) made.blob = blob;
  all[id] = made;
  write(all);
  return made;
}
