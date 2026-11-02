import "dotenv/config";
import { MemWal } from "@mysten-incubation/memwal";

const memwal = MemWal.create({
  key: process.env.MEMWAL_KEY!,
  accountId: process.env.MEMWAL_ACCOUNT_ID!,
  serverUrl: process.env.MEMWAL_SERVER_URL!,
  namespace: "plumbing",
});

const ns: any = await memwal.listNamespaces();
console.log("namespaces:", ns.namespaces?.map((n: any) => `${n.name}(${n.memoryCount ?? "?"})`).join(", "));

let total = 0;
for (const n of ns.namespaces ?? []) {
  let cursor: string | undefined;
  let count = 0;
  do {
    const page: any = await memwal.listMemories({ cursor, namespace: n.name, limit: 100 });
    count += page.memories?.length ?? 0;
    cursor = page.cursor ?? undefined;
  } while (cursor);
  total += count;
  console.log(`${n.name}: ${count}`);
}
console.log("TOTAL MAINNET MEMORIES:", total);
