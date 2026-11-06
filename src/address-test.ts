/**
 * The typed address is the one place this product asks a person to type something that
 * matters, so it is tested without a wallet, a model or a browser. The rules are the
 * product: a full address or nothing, one name per address, one address per name, and a
 * payment that fails must not also throw away the name that was just kept.
 */
import { cleanAddress, keepAddress, maskAddress, keptTurn, type AddressDeps, type Named } from "./address.js";
import { addressNeed, SUI_ADDRESS } from "../public/format.js";

const checks: string[] = [];
function expect(label: string, ok: boolean) {
  checks.push(`${ok ? "ok  " : "FAIL"} ${label}`);
  if (!ok) throw new Error(label);
}

const A = "0x" + "a".repeat(64);
const B = "0x" + "b".repeat(64);

/*
 * The space a person pastes an address into is the space that adds a newline, and a
 * newline at the end has already cost one real payment its build. Trimming is not
 * cosmetic here.
 */
expect("a full address is accepted", cleanAddress(A) === A);
expect("surrounding whitespace is trimmed rather than refused", cleanAddress(`  ${A}\n`) === A);
expect("the browser helper agrees on what a full address is", SUI_ADDRESS.test(A) && !SUI_ADDRESS.test(A.slice(0, -1)));
expect("an empty address is refused", (() => { try { cleanAddress(""); return false; } catch { return true; } })());
expect("a bare 0x is refused", (() => { try { cleanAddress("0x"); return false; } catch { return true; } })());
expect("one hex character short is refused", (() => { try { cleanAddress(A.slice(0, -1)); return false; } catch { return true; } })());
expect("an address without 0x is refused", (() => { try { cleanAddress(A.slice(2)); return false; } catch { return true; } })());
expect("a name in the address slot is refused", (() => { try { cleanAddress("Ravi"); return false; } catch { return true; } })());
expect("a non hex character is refused", (() => { try { cleanAddress("0x" + "g".repeat(64)); return false; } catch { return true; } })());
expect("the refusal says what a Sui address is", (() => { try { cleanAddress("0x12"); return false; } catch (err) { return /64 hex characters/.test((err as Error).message); } })());
expect("the mask keeps both ends and hides the middle", maskAddress(A) === "0xaaaaaa…aaaaaa");

/*
 * The page may hear two needs in one turn. find_person reports the name, pay_usdc
 * reports the name and the amount, and the field has to end up carrying the amount.
 */
const needOfName = { needs_address: true, who: "Ravi", looks_like_address: false };
const needOfPay = { needs_address: true, who: "Ravi", looks_like_address: false, amount: 2.5 };
expect("a name miss alone opens the field without an amount", addressNeed([{ result: needOfName }])?.amount === null);
expect("a payment miss carries the amount into the field", addressNeed([{ result: needOfPay }])?.amount === 2.5);
expect("the amount bearing need wins over the bare name", addressNeed([{ result: needOfName }, { result: needOfPay }])?.amount === 2.5);
expect("the same choice holds in the other order", addressNeed([{ result: needOfPay }, { result: needOfName }])?.amount === 2.5);
expect("a partial address is flagged so it is never written as a name", addressNeed([{ result: { ...needOfPay, who: "0xabc", looks_like_address: true } }])?.looksLikeAddress === true);
expect("an ordinary tool result asks for nothing", addressNeed([{ result: { alias: "Sana", address: A } }]) === null);
expect("no steps at all asks for nothing", addressNeed([]) === null && addressNeed(undefined) === null);
expect("a need with no person is ignored rather than drawn as an empty heading", addressNeed([{ result: { needs_address: true } }]) === null);
expect("a failed step carries no need", addressNeed([{ result: undefined, error: "boom" }]) === null);

function deps(over: Partial<AddressDeps> = {}) {
  const calls = { label: [] as [string, string][], pay: [] as [string, number][] };
  const base: AddressDeps = {
    byName: async () => null,
    byAddress: async () => null,
    label: async (name, address) => {
      calls.label.push([name, address]);
      return { alias: name, address };
    },
    pay: async (to, usdc) => {
      calls.pay.push([to, usdc]);
      return { awaiting_signature: true, usdc, to };
    },
  };
  return { deps: { ...base, ...over }, calls };
}

const keptNew = await (async () => {
  const d = deps();
  const kept = await keepAddress({ name: "Ravi", address: ` ${A} ` }, d.deps);
  return { kept, calls: d.calls };
})();
expect("a new name is labelled against the trimmed address", keptNew.calls.label.length === 1 && keptNew.calls.label[0][1] === A);
expect("the kept person comes back for the screen", keptNew.kept.person?.alias === "Ravi" && keptNew.kept.person?.address === A);
expect("naming alone never prepares a payment", keptNew.kept.payment === null && keptNew.calls.pay.length === 0);
expect("naming alone reports no payment error", keptNew.kept.payment_error === "");

const paidNew = await (async () => {
  const d = deps();
  const kept = await keepAddress({ name: "Ravi", address: A, usdc: "2.5" }, d.deps);
  return { kept, calls: d.calls };
})();
expect("an amount on the same form prepares the payment after the name", paidNew.calls.pay.length === 1 && paidNew.calls.pay[0][0] === "Ravi" && paidNew.calls.pay[0][1] === 2.5);
expect("the prepared payment travels back with the kept name", (paidNew.kept.payment as { awaiting_signature?: boolean })?.awaiting_signature === true);

const same = await (async () => {
  const d = deps({
    byName: async (name): Promise<Named> => ({ alias: name, address: A }),
    byAddress: async (): Promise<Named> => ({ alias: "Ravi", address: A }),
  });
  const kept = await keepAddress({ name: "Ravi", address: A }, d.deps);
  return { kept, calls: d.calls };
})();
expect("a name and address already known are not labelled twice", same.calls.label.length === 0 && same.kept.person?.alias === "Ravi");

