import type { Sale } from "./x402.js";
import type { Note } from "./notes.js";

/**
 * The product claim is that a memory is worth something, and the only version of that
 * sentence a reviewer can check is a number: what other wallets have paid into this
 * person's address for lines this person already keeps. So the count gets its own file,
 * away from the route that prints it, because a figure about money that cannot be tested
 * one row at a time is a figure somebody has to take on trust.
 */

export type Trail = { from: string; address: string; usdc: number; on: string; tx: string };

export type EarnedRow = {
  id: string;
  title: string;
  usdc: number;
  pay_to: string;
  created: string;
  link: string;
  /** Whether the words behind this wall were a line out of the store or typed for it. */
  from_memory: boolean;
  opened: number;
  earned: number;
  money: Trail[];
};

export type Earnings = {
  wallet: string;
  rows: EarnedRow[];
  total: number;
  into_this_wallet: number;
  links: number;
  bought: number;
};

/**
 * Sums are kept at the precision USDC actually carries. Adding three one cent payments
 * in floating point gives 0.030000000000000002, and a page that prints that makes a
 * reader wonder whether the money was measured or guessed. Rounding to cents instead
 * would be wrong in the other direction, because a link may be priced at half a cent.
 */
const exact = (n: number) => Math.round(n * 10 ** 6) / 10 ** 6;

/**
 * What a link has been paid, from its receipts only. Nothing here looks at the chain or
 * at the notes file, so the caller decides which receipts exist to be counted and a test
 * can hand over a payment that never happened and check the arithmetic refuses to invent
 * a second one.
 */
export function tally(all: Note[], sales: (resource: string) => Sale[], wallet: string, name: (address: string) => string): Earnings {
  const rows: EarnedRow[] = all.map((n) => {
    const paid = sales(`note:${n.id}`);
    const money: Trail[] = paid
      .map((s) => ({ from: name(s.payer), address: s.payer, usdc: s.usdc, on: s.at, tx: s.digest }))
      // Newest money first, because a person reading this list is asking what happened,
      // and an older payment above a newer one reads as a total that has stopped moving.
      .sort((a, b) => (a.on < b.on ? 1 : a.on > b.on ? -1 : 0));
    return {
      id: n.id,
      title: n.title,
      usdc: n.usdc,
      pay_to: n.pay_to,
      created: n.created,
      link: `/ask/${n.id}`,
      from_memory: !!n.blob,
      opened: paid.length,
      earned: exact(money.reduce((t, m) => t + m.usdc, 0)),
      money,
    };
  });

  const total = exact(rows.reduce((t, r) => t + r.earned, 0));
  const own = rows.filter((r) => r.pay_to.toLowerCase() === wallet.toLowerCase());
  return {
    wallet,
    rows,
    total,
    /*
     * Kept apart from the total because a link can be made to pay an address other than
     * the wallet this page is narrating, and one headline figure would credit that money
     * to whoever is looking at the screen. A list of earnings that overstates what is in
     * your own wallet is the exact kind of number this product was built to stop making.
     */
    into_this_wallet: exact(own.reduce((t, r) => t + r.earned, 0)),
    links: rows.length,
    bought: rows.filter((r) => r.opened > 0).length,
  };
}
