import "dotenv/config";
import { PAY_CHAIN, PAY_NET } from "./chain.js";
import { TOOLS, TOOL_NAMES, runTool } from "./tools.js";
import { session } from "./session.js";
import { paymentsEnabled } from "./wallet.js";

/**
 * One code path for every provider: NVIDIA NIM, Gemini and OpenAI all expose an
 * OpenAI-compatible /chat/completions with function calling, so the key and the
 * base URL are the only things that change between them.
 *
 * A request is therefore an attempt, and an attempt is a route plus a model name.
 * The order is the product: Gemini answers first when it has a key, NVIDIA Ultra is the
 * very next attempt when a Gemini name refuses, and the local stub is alone in the list
 * so `npm run demo` never drifts onto a network. Nothing here is a fallback that hides a
 * failure: every attempt that did not answer is named in the error the page shows.
 */
type Route = { id: string; base: string; key: string; models: string[] };

/** A placeholder key is a config mistake, not a provider, so it never reaches the network. */
const usable = (k?: string) => {
  const v = (k ?? "").trim();
  return v && v !== "stub" ? v : "";
};

const STUB_BASE = (process.env.MODEL_BASE_URL ?? "https://generativelanguage.googleapis.com/v1beta/openai").replace(/\/$/, "");
const STUB_KEY = (process.env.MODEL_API_KEY ?? process.env.GEMINI_API_KEY ?? "").trim();

/**
 * `npm run demo` points the same code at a local rule based model and hands it the
 * word `stub` as a key. Both halves of that have to keep the lane to themselves,
 * because a demo that silently drifts onto a free tier answers a different question
 * than the one the video claims it answers.
 */
const IS_STUB = /127\.0\.0\.1|localhost/.test(STUB_BASE) || STUB_KEY === "stub";

/**
 * The same rule applies to the NVIDIA key: no prefix is checked, so a credential of
 * another shape is sent once and answered by the provider's own 401 rather than by a
 * guess in this file. The catalogue endpoint on this gateway answers any key, even a
 * junk one, so a 200 from /v1/models proves nothing about whether inference is allowed.
 */
const rawNvidia = (process.env.NVIDIA_API_KEY ?? "").trim();
const NVIDIA_KEY = usable(rawNvidia);
const NVIDIA_WHY = "NVIDIA_API_KEY is set but is not usable, so NVIDIA was never asked";

const GEMINI: Route = {
  id: "gemini",
  base: STUB_BASE,
  key: IS_STUB ? STUB_KEY : usable(STUB_KEY),
  models: list(process.env.MODEL_NAME, "gemini-3.1-flash-lite,gemini-3.5-flash"),
};

/**
 * The chain is two providers deep and the order is the product. Gemini leads because the
 * person asked for it, and NVIDIA covers the lane behind it. That is a deliberate trade,
 * not a free win: on the nine shipped probes on 2026-11-04, Gemini flash lite sent 6 of
 * 6 tool calls and 3 of 3 spoken answers at a 3.4 s median with an 11.6 s tail, while the
 * 550B Ultra sent the same 6 of 6 and 3 of 3 at 1.2 s with a 1.9 s tail. Gemini is the
 * more familiar name and the slower mouth. Ultra is the second attempt on the whole
 * chain, not merely the first NVIDIA name, so the two lanes are alternated by depth:
 * Gemini lite, Ultra, Gemini flash, Bolt. A grouped order would hand a dead Gemini key
 * to Gemini's second name before Ultra ever saw the turn. The evidence behind that order: on a 24 probe
 * sweep the 4B Bolt sent every prompt to a plausible tool at 986 ms and Ultra sent 20 of
 * 24, and on the nine shipped probes Ultra called remember_this on every attempt while
 * Bolt answered "remember that" in words and never called the tool in three runs. Super
 * VL sent 19 of 24 at 0.5 seconds and the 30B Lightning answered people_you_know to half
 * the prompts, so neither is in the chain.
 *
 * A reasoning model that spends its first seconds thinking is hold music even when its
 * quota is fresh, so every NVIDIA call carries chat_template_kwargs with thinking off.
 * The same models with thinking on measured 1.5 seconds where thinking off measured 0.3,
 * and the 120B once returned null content because its whole token budget went to
 * reasoning. On 2026-11-04 the 550B Ultra was run both ways on the nine shipped probes:
 * thinking on sent 6 of 6 tool calls and 3 of 3 spoken answers at a 2.8 s median with a
 * 6.8 s tail, thinking off sent the same 6 of 6 and 3 of 3 at 1.2 s with a 1.9 s tail.
 * Thinking bought no accuracy here and doubled the wait, so it stays off. The flag is
 * ignored by models that do not think.
 *
 * On 2026-11-03 the first key listed the catalogue while every inference call came back
 * 403 Authorization failed. The catalogue endpoint answers even a junk key, so that 200
 * was not evidence of anything. A newly generated key answered 200 immediately, which is
 * why the refusal is reported as a key problem and not as a model problem.
 *
 * OpenRouter is gone from this lane on purpose. Its free requests read 52 used of 50,
 * every free name answered 429 within 200 ms, and the paid names were refused with a
 * 402 about credit. It still serves the HeyGen voice in speech.ts, which is a separate
 * allowance and a separate file.
 */
