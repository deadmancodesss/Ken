import "dotenv/config";

const url = process.env.TATUM_SUI_GRAPHQL_URL!;
const key = process.env.TATUM_API_KEY!;
const q = process.argv[2];
if (!q) throw new Error("pass a graphql query as argv[2]");

const r = await fetch(url, {
  method: "POST",
  headers: { "content-type": "application/json", "x-api-key": key },
  body: JSON.stringify({ query: q }),
});
const b: any = await r.json().catch(() => ({}));
if (b.errors?.length) console.log("ERR:", b.errors.map((e: any) => e.message).join(" | "));
if (b.data) console.log(JSON.stringify(b.data, null, 1).slice(0, 3000));
