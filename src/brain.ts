import "dotenv/config";
import { TOOLS, TOOL_NAMES, runTool } from "./tools.js";
import { session } from "./session.js";

/**
 * One code path for every provider: Gemini, OpenRouter and OpenAI all expose an
 * OpenAI-compatible /chat/completions with function calling, so the key and the
 * base URL are the only things that change between them.
 *
 * A request is therefore an attempt, and an attempt is a route plus a model name.
 * The order is the product: OpenRouter answers first when it has a key, Gemini
 * covers the whole lane when OpenRouter is out of daily requests or out of credit,
 * and the local stub is alone in the list so `npm run demo` never drifts onto a
 * network. Nothing here is a fallback that hides a failure: every attempt that did
 * not answer is named in the error the page shows.
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
 * A value that begins `apikey_` is the shape a browser session leaves behind and was
 * measured answering an authentication error rather than a model answer. It is dropped so
 * one bad credential cannot make every turn of a live demo pay for a doomed request
 * first. Any other shape is believed, because a prefix is not a promise.
 */
const rawOpenRouter = (process.env.OPENROUTER_API_KEY ?? "").trim();
const OPENROUTER_KEY = /^apikey_/i.test(rawOpenRouter) ? "" : usable(rawOpenRouter);
const OPENROUTER_WHY = "OPENROUTER_API_KEY is a web session token, not an API key. Make one at openrouter.ai/settings/keys";

const GEMINI: Route = {
  id: "gemini",
  base: STUB_BASE,
  key: IS_STUB ? STUB_KEY : usable(STUB_KEY),
  models: list(process.env.MODEL_NAME, "gemini-3.1-flash-lite,gemini-3.5-flash"),
};

/**
 * `:free` variants are metered by requests rather than tokens, and the whole free
 * pool is capped per day, so a chain is a budget as much as a quality ladder.
 * Nemotron 3.5 Lightning leads because it declares tools, tool_choice and a 3B
 * active parameter count, and a spoken answer that arrives in two seconds beats a
 * better one that arrives in forty. Gemma 4 31B is the dense fallback, and Nemotron
 * Ultra is the last resort: 55B active parameters is the most capable free name on
 * the service and also the slowest thing that could answer mid sentence.
 */
const OPENROUTER: Route = {
  id: "openrouter",
  base: (process.env.OPENROUTER_BASE_URL ?? "https://openrouter.ai/api/v1").replace(/\/$/, ""),
  key: OPENROUTER_KEY,
  models: list(process.env.OPENROUTER_MODEL, "nvidia/nemotron-3.5-lightning:free,google/gemma-4-31b-it:free,nvidia/nemotron-3-ultra-550b-a55b:free"),
};

/**
 * The rounds that carry tool schemas are a different job from the round that speaks.
 * Choosing between twelve tools is one classification, and OpenRouter sells that job
 * as a router: Jev Router picks a model and a reasoning effort per request. It prices
 * at whatever the model it chose prices at, so an account with no credit is refused
 * with a 402 and Free Models Router behind it costs nothing. Both are tried before any
 * named chat model, and a chain of two is the whole reason for the second one.
 */
const DECIDE: Route = {
  id: "openrouter",
  base: OPENROUTER.base,
  key: OPENROUTER.key,
  models: list(process.env.DECISION_MODEL, "typesafe/jev-router,openrouter/free"),
};

