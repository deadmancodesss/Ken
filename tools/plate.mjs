/**
 * One command from a sentence to a finished plate.
 *
 * npm run plate -- life-market "a woman at a market stall handing over a coin" [--model flux-2-klein-4b] [--ratio 3:2]
 *
 * The style is locked in the preamble rather than left to each prompt, because a
 * cast of six drawings that do not look like they came from the same book is worse
 * than four that do. Output goes through tools/normalize.mjs so the sheet inside the
 * drawing is pushed to pure white, which is the only way mix-blend-mode: multiply
 * disappears into the page instead of leaving a rectangle.
 */
import { copyFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { basename, join, resolve } from "node:path";
import { config } from "dotenv";

config();

const BASE = "https://api.apiframe.ai/v2";
const RAW = "vibe_images";
const ASSETS = "public/assets";

/* Every plate shares this. It names the four tokens the theme already uses so a
   drawing cannot arrive with a colour the pages have no variable for, and it names
   the two people who already appear in the published plates, because a cast that
   changes face between pages reads as clip art rather than as one book. */
const STYLE = `Hand-drawn children's book comic illustration in ink and wash, mid-century European picture book style. Confident dark brown-black ink outlines of uneven weight, fine crosshatched shading in the shadows, flat unshaded colour fills. Plain white paper background, completely flat, no gradient, no texture, no wash, generous empty white margins. Palette strictly limited to white paper, dark brown-black ink, terracotta clay red #A34F24, moss green #4C6B3F, brick red #9A3A2E and muted sand tan. No blue anywhere, no pink, no neon, no glow, no photorealism, no 3D render. Two ordinary people recur in every drawing: a man in his thirties with messy dark hair and light stubble, wearing a terracotta crew-neck sweater, moss green trousers and brown shoes, and a woman with dark curly hair tied back, wearing a moss green shirt, a brick red skirt and black shoes. Simple charming imperfect shapes, warm and slightly comic. Absolutely no text, no letters, no numbers, no labels, no signature.`;

const PARAMS_KEY = {
  "flux-2-dev": "fluxParams",
  "imagen-4-fast": "imagenParams",
  "nano-banana-2-lite": "nanoBananaParams",
  "ideogram-v4-turbo": "ideogramParams",
};

/* Workers AI, measured on our own account on 2026-11-02. `shape` is not a style
   preference: the flux-2 family answers 400 to json and only accepts multipart,
   and the older models name the step count num_steps rather than steps. Sizes are
   multiples of 64 because that is what the endpoint rejects anything else for. */
const CF_MODELS = {
  "flux-2-klein-4b": { id: "@cf/black-forest-labs/flux-2-klein-4b", shape: "form", steps: "steps", size: true },
  "flux-2-klein-9b": { id: "@cf/black-forest-labs/flux-2-klein-9b", shape: "form", steps: "steps", size: true },
  "flux-2-dev": { id: "@cf/black-forest-labs/flux-2-dev", shape: "form", steps: "steps", size: true },
  "flux-1-schnell": { id: "@cf/black-forest-labs/flux-1-schnell", shape: "json", steps: "steps", size: false },
  "sdxl-lightning": { id: "@cf/bytedance/stable-diffusion-xl-lightning", shape: "json", steps: "num_steps", size: true },
  "phoenix": { id: "@cf/leonardo/phoenix-1.0", shape: "json", steps: "num_steps", size: true },
};

const RATIOS = {
  "1:1": [1024, 1024],
  "3:2": [1536, 1024],
  "2:3": [1024, 1536],
  "4:3": [1344, 1024],
  "16:9": [1792, 1024],
};

const PNG_SIG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

/** The flux models answer with jpeg whatever the file is called, and the keyer reads
    png bytes, so the container is sniffed from the first bytes rather than trusted. */
function writeRaw(bytes, path) {
  if (bytes.subarray(0, 8).equals(PNG_SIG)) return writeFileSync(path, bytes);
  if (bytes[0] !== 0xff || bytes[1] !== 0xd8) {
    throw new Error(`unknown image container, first bytes were ${bytes.subarray(0, 4).toString("hex")}`);
  }
  const tmp = `${path}.jpeg`;
  writeFileSync(tmp, bytes);
  run("sips", ["-s", "format", "png", tmp, "--out", path]);
  rmSync(tmp);
}

async function cloudflare(modelKey, prompt, flags) {
  const account = process.env.CF_ACCOUNT_ID;
  const token = process.env.CF_AI_TOKEN ?? process.env.IMAGE_API_KEY;
  if (!account || !token) {
    throw new Error("CF_ACCOUNT_ID and CF_AI_TOKEN belong in .env, never in a chat message");
  }
  const m = CF_MODELS[modelKey];
  if (!m) throw new Error(`no cloudflare model named ${modelKey}. Known: ${Object.keys(CF_MODELS).join(", ")}`);

  const fields = { prompt, [m.steps]: Number(flags.steps), seed: Number(flags.seed) };
  if (m.size) {
    const [w, h] = RATIOS[flags.ratio] ?? RATIOS["3:2"];
    Object.assign(fields, { width: w, height: h });
  }

  const headers = { authorization: `Bearer ${token}` };
  let body;
  if (m.shape === "form") {
    body = new FormData();
    for (const [k, v] of Object.entries(fields)) body.append(k, String(v));
  } else {
    body = JSON.stringify(fields);
    headers["content-type"] = "application/json";
  }

  const url = `https://api.cloudflare.com/client/v4/accounts/${account}/ai/run/${m.id}`;
  const started = Date.now();
  const res = await fetch(url, { method: "POST", headers, body });
  if (!res.ok) throw new Error(`${m.id} answered ${res.status}: ${(await res.text()).slice(0, 300)}`);

  /* Half these models answer with json and a base64 field, the other half answer
     with the raw image bytes, so the content type is the only switch that works. */
  const type = res.headers.get("content-type") ?? "";
  let bytes, neurons;
  if (type.includes("json")) {
    const data = await res.json();
    const image = data?.result?.image;
    if (!image) throw new Error(`${m.id} returned no image: ${JSON.stringify(data).slice(0, 300)}`);
    bytes = Buffer.from(image.startsWith("data:") ? image.split(",")[1] : image, "base64");
    neurons = data?.result?.usage?.neurons;
  } else {
    bytes = Buffer.from(await res.arrayBuffer());
  }
  const secs = ((Date.now() - started) / 1000).toFixed(1);
  console.log(`cloudflare ${m.id} in ${secs}s, ${(bytes.length / 1024).toFixed(0)} KB${neurons ? `, ${neurons.toFixed(0)} neurons` : ""}`);
  return bytes;
}

function parseArgs(argv) {
  const positional = [];
  const flags = { model: "", ratio: "3:2", seed: "20261102", width: 1100, steps: "4", key: "on", provider: "" };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (["--model", "--ratio", "--seed", "--width", "--from", "--steps", "--provider"].includes(a)) flags[a.slice(2)] = argv[++i];
    else if (a === "--no-key") flags.key = "off";
    else positional.push(a);
  }
  if (!flags.provider) {
    flags.provider = process.env.CF_ACCOUNT_ID && (process.env.CF_AI_TOKEN ?? process.env.IMAGE_API_KEY) ? "cloudflare" : "apiframe";
  }
  if (!flags.model) flags.model = flags.provider === "cloudflare" ? "flux-2-klein-4b" : "flux-2-dev";
  return { name: positional[0], scene: positional.slice(1).join(" ").trim(), flags };
}

