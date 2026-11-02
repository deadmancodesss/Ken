import { randomBytes } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { USDC_DECIMALS, paymentCap } from "./wallet.js";

/**
 * Everything the paid index sells so far was written by the index: a stand-in tagging
 * API, a fixed price, a payout address in the environment. This file is the other half
 * of the protocol, where the person writes the thing behind the wall, sets the price
 * and names the wallet the money has to reach. The handshake does not change at all,
 * which is the point of doing it over 402 rather than inventing a payments page.
 */
export type Note = {
  id: string;
  title: string;
  body: string;
  usdc: number;
  pay_to: string;
  created: string;
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

const MAX_TITLE = 90;
const MAX_BODY = 6000;

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
export function createNote(input: { title?: unknown; body?: unknown; usdc?: unknown; payTo?: unknown }): Note {
  const title = String(input.title ?? "").replace(/\s+/g, " ").trim().slice(0, MAX_TITLE);
  const body = String(input.body ?? "").replace(/\r\n/g, "\n").trim().slice(0, MAX_BODY);
  const payTo = String(input.payTo ?? "").trim().toLowerCase();
  const usdc = Number(input.usdc);
  const units = Math.round(usdc * 10 ** USDC_DECIMALS);

  if (!title) throw new Error("a link needs a title, or the person on the other side has nothing to decide about");
  if (body.length < 20) throw new Error("there has to be something behind the wall. Write at least a couple of sentences");
  if (!ADDRESS.test(payTo)) throw new Error("the money needs a full 0x Sui testnet address to arrive at");
  if (!Number.isFinite(usdc) || !Number.isInteger(units) || units <= 0) {
    throw new Error(`the price has to be a whole number of USDC cents above zero, and ${input.usdc} is not`);
  }
  if (usdc > paymentCap()) throw new Error(`the ceiling on one signature is ${paymentCap()} USDC, so a link cannot ask for ${usdc}`);

  const all = read();
  let id = "";
  do id = randomBytes(6).toString("hex");
  while (all[id]);

  const made: Note = { id, title, body, usdc: units / 10 ** USDC_DECIMALS, pay_to: payTo, created: new Date().toISOString() };
  all[id] = made;
  write(all);
  return made;
}
