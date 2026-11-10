import "dotenv/config";
import { Ed25519Keypair } from "@mysten/sui/keypairs/ed25519";
import { Transaction } from "@mysten/sui/transactions";
import { verifyTransactionSignature } from "@mysten/sui/verify";
import {
  amountToBase,
  baseToAmount,
  decodeHeader,
  encodeHeader,
  envelopeFromSigned,
  isUsdc,
  openEnvelope,
  paymentRequired,
  requirementsFor,
  sameVersion,
} from "./x402wire.js";
import { USDC_ASSET } from "./wallet.js";
import { PAY_CHAIN, USDC_COIN } from "./chain.js";

let fails = 0;
const expect = (what: string, ok: boolean) => {
  console.log(`${ok ? "ok   " : "FAIL "} ${what}`);
  if (!ok) fails++;
};
const throws = (fn: () => unknown) => {
  try {
    fn();
    return false;
  } catch {
    return true;
  }
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

  const defaults = requirementsFor({
    resource: "receipt:" + "8tucBNY7DBfADas9BYF4BpCY6R974vgVts9MAcQxZ57J",
    description: "a chain check",
    payTo: "0x" + "55".repeat(32),
    baseUnits: 10_000n,
  });
  expect("terms default to the ledger this build pays on", defaults.network === PAY_CHAIN);
  expect("terms default to the USDC this build settles", defaults.asset === USDC_ASSET);
  expect("terms default to a ten minute window", defaults.maxTimeoutSeconds === 600);
  expect("terms carry the USDC symbol and decimals a wallet needs", defaults.extra.symbol === "USDC" && defaults.extra.decimals === 6);
  expect("terms name the index unless the seller has another name", defaults.extra.name === "Ken paid index" && defaults.extra.quote === undefined);

  const overridden = requirementsFor({
    resource: "profile:" + "0x" + "66".repeat(32),
    description: "another seller",
    payTo: "0x" + "55".repeat(32),
    baseUnits: 30_000n,
    network: "sui:mainnet",
    asset: USDC_COIN.mainnet,
    timeoutSeconds: 30,
    name: "Fixture seller",
    quote: "q2",
  });
  expect("terms can name the other ledger and its USDC", overridden.network === "sui:mainnet" && overridden.asset === USDC_COIN.mainnet);
  expect("terms keep a seller's own window, name and quote", overridden.maxTimeoutSeconds === 30 && overridden.extra.name === "Fixture seller" && overridden.extra.quote === "q2");

  expect("a decimal USDC price becomes base units", amountToBase(0.01) === 10_000n);
  expect("a fractional price keeps all six places", amountToBase(1.234567) === 1_234_567n);
  expect("half a base unit rounds up to one unit", amountToBase(0.0000005) === 1n);
  expect("base units turn back into the quoted price", baseToAmount("10000") === 0.01 && baseToAmount(1_234_567n) === 1.234567);
  expect("USDC is recognised on both ledgers", isUsdc(USDC_COIN.mainnet) && isUsdc(USDC_COIN.testnet));
  expect("a lookalike coin and SUI are not USDC", !isUsdc("0x2::sui::SUI") && !isUsdc("0x0bad::usdc::USDC"));
  expect("a header that is not JSON is refused", throws(() => decodeHeader(Buffer.from("not json").toString("base64"))));
  expect("an empty payment payload is refused", throws(() => openEnvelope("")));
  expect("a payload that is not a signed transaction is refused", throws(() => openEnvelope("AAAA")));
  expect("version 2 is accepted in its published spellings", sameVersion("2") && sameVersion("v2"));
  expect("a version 3 document is refused", !sameVersion(3));

  console.log(fails ? `\n${fails} wire check(s) failed` : "\nall wire checks green, no money moved");
  process.exit(fails ? 1 : 0);
};

run().catch((err) => {
  console.error(err);
  process.exit(1);
});