const moved = await (async () => {
  const d = deps({ byName: async (name): Promise<Named> => ({ alias: name, address: B }) });
  try {
    await keepAddress({ name: "Ravi", address: A }, d.deps);
    return "kept";
  } catch (err) {
    return (err as Error).message;
  }
})();
expect("a name already kept at a different address is refused", /different address/.test(moved));
expect("the refusal shows the old address masked, not the one being typed", /0xbbbbbb…bbbbbb/.test(moved) && !moved.includes(A));

const taken = await (async () => {
  const d = deps({ byAddress: async (): Promise<Named> => ({ alias: "Sana", address: A }) });
  try {
    await keepAddress({ name: "Ravi", address: A }, d.deps);
    return "kept";
  } catch (err) {
    return (err as Error).message;
  }
})();
expect("an address already kept under another name is refused", /already kept as Sana/.test(taken));

const caseSame = await (async () => {
  const d = deps({
    byName: async (): Promise<Named> => ({ alias: "Ravi", address: A }),
    byAddress: async (): Promise<Named> => ({ alias: "ravi", address: A }),
  });
  const kept = await keepAddress({ name: "RAVI", address: A }, d.deps);
  return { kept, calls: d.calls };
})();
expect("the same name in different case is the same name", caseSame.calls.label.length === 0 && caseSame.kept.person?.alias === "Ravi");

const addressOnly = await (async () => {
  const d = deps();
  const kept = await keepAddress({ address: A, usdc: 1 }, d.deps);
  return { kept, calls: d.calls };
})();
expect("an address with no name is not labelled", addressOnly.calls.label.length === 0 && addressOnly.kept.person === null);
expect("an unnamed address still receives the payment", addressOnly.calls.pay[0][0] === A && addressOnly.calls.pay[0][1] === 1);

const typedAsName = await (async () => {
  const d = deps();
  const kept = await keepAddress({ name: A, address: A }, d.deps);
  return { kept, calls: d.calls };
})();
expect("a pasted address in the name slot is not written to memory as a name", typedAsName.calls.label.length === 0 && typedAsName.kept.person === null);

const failedPay = await (async () => {
  const d = deps({
    pay: async () => {
      throw new Error("the transfer builder found less than 0.02 testnet USDC");
    },
  });
  const kept = await keepAddress({ name: "Ravi", address: A, usdc: 0.02 }, d.deps);
  return kept;
})();
expect("a failed payment keeps the name that already succeeded", failedPay.person?.alias === "Ravi");
expect("a failed payment is reported beside the name, not instead of it", /less than 0.02/.test(failedPay.payment_error));
expect("a failed payment returns no payment object", failedPay.payment === null);

const noAmount = await (async () => {
  const d = deps();
  const kept = await keepAddress({ name: "Ravi", address: A, usdc: "not money" }, d.deps);
  return { kept, calls: d.calls };
})();
expect("an unreadable amount names the person and does not pay", noAmount.kept.person?.alias === "Ravi" && noAmount.calls.pay.length === 0);
const negative = await (async () => {
  const d = deps();
  await keepAddress({ name: "Ravi", address: A, usdc: -3 }, d.deps);
  return d.calls;
})();
expect("a negative amount is not a payment", negative.pay.length === 0);

const waitingRow = keptTurn({ person: { alias: "Ravi", address: A }, address: A, payment: { awaiting_signature: true, usdc: 2.5 }, payment_error: "" });
expect("the row says the transfer is waiting for a signature", /waiting for your signature/.test(waitingRow.said));
expect("the row never prints the full address", !waitingRow.said.includes(A) && !waitingRow.asked.includes(A));
expect("the row shows the masked address instead", waitingRow.said.includes("0xaaaaaa…aaaaaa"));
expect("the model history carries the full address, because the next turn needs it", String((waitingRow.delta[0] as { content?: string }).content).includes(A));
expect("the trace holds the name and the payment", waitingRow.steps.map((s) => s.name).join(",") === "name_a_person,pay_usdc" && waitingRow.steps.every((s) => s.ok));

const settledRow = keptTurn({ person: { alias: "Ravi", address: A }, address: A, payment: { usdc: 1.5, digest: "x" }, payment_error: "" });
expect("a settled payment says sent and settled", /sent and settled on chain/.test(settledRow.said));
const duplicateRow = keptTurn({ person: { alias: "Ravi", address: A }, address: A, payment: { usdc: 1.5, digest: "x", duplicate: true }, payment_error: "" });
expect("a duplicate is called the same payment, not a second one", /same payment as before, not a second one/.test(duplicateRow.said));

const brokenRow = keptTurn({ person: { alias: "Ravi", address: A }, address: A, payment: null, payment_error: "no USDC at this address" });
expect("a payment failure is spoken plainly", /could not be prepared\. no USDC at this address/.test(brokenRow.said));
expect("a payment failure is a failed step in the trace", brokenRow.steps.find((s) => s.name === "pay_usdc")?.ok === false);
expect("the kept name still reads as kept after a payment failure", /Kept Ravi at/.test(brokenRow.said));

const plainRow = keptTurn({ person: null, address: A, payment: null, payment_error: "" });
expect("an address with no name is read back masked", /Read the address 0xaaaaaa…aaaaaa/.test(plainRow.said) && !plainRow.said.includes(A));
expect("an address with no name has no naming step", plainRow.steps.length === 0);

console.log(checks.join("\n"));
console.log(`\nthe typed address is validated, one name cannot move to another address, and a failed payment does not undo the name`);
