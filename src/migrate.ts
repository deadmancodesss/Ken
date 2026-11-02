import "dotenv/config";
import { MemWal } from "@mysten-incubation/memwal";
import { LEGACY, scope } from "./scope.js";
import { useDemoWallet } from "./session.js";

/**
 * One-off move from the shared namespaces to per-wallet ones. It rewrites the same
 * facts, only changing where they are filed and swapping stored em dashes for
 * commas, so the old records stay on chain unread and this can run twice safely.
 *
 *   npx tsx src/migrate.ts
 */
const ACCOUNT = {
  key: process.env.MEMWAL_KEY!,
  accountId: process.env.MEMWAL_ACCOUNT_ID!,
  serverUrl: process.env.MEMWAL_SERVER_URL!,
};

const clean = (text: string) => text.replace(/[—–]/g, ",").replace(/,\s*,/g, ",").replace(/\s{2,}/g, " ").trim();

async function readAll(namespace: string, query: string) {
  const wal = MemWal.create({ ...ACCOUNT, namespace });
  const res: any = await wal.recall({ query, namespace, limit: 100 });
  return (res.results ?? []) as { text: string; blob_id: string }[];
}

async function writeAll(namespace: string, texts: string[]) {
  const wal = MemWal.create({ ...ACCOUNT, namespace });
  const written: string[] = [];
  for (const text of texts) {
    const res: any = await wal.rememberAndWait(text, { idempotencyKey: text.replace(/\W/g, "").slice(0, 120) });
    written.push(res.blob_id ?? "");
    console.log("wrote", namespace, "|", text.slice(0, 72));
  }
  return written;
}

async function main() {
  useDemoWallet();
  const into = { people: scope("people"), counterparties: scope("counterparties") };
  console.log("demo session", into);

  const people = await readAll(LEGACY.people, "Person");
  const peopleTexts = [...new Set(people.map((p) => clean(p.text)).filter((t) => /^Person "/.test(t)))];
  console.log(`legacy ${LEGACY.people}: ${peopleTexts.length} person lines`);
  await writeAll(into.people, peopleTexts);

  const parties = await readAll(LEGACY.counterparties, "counterparty");
  const partyTexts = [...new Set(parties.map((p) => clean(p.text)))];
  console.log(`legacy ${LEGACY.counterparties}: ${partyTexts.length} money lines`);
  await writeAll(into.counterparties, partyTexts);

  console.log("done");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
