import "dotenv/config";
import { readFileSync, appendFileSync } from "node:fs";
import { Ed25519Keypair } from "@mysten/sui/keypairs/ed25519";

const envPath = new URL("../.env", import.meta.url).pathname;
if (readFileSync(envPath, "utf8").includes("AGENT_SECRET_KEY=")) {
  console.log("agent wallet already exists, leaving .env untouched");
  process.exit(0);
}

const kp = Ed25519Keypair.generate();
appendFileSync(
  envPath,
  `\n# testnet-only agent wallet (freshly generated, holds no mainnet funds)\nAGENT_ADDRESS=${kp.toSuiAddress()}\nAGENT_SECRET_KEY=${kp.getSecretKey()}\n`,
);
console.log("created agent wallet");
console.log("address:", kp.toSuiAddress());
