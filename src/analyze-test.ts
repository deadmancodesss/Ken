import "dotenv/config";
import { MemWal } from "@mysten-incubation/memwal";

const memwal = MemWal.create({
  key: process.env.MEMWAL_KEY!,
  accountId: process.env.MEMWAL_ACCOUNT_ID!,
  serverUrl: process.env.MEMWAL_SERVER_URL!,
  namespace: "selftest",
});

const text = `Conversation on a Tuesday evening:
User: I sent 18 USDC to the landlord alias "V" again, that's the second month in a row on the 2nd.
Agent: Noted. Anything unusual?
User: Yes, I signed an unlimited token approval for an app I didn't recognise, then revoked it ten minutes later after the warning.
User: Also I always pay "V" late when the 2nd falls on a weekend, so remind me the Thursday before.`;

console.log("analyzeAndWait …");
const res: any = await memwal.analyzeAndWait(text, "selftest");
console.log(JSON.stringify(res, null, 1).slice(0, 4000));

console.log("\nrecall 'landlord' …");
const recall: any = await memwal.recall({ query: "landlord payment timing" });
console.log(JSON.stringify(recall, null, 1).slice(0, 3000));
