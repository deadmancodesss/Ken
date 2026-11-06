import "dotenv/config";
import { Ed25519Keypair } from "@mysten/sui/keypairs/ed25519";
import { Transaction } from "@mysten/sui/transactions";
import { verifyTransactionSignature } from "@mysten/sui/verify";
import {
  decodeHeader,
  encodeHeader,
  envelopeFromSigned,
  openEnvelope,
  paymentRequired,
  requirementsFor,
  sameVersion,
} from "./x402wire.js";
import { USDC_ASSET } from "./wallet.js";
import { PAY_CHAIN } from "./chain.js";

let fails = 0;
const expect = (what: string, ok: boolean) => {
  console.log(`${ok ? "ok   " : "FAIL "} ${what}`);
  if (!ok) fails++;
};

/* A transaction built without a reader: every coin and gas object is written down, so
 * the bytes are complete and the signature path can be exercised without the chain. */
const txFor = (sender: string, to: string) => {
  const tx = new Transaction();
  tx.setSender(sender);
  tx.setGasPrice(1000);
  tx.setGasBudget(10_000_000);
  tx.setGasPayment([{ objectId: "0x" + "11".repeat(32), version: "1", digest: "11111111111111111111111111111111" }]);
  tx.transferObjects([tx.objectRef({ objectId: "0x" + "22".repeat(32), version: "1", digest: "11111111111111111111111111111111" })], to);
  return tx;
};

const run = async () => {
  const key = Ed25519Keypair.generate();
  const sender = key.toSuiAddress();
  const to = "0x" + "33".repeat(32);
  const bytes = await txFor(sender, to).build();
  const bytesBase64 = Buffer.from(bytes).toString("base64");
  const signature = (await key.signTransaction(bytes)).signature;
  const envelope = envelopeFromSigned(bytesBase64, signature);
  const opened = openEnvelope(envelope);

  expect("the envelope opens", opened.transaction.length === bytes.length);
  expect("the sender survives the round trip", opened.sender === sender);
  expect("the signature survives the round trip", opened.signatures[0] === signature);
  expect("the fingerprint is a sha256", /^[0-9a-f]{64}$/.test(opened.fingerprint));

  const pub = await verifyTransactionSignature(opened.transaction, opened.signatures[0], { address: sender });
  expect("the signature verifies against the transaction", pub.toSuiAddress() === sender);

  const wrong = Ed25519Keypair.generate().toSuiAddress();
  let refused = false;
  try {
    await verifyTransactionSignature(opened.transaction, opened.signatures[0], { address: wrong });
  } catch {
    refused = true;
  }
  expect("the signature is refused for a different sender", refused);

  let tampered = false;
  try {
    const bad = Buffer.from(opened.transaction);
    bad[bad.length - 1] ^= 0xff;
    await verifyTransactionSignature(bad, opened.signatures[0], { address: sender });
  } catch {
    tampered = true;
  }
  expect("a changed transaction is refused", tampered);

  const requirements = requirementsFor({
    resource: "profile:0x" + "44".repeat(32),
    description: "a chain profile",
    payTo: "0x" + "55".repeat(32),
    baseUnits: 10_000n,
    quote: "q1",
  });
  const required = paymentRequired({
    error: "payment required",
    url: "http://127.0.0.1:8788/paid",
    description: "a chain profile",
    accepts: [requirements],
  });
  const header = encodeHeader(required);
  const back = decodeHeader<typeof required>(header);
  expect("the 402 header carries the protocol version", back.x402Version === 2);
  expect("the 402 header carries the exact scheme", back.accepts[0].scheme === "exact");
  expect("the 402 header carries the network", back.accepts[0].network === PAY_CHAIN);
  expect("the 402 header carries the asset", back.accepts[0].asset === USDC_ASSET);
  expect("the 402 header carries the amount in base units", back.accepts[0].amount === "10000");
  expect("the 402 header carries the quote", back.accepts[0].extra.quote === "q1");
  expect("a version 2 document is accepted", sameVersion(2));
  expect("an older version is refused", !sameVersion(1));

  console.log(fails ? `\n${fails} wire check(s) failed` : `\nall ${fails ? "" : "14 "}wire checks green, no money moved`);
  process.exit(fails ? 1 : 0);
};

run().catch((err) => {
  console.error(err);
  process.exit(1);
});
