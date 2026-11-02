// Shared behaviour for every page: the masthead state, the wallet handshake and
// the scroll reveals. Keeping it here is what stops the app and the landing page
// from disagreeing about what the same chip does.
import { discover, connect } from "./wallet.js";

export const $ = (id) => document.getElementById(id);

export const shortAddr = (a) => `${a.slice(0, 6)}…${a.slice(-4)}`;

// Chain units and ISO dates are the two things this product exists to hide.
export function spoken(text) {
  const [num, ...rest] = String(text).split(" ");
  const x = Number(num);
  if (!Number.isFinite(x)) return text;
  const unit = rest.join(" ");
  if (x !== 0 && Math.abs(x) < 0.01) return unit ? `under a cent of ${unit}` : "under a cent";
  return [x >= 100 ? String(Math.round(x)) : x.toFixed(2).replace(/\.?0+$/, ""), unit].join(" ");
}

export function when(iso) {
  if (!iso) return "never";
  // Both sides are pinned to local midday, because a stored date is a calendar day and
  // a millisecond difference across a timezone boundary used to call today yesterday.
  const noon = (d) => new Date(d).setHours(12, 0, 0, 0);
  const days = Math.round((noon(new Date()) - noon(iso.slice(0, 10))) / 86_400_000);
  if (days <= 0) return "today";
  if (days === 1) return "yesterday";
  if (days < 7) return days + " days ago";
  if (days < 14) return "last week";
  return Math.floor(days / 7) + " weeks ago";
}

/**
 * A stored line is written by code, so it comes back holding a whole address, a whole
 * digest and an ISO date. Those are the exact three things this product exists to hide,
 * and Walrus memory has no delete, so the only place to fix it is on the way to screen.
 */
export function plain(text) {
  return String(text)
    .replace(/\bCounterparty\b/g, "An address")
    .replace(/\btx\s+([1-9A-HJ-NP-Za-km-z]{30,})/g, (_, d) => `tx ${d.slice(0, 8)}…`)
    .replace(/\b0x[0-9a-f]{40,}\b/gi, (a) => shortAddr(a))
    .replace(/\bon (\d{4}-\d{2}-\d{2})\b/g, (_, d) => when(d))
    .replace(/\b\d{4}-\d{2}-\d{2}\b/g, (d) => when(d))
    .replace(/\b\d+\.\d{5,}\s+[A-Z]{3,4}\b/g, (m) => spoken(m))
    .replace(/\b(\d+) transaction\(s\)/g, (_, n) => `${n} transaction${n === "1" ? "" : "s"}`)
    .replace(/\bnot yet labelled by the user\.?/gi, "Nothing has named it yet")
    .replace(/\buser revoked\b/gi, "you revoked")
    .replace(/\s+,/g, ",")
    .replace(/\s{2,}/g, " ")
    .trim();
}

/** Sections fade up once as they enter the viewport. */
export function reveal() {
  const items = document.querySelectorAll(".reveal");
  if (!items.length) return;
  if (!("IntersectionObserver" in window)) {
    items.forEach((el) => el.classList.add("shown"));
    return;
  }
  const io = new IntersectionObserver(
    (rows) => {
      for (const r of rows) {
        if (!r.isIntersecting) continue;
        r.target.classList.add("shown");
        io.unobserve(r.target);
      }
    },
    { rootMargin: "0px 0px -8% 0px" },
  );
  // Whatever is already on screen is shown immediately instead of waiting for a
  // callback. An observer can be delayed by a hidden or prerendered tab, and a
  // landing page that fades in from invisible would simply look empty.
  const viewport = window.innerHeight || document.documentElement.clientHeight;
  items.forEach((el) => {
    if (el.getBoundingClientRect().top < viewport) el.classList.add("shown");
    else io.observe(el);
  });
}

/*
 * Talk and Call must not disagree about which voice the agent has, so the saved
 * pick lives here and both pages read it.
 */
const NOVELTY =
  /^(bahh|boing|bells|bubbles|cellos|eddy|flo|good news|bad news|grandma|grandpa|jester|junior|kathy|klang|organ|pipe|ralph|reed|rocko|sandy|shelley|superstar|trinoids|whisper|wobble|zarvox|albert|ellen|pink|zelda|hot mess|big zebra|brave heart|overcast|wildcat|superhero)\b/i;

export const tidyVoice = (v) => v.name.replace(/Google |Microsoft |Natural |Compact /g, "").trim() || v.name;

const canon = (code) => (code || "").toLowerCase().replace(/_/g, "-");

/** One language runs the whole call. The microphone listens in it and the answer comes back in it. */
export const langSetting = () => localStorage.getItem("tr.lang") || "en-US";

