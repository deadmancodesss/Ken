import { createServer } from "node:http";

/**
 * A scripted stand-in for the model, OpenAI-compatible so brain.ts talks to it
 * unchanged. Two uses: it verifies the server → tool → Walrus → chain path with
 * no key, and it is the fallback if the real API is unreachable while recording.
 * It is deliberately not clever: keywords pick the tool, the tool's own output
 * becomes the sentence.
 */
const PORT = Number(process.env.STUB_PORT ?? 8899);

const RULES: [RegExp, string, (m: RegExpMatchArray) => Record<string, unknown>][] = [
  // Imperatives first. "remember that Priya tutors my sister, 40 USDC a month"
  // contains the word month, and a loose keyword must never beat a direct command.
  [/^\s*(remember|note) (that )?(.*)$/i, "remember_this", (m) => ({ text: m[3] })],
  // Both word orders, because nobody says "pay 0.95 to Tara". The landing page
  // advertises "pay Tara 0.95", so the fallback has to answer that too.
  [/^\s*(?:pay|send) ([\d.]+)\s*(?:usdc\s+)?(?:to\s+)?(.+)$/i, "pay_usdc", (m) => ({ amount: m[1], to: m[2] })],
  [/^\s*(?:pay|send)\s+(.+?)\s+([\d.]+)\s*(?:usdc)?$/i, "pay_usdc", (m) => ({ amount: m[2], to: m[1] })],
  // A full address spoken back to the agent is a lookup, not a memory search.
  [/^\s*(?:who|what)\s+(?:is|was)\s+(0x[0-9a-fA-F]+)/i, "who_is_this", (m) => ({ address: m[1] })],
  // Must come before "who do I pay": a superlative is a ranking question, and
  // answering it with a list of names is the difference between a demo and a toy.
  // "most often" is cadence and has to win over the plain amount reading.
  [/most often|frequent|regular/i, "money_history", () => ({ limit: 12, sort: "cadence" })],
  [/most|biggest|largest|top \d|highest/i, "money_history", () => ({ limit: 12, sort: "amount" })],
  // A named person plus a money verb is the question the face chips ask.
  [/has ([a-z][a-z]{2,}) paid/i, "find_person", (m) => ({ name: m[1] })],
  [/(?:sent|paid|given|received|owe) (?:me back )?(?:to |from )?(?:me )?([a-z][a-z]{2,})/i, "find_person", (m) => ({ name: m[1] })],
  [/who do i (know|pay)|my people|list people/i, "people_you_know", () => ({})],
  [/what do i (usually )?(pay|owe)|how much do i|history|spent/i, "money_history", () => ({ limit: 12 })],
  [/month|last month/i, "monthly_summary", () => ({})],
  [/how many|how much.*stored|memory.*full|what.*stored/i, "memory_stats", () => ({})],
  // "what about Sana?" is how a follow-up is actually said, and it means the previous
  // question with a different name. The real model gets that from history.
  [/^\s*(?:what about|and)\s+([a-z][a-z]{2,})\W*$/i, "find_person", (m) => ({ name: m[1] })],
  [/(.+)/i, "what_do_i_remember", (m) => ({ query: m[1] })],
];

function pick(text: string) {
  for (const [re, name, args] of RULES) {
    const m = text.match(re);
    if (m) return { name, args: args(m) };
  }
  return { name: "what_do_i_remember", args: { query: text } };
}

/** A paid record stores its receipt inside the note. Nobody reads a digest aloud. */
function receipt(note: unknown): string {
  return String(note ?? "").replace(/,? [Bb]ought for [\d.]+ USDC.*$/, "").replace(/[.\s]+$/, "");
}

/** Nobody says "one point three two eight four five nine". */
function spoken(n: string | number): string {
  const x = Number(n);
  if (!Number.isFinite(x)) return String(n);
  // Rounding a dust amount to zero reads as a lie, not as shorthand.
  if (x !== 0 && Math.abs(x) < 0.01) return "under a cent";
  return x >= 100 ? String(Math.round(x)) : x.toFixed(2).replace(/\.?0+$/, "");
}

