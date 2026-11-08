import { createServer } from "node:http";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { Ed25519Keypair } from "@mysten/sui/keypairs/ed25519";

/*
 * Two server behaviours that a browser cannot prove by hand: one answer at a time per
 * thread, and the browser's own day inside the prompt. A fake model on localhost holds
 * a turn open long enough for a second press to arrive, so the lock is proved without
 * spending a provider request. The same turn records the system prompt, so the timezone
 * cookie is proved from the request that carried it rather than from the helper alone.
 */

let fails = 0;
const expect = (what: string, ok: boolean) => {
  console.log(`${ok ? "ok   " : "FAIL "} ${what}`);
  if (!ok) fails++;
};

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

type Seen = { text: string; system: string; at: number };
const seen: Seen[] = [];

const model = createServer(async (req, res) => {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  let body: any = {};
  try {
    body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {}
  const asked = String((body.messages ?? []).filter((m: any) => m.role !== "system").at(-1)?.content ?? "");
  const system = String((body.messages ?? []).find((m: any) => m.role === "system")?.content ?? "");
  seen.push({ text: asked, system, at: Date.now() });
  // Long enough for a second press to land while the thread is still answering.
  if (asked.includes("hold the line")) await sleep(1200);
  res.setHeader("content-type", "application/json");
  res.end(JSON.stringify({ model: body.model ?? "stub", choices: [{ message: { role: "assistant", content: "held" } }] }));
});
await new Promise<void>((resolve) => model.listen(0, "127.0.0.1", () => resolve()));
const modelPort = (model.address() as any).port;

const root = fileURLToPath(new URL("..", import.meta.url));
const probe = createServer();
await new Promise<void>((resolve) => probe.listen(0, "127.0.0.1", () => resolve()));
const appPort = (probe.address() as any).port;
await new Promise<void>((resolve) => probe.close(() => resolve()));

const logs: string[] = [];
const child = spawn(process.execPath, ["--import", "tsx", "src/server.ts"], {
  cwd: root,
  env: {
    ...process.env,
    PORT: String(appPort),
    HOST: "127.0.0.1",
    SEATS_DB: ":memory:",
    CHATS_DB: ":memory:",
    VOICE_LIVE: "0",
    PAY_NETWORK: "testnet",
    PAY_ENABLED: "0",
    MODEL_BASE_URL: `http://127.0.0.1:${modelPort}`,
    MODEL_API_KEY: "stub",
    MODEL_NAME: "stub-model",
    TURN_BUDGET_MS: "20000",
    TOOL_BUDGET_MS: "10000",
  },
  stdio: ["ignore", "pipe", "pipe"],
});
child.stdout.on("data", (b) => logs.push(String(b)));
child.stderr.on("data", (b) => logs.push(String(b)));

const base = `http://127.0.0.1:${appPort}`;

type Reply = { status: number; body: any; headers: Headers };

async function call(method: string, path: string, body?: unknown, cookie = ""): Promise<Reply> {
  const res = await fetch(base + path, {
    method,
    headers: { ...(body ? { "content-type": "application/json" } : {}), ...(cookie ? { cookie } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let parsed: any = {};
  try {
    parsed = JSON.parse(text);
  } catch {
    parsed = { raw: text };
  }
  return { status: res.status, body: parsed, headers: res.headers };
}

function cookieFrom(headers: Headers): string {
  const all = headers.getSetCookie?.() ?? [headers.get("set-cookie") ?? ""];
  for (const raw of all) {
    const hit = /tr_seat=([A-Za-z0-9_-]{10,64})/.exec(raw);
    if (hit) return `tr_seat=${hit[1]}`;
  }
  return "";
}

function dayAt(offset: number, at: number): string {
  const clock = new Date(at + offset * 60_000);
  return `${clock.getUTCFullYear()}-${String(clock.getUTCMonth() + 1).padStart(2, "0")}-${String(clock.getUTCDate()).padStart(2, "0")}`;
}

try {
  let ready = false;
  for (let i = 0; i < 120 && !ready; i++) {
    try {
      const res = await fetch(base + "/");
      ready = res.ok;
      await res.text();
    } catch {
      await sleep(100);
    }
  }
  if (!ready) throw new Error(`the server did not answer on ${base}\n${logs.join("").slice(-2000)}`);

  // A real signature from a throwaway key, so the gated turn routes answer this seat.
  const key = Ed25519Keypair.generate();
  const address = key.toSuiAddress();
  const challenge = await call("POST", "/wallet/challenge", { address });
  expect("the challenge is offered", challenge.status === 200 && typeof challenge.body.message === "string");
  const seat = cookieFrom(challenge.headers);
  expect("the challenge binds to a seat cookie", /^tr_seat=/.test(seat));
  const signed = await key.signPersonalMessage(new TextEncoder().encode(String(challenge.body.message)));
  const login = await call(
    "POST",
    "/wallet",
    { address, chain: "sui:testnet", message: challenge.body.message, bytes: signed.bytes, signature: signed.signature },
    seat,
  );
  expect("a real wallet signature is accepted", login.status === 200 && login.body.source === "wallet");

  // One thread answers once. A press that arrives during the answer is refused.
  const holding = call("POST", "/turn", { text: "hold the line", session: "lock" }, seat);
  await sleep(300);
  const early = await call("POST", "/turn", { text: "second press", session: "lock" }, seat);
  expect("a second press on a thread still answering is refused", early.status === 409);
  expect("the refusal says the previous answer is still running", /still answering/.test(String(early.body.error)));

  // The lock is per thread, not per server: a different conversation still runs.
  const created = await call("POST", "/sessions", { title: "Second thread" }, seat);
  const other = String(created.body?.session?.id ?? "");
  expect("a second thread can be created while the first is held", created.status === 200 && !!other);
  const parallel = await call("POST", "/turn", { text: "parallel thread", session: other }, seat);
  expect("a different thread is not blocked by the held one", parallel.status === 200);

  const first = await holding;
  expect("the held turn finishes normally", first.status === 200 && first.body.text === "held");

  const released = await call("POST", "/turn", { text: "after release", session: "lock" }, seat);
  expect("the lock is released after the answer", released.status === 200);
  expect("the refused press never reached the model", !seen.some((s) => s.text === "second press"));
  expect("the parallel thread did reach the model", seen.some((s) => s.text === "parallel thread"));

  // The browser's clock is read from the cookie and travels into the system prompt.
  const east = await call("POST", "/turn", { text: "timezone plus", session: "tzplus" }, `${seat}; tr_tz=840`);
  const west = await call("POST", "/turn", { text: "timezone minus", session: "tzminus" }, `${seat}; tr_tz=-720`);
  expect("both timezone turns answer", east.status === 200 && west.status === 200);
  const eastSeen = seen.find((s) => s.text === "timezone plus");
  const westSeen = seen.find((s) => s.text === "timezone minus");
  const eastDay = eastSeen ? dayAt(840, eastSeen.at) : "east missing";
  const westDay = westSeen ? dayAt(-720, westSeen.at) : "west missing";
  expect("the prompt carries the day at UTC plus fourteen", !!eastSeen && eastSeen.system.includes(`Today is ${eastDay}`));
  expect("the prompt carries the day at UTC minus twelve", !!westSeen && westSeen.system.includes(`Today is ${westDay}`));
  expect("the two clocks produce different calendar days", eastDay !== westDay);
} catch (err) {
  console.error((err as Error).message);
  fails++;
} finally {
  child.kill("SIGTERM");
  await new Promise<void>((resolve) => model.close(() => resolve()));
  await sleep(200);
  if (child.exitCode === null) child.kill("SIGKILL");
}

if (fails) {
  console.error(`${fails} server behaviour checks failed`);
  process.exitCode = 1;
} else {
  console.log("all server behaviour checks passed");
}
