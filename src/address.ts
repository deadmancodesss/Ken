/**
 * A wallet address is the one thing this product asks a person to type rather than say.
 * A microphone turns 64 hex characters into a sentence that is confidently wrong, and a
 * wrong address is money that never comes back. So the validation, the naming rules and
 * the sentence the transcript keeps all live here, away from the HTTP handler, and are
 * tested with fakes instead of a wallet.
 */

export const SUI_ADDRESS = /^0x[0-9a-fA-F]{64}$/;

/** The first and last few characters, which is enough for a reader to recognise a pasted address. */
export function maskAddress(address: string): string {
  const text = String(address);
  return `${text.slice(0, 8)}…${text.slice(-6)}`;
}

export function cleanAddress(input: unknown): string {
  const text = String(input ?? "").trim();
  if (!text) throw new Error("an address is required");
  if (!SUI_ADDRESS.test(text)) {
    throw new Error("that is not a full Sui address. A Sui address is 0x followed by 64 hex characters");
  }
  return text;
}

export type Named = { alias: string; address: string };

export type AddressDeps = {
  byName: (name: string) => Promise<Named | null>;
  byAddress: (address: string) => Promise<Named | null>;
  label: (name: string, address: string) => Promise<Named>;
  pay: (to: string, amount: number, asset: "USDC" | "SUI") => Promise<unknown>;
};

export type Kept = {
  person: Named | null;
  address: string;
  /** The coin the sentence asked to send, so a failure still names the right one. */
  asset: "USDC" | "SUI";
  /** The tool result when a payment was asked for, otherwise null. */
  payment: unknown;
  /** A payment that failed does not undo the name, so its reason travels beside it. */
  payment_error: string;
};

/**
 * The one place a typed address becomes a kept name and, when the sentence carried an
 * amount, a prepared payment. It refuses to move a name to a different address and it
 * refuses to give one address two names, because either one leaves the next lookup
 * resolving to a person the reader did not mean. A payment that fails is reported
 * beside the name rather than instead of it, since the naming already succeeded and
 * throwing that away would make the person type the same address again.
 */
export async function keepAddress(
  input: { name?: unknown; address?: unknown; amount?: unknown; asset?: unknown },
  deps: AddressDeps,
): Promise<Kept> {
  const address = cleanAddress(input.address);
  const typed = String(input.name ?? "").trim();
  // An address typed into the name slot is not a name. The field that was filled in is
  // the one that decides the recipient, so a partial 0x string is never written to memory.
  const name = typed && !/^0x/i.test(typed) ? typed : "";
  const asset: "USDC" | "SUI" = input.asset === "SUI" ? "SUI" : "USDC";
  const amount = Number(input.amount);
  const sending = Number.isFinite(amount) && amount > 0 ? amount : null;

  let person: Named | null = null;
  if (name) {
    const sameName = await deps.byName(name);
    if (sameName && sameName.address.toLowerCase() !== address.toLowerCase()) {
      throw new Error(`${name} is already kept as ${maskAddress(sameName.address)}, and this is a different address, so nothing was changed`);
    }
    const sameAddress = await deps.byAddress(address);
    if (sameAddress && sameAddress.alias.toLowerCase() !== name.toLowerCase()) {
      throw new Error(`this address is already kept as ${sameAddress.alias}, so nothing was changed`);
    }
    person = sameName ?? sameAddress ?? (await deps.label(name, address));
  }

  let payment: unknown = null;
  let payment_error = "";
  if (sending !== null) {
    try {
      payment = await deps.pay(person?.alias ?? address, sending, asset);
    } catch (err) {
      payment_error = (err as Error).message;
    }
  }
  return { person, address, asset, payment, payment_error };
}

export type KeptTurn = {
  asked: string;
  said: string;
  steps: { name: string; ok: boolean; result?: unknown; error?: string }[];
  delta: unknown[];
};

/**
 * What the transcript says after a typed address. The row a person reads carries a
 * masked address, and the full one travels only in the model history, where the next
 * question can use it and no mouth reads it out.
 */
export function keptTurn(kept: Kept): KeptTurn {
  const masked = maskAddress(kept.address);
  const person = kept.person;
  const label = person?.alias ?? masked;
  const payment = kept.payment as any;
  const tool = kept.asset === "SUI" ? "pay_sui" : "pay_usdc";
  const steps: KeptTurn["steps"] = [];
  if (person) steps.push({ name: "name_a_person", ok: true, result: person });

  let note = "";
  if (payment?.awaiting_signature) {
    note = `${payment.amount} ${payment.asset} is waiting for your signature in the ticket under this reply.`;
    steps.push({ name: tool, ok: true, result: payment });
  } else if (payment) {
    const duplicate = payment.duplicate ? " It is the same payment as before, not a second one." : "";
    note = `${payment.amount} ${payment.asset} was sent and settled on chain.${duplicate}`;
    steps.push({ name: tool, ok: true, result: payment });
  } else if (kept.payment_error) {
    note = `The payment could not be prepared. ${kept.payment_error}`;
    steps.push({ name: tool, ok: false, error: kept.payment_error });
  }

  const lead = person ? `Kept ${label} at ${masked}.` : `Read the address ${masked}.`;
  const said = note ? `${lead} ${note}` : lead;
  const what = person ? `I typed the address ${kept.address} for ${label}.` : `I typed the address ${kept.address}.`;
  return {
    asked: person ? `typed the address for ${label}: ${masked}` : `typed the address ${masked}`,
    said,
    steps,
    delta: [{ role: "user", content: `${what}${note ? ` ${note}` : ""} Keep it and use it from now on.` }],
  };
}