export const setLang = (code) => localStorage.setItem("tr.lang", code);

/*
 * Names come from the browser's own locale data rather than a table written by
 * hand, because a picker that shows "bg-BG" instead of "Bulgarian" is a picker
 * nobody uses.
 */
let names = null;
function label(code) {
  const [lang, region] = canon(code).split("-");
  try {
    names ??= {
      lang: new Intl.DisplayNames([navigator.language || "en"], { type: "language" }),
      region: new Intl.DisplayNames([navigator.language || "en"], { type: "region" }),
    };
    const l = names.lang.of(lang) || lang;
    // A numeric region such as 001 means "the world", which reads as noise in a picker.
    const r = region && !/^\d+$/.test(region) ? names.region.of(region.toUpperCase()) : "";
    return r && r.toLowerCase() !== l.toLowerCase() ? `${l[0].toUpperCase()}${l.slice(1)} (${r})` : `${l[0].toUpperCase()}${l.slice(1)}`;
  } catch {
    return code;
  }
}

/** The name of a language code, for a page that shows the choice instead of offering it. */
export const langName = (code) => label(code);

/** Only languages this browser can actually speak, because a call it cannot answer is worse than no picker. */
export function spokenLanguages() {
  if (!window.speechSynthesis) return [];
  const seen = new Map();
  for (const v of speechSynthesis.getVoices()) {
    if (NOVELTY.test(v.name.trim())) continue;
    if (!seen.has(v.lang)) seen.set(v.lang, label(v.lang));
  }
  const want = canon(langSetting());
  return [...seen]
    .map(([code, name]) => ({ code, name }))
    .sort(
      (a, b) =>
        (canon(b.code) === want) - (canon(a.code) === want) ||
        Number(canon(b.code).startsWith("en")) - Number(canon(a.code).startsWith("en")) ||
        a.name.localeCompare(b.name),
    );
}

export function voicesWorthHearing(lang = langSetting()) {
  if (!window.speechSynthesis) return [];
  const want = canon(lang);
  const family = want.split("-")[0];
  const usable = speechSynthesis.getVoices().filter((v) => !NOVELTY.test(v.name.trim()));
  // Falling back to English beats handing the page an empty picker and a silent agent.
  const same = usable.filter((v) => canon(v.lang).startsWith(family));
  const list = same.length ? same : usable.filter((v) => canon(v.lang).startsWith("en"));
  const rank = (v) => (/enhanced|premium|natural|google/i.test(v.name) ? 2 : 0) + (canon(v.lang) === want ? 1 : 0);
  return list.sort((a, b) => rank(b) - rank(a));
}

export const paceSetting = () => Number(localStorage.getItem("tr.pace")) || 1.03;

/** A configured utterance, or null when this browser has no speech at all. */
export function buildSpeech(text) {
  if (!window.speechSynthesis) return null;
  speechSynthesis.cancel();
  const u = new SpeechSynthesisUtterance(text);
  const list = voicesWorthHearing();
  const saved = localStorage.getItem("tr.voice");
  const picked = list.find((v) => tidyVoice(v) === saved) ?? list[0];
  if (picked) u.voice = picked;
  u.lang = picked?.lang ?? langSetting();
  const pace = paceSetting();
  // Rate and pitch move together. Rate alone just sounds like a fast robot.
  u.rate = pace;
  u.pitch = 0.96 + (pace - 1) * 0.4;
  return u;
}

const peak = (buf) => {
  let top = 0;
  for (const v of buf) top = Math.max(top, Math.abs(v - 128) / 128);
  return Math.min(1, top * 2.6);
};

/**
 * Real microphone level from 0 to 1, so a visual can move with the sound coming
 * out of a person rather than with a timer. Returns a stop function. Throws when
 * the browser has no microphone API or the permission was refused, which the
 * caller reports instead of showing a ribbon that would be lying.
 */
export async function startMic(onLevel) {
  const AC = window.AudioContext || window.webkitAudioContext;
  if (!navigator.mediaDevices?.getUserMedia || !AC) throw new Error("no microphone here");
  const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
  const ctx = new AC();
  const src = ctx.createMediaStreamSource(stream);
  const analyser = ctx.createAnalyser();
  analyser.fftSize = 256;
  src.connect(analyser);
  const buf = new Uint8Array(analyser.frequencyBinCount);
  let raf = 0;
  const step = () => {
    analyser.getByteTimeDomainData(buf);
    onLevel(peak(buf));
    raf = requestAnimationFrame(step);
  };
  step();
  return () => {
    cancelAnimationFrame(raf);
    stream.getTracks().forEach((t) => t.stop());
    ctx.close().catch(() => {});
  };
}