function list(raw: string | undefined, fallback: string): string[] {
  return (raw ?? fallback)
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

/** Ordered attempts for one lane. The stub lane is short and never touches a network. */
function attempts(lane: "decide" | "chat"): { route: Route; model: string }[] {
  if (IS_STUB) return [{ route: GEMINI, model: GEMINI.models[0] }];
  const routes: Route[] = [];
  if (lane === "decide" && DECIDE.key) routes.push(DECIDE);
  if (OPENROUTER.key) routes.push(OPENROUTER);
  if (GEMINI.key) routes.push(GEMINI);
  return routes.flatMap((route) => route.models.map((model) => ({ route, model })));
}

/** The routes a key actually unlocks, so a page can say which provider is in charge. */
export function brainRoutes() {
  if (IS_STUB) return [{ id: "stub", models: GEMINI.models }];
  return [OPENROUTER.key ? { id: OPENROUTER.id, models: OPENROUTER.models } : null, GEMINI.key ? { id: "gemini", models: GEMINI.models } : null].filter(
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
    // A route that is switched off says why, because "Gemini answered" and "OpenRouter
    // was never asked" are different sentences and only one of them is true here.
    why: OPENROUTER.key ? "" : rawOpenRouter ? OPENROUTER_WHY : "no OPENROUTER_API_KEY in .env",
  };
}

/** One prompt for both transports, so a call and a typed question can never disagree. */
export const systemPrompt = () => `You are the voice agent for a Sui wallet. You can see the chain through Tatum and you remember
things on Walrus. Today is ${new Date().toISOString().slice(0, 10)}. ${
  session().source === "wallet"
    ? `You are speaking for the wallet ${session().wallet} on ${session().network}, which the person in front of you connected themselves. Every payment you prepare needs their signature.`
    : `The wallet you speak for is the demo wallet ${session().wallet} on ${session().network}, and it pays without asking because the money is worthless testnet dust.`
}

Rules you must not break:
- Never invent or guess a wallet address. Only use an address a tool returned.
- Before paying anyone by name, call find_person. If it returns not_found, ask the user for the address instead of guessing.
- If find_person returns confidence below 1, repeat the name you stored back and ask whether that is the person they meant. Never pay on a name the microphone only nearly got right.
- Prefer answering from memory over re-reading the chain. Call who_is_this or money_history only when memory does not already answer it.
- "What is due", "is anything overdue", "has she asked again" and "what do I usually pay them" are all one tool: what_is_due. Its lines are measured from real transfers, so read the line instead of working out a date yourself, and say "no rhythm yet" plainly when that is what it returned.
- paid_lookup costs real testnet money. Call it only after who_is_this comes back with named_as null, and never twice for the same address in one conversation. If it answers cost_usdc 0, say you already knew it and did not pay.
- Speak in short sentences. Your reply is read out loud. No markdown, no bullet points, no hex strings unless the user asks for one.
- Round money out loud: say "1.33 USDC", never "1.328459". Say "yesterday" or "last week", never an ISO date.
- A day you say out loud is worked out from a date a tool returned, counted against today's date above. A payment made today is today. Never guess a date, and never repeat one from an older part of this conversation.
- Answer in the language the user spoke to you in.
- Write the way people talk. Never use an em dash and never use a semicolon. Break the thought into two short sentences instead.
- Say "the agent wallet" only if asked about the address. Otherwise talk about people by name.
- If a tool fails, tell the user what failed plainly and do not retry more than once.
- When pay_usdc returns awaiting_signature, the money has NOT moved. Say it is waiting on the Pay page for them to sign. Never say you sent it.`;

export type Step = { name: string; args: Record<string, unknown>; ok: boolean; result?: unknown; error?: string };
export type Turn = { text: string; steps: Step[] };

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
 * a dead conversation, so the attempt is cut and the next name is asked. Set to 0 to
 * wait as long as the provider likes, which is what a batch test wants and never what
 * a person holding a microphone wants.
 */
const TIMEOUT = Number(process.env.MODEL_TIMEOUT_MS ?? 120_000);

type Message = { content?: string; tool_calls?: { id: string; function: { name: string; arguments: string } }[] };

async function attempt(route: Route, model: string, messages: unknown[], withTools: boolean, signal?: AbortSignal) {
  const body: Record<string, unknown> = { model, messages, tool_choice: "auto" };
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
  // The status travels with the body because OpenRouter puts a 402, a 429 and a 503 in
  // the same shaped JSON, and telling them apart is the difference between waiting for
  // a minute, adding credit, or moving to another model right now.
  return { status: res.status, ok: res.ok, parsed: (await res.json().catch(() => ({}))) as any };
}

/**
 * Ask every name in the lane until one answers, and keep what each of the others said
 * wrong. A 401 ends its whole route because a bad key does not get better on the next
 * model, and a 402 is OpenRouter saying the account has no credit, which the free
 * router behind it can survive. Everything else moves politely to the next name.
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
        return message as Message;
      }
      failures.push(`${model} (${status || "no status"}) ${reason(parsed)}`);
      // A bad key does not get better on the next model name, so the whole route is
      // dropped rather than walked. Every other failure is the provider's problem and
      // moves politely to the next name.
      if (status === 401 || status === 403) dead.add(route.id);
    } catch (err) {
      const name = (err as Error).name;
      failures.push(`${model} ${name === "TimeoutError" ? `was cut off after ${Math.round(TIMEOUT / 1000)} s` : (err as Error).message}`);
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
  const route = [GEMINI, OPENROUTER, DECIDE].find((r) => r.id === routeId && r.key);
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
  return [OPENROUTER, GEMINI].filter((r) => r.key && !IS_STUB).map((r) => ({ id: r.id, base: r.base, models: r.models }));
}

/** Runs one user turn to completion, resolving every tool call the model asks for. */
export async function runTurn(
  text: string,
  history: unknown[] = [],
  maxRounds = 6,
  signal?: AbortSignal,
): Promise<Turn & { history: unknown[] }> {
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
      const said = message.content?.trim() || "(the model returned nothing to say)";
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
        step.error = `unknown tool`;
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
