import "dotenv/config";
import { SuiGraphQLClient } from "@mysten/sui/graphql";
import { Ed25519Keypair } from "@mysten/sui/keypairs/ed25519";

/**
 * Does in a script what an extension does in a popup: takes the bytes the page was
 * shown, signs them, and submits. Used to drive the settle path with a real digest.
 */
async function main() {
  const held: any = await fetch("http://127.0.0.1:8787/pending").then((r) => r.json());
  const p = held.pending;
  if (!p) throw new Error("nothing is waiting for a signature");

  const bytes = Uint8Array.from(Buffer.from(p.bytes, "base64"));
  const key = Ed25519Keypair.fromSecretKey(process.env.AGENT_SECRET_KEY!);
  const sig = await key.signTransaction(bytes);
  // signTransaction already hands back base64 of the scheme bytes, so re-encoding it
  // here is what makes the node answer "invalid signature format".
  const suiSig = sig.signature;

  const client = new SuiGraphQLClient({
    url: process.env.TATUM_SUI_GRAPHQL_URL_TESTNET!,
    network: "testnet",
    headers: { "x-api-key": process.env.TATUM_API_KEY_TESTNET! },
  });

  const res: any = await client.query({
    query:
      "mutation($b: Base64!, $s: [Base64!]!){ executeTransaction(transactionDataBcs:$b, signatures:$s){ effects { digest status } } }",
    variables: {
      b: Buffer.from(bytes).toString("base64"),
      s: [suiSig],
    },
  });
  console.log(JSON.stringify(res).slice(0, 600));
}

void main();
