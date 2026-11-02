import "dotenv/config";
import { MemWal } from "@mysten-incubation/memwal";

const id = process.env.MEMWAL_ACCOUNT_ID?.trim() ?? "";
const key = process.env.MEMWAL_KEY?.trim() ?? "";

const relayers = [
  "https://relayer.memory.walrus.xyz",
  "https://relayer-staging.memory.walrus.xyz",
];

for (const serverUrl of relayers) {
  const tag = serverUrl.includes("staging") ? "STAGING" : "MAINNET";
  try {
    const m = MemWal.create({ key, accountId: id, serverUrl, namespace: "plumbing" });
    const health = await m.health();
    const info = `health=${health.status} write_ready=${String(health.write_ready)}`;
    try {
      const ns = await m.listNamespaces();
      console.log(`${tag} listNamespaces OK   ${info} -> ${JSON.stringify(ns).slice(0, 220)}`);
    } catch (err) {
      console.log(`${tag} listNamespaces 401  ${info} -> ${String((err as Error).message).slice(0, 90)}`);
    }
  } catch (err) {
    console.log(`${tag} setup threw -> ${(err as Error).message.slice(0, 200)}`);
  }
  await new Promise((r) => setTimeout(r, 2500));
}
