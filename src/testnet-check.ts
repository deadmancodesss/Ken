import "dotenv/config";

const url = process.env.TATUM_SUI_GRAPHQL_URL_TESTNET!;
const key = process.env.TATUM_API_KEY_TESTNET!;
const WALLET = process.env.SUI_ADDRESS || "0xcb8443096332cb1c89faf2b4dd397e77a0749c8ed18ddb1a74bd4ba86ab53535";

const r = await fetch(url, {
  method: "POST",
  headers: { "content-type": "application/json", "x-api-key": key },
  body: JSON.stringify({
    query: `{ address(address:"${WALLET}"){ balances(first:10){ nodes { coinType { repr } totalBalance } } } }`,
  }),
});
const b: any = await r.json();
console.log(JSON.stringify(b.data ?? b.errors, null, 1));