/*
 * The model's own voice arrives as audio bytes from /speak. Two vendors can answer
 * that call and the server names whichever one did, so a page that says "Fish spoke"
 * is reporting a measurement rather than a setting. Until any key exists the server
 * says so, and these helpers report that instead of pretending the page is silent for
 * a mystery reason.
 */
let speech = { enabled: false, model: "none", voice: "", voices: [], providers: [], known: false };

export const remoteSpeech = () => speech;

/** Remembers what the server reported about its own voice, so pickers can match it. */
export function noteSpeech(state) {
  if (state?.tts) speech = { ...state.tts, known: true };
  return speech;
}

export const gvoiceSetting = () => localStorage.getItem("tr.gvoice") || speech.voice;

export const setGvoice = (v) => localStorage.setItem("tr.gvoice", v);

let playCtx = null;

/**
 * Speaks through the model and returns a stop function. The level it reports comes
 * from the audio actually playing, which is what makes the ribbon honest for the
 * agent's voice as well as the user's.
 */
export async function speakRemote(text, { onLevel, onEnd, onVoice } = {}) {
  const res = await fetch("/speak", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ text, voice: gvoiceSetting() }),
  });
  if (!res.ok || !(res.headers.get("content-type") || "").includes("audio")) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body.error || `voice call failed (${res.status})`);
  }
  const AC = window.AudioContext || window.webkitAudioContext;
  if (!AC) throw new Error("this browser cannot play audio");
  const bytes = await res.arrayBuffer();
  onVoice?.({ id: res.headers.get("x-voice") ?? "", ms: Number(res.headers.get("x-voice-ms") ?? 0) });
  playCtx ??= new AC();
  await playCtx.resume().catch(() => {});
  const buffer = await playCtx.decodeAudioData(bytes);

  const src = playCtx.createBufferSource();
  src.buffer = buffer;
  // Pace is a playback rate here rather than a synthesis parameter, so the slider
  // the user set keeps meaning the same thing on both voices.
  src.playbackRate.value = paceSetting();
  const analyser = playCtx.createAnalyser();
  analyser.fftSize = 256;
  src.connect(analyser);
  analyser.connect(playCtx.destination);

  const buf = new Uint8Array(analyser.frequencyBinCount);
  let raf = 0;
  let done = false;
  const stop = () => {
    if (done) return;
    done = true;
    cancelAnimationFrame(raf);
    try {
      src.stop();
    } catch {
      /* already finished */
    }
  };
  const step = () => {
    if (done) return;
    analyser.getByteTimeDomainData(buf);
    onLevel?.(peak(buf));
    raf = requestAnimationFrame(step);
  };
  src.onended = () => {
    if (done) return;
    done = true;
    cancelAnimationFrame(raf);
    onLevel?.(0);
    onEnd?.();
  };
  step();
  src.start();
  return stop;
}

async function post(payload) {
  const res = await fetch("/wallet", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(payload),
  });
  const body = await res.json();
  if (!res.ok) throw new Error(body.error || "http " + res.status);
  return body;
}

/**
 * Wires the wallet chip and returns the current session to the caller so each
 * page can load whatever it displays.
 */
export function mountWallet(onChange) {
  const btn = $("connect");
  if (!btn) return;
  btn.onclick = async () => {
    if (btn.dataset.mode === "wallet") {
      btn.textContent = "returning…";
      await post({ demo: true }).catch(() => {});
      btn.textContent = "Connect wallet";
      btn.dataset.mode = "";
      btn.classList.remove("on");
      onChange?.();
      return;
    }
    btn.textContent = "looking…";
    try {
      const found = discover();
      if (!found.length) {
        btn.textContent = "Connect wallet";
        $("whose").textContent = "no Sui wallet here. Install Suiet, Ethos, Martian or Suilend";
        return;
      }
      const picked = await connect(found[0].name);
      await post({ address: picked.address, chain: picked.chain });
      btn.textContent = "Use the demo story";
      btn.dataset.mode = "wallet";
      btn.classList.add("on");
      onChange?.();
    } catch (err) {
      btn.textContent = "Connect wallet";
      $("whose").textContent = err.message;
    }
  };
}

/*
 * State frames are read by clicking, not by waiting. A block that steps itself on a
 * timer turns a page into a screensaver, and the reader who wants to linger on frame
 * three has to catch it mid-air. The bars under each block are the controls.
 */
