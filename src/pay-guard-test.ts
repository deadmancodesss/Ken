/**
 * The voice call on 2026-11-09 asked to pay an interior designer, the model called
 * pay_usdc with no recipient, and the guard threw. A thrown tool carries no result for
 * the page to draw from, so no form opened, and the model still described one. A pay
 * call missing its recipient or its amount is an ordinary state of a conversation, so
 * it now answers with a cue that says nothing opened and names the missing piece.
 */
process.env.PAY_ENABLED = "1";
const { runTool } = await import("./tools.js");

const checks: string[] = [];
function expect(label: string, ok: boolean) {
  checks.push(`${ok ? "ok  " : "FAIL"} ${label}`);
  if (!ok) throw new Error(label);
}

const noRecipient = (await runTool("pay_usdc", {})) as Record<string, unknown>;
expect("a payment with no recipient is a cue, not a crash", noRecipient.needs_recipient === true);
expect("the cue is not an address request, because there is no name to show", !("needs_address" in noRecipient));
expect("the cue says nothing opened", /no field is open/.test(String(noRecipient.note)));
expect("the cue carries the coin that was asked for", noRecipient.asset === "USDC");

const sui = (await runTool("pay_sui", { amount: 0.5 })) as Record<string, unknown>;
expect("a SUI pay call keeps SUI on the cue", sui.needs_recipient === true && sui.asset === "SUI");

const noAmount = (await runTool("pay_usdc", { to: "Albert" })) as Record<string, unknown>;
expect("a payment with no amount is a cue, not a crash", noAmount.needs_amount === true);
expect("the amount cue keeps the name it was given", noAmount.who === "Albert");
expect("the amount cue says nothing opened", /no field is open/.test(String(noAmount.note)));

const zero = (await runTool("pay_sui", { to: "Albert", amount: 0 })) as Record<string, unknown>;
expect("a zero amount is refused the same way", zero.needs_amount === true);

console.log(checks.join("\n"));
console.log("\na pay call missing its recipient or amount says what is missing and opens nothing");