async function api(path, init) {
  const res = await fetch(`${BASE}${path}`, {
    ...init,
    headers: { "x-api-key": process.env.PLATE_API_KEY, "content-type": "application/json", ...init?.headers },
  });
  const text = await res.text();
  let body;
  try {
    body = JSON.parse(text);
  } catch {
    throw new Error(`${path} answered ${res.status} with ${text.slice(0, 200)}`);
  }
  if (!res.ok) throw new Error(`${path} answered ${res.status}: ${text.slice(0, 400)}`);
  return body;
}

async function credits() {
  try {
    const me = await api("/me");
    return me.team?.credits ?? null;
  } catch {
    return null;
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Result shapes are not pinned by the spec, so every plausible URL field is collected. */
function urlsFrom(value, out = []) {
  if (!value) return out;
  if (typeof value === "string") {
    if (/^https?:\/\//.test(value)) out.push(value);
    return out;
  }
  if (Array.isArray(value)) for (const v of value) urlsFrom(v, out);
  else if (typeof value === "object") for (const v of Object.values(value)) urlsFrom(v, out);
  return out;
}

async function waitForJob(id) {
  const deadline = Date.now() + 240_000;
  for (;;) {
    const job = await api(`/jobs/${id}`);
    if (job.status === "COMPLETED") return job;
    if (job.status === "FAILED" || job.status === "CANCELLED") throw new Error(`job ${id} ${job.status}: ${job.error}`);
    if (Date.now() > deadline) throw new Error(`job ${id} still ${job.status} after 4 minutes`);
    await sleep(2000);
  }
}

function run(cmd, args) {
  const r = spawnSync(cmd, args, { stdio: "inherit" });
  if (r.error) throw new Error(`${cmd} failed: ${r.error.message}`);
  if (r.status !== 0) throw new Error(`${cmd} exited ${r.status}`);
}

const { name, scene, flags } = parseArgs(process.argv.slice(2));
if (!name || (!scene && !flags.from)) {
  console.error('usage: npm run plate -- <name> "<scene>" [--model flux-2-klein-4b] [--ratio 3:2] [--steps 4] [--seed N] [--width 1100] [--no-key]');
  console.error('       npm run plate -- <name> --from somewhere/drawing.png [--width 1100] [--no-key]');
  process.exit(2);
}

mkdirSync(RAW, { recursive: true });
mkdirSync(ASSETS, { recursive: true });
const rawPath = join(RAW, `${basename(name)}.png`);

/* One command either way, so a drawing from anywhere goes through the same white
   keying and the same encoder as a drawing from an api. */
function encode() {
  if (flags.key === "off") {
    console.log("skipped normalize and encode, raw png only");
    return;
  }
  const keyed = join(RAW, `${basename(name)}-keyed.png`);
  run("node", ["tools/normalize.mjs", rawPath, keyed, String(flags.width)]);
  run("cwebp", ["-m", "6", "-q", "74", keyed, "-o", join(ASSETS, `${basename(name)}.webp`)]);
  const out = join(ASSETS, `${basename(name)}.webp`);
  console.log(`out  ${out} ${(readFileSync(out).length / 1024).toFixed(0)} KB`);
  console.log("now add a <figure class=\"plate\"> with that src and a caption written for the page it sits on.");
}

if (flags.from) {
  const src = resolve(flags.from);
  if (!existsSync(src)) {
    console.error(`no such file: ${src}. It has to be a png, because the keyer reads png bytes.`);
    process.exit(2);
  }
  copyFileSync(src, rawPath);
  console.log(`raw  ${rawPath} copied from ${src}, nothing generated`);
  encode();
  process.exit(0);
}

const prompt = `${STYLE}\n\nScene: ${scene}`;

if (flags.provider === "cloudflare") {
  writeRaw(await cloudflare(flags.model, prompt, flags), rawPath);
  encode();
  process.exit(0);
}

if (!process.env.PLATE_API_KEY) {
  console.error("PLATE_API_KEY is not set. It belongs in .env, never in a chat message.");
  process.exit(2);
}

const key = PARAMS_KEY[flags.model];
if (!key) console.error(`no parameter block known for ${flags.model}, sending only prompt and model`);

const before = await credits();
console.log(`credits before: ${before ?? "unknown"}`);

const body = { model: flags.model, prompt, ...(key ? { [key]: { aspect_ratio: flags.ratio, output_format: "png" } } : {}) };
if (key === "fluxParams") Object.assign(body[key], { seed: Number(flags.seed), steps: 24, guidance: 3 });
if (key === "ideogramParams") Object.assign(body[key], { seed: Number(flags.seed), rendering_speed: "quality" });

const accepted = await api("/images/generate", { method: "POST", body: JSON.stringify(body) });
console.log(`job ${accepted.jobId} ${accepted.status}`);

const job = await waitForJob(accepted.jobId);
const urls = urlsFrom(job.result).filter((u) => !/\.json$/i.test(u));
if (!urls.length) throw new Error(`job completed with no image url: ${JSON.stringify(job.result).slice(0, 400)}`);

const bytes = Buffer.from(await (await fetch(urls[0])).arrayBuffer());
writeFileSync(rawPath, bytes);
console.log(`raw  ${rawPath} ${(bytes.length / 1024).toFixed(0)} KB, cost ${job.creditCost ?? "?"} credits`);

encode();

const after = await credits();
if (before !== null && after !== null) console.log(`credits after: ${after}`);