/** Nobody says "second of November" either. */
function when(iso: string | null): string {
  if (!iso) return "a while ago";
  const days = Math.round((Date.parse(new Date().toISOString().slice(0, 10)) - Date.parse(iso)) / 86_400_000);
  if (days <= 0) return "today";
  if (days === 1) return "yesterday";
  if (days < 7) return `${days} days ago`;
  if (days < 14) return "last week";
  return `${Math.round(days / 7)} weeks ago`;
}

/** "2026-11" is a database key, not a thing a person says. */
function monthName(iso: string): string {
  const [y, m] = String(iso).split("-").map(Number);
  const name = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"][(m ?? 1) - 1];
  const thisMonth = new Date().toISOString().slice(0, 7);
  return `${y}-${String(m).padStart(2, "0")}` === thisMonth ? "this month" : name;
}

function say(name: string, result: any, args: any = {}): string {
  if (name === "people_you_know") {
    if (!result?.length) return "I have not been taught any names yet.";
    return "You have named " + result.map((p: any) => `${p.alias}${p.note ? `, ${p.note}` : ""}`).join(". ") + ".";
  }
  if (name === "money_history") {
    if (!result?.length) {
      // Naming the person in the refusal is what makes it sound like it listened.
      return args.person
        ? `I have no payments with ${args.person} in the range I read.`
        : "I can see no money moving in the range I read.";
    }
    const cadence = (n: number) => (n === 1 ? "about once a day" : `about every ${n} days`);
    const line = (p: any) =>
      `${p.name ?? "someone you have never named"}, ${spoken(p.net)} ${p.asset} ${
        p.direction === "received" ? "coming in" : p.direction === "mixed" ? "both ways" : "going out"
      } over ${p.flows === 1 ? "one payment" : p.flows + " payments"}` +
      (p.usualAmount && p.flows > 1 ? `, usually ${spoken(p.usualAmount)} each` : "") +
      (p.gapDays ? `, ${cadence(p.gapDays)}` : "") +
      `, most recently ${when(p.lastSeen)}.`;
    return result.slice(0, 5).map(line).join(" ");
  }
  if (name === "monthly_summary") {
    if (!result?.length) return "No monthly totals yet.";
    return result.map((m: any) => `${monthName(m.month)}: ${spoken(m.total)} ${m.asset}`).join(". ");
  }
  if (name === "memory_stats") return `I hold ${result?.total ?? 0} memories on Walrus.`;
  if (name === "remember_this") return "Stored. That is on Walrus now.";
  // This string goes to speech synthesis. A 64-character digest read aloud is
  // unlistenable, so the proof stays in the tool trace and the eye only says it landed.
  if (name === "pay_usdc") {
    if (result?.awaiting_signature) {
      return `I have put ${spoken(result.usdc)} USDC for ${result.to} on the Pay page. Sign it there and it goes.`;
    }
    return `Sent ${spoken(result?.usdc)} USDC. It settled on chain just now.`;
  }
  if (name === "find_person")
    return result?.address ? `Found ${result.address.slice(0, 10)}…` : `I have never been told who that is.`;
  if (name === "paid_lookup") {
    if (result?.awaiting_signature) {
      return `Naming that address costs ${spoken(result.usdc)} USDC at the paid index. It is on the Pay page for you to sign.`;
    }
    const note = receipt(result?.note);
    if (!result?.cost_usdc) return `I already knew that one. ${result?.name}${note ? `, ${note}` : ""}. It cost nothing.`;
    return `That cost ${spoken(result.cost_usdc)} USDC at the paid index. It is ${result.name}, ${note}. I will remember it now.`;
  }
  if (name === "who_is_this") {
    if (result?.named_as) return `${result.named_as}. ${receipt(result.note)}`.trim();
    return `I have never been told who ${String(result?.address ?? "that").slice(0, 10)}… is.`;
  }
  if (name === "what_do_i_remember") {
    if (!result?.matched) return "Nothing in memory matches that.";
    return [
      ...(result.people ?? []).map((p: any) => `${p.alias}: ${p.note}`),
      ...(result.memories ?? []).map((m: any) => m.text),
    ]
      .slice(0, 4)
      .join(". ");
  }
  if (Array.isArray(result)) {
    if (!result.length) return "Nothing in memory matches that.";
    return result.map((r: any) => r.note || r.text || r.alias).join(". ");
  }
  return JSON.stringify(result).slice(0, 400);
}