export function pinCycle(box, index) {
  if (!box) return;
  const frames = [...box.querySelectorAll(".frame")];
  if (!frames.length) return;
  const bars = [...box.querySelectorAll(".bars i")];
  const i = Math.max(0, Math.min(frames.length - 1, index));
  box.dataset.at = String(i);
  frames.forEach((f, n) => f.classList.toggle("on", n === i));
  bars.forEach((b, n) => b.classList.toggle("on", n === i));
}

export function cycles() {
  const slow = matchMedia("(prefers-reduced-motion: reduce)").matches;
  for (const box of document.querySelectorAll(".cycle")) {
    // A manual cycle is wired to real product state by the page, so a click would
    // be a lie about where the transaction actually is.
    if (box.hasAttribute("data-manual")) continue;
    const frames = [...box.querySelectorAll(".frame")];
    if (frames.length < 2) continue;
    const bars = [...box.querySelectorAll(".bars i")];

    if (slow) {
      frames.forEach((f) => f.classList.add("on"));
      bars.forEach((b) => b.classList.add("on"));
      continue;
    }

    bars.forEach((b, n) => {
      b.tabIndex = 0;
      b.setAttribute("role", "tab");
      const head = frames[n]?.querySelector("h4, b")?.textContent ?? "";
      b.setAttribute("aria-label", `show stage ${n + 1} of ${frames.length}${head ? ", " + head : ""}`);
      b.title = b.getAttribute("aria-label");
      const pick = () => pinCycle(box, n);
      b.addEventListener("click", pick);
      b.addEventListener("keydown", (e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          pick();
        }
      });
    });
    pinCycle(box, 0);
  }
}

/**
 * Numbers on the story pages come from the running server rather than from copy, so
 * a claim like "three names, three cents" is the real ledger at the moment it is read.
 */
export function fillStats(body) {
  if (!body) return;
  const map = {
    memories: body.stats?.total ?? 0,
    spend: Number(body.spend?.usdc ?? 0).toFixed(2),
    lookups: body.spend?.lookups ?? 0,
    price: Number(body.spend?.price ?? 0.01).toFixed(2),
    wallet: shortAddr(body.session?.wallet ?? ""),
    network: body.session?.network ?? "",
    model: (body.model || "").replace("gemini-", "gem "),
  };
  for (const el of document.querySelectorAll("[data-stat]")) {
    const v = map[el.dataset.stat];
    if (v !== undefined && v !== null) el.textContent = String(v);
  }
}

/** Fills the masthead readouts. Missing ids are skipped so pages can show a subset. */
export async function loadMeta(refresh) {
  const res = await fetch(refresh ? "/state?refresh=1" : "/state").catch(() => null);
  if (!res || !res.ok) return null;
  const body = await res.json();
  noteSpeech(body);
  const set = (id, v) => {
    const el = $(id);
    if (el) el.textContent = v;
  };
  set("model", (body.model || "").replace("gemini-", "gem "));
  set("decide", (body.brain?.decide || "").replace("gemini-", "gem "));
  set("memCount", body.stats.total);
  set("spend", `${Number(body.spend?.usdc ?? 0).toFixed(2)}${body.spend?.lookups ? ` over ${body.spend.lookups}` : ""}`);
  set("chainState", `${body.session?.network ?? "·"}${body.payments ? ", live" : ", read only"}`);
  const s = body.session;
  if (s) {
    set("whose", s.source === "wallet" ? `your wallet · ${shortAddr(s.wallet)}` : `the demo story · ${shortAddr(s.wallet)}`);
    const btn = $("connect");
    if (btn) {
      const on = s.source === "wallet";
      btn.dataset.mode = on ? "wallet" : "";
      btn.classList.toggle("on", on);
      btn.textContent = on ? "Use the demo story" : "Connect wallet";
    }
  }
  return body;
}

/* The masthead folds below 720px, and a menu that stays open after you have picked
   a destination is a menu you have to close twice. Escape and a tap outside close it
   too, because a panel that only closes by its own button is a trap on a phone. */
export function mountMasthead() {
  const head = document.querySelector("header");
  const btn = head?.querySelector("[data-menu]");
  const nav = head?.querySelector("nav.tabs");
  if (!head || !btn || !nav) return;
  const set = (open) => {
    head.classList.toggle("open", open);
    btn.setAttribute("aria-expanded", String(open));
    btn.textContent = open ? "close" : "menu";
  };
  set(false);
  btn.addEventListener("click", () => set(!head.classList.contains("open")));
  nav.addEventListener("click", (e) => {
    if (e.target.closest("a")) set(false);
  });
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape") set(false);
  });
  document.addEventListener("click", (e) => {
    if (head.classList.contains("open") && !head.contains(e.target)) set(false);
  });
}

if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", mountMasthead);
else mountMasthead();