const NVIDIA: Route = {
  id: "nvidia",
  base: (process.env.NVIDIA_BASE_URL ?? "https://integrate.api.nvidia.com/v1").replace(/\/$/, ""),
  key: NVIDIA_KEY,
  models: list(process.env.NVIDIA_MODEL, "nvidia/nemotron-3-ultra-550b-a55b,nvidia/nemotron-3.5-bolt-e4b"),
};

function list(raw: string | undefined, fallback: string): string[] {
  return (raw ?? fallback)
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

/**
 * A route that refuses its key is skipped for a minute rather than re-asked on every
 * turn. On 2026-11-03 NVIDIA answered 403 Authorization failed in about 200 ms while its
 * catalogue still listed every model, so the lead cost each turn a wasted round trip
 * before Gemini answered. A minute is short enough that a fixed key or a lifted block
 * recovers inside one demo, and long enough that a dead key costs one request a minute
 * rather than one a turn.
 */
const REST_MS = Number(process.env.ROUTE_COOLDOWN_MS ?? 60_000);
const restingUntil = new Map<string, number>();
const resting = (id: string) => (restingUntil.get(id) ?? 0) > Date.now();

/** Ordered attempts for one lane. The stub lane is short and never touches a network. */
function attempts(lane: "decide" | "chat"): { route: Route; model: string }[] {
  if (IS_STUB) return [{ route: GEMINI, model: GEMINI.models[0] }];
  const routes: Route[] = [];
  if (GEMINI.key) routes.push(GEMINI);
  if (NVIDIA.key) routes.push(NVIDIA);
  // If every route is resting, ask them anyway: a stale cooldown must never leave a turn
  // with nobody to ask.
  const live = routes.filter((r) => !resting(r.id));
  const laneRoutes = live.length ? live : routes;
  // Alternated by depth, not grouped by provider, because the person asked for Gemini
  // first and Ultra second. Grouping would put Gemini's second name ahead of Ultra and
  // spend a request on the same key that just refused. This way the order is Gemini
  // lite, Ultra, Gemini flash, Bolt.
  const out: { route: Route; model: string }[] = [];
  const depth = Math.max(0, ...laneRoutes.map((r) => r.models.length));
  for (let i = 0; i < depth; i++) {
    for (const route of laneRoutes) {
      const model = route.models[i];
      if (model) out.push({ route, model });
    }
  }
  const seen = new Set<string>();
  return out
    // A name that just failed while choosing a tool fails the same way while speaking.
    // Asking twice only doubles the wait.
    .filter(({ route, model }) => {
      const key = `${route.base}|${model}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
}

/** The routes a key actually unlocks, so a page can say which provider is in charge. */
export function brainRoutes() {
  if (IS_STUB) return [{ id: "stub", models: GEMINI.models }];
  return [GEMINI.key ? { id: "gemini", models: GEMINI.models } : null, NVIDIA.key ? { id: NVIDIA.id, models: NVIDIA.models } : null].filter(
    (r): r is { id: string; models: string[] } => !!r
  );
}

/**
 * Each lane remembers its own answer. One shared name would let the model that chose
 * a tool claim credit for the sentence, and the two are often not the same model.
 */
let spokeBy = "";
let decidedBy = "";

/**
 * What went wrong first in the turn just finished, and who answered in the end. The
 * screen shows one line only when a provider refused and another one took the turn,
 * because "NVIDIA answered" and "Gemini was rate limited, so NVIDIA answered" are
 * different facts and a demo should be able to tell them apart.
 */
type Miss = { route: Route; model: string; why: string };
let turnMiss: Miss | null = null;
let turnServed: { route: Route; model: string } | null = null;

/** A configured slug is not a sentence, so the few names in the chain are shortened. */
function shortName(model: string) {
  const m = model.toLowerCase();
  if (m.includes("ultra")) return "Nemotron Ultra";
  if (m.includes("bolt")) return "Nemotron Bolt";
  if (m.startsWith("gemini-")) {
    const rest = m.slice("gemini-".length).replace(/^\d+(\.\d+)*[-.]?/, "").replace(/-/g, " ");
    return `Gemini ${rest}`.trim();
  }
  return model;
}

const PROVIDER: Record<string, string> = { gemini: "Gemini", nvidia: "NVIDIA" };

/**
 * One line about the last turn, empty when the first choice answered. It names the
 * refusal and the provider that covered it, and it never turns a 429 into a guessed
 * remaining quota. This is an observed event, not a meter.
 */
export function fallbackNote() {
  const miss = turnMiss;
  const served = turnServed;
  if (!miss || !served) return "";
  const sameRoute = miss.route.id === served.route.id;
  if (sameRoute && miss.model === served.model) return "";
  const from = sameRoute ? shortName(miss.model) : (PROVIDER[miss.route.id] ?? miss.route.id);
  const to = sameRoute ? shortName(served.model) : (PROVIDER[served.route.id] ?? served.route.id);
  return `${from} ${miss.why}, so ${to} answered this turn.`;
}

/**
 * Routers answer with the name of the model they picked, so the served name is
 * reported rather than the requested one. A screen that said "Jev Router" while
 * a 2.6B model answered is the same lie this file exists to prevent.
 */
export function modelName() {
  const first = attempts("chat")[0];
  if (!first) return "stub rules, no model key";
  if (IS_STUB) return "stub rules, no model key";
  return spokeBy || first.model;
}

/** The name used for tool routing, which is often not the name that spoke. */
export function decisionName() {
  const first = attempts("decide")[0];
  if (!first || IS_STUB) return "stub rules, no model key";
  return decidedBy || first.model;
}

export function brainState() {
  return {
    answer: modelName(),
    decide: decisionName(),
    routes: brainRoutes(),
    stub: IS_STUB,
    // A route that is switched off says why, because "Gemini answered" and "NVIDIA was
    // never asked" are different sentences and only one of them is true here.
    why: GEMINI.key
      ? resting("gemini")
        ? "Gemini refused this key, so NVIDIA answers until the cooldown ends"
        : ""
      : NVIDIA.key
        ? "no Gemini key in .env, so NVIDIA is the whole chain"
        : rawNvidia
          ? NVIDIA_WHY
          : "no model key in .env, so nothing can answer",
  };
}

/** One prompt for both transports, so a call and a typed question can never disagree. */
export const systemPrompt = () => `You are Ken, a personal agent for a Sui wallet. You can see the chain through Tatum and you remember
things on Walrus. Today is ${new Date().toISOString().slice(0, 10)}. ${
  session().source === "wallet"
    ? `You are speaking for the wallet ${session().wallet} on ${session().network}, which the person in front of you connected themselves. Every payment you prepare needs their signature.`
    : `The wallet you speak for is the demo wallet ${session().wallet} on ${session().network}. ${
      PAY_NET === "testnet"
        ? "It pays without asking because that money is worthless testnet dust."
        : `It will not sign a payment of its own, because this build settles on ${PAY_CHAIN} where that money is real. Say a payment needs a connected wallet to sign, and never say money moved.`
    }`
}

Rules you must not break:
- You are Ken. If someone greets you, says your name, or asks who you are, introduce yourself as Ken in one short sentence and say what you can do, such as reading the chain, keeping names, setting a limit, or making a payment request. Never describe yourself as only a voice agent. You answer in text chat, on a voice call, in the morning brief, on the statement and behind paid links, and it is one memory everywhere.
- Never invent or guess a wallet address. Only use an address a tool returned.
- If find_person returns confidence below 1, repeat the name you stored back and ask whether that is the person they meant. Never pay on a name the microphone only nearly got right.
- Prefer answering from memory over re-reading the chain. Call who_is_this or money_history only when memory does not already answer it.
- When the user asks who an address is, call who_is_this first. It is the tool that knows names, notes, the faucet label and every coin in the relationship. Call address_activity only when they ask what that address does or whether it can be trusted.
- A balance question ("how much money do I have", "what is my balance") is answered only by wallet_balance. money_history and monthly_summary describe movement, never what is left, so their totals are not a balance. Quote every coin the wallet holds with its own unit, and quote the dollar total only when the tool returned one.
- "How did this balance get here", "who funded me", "where did the money come from" are how_money_came. Read its said lines and repeat the total it read. If a coin's gap is not zero, say plainly that the transfers read do not fully explain that coin and that the rest is usually gas or older history. If read.complete is false, say it stopped at the read cap and older money is not in the answer. Never claim the whole history when it did not read the whole history.
- When money_history or who_is_this returns coins, each coin is a separate fact. Someone sent 20 USDC and 0.0024 SUI must be read as both, not as the dominant coin alone.
- An address the user asks about is address_activity, after find_person when they gave a name. Say the measured pattern and say that a pattern is not a verdict. Never call an address spam or a scam on your own judgement. A mark exists only when the user asks for one, through mark_spam. It reads at most the last 20 transactions, so with_you 0 means none in that window, not never. If the pattern says the whole history was read, you may say that. Otherwise say it is the last read window, not everything.
- When the user says a person or an address is spam, call mark_spam with the name or the full address. When they ask who is marked, call spam_marks. When they want a mark gone, call unmark_spam. A mark is their judgement, so never write one they did not ask for. If mark_spam returns needs_address, ask for the address in one short sentence and let the field under your reply carry it.
- When the user asks to be reminded at a time, call remind_me with the thing and their own time words, and never work out the time yourself. Read its said line back. If it returns unclear or past, ask for a clearer future time and never say a reminder was set. When they ask what is waiting, call reminders. When they want one gone, call cancel_reminder. A reminder fires only while the server is running, so say that plainly if they expect it while the app is closed.
- "What is due", "is anything overdue", "has she asked again", "what do I pay every month" and "what are my fixed commitments" are all one tool: what_is_due. Its lines are measured from real transfers, so read the line instead of working out a date yourself, and say "no rhythm yet" plainly when that is what it returned. Its committed field already totals the rhythms into a monthly figure per asset, so quote that number instead of adding anything up in your head. Each line also carries who_pays. A line beginning "you pay" is money leaving this wallet. Say "you pay Sana 0.52 USDC", never "Sana owes you". A line beginning "you exchange" is two-way, so keep the word exchange and never say Dev owes you.
- When the user says "remember", "note this down", or tells you a fact about a person, call remember_this with one self-contained sentence. Saying you will remember it without calling the tool remembers nothing.
- When money_history returns flows and a usual amount, say both in the same answer: how many times money moved and what the usual amount was.
- A monthly limit is read or changed only by set_monthly_limit. Call it with the number when the person says "set my limit to 25" or "lift my limit" (zero lifts it), and call it with no number when they ask how much of the limit is left. Read its said lines. Never say the limit stops a payment, because it does not.
- When the person wants to be paid, send a bill, or make a payment request link, call request_money once with the amount and what it is for when they already said them. The page opens a form, and no link exists until the person presses the button there. If it returns needs_wallet, ask them to connect a wallet and say no link was made. Never say the link was sent to anyone, because it is a link they have to share.
- Speak in short sentences. Your reply is read out loud. No markdown, no bullet points, no hex strings unless the user asks for one.
- Round money out loud: say "1.33 USDC", never "1.328459". Say "yesterday" or "last week", never an ISO date.
- A day you say out loud is worked out from a date a tool returned, counted against today's date above. A payment made today is today. Never guess a date, and never repeat one from an older part of this conversation.
- Answer in the language the user spoke to you in.
- Write the way people talk. Never use an em dash and never use a semicolon. Break the thought into two short sentences instead.
- Say "the agent wallet" only if asked about the address. Otherwise talk about people by name.
- If a read fails, tell the user what failed plainly and do not retry more than once.
${paymentsEnabled() ? `- Before paying anyone by name, call find_person. If it returns not_found, call pay_usdc once with that name and the amount, so the page can carry the amount into its address field, then ask the user for the full address in one short sentence.
- paid_lookup costs real ${PAY_CHAIN} money. Call it only after who_is_this comes back with named_as null, and never twice for the same address in one conversation. If it answers cost_usdc 0, say you already knew it and did not pay.
- verify_payment costs the same small fee and is the only way to settle a claim about a transaction. Use it when somebody hands you a digest and says they paid, or when a memory and a person disagree about whether money moved. Its answer is remembered, so never call it twice for one digest. If it says nothing with that digest exists, say so flatly. That is a real answer and the thing the person paid to hear.
- open_paid_link buys what another person remembers, which is the only way to pay a person rather than a service. Use it when somebody hands you a link id and asks what is behind it, or asks to buy what another wallet knows about something. The price is written on their link, so repeat that price and never the index's. If it answers cost_usdc 0 you already opened that link, so say you read it from your own memory and paid nothing.
- When any tool returns awaiting_signature, the money has NOT moved. The ticket is drawn right under your reply, so say it is waiting there for them to sign and never send them to another page. Never say you sent it.
- When pay_usdc or find_person returns needs_address, the page is already showing a field for the full address and the payment finishes there without another instruction. Ask for the address in one short sentence, never guess one, never read a hex string out loud, and never say the money moved. Do not call name_a_person or pay_usdc again for that request.
- A payment is never retried on a timeout. If a payment tool returns pending or says the money may have moved, do not call it again for that payment. Call money_history for that person and say what the chain shows. A transfer that settled is reported as sent even if the tool's wait ended first.
- Never call pay_usdc twice with the same person and amount in one conversation unless the user asks again after you have read the chain. A duplicate call returns the first digest, and saying it is a second payment is the lie that spends twice.
- When pay_usdc returns marked_spam, nothing was built and no money moved. Say plainly that the address is marked spam, repeat the reason, and ask whether they still want to send. Call pay_usdc again with confirm_spam yes only after they clearly say yes in this conversation.` : `- Payments are switched off in this build, so pay_usdc, paid_lookup, verify_payment and open_paid_link do not exist here. If someone asks to send money or to buy a paid fact, say in one short sentence that payments are off in this build, and never say anything moved.`}
- A person's address reaches you as text the user typed into that field, never as speech. When the user wants an address kept and you do not already hold the full 0x string, call name_a_person with the name and an empty address. Never ask them to say the address out loud, and when name_a_person comes back with needs_address, ask in one short sentence and wait. If any message in this conversation says the typed address was kept, the save has already happened. Do not call name_a_person for that name, do not call find_person for it, and never ask for the address again.`;

export type Step = { name: string; args: Record<string, unknown>; ok: boolean; result?: unknown; error?: string };
export type Turn = { text: string; steps: Step[] };

/**
 * The prompt asks for plain spoken words, and a model handed a tool result still
 * decorates them: bold markers around a name, an em dash between two clauses, a
 * semicolon where a full stop belongs. Those characters are read literally on screen,
 * and they break the two writing rules this whole project holds to. The prompt is
 * still the first attempt, but a rule that matters is enforced on the way out rather
 * than trusted to the next model, so the answer is repaired once here.
 */
export function tidy(text: string) {
  return String(text)
    .replace(/\*\*([^*\n]+)\*\*/g, "$1")
    .replace(/__([^_\n]+)__/g, "$1")
    .replace(/(^|[\s(])\*([^*\n]+)\*(?=[\s).,!?]|$)/g, "$1$2")
    .replace(/^\s*#{1,6}\s+/gm, "")
    .replace(/^\s*[-*]\s+/gm, "")
    .replace(/\s*—\s*/g, ", ")
    .replace(/\s*;\s*/g, ". ")
    .replace(/[ \t]{2,}/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

const round2 = (n: number) => Math.round(n * 100) / 100;

/** A money figure in a spoken sentence. A bare number is not judged because it may be a count or a date. */
const MONEY_SAID = /(\d+(?:[.,]\d+)?)\s*(?:USDC|USDU|SUI|USD|dollars?)\b/gi;

function moneySaid(text: string): number[] {
  return [...text.matchAll(MONEY_SAID)].map((m) => round2(Number(m[1].replace(",", "."))));
}

const NUMBER_WORDS: Record<string, number> = {
  one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10,
  eleven: 11, twelve: 12, fifteen: 15, twenty: 20, thirty: 30, forty: 40, fifty: 50,
};

/** Every count a sentence carries, digits or words, so "five times" is not read as zero. */
function spokenNumbers(text: string): Set<number> {
  const out = new Set<number>();
  for (const m of text.matchAll(/\d+(?:[.,]\d+)?/g)) out.add(round2(Number(m[0].replace(",", "."))));
  for (const m of text.matchAll(/\b(one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|fifteen|twenty|thirty|forty|fifty)\b/gi)) {
    out.add(NUMBER_WORDS[m[1].toLowerCase()]);
  }
  return out;
}

const FIGURE_TOOLS = new Set([
  "who_is_this", "money_history", "monthly_summary", "what_is_due", "pay_usdc",
  "paid_lookup", "verify_payment", "open_paid_link", "make_report", "what_do_i_remember", "people_you_know",
  "wallet_balance", "how_money_came", "address_activity", "set_monthly_limit", "request_money",
]);

type Figure = { name: string; flows: number; usual: string; unit: string };

/**
 * The model reads a tool result, but it can still say a figure no tool returned, drop
 * half of a pair the question asked for, or turn "you pay Sana" into "Sana owes you".
 * Those are the three errors that matter in a wallet, and none of them needs a second
 * model to catch. This judges figures and direction, never the prose. It only runs when
 * a tool that actually returns money facts ran this turn, so a remembered rent figure
 * is not stripped just because the only tool was remember_this.
 */
export function groundAnswer(said: string, asked: string, steps: Step[]): string {
  const done = steps.filter((s) => s.ok && s.result !== undefined);
  const figureTool = done.some((s) => FIGURE_TOOLS.has(s.name));
  if (!done.length || !figureTool) return said;

  const nums = new Set<number>();
  const figures: Figure[] = [];
  const directions: { name: string; mode: "pay" | "exchange" }[] = [];

  const walk = (value: unknown, inherited = "") => {
    if (Array.isArray(value)) {
      value.forEach((v) => walk(v, inherited));
      return;
    }
    if (!value || typeof value !== "object") return;
    const row = value as Record<string, unknown>;
    const name = String(row.name ?? row.named_as ?? row.person ?? inherited ?? "");
    const flows = Number(row.flows);
    const raw = row.usual_amount ?? row.usualAmount ?? row.usual;
    if (Number.isFinite(flows) && typeof raw === "string") {
      const number = raw.match(/\d+(?:[.,]\d+)?/)?.[0];
      const unit = raw.match(/\b(USDC|USDU|SUI)\b/i)?.[0] ?? (typeof row.asset === "string" ? row.asset : "");
      if (number) figures.push({ name, flows, usual: number.replace(",", "."), unit });
    }
    if (name && typeof row.who_pays === "string") {
      if (row.who_pays === "you") directions.push({ name, mode: "pay" });
      else if (row.who_pays === "both") directions.push({ name, mode: "exchange" });
    }
    if (name && typeof row.direction === "string") {
      if (row.direction === "sent") directions.push({ name, mode: "pay" });
      else if (row.direction === "mixed") directions.push({ name, mode: "exchange" });
    }
    for (const v of Object.values(row)) {
      if (typeof v === "number" && Number.isFinite(v)) nums.add(round2(v));
      else if (typeof v === "string") {
        for (const m of v.matchAll(/\d+(?:[.,]\d+)?/g)) nums.add(round2(Number(m[0].replace(",", "."))));
      } else walk(v, name);
    }
  };
  done.forEach((s) => walk(s.result));

  let out = said;
  // A sentence with a money figure no tool returned is not spoken. The rest of the
  // answer survives, because one bad clause should not erase a true one.
  const sentences = out.split(/(?<=[.!?])\s+/);
  const kept = sentences.filter((s) => moneySaid(s).every((n) => nums.has(n)));
  if (kept.length !== sentences.length) {
    out = kept.length
      ? `${kept.join(" ")} I left out a figure I could not confirm.`
      : "I read the chain but I cannot confirm the figure I was about to say. Ask me again and I will read it back to you.";
  }

  // "Sana owes" is the wrong way round when the tool says the money left this wallet.
  const seen = new Set<string>();
  for (const d of directions) {
    const key = d.name.toLowerCase();
    if (!d.name || seen.has(key)) continue;
    seen.add(key);
    const escaped = d.name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const owes = new RegExp(`\\b${escaped}\\s+owes(?:\\s+you)?\\b`, "i");
    out = out
      .split(/(?<=[.!?])\s+/)
      .map((s) => {
        if (!owes.test(s) || !/(?:USDC|USDU|SUI|USD|dollars?|\d)/i.test(s)) return s;
        return s.replace(new RegExp(owes.source, "gi"), d.mode === "pay" ? `You pay ${d.name}` : `You exchange with ${d.name}`);
      })
      .join(" ");
  }

  // The question asked how often and how much, the tool holds both, and the answer
  // carried only one. Add the missing half from the tool, not from the model's head.
  const wantsFrequency = /\bhow often\b|\bhow many times\b|\bfrequency\b|\bcadence\b/i.test(asked);
  const wantsAmount = /\bhow much\b|\busual(?:ly)?\b|\bamount\b|\bwhat does .*? get\b|\bwhat do .*? get\b/i.test(asked);
  if (wantsFrequency && wantsAmount) {
    const spoken = spokenNumbers(out);
    // "Every day" answers how often even when the sentence never says the total count.
    const hasCadence = /\b(?:every|each)\s+(?:day|week|month|year)\b|\bdaily\b|\bweekly\b|\bmonthly\b|\byearly\b/i.test(out);
    const named = figures.filter((f) => f.name && (asked.toLowerCase().includes(f.name.toLowerCase()) || out.toLowerCase().includes(f.name.toLowerCase())));
    const pool = named.length ? named : figures.length === 1 ? figures : [];
    for (const f of pool.slice(0, 2)) {
      const half: string[] = [];
      if (!hasCadence && !spoken.has(round2(f.flows))) half.push(`${f.flows} ${f.flows === 1 ? "payment" : "payments"}`);
      if (!spoken.has(round2(Number(f.usual)))) half.push(`a usual amount of ${f.usual}${f.unit ? ` ${f.unit}` : ""}`);
      if (half.length) out += ` ${f.name || "That person"} has ${half.join(" and ")}.`;
    }
  }

  return out;
}

function schemas() {
  return TOOLS.map((t) => ({
    type: "function",
    function: {
      name: t.name,
      description: t.description,
      parameters: { type: "object", properties: t.parameters, required: t.required },
    },
  }));
}

/**
 * A model that is thinking for three and a half minutes is not a slow answer, it is
 * a dead conversation, so the attempt is cut and the next name is asked. The cap moved
 * from two minutes to forty five after a measured free-tier tail of 54 seconds turned
 * a reply into hold music, then to twenty five on 2026-11-03 after a dead direct Gemini
 * route held a typed question for the full forty five before reporting a failure. Set
 * it to 0 to wait as long as the provider likes, which is what a batch test wants and
 * never what a person holding a microphone wants.
 */
const TIMEOUT = Number(process.env.MODEL_TIMEOUT_MS ?? 24_000);

/**
 * The cap is about what comes back in time. A reasoning model allowed to think for
 * thousands of tokens returns an empty message inside a voice turn, and a model allowed
 * to write for thousands returns a paragraph nobody asked to hear. The 30B Nemotron spent
 * a whole 400 token budget thinking and returned no tool call at all, so the cap has to
 * leave room for the thought and still keep the reply a handful of sentences.
 */
const MAX_TOKENS = Number(process.env.MODEL_MAX_TOKENS ?? 600);

type Message = { content?: string; tool_calls?: { id: string; function: { name: string; arguments: string } }[] };

async function attempt(route: Route, model: string, messages: unknown[], withTools: boolean, signal?: AbortSignal) {
  const body: Record<string, unknown> = { model, messages, tool_choice: "auto" };
  if (MAX_TOKENS > 0) body.max_tokens = MAX_TOKENS;
  // Nemotron reasons by default, and a voice turn has no seconds to spare for it. The
  // flag is ignored by models that do not think, and NVIDIA_THINKING=1 turns it back on
  // for a batch test that wants the reasoning.
  if (route.id === "nvidia" && process.env.NVIDIA_THINKING !== "1") body.chat_template_kwargs = { enable_thinking: false };
  // Closing a turn for real needs the tools removed as well as the prompt asking for
  // an answer, because a model offered a paid lookup will keep taking it.
  if (withTools) body.tools = schemas();
  const timeout = TIMEOUT > 0 ? AbortSignal.timeout(TIMEOUT) : undefined;
  const both = timeout && signal ? AbortSignal.any([timeout, signal]) : timeout ?? signal;
  const res = await fetch(`${route.base}/chat/completions`, {
    method: "POST",
    signal: both,
    headers: { "content-type": "application/json", authorization: `Bearer ${route.key}` },
    body: JSON.stringify(body),
  });
  // The status travels with the body because a provider puts a 401, a 403 and a 429 in
  // the same shaped JSON, and telling them apart is the difference between replacing a
  // key, waiting a minute, or moving to another model right now.
  return { status: res.status, ok: res.ok, parsed: (await res.json().catch(() => ({}))) as any };
}

/**
 * Ask every name in the lane until one answers, and keep what each of the others said
 * wrong. A 401 ends its whole route because a bad key does not get better on the next
 * model, and a 403 is NVIDIA refusing inference for this key, which Gemini behind it
 * survives. Gemini spells the same refusal as a 400 whose body says "Please pass a valid
 * API key", so a 400 that names the key is treated as a dead route too. Everything else
 * moves politely to the next name.
 */
async function complete(messages: unknown[], lane: "decide" | "chat", signal?: AbortSignal, withTools = true): Promise<Message> {
  const failures: string[] = [];
  const dead = new Set<string>();
  for (const { route, model } of attempts(lane)) {
    if (dead.has(route.id)) continue;
    if (!route.key) {
      failures.push(`${route.id}/${model} has no key`);
      continue;
    }
    try {
      const { status, ok, parsed } = await attempt(route, model, messages, withTools, signal);
      const message = parsed?.choices?.[0]?.message;
      if (ok && message) {
        // A router reports the model it actually ran, and that is the name for the screen.
        const served = String(parsed.model ?? model);
        if (lane === "decide") decidedBy = served;
        else spokeBy = served;
        turnServed = { route, model };
        // A decide round that returns no tool call is the answer, not a classification.
        // Without this, a fallback that speaks in the tool round is reported as the first
        // configured name, which is the exact lie this file exists to prevent.
        if (lane === "decide" && !(message.tool_calls ?? []).length) spokeBy = served;
        return message as Message;
      }
      failures.push(`${model} (${status || "no status"}) ${reason(parsed)}`);
      const why = reason(parsed);
      const refusedKey = status === 401 || status === 403 || (status === 400 && /api[_ ]?key|unauthenticated/i.test(why));
      if (!turnMiss) turnMiss = { route, model, why: status === 429 ? "was rate limited" : refusedKey ? "refused the key" : "failed" };
      // A bad key does not get better on the next model name, so the whole route is
      // dropped rather than walked. Every other failure is the provider's problem and
      // moves politely to the next name.
      if (refusedKey) {
        dead.add(route.id);
        restingUntil.set(route.id, Date.now() + REST_MS);
      }
    } catch (err) {
      const name = (err as Error).name;
      failures.push(`${model} ${name === "TimeoutError" ? `was cut off after ${Math.round(TIMEOUT / 1000)} s` : (err as Error).message}`);
      if (!turnMiss) turnMiss = { route, model, why: name === "TimeoutError" ? "timed out" : "could not be reached" };
    }
  }
  throw new Error(`every model in the ${lane} lane failed. ${failures.join(" · ") || "no route has a key"}`);
}

/** One line per failure, with the provider's own blob cut off rather than shown. */
function reason(parsed: any) {
  return String(parsed?.error?.message ?? JSON.stringify(parsed)).replace(/\s+/g, " ").slice(0, 110);
}

/**
 * One ask, measured, against one named model on one named route. This is the seam
 * `npm run textbench` uses to compare models that are not in the chain yet, which is how
 * a chain gets chosen by numbers rather than by a guess about which vendor is clever.
 * Nothing here is a fallback: a model that fails reports failing, because a benchmark
 * that quietly retries is a benchmark that reports the fallback's score.
 */
export async function probe(routeId: string, model: string, messages: unknown[], withTools = true) {
  const route = [NVIDIA, GEMINI].find((r) => r.id === routeId && r.key);
  if (!route) throw new Error(`route ${routeId} has no key in .env`);
  const t0 = Date.now();
  const { status, ok, parsed } = await attempt(route, model, messages, withTools);
  const ms = Date.now() - t0;
  if (!ok || !parsed?.choices?.[0]?.message)
    return { ms, status, served: "", content: "", calls: [], error: `${status} ${reason(parsed)}` };
  const message = parsed.choices[0].message as Message;
  return {
    ms,
    status,
    served: String(parsed.model ?? model),
    content: message.content ?? "",
    calls: (message.tool_calls ?? []).map((c) => ({ name: c.function?.name ?? "", args: c.function?.arguments ?? "" })),
    error: "",
  };
}

/** Every route a key unlocks, so the benchmark can be told to run on the one that exists. */
export function probeRoutes() {
  return [GEMINI, NVIDIA].filter((r) => r.key && !IS_STUB).map((r) => ({ id: r.id, base: r.base, models: r.models }));
}

/** Runs one user turn to completion, resolving every tool call the model asks for. */
export async function runTurn(
  text: string,
  history: unknown[] = [],
  maxRounds = 6,
  signal?: AbortSignal,
): Promise<Turn & { history: unknown[] }> {
  turnMiss = null;
  turnServed = null;
  const messages: unknown[] = [
    { role: "system", content: systemPrompt() },
    ...history,
    { role: "user", content: text },
  ];
  const steps: Step[] = [];

  for (let round = 0; round < maxRounds; round++) {
    const last = round === maxRounds - 1;
    // Picking a tool is a classification and speaking is a sentence, so the two rounds
    // are allowed to be answered by different models. No extra call is spent to do it.
    const message = await complete(messages, last ? "chat" : "decide", signal, !last);
    const calls = last ? [] : (message.tool_calls ?? []);
    if (calls.length === 0) {
      const said = groundAnswer(tidy(message.content?.trim() || "(the model returned nothing to say)"), text, steps);
      // The tool results have to travel with the answer. A next turn that cannot see
      // which address it already paid for is the one way this product double spends.
      return { text: said, steps, history: [...messages.slice(1), { role: "assistant", content: said }] };
    }

    messages.push({ role: "assistant", content: message.content ?? "", tool_calls: calls });
    for (const call of calls) {
      const name = call.function?.name ?? "";
      let args: Record<string, unknown> = {};
      try {
        args = JSON.parse(call.function?.arguments || "{}");
      } catch {
        args = {};
      }
      const step: Step = { name, args, ok: false };
      if (!TOOL_NAMES.includes(name)) {
        step.error = `this build has no ${name} tool, so nothing happened`;
      } else {
        try {
          step.result = await runTool(name, args);
          step.ok = true;
        } catch (err) {
          step.error = (err as Error).message;
        }
      }
      steps.push(step);
      messages.push({
        role: "tool",
        tool_call_id: call.id,
        content: JSON.stringify(step.ok ? step.result : { error: step.error }),
      });
    }
  }
  throw new Error(`gave up after ${maxRounds} rounds of tool calls without answering`);
}