/**
 * A failed tool call comes back as { error }, and a formatter that only knows
 * success will announce "Sent undefined USDC" for money that never moved. Nothing
 * is ever reported as done when the tool said it was not.
 */
function speakResult(name: string, result: any, args: any = {}): string {
  if (result && typeof result === "object" && "error" in result) {
    const why = String(result.error);
    return name === "pay_usdc" ? `I did not send anything. ${why}` : `That did not work. ${why}`;
  }
  return say(name, result, args);
}

createServer(async (req, res) => {
  if (req.method !== "POST") {
    res.writeHead(404).end();
    return;
  }
  const raw = await new Promise<string>((resolve) => {
    let s = "";
    req.on("data", (c) => (s += c));
    req.on("end", () => resolve(s));
  });
  const body = JSON.parse(raw);
  const messages: any[] = body.messages ?? [];
  const userText = String([...messages].reverse().find((m) => m.role === "user")?.content ?? "");

  /*
   * Tool traffic from an earlier turn is history, not an unfinished call. The real
   * model knows that from the message ordering, and a scripted stand-in has to be
   * told, or turn two re-announces turn one's answer.
   */
  const at = messages.map((m) => m.role).lastIndexOf("user");
  const turn = at < 0 ? messages : messages.slice(at);
  const lastCall = [...turn].reverse().find((m) => m.tool_calls?.length)?.tool_calls?.[0];
  const lastTool = [...turn].reverse().find((m) => m.role === "tool");
  const called = (name: string) => turn.some((m) => m.tool_calls?.some((c: any) => c.function?.name === name));

  /**
   * The one piece of judgement worth scripting: memory answered nothing, so the
   * next move is to buy the answer, and only for the address that came back
   * unnamed. A real model does this from the tool description. The fallback has to
   * do it too, or the recording shows a dead end instead of the loop.
   */
  function followUp(name: string | undefined, result: any) {
    if (name === "find_person" && result?.address && !called("money_history")) {
      return { name: "money_history", args: { limit: 12, person: result.alias ?? result.address } };
    }
    if (name === "who_is_this" && result && !result.named_as && !called("paid_lookup")) {
      return { name: "paid_lookup", args: { address: result.address } };
    }
    return null;
  }

  const prior = lastCall && lastTool ? JSON.parse(lastTool.content) : null;
  const next = lastCall && lastTool ? followUp(lastCall.function.name, prior) : null;

  const reply = next
    ? {
        content: "",
        tool_calls: [{ id: "stub2", function: { name: next.name, arguments: JSON.stringify(next.args) } }],
      }
    : lastCall && lastTool
      ? { content: speakResult(lastCall.function.name, prior, JSON.parse(lastCall.function.arguments || "{}")) }
      : {
          content: "",
          tool_calls: [
            {
              id: "stub1",
              function: { name: pick(userText).name, arguments: JSON.stringify(pick(userText).args) },
            },
          ],
        };

  res.writeHead(200, { "content-type": "application/json" });
  res.end(JSON.stringify({ choices: [{ message: reply }] }));
}).listen(PORT, "127.0.0.1", () => console.log(`stub model on http://127.0.0.1:${PORT}`));
