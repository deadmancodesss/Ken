// Shared behaviour for every page: the masthead state, the wallet handshake and
// the scroll reveals. Keeping it here is what stops the app and the landing page
// from disagreeing about what the same chip does.
import { discover, connect, resume, whyNoSuiWallet } from "./wallet.js";
import { dialogue, walletAsked, walletWaiting, walletOpen, walletFailed } from "./dialogue.js";

// The four word-shaping helpers live in format.js, so a node test can read them
// without loading this file and hitting wallet.js's use of window. They are bound
// here too because the masthead prints a shortened address.
import { shortAddr, faceUrl, spoken, when, plain, addressNeed, requestNeed, maskAddress, SUI_ADDRESS, explorerTx } from "./format.js";
export { shortAddr, faceUrl, spoken, when, plain, addressNeed, requestNeed, maskAddress, SUI_ADDRESS, explorerTx };

/*
 * Which ledger this build settles on is a server field. Pages that print a payment
 * label or build an explorer link read it from here instead of typing "testnet" into
 * copy, which is how a mainnet build ended up telling people their money was worthless
 * dust. The default is the network a fresh deploy pays on.
 */
let settleNet = "mainnet";
export const payNetwork = () => settleNet;
export const payChain = () => `sui:${settleNet}`;

export const $ = (id) => document.getElementById(id);

/**
 * A receipt is only useful if the long string on it can leave the screen, and a
 * clipboard that silently fails wastes the one time a person tries. The older
 * selection path is kept because a browser without a secure context has no
 * navigator.clipboard at all.
 */
export async function copyText(text) {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    try {
      const box = document.createElement("textarea");
      box.value = text;
      box.setAttribute("readonly", "");
      box.style.cssText = "position:fixed;left:-9999px;top:0";
      document.body.appendChild(box);
      box.select();
      const ok = document.execCommand("copy");
      box.remove();
      return ok;
    } catch {
      return false;
    }
  }
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
 * caller reports instead of showing a meter that would be lying.
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
 * from the audio actually playing, which is what makes the scope honest for the
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
 * One wallet connects itself. Three wallets in the same browser is a decision only
 * the person can make, so the dialogue asks it rather than whichever extension
 * happened to register first. The choice lives inside the sheet because a row of
 * chips under a masthead is invisible the moment the sheet is over it.
 */
export function pickWallet(dlg, { onStatus, onPick, control } = {}) {
  const found = discover();
  if (!found.length) throw new Error(whyNoSuiWallet());
  if (found.length === 1) return connect(found[0].wallet, onStatus, control);
  return new Promise((resolve) => {
    dlg.replace({
      tone: "wait",
      kicker: "more than one door answered",
      title: "which of these holds your money?",
      line: "This page will not choose for you. Whichever one you pick is the only one it asks.",
      beats: found.map((f) => {
        const onSui = (a) => a.address && (!a.chain || String(a.chain).toLowerCase().startsWith("sui:"));
        const shown = f.accounts.filter(onSui);
        const other = f.accounts.find((a) => a.address && !onSui(a));
        return {
          text: shown.length
            ? `${f.name} already shows ${shortAddr(shown[0].address)} on ${shown[0].chain}`
            : other
              ? `${f.name} holds ${other.chain}, and this page cannot pay on a chain that is not Sui`
              : `${f.name} has shown this page no account it can read yet`,
          mark: shown.length ? "check" : "dot",
        };
      }),
      actions: found.map((f) => ({
        label: f.name,
        icon: f.icon,
        primary: f.accounts.some((a) => a.address && (!a.chain || String(a.chain).toLowerCase().startsWith("sui:"))),
        onClick: () => {
          onPick?.(f.name);
          resolve(f.wallet);
        },
      })),
    });
  }).then((wallet) => connect(wallet, onStatus, control));
}

/*
 * What this browser kept about the wallet being let go of. The name beside an address is
 * a convenience and the stored brief is a whole sentence about somebody's money, so both
 * outlive the page unless something deletes them. Leaving is therefore an action with a
 * list rather than a change of state, and the list is what the sheet reads back, because
 * a person is entitled to know which of their traces a button actually removed. The same
 * sentences are dropped when a wallet is picked up, keeping only the name the new account
 * is about to overwrite, because a stored paragraph about the previous wallet has no
 * business outliving it either.
 */
function forgetBrowser({ name = true, briefs = true } = {}) {
  const dropped = [];
  const kill = (store, key, label) => {
    try {
      if (store.getItem(key) === null) return;
      store.removeItem(key);
      if (!dropped.includes(label)) dropped.push(label);
    } catch {
      /* a window that refuses storage has nothing here left to clear either */
    }
  };
  if (name) kill(localStorage, "walletName", "the wallet name this page stored");
  if (briefs) {
    try {
      for (const key of Object.keys(sessionStorage)) {
        if (key.startsWith("brief-")) kill(sessionStorage, key, "the brief it had already said out loud");
      }
    } catch {
      /* same */
    }
  }
  return dropped;
}

/**
 * Wires the wallet chip and returns the current session to the caller so each page
 * can load whatever it displays.
 *
 * The telling is a cartoon sheet rather than a line in the masthead. It opens the
 * moment a person presses Connect, so the wait has a face, and it stays the same
 * sheet when the answer arrives, because a card that mutates in front of you reads
 * as a character talking while a second card replacing the first reads as a page
 * reloading.
 */
export function mountWallet(onChange) {
  const btn = $("connect");
  if (!btn) return;

  const toDemo = async () => {
    btn.textContent = "letting go…";
    let left = null;
    try {
      left = await post({ demo: true });
    } catch {
      /* nothing was dropped, and the sheet below says so */
    }
    if (left?.source !== "demo" && left?.source !== "none") {
      btn.textContent = "Disconnect";
      dialogue({
        who: "mouse",
        tone: "bad",
        kicker: "the server would not let go",
        title: "this page still reads your address",
        line: "Nothing was cleared, so nothing is half-gone. Press try again, and if it fails a second time reload the page, because a dead server cannot forget on command.",
        beats: [
          { text: "your wallet is still the account every read on this page is for", mark: "cross" },
          { text: "this browser kept its copy of the wallet name and the brief, since dropping them while the server still holds your address would leave the two halves disagreeing", mark: "dot" },
        ],
        stamp: "still here",
        actions: [
          { label: "try again", primary: true, onClick: (dlg) => { dlg.close(true); toDemo(); } },
          { label: "reload the page", onClick: () => location.reload() },
        ],
      });
      return;
    }
    const dropped = forgetBrowser();
    btn.textContent = "Connect wallet";
    btn.dataset.mode = "";
    btn.classList.remove("on");
    btn.removeAttribute("title");
    syncWalletGate(false);
    document.dispatchEvent(new CustomEvent("wallet:changed"));
    onChange?.();
    dialogue({
      who: "mouse",
      tone: "good",
      kicker: "the page let go of your account",
      title: "nothing here carries your address now",
      line: "Your wallet is disconnected and all workspace tools are locked until you connect a Sui wallet again.",
      beats: [
        {
          text: dropped.length ? `this browser also dropped ${dropped.join(", ")}` : "this browser had nothing of yours stored",
          mark: "check",
        },
        { text: "the server dropped your address, the balance it had read for you, the conversation, and every sentence it had voiced about your people", mark: "check" },
        { text: "every protected surface is now locked until you reconnect", mark: "check" },
        { text: "what stays is what no button here can undo: the notes already written to Walrus under your address, since that store has no delete verb, and anything that settled on the chain", mark: "dot" },
        { text: "press Connect wallet whenever you want your own account back", mark: "dot" },
      ],
      stamp: "locked",
    });
  };

  const ask = async () => {
    const found = discover();
    if (!found.length) {
      dialogue(walletFailed(new Error(whyNoSuiWallet()), { retry: ask, onDemo: toDemo }));
      return;
    }

    const control = {};
    let who = found.length === 1 ? found[0].name : "the wallet";
    const waiting = () =>
      walletWaiting(who, {
        onAgain: () => control.again?.(),
        onDemo: toDemo,
      });

    /* The sheet opens before the wallet is asked, so the window the extension opens
       lands over a page that already says what it is waiting for. */
    const dlg = dialogue(found.length === 1 ? waiting() : walletAsked(found.length));
    btn.textContent = "asking…";
    try {
      const picked = await pickWallet(dlg, {
        control,
        onPick: (name) => {
          who = name;
          dlg.replace(waiting());
        },
        onStatus: (s) => {
          dlg.status(s);
          btn.textContent = "waiting on your wallet…";
        },
      });
      await post({ address: picked.address, chain: picked.chain });
      /* The name is the wallet's own, kept beside its address so the masthead can say
         Slush rather than a string of hex. It is only ever shown when the address it
         was saved with is the address this page is actually speaking for. */
      try {
        localStorage.setItem("walletName", JSON.stringify({ address: picked.address, name: picked.name }));
      } catch {
        /* private windows refuse storage, and an address is still honest */
      }
      forgetBrowser({ name: false });
      btn.textContent = "Disconnect";
      btn.title = "let go of this wallet and clear what this page stored about it";
      btn.dataset.mode = "wallet";
      btn.classList.add("on");
      syncWalletGate(true);
      document.dispatchEvent(new CustomEvent("wallet:changed"));
      dlg.replace(walletOpen(picked, { seconds: dlg.seconds(), onDemo: toDemo, payNet: settleNet }));
      onChange?.();
    } catch (err) {
      btn.textContent = "Connect wallet";
      dlg.replace(walletFailed(err, { seconds: dlg.seconds(), retry: ask, onDemo: toDemo }));
    }
  };

  btn.onclick = () => (btn.dataset.mode === "wallet" ? toDemo() : ask());
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

/**
 * Renders a /state body that the caller already holds. Split out of loadMeta because a
 * page that reads the same endpoint for its own rail would otherwise ask twice, and
 * ?refresh=1 is not a cache hit, it is a fresh walk over the chain.
 */
export function paintMeta(body) {
  noteSpeech(body);
  settleNet = body?.pay_network === "testnet" ? "testnet" : "mainnet";
  const set = (id, v) => {
    const el = $(id);
    if (el) el.textContent = v;
  };
  set("model", (body.model || "").replace("gemini-", "gem "));
  set("decide", (body.brain?.decide || "").replace("gemini-", "gem "));
  set("memCount", body.stats?.total ?? 0);
  set("spend", `${Number(body.spend?.usdc ?? 0).toFixed(2)}${body.spend?.lookups ? ` over ${body.spend.lookups}` : ""}`);
  set("chainState", `${body.session?.network ?? "·"}${body.payments ? ", live" : ", read only"}`);
  const status = document.querySelector(".statusBtn");
  if (status) {
    status.dataset.live = String(Boolean(body.payments));
    status.title = body.payments
      ? settleNet === "mainnet"
        ? `payments are live on mainnet, where that money is real, so nothing moves until your own wallet signs`
        : "payments are live, this build can move testnet money"
      : "read only, nothing on this page can move money";
  }
  const s = body.session;
  markNetwork?.(s?.network);
  if (s) {
    let named = "";
    try {
      const saved = JSON.parse(localStorage.getItem("walletName") || "null");
      if (saved?.address === s.wallet) named = saved.name;
    } catch {
      /* the address is plenty when storage is unavailable */
    }
    const on = s.source === "wallet" && Boolean(s.wallet);
    set("whose", on ? `${named || "your wallet"} · ${shortAddr(s.wallet)}` : "wallet not connected");
    const btn = $("connect");
    if (btn) {
      btn.dataset.mode = on ? "wallet" : "";
      btn.classList.toggle("on", on);
      btn.textContent = on ? "Disconnect" : "Connect wallet";
      if (on) btn.title = "let go of this wallet and clear what this page stored about it";
      else btn.removeAttribute("title");
    }
    syncWalletGate(on);
    /* The seat says a wallet is connected, which outlives the tab, so this load has
       not asked the wallet anything yet. Asking it quietly here is what lets Sign in
       wallet find the account later without opening a window on page load. */
    if (on) resumeWallet();
  }
  return body;
}

const PUBLIC_PATHS = new Set(["/", "/index.html", "/how", "/how.html", "/features", "/features.html", "/life", "/life.html"]);

export function syncWalletGate(connected) {
  const path = location.pathname.replace(/\/+$/, "") || "/";
  if (PUBLIC_PATHS.has(path)) return;
  const main = document.querySelector("main");
  if (!main) return;
  let gate = document.getElementById("walletGate");
  if (connected) {
    if (gate) gate.hidden = true;
    main.hidden = false;
    return;
  }
  main.hidden = true;
  if (!gate) {
    gate = document.createElement("section");
    gate.id = "walletGate";
    gate.className = "walletGate";
    gate.setAttribute("aria-label", "Wallet connection required");
    gate.innerHTML = `
      <div class="wgShell">
        <div class="wgCard">
          <div class="wgTop">
            <span class="wgKicker">wallet required · demo mode disabled</span>
            <span class="wgStamp">locked</span>
          </div>
          <div class="wgBody">
            <div class="wgStage" aria-hidden="true">
              <div class="wgMouse">
                <img src="/assets/cast-four-cut.webp" width="1100" height="628" alt="" />
              </div>
              <div class="wgCaption">the purse mouse · guards the door</div>
            </div>
            <div class="wgCopy">
              <h1>Connect your Sui wallet to unlock this room.</h1>
              <p class="wgLead">Shared demo mode has been removed so no visitor can pollute another person's Walrus memory, chats, reminders, limits or payment tickets. Every tool here speaks strictly for the wallet you connect.</p>
              <div class="wgGrid">
                <div class="wgCell">
                  <span class="wgIdx">01 · walrus</span>
                  <b>Isolated memory</b>
                  <span>Your people and notes live under your own wallet namespace on Mainnet.</span>
                </div>
                <div class="wgCell">
                  <span class="wgIdx">02 · sui usdc</span>
                  <b>Unsigned tickets only</b>
                  <span>This server prepares bytes and holds no signing key. You sign in your wallet.</span>
                </div>
                <div class="wgCell">
                  <span class="wgIdx">03 · zero conflicts</span>
                  <b>Private workspace</b>
                  <span>Chats, voice calls, spam marks, reminders and statements belong to your address alone.</span>
                </div>
              </div>
              <div class="wgActions">
                <button type="button" class="primary" id="wgConnectBtn">Connect Sui wallet</button>
                <a class="wgHowBtn" href="/how">Interactive How It Works →</a>
                <a class="wgFeatBtn" href="/features">Explore 18 capabilities</a>
              </div>
            </div>
          </div>
        </div>
      </div>
    `;
    main.parentNode.insertBefore(gate, main);
    gate.querySelector("#wgConnectBtn")?.addEventListener("click", () => {
      const topBtn = $("connect");
      if (topBtn) topBtn.click();
    });
  }
  gate.hidden = false;
}

let stillAsking = false;
async function resumeWallet() {
  if (stillAsking) return;
  stillAsking = true;
  try {
    await resume();
  } catch {
    /* a wallet that will not answer quietly is asked properly when it is needed */
  }
}

/*
 * Which ledger is being read is a server field, so this control never holds a copy of
 * it. paintMeta marks it from every /state read, which means the two names on the pill
 * can only ever disagree with the numbers underneath them if the server itself says so.
 */
let markNetwork = null;

export function mountNetwork(onChange) {
  const slot = document.querySelector(".wallet");
  if (!slot || slot.querySelector(".nets")) return null;
  const box = document.createElement("div");
  box.className = "nets";
  box.setAttribute("role", "group");
  box.setAttribute("aria-label", "Which Sui ledger this page reads");
  let current = "";
  /* The note has to be re-read on every /state paint, because which of these two
     buttons can hold a payment is decided by the server, not by the order of the pair. */
  const notes = () => ({
    testnet: `reads the testnet history.${
      settleNet === "testnet" ? " This is the network this build prepares a payment on, and the dust there is worthless." : " Nothing a payment is prepared on in this build."
    }`,
    mainnet: `reads your real balances and transfers.${
      settleNet === "mainnet"
        ? " This is the network this build prepares a payment on, and only your own wallet signature moves it."
        : " Nothing here can move mainnet money."
    }`,
  });
  const set = (net) => {
    current = net ?? "";
    const NOTES = notes();
    for (const b of box.children) {
      const on = b.dataset.net === current;
      b.classList.toggle("on", on);
      b.setAttribute("aria-pressed", String(on));
      if (NOTES[b.dataset.net]) b.title = NOTES[b.dataset.net];
    }
  };
  markNetwork = set;

  for (const net of ["testnet", "mainnet"]) {
    const b = document.createElement("button");
    b.type = "button";
    b.dataset.net = net;
    b.textContent = net;
    b.title = notes()[net];
    b.setAttribute("aria-pressed", "false");
    b.addEventListener("click", async () => {
      if (net === current) return;
      for (const other of box.children) other.disabled = true;
      let res = null;
      let body = null;
      try {
        res = await fetch("/network", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ network: net }),
        });
        body = await res.json().catch(() => null);
      } catch {
        /* a server that is not answering is reported by the sheet below */
      }
      for (const other of box.children) other.disabled = false;
      if (!res || !res.ok) {
        dialogue({
          who: "mouse",
          tone: "bad",
          kicker: "the read did not move",
          title: `still reading ${current || "the last network"}`,
          line:
            body?.error ??
            "The server did not answer, so every number on this page is still the one you were shown. Press the other name to try again.",
          stamp: "nothing changed",
          actions: [{ label: "ok", primary: true }],
        });
        return;
      }
      set(body?.network ?? net);
      onChange?.(body);
    });
    box.append(b);
  }
  slot.insertBefore(box, slot.querySelector("#connect") ?? slot.firstChild);
  /* The switch is born after the masthead has already placed its pieces, and on a
     phone it belongs inside the menu sheet rather than the wallet row. */
  document.dispatchEvent(new CustomEvent("masthead:layout"));
  return box;
}

/** The same read, fetched here rather than handed in. Missing ids are skipped so each page shows a subset. */
export async function loadMeta(refresh) {
  const res = await fetch(refresh ? "/state?refresh=1" : "/state").catch(() => null);
  if (!res || !res.ok) return null;
  return paintMeta(await res.json());
}

/*
 * The story pages are written in the second person about invented people, and they are the
 * pages a judge reads while a wallet is connected from a earlier tab. Nothing about those
 * sentences is false about the cast, and everything about them is false about the reader,
 * so the difference has to be stated where it is being read rather than assumed from a
 * masthead line two scrolls away. In demo mode there is nothing to correct, so no line.
 */
export function castNotice(body) {
  if (body?.session?.source !== "wallet") return;
  if (document.querySelector(".castnote")) return;
  try {
    if (sessionStorage.getItem("cast-note-dismissed") === "1") return;
  } catch {
    /* private windows refuse storage, and a note that cannot be remembered is still true */
  }
  const box = document.createElement("aside");
  box.className = "castnote";
  box.setAttribute("role", "note");
  box.setAttribute("aria-label", "About the examples on this page");
  const text = document.createElement("p");
  text.textContent = "These examples are the invented cast, not your money. Your own people are on ";
  const link = document.createElement("a");
  link.href = "/app";
  link.textContent = "the App page";
  text.append(link, ".");
  const close = document.createElement("button");
  close.type = "button";
  close.className = "x";
  close.setAttribute("aria-label", "Dismiss this note");
  close.textContent = "×";
  close.addEventListener("click", () => {
    try {
      sessionStorage.setItem("cast-note-dismissed", "1");
    } catch {
      /* the note still closes for this page */
    }
    box.remove();
  });
  box.append(text, close);
  document.body.append(box);
}

/* One glyph per destination, drawn at the same weight as every other rule in the build.
   They live here rather than in twelve copies of the header so a new page cannot quietly
   become the one page whose Talk link has no picture. A page that carries an unknown
   href simply keeps its word. */
const NAV_ICONS = {
  "/app": "M4 5.5h16v10.5H9.5L4 20z M8 9h8 M8 12.5h5",
  "/memory": "M5 7h14v13H5z M5 7l2-3h10l2 3 M9 11h6 M9 15h4",
  "/pay": "M3 6h18v12H3z M3 10h18 M7 15h4",
  "/request": "M10.2 13.8a4 4 0 0 0 5.6 0l3-3a4 4 0 0 0-5.6-5.6l-1 1 M13.8 10.2a4 4 0 0 0-5.6 0l-3 3a4 4 0 0 0 5.6 5.6l1-1",
  "/ask": "M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18z M9.6 9.2a2.5 2.5 0 1 1 3.4 2.3c-.7.3-1 .8-1 1.5v.5 M12 16.8h.01",
  "/report": "M5 3h14v18l-3-2-2 2-2-2-2 2-3-2z M9 8h6 M9 12h6 M9 16h3",
  "/features": "M4 4h7v7H4z M13 4h7v7h-7z M4 13h7v7H4z M13 13h7v7h-7z",
  "/how": "M4 18l5-2 6 2 5-2V6l-5 2-6-2-5 2z M9 16V8 M15 18V10",
  "/life": "M12 8a4 4 0 1 0 0 8 4 4 0 0 0 0-8z M12 3v2 M12 19v2 M3 12h2 M19 12h2 M5.6 5.6l1.4 1.4 M17 17l1.4 1.4 M18.4 5.6 17 7 M7 17l-1.4 1.4",
};

function navGlyph(d) {
  const ns = "http://www.w3.org/2000/svg";
  const svg = document.createElementNS(ns, "svg");
  svg.setAttribute("viewBox", "0 0 24 24");
  svg.setAttribute("class", "navicon");
  svg.setAttribute("aria-hidden", "true");
  const path = document.createElementNS(ns, "path");
  path.setAttribute("d", d);
  svg.append(path);
  return svg;
}

function paintNavIcons(head) {
  for (const a of head.querySelectorAll("nav.tabs a[href]")) {
    if (a.querySelector(".navicon")) continue;
    const d = NAV_ICONS[a.getAttribute("href")];
    if (d) a.prepend(navGlyph(d));
  }
}

/* The masthead is one row above a laptop and one sheet below it. The sheet carries the
   wallet name, the ledger switch and the status readouts, so the top row keeps only the
   mark, the connect chip and the menu. Everything that opens closes on Escape and on a
   tap outside, because a panel that only closes by its own button is a trap on a phone. */
export function mountMasthead() {
  const head = document.querySelector("header");
  if (!head) return;
  const btn = head.querySelector("[data-menu]");
  const nav = head.querySelector("nav.tabs");
  const more = head.querySelector(".moreBtn");
  const moreMenu = head.querySelector(".moreMenu");
  const statusBtn = head.querySelector(".statusBtn");
  const statusBox = head.querySelector(".statusBox");
  const wallet = head.querySelector(".wallet");
  const extra = head.querySelector(".navExtra");
  const narrow = typeof matchMedia === "function"
    ? matchMedia("(max-width: 1199px)")
    : { matches: false, addEventListener: null };

  const closeMore = () => {
    if (!more || !moreMenu) return;
    moreMenu.hidden = true;
    more.setAttribute("aria-expanded", "false");
  };
  const closeStatus = () => {
    if (!statusBtn || !statusBox) return;
    statusBox.hidden = true;
    statusBtn.setAttribute("aria-expanded", "false");
  };
  const setMenu = (open) => {
    head.classList.toggle("open", open);
    btn?.setAttribute("aria-expanded", String(open));
    btn?.setAttribute("aria-label", open ? "Close menu" : "Open menu");
    if (!open) closeMore();
  };
  const setStatus = (open) => {
    if (!statusBtn || !statusBox) return;
    statusBox.hidden = !open;
    statusBtn.setAttribute("aria-expanded", String(open));
  };

  /* The pieces below the top row move between the wallet and the menu sheet. The DOM
     order is fixed, only the parent changes, so paintMeta keeps finding the same ids. */
  const place = () => {
    if (!extra || !wallet) return;
    const whose = wallet.querySelector("#whose") ?? extra.querySelector("#whose");
    const nets = wallet.querySelector(".nets") ?? extra.querySelector(".nets");
    if (narrow.matches) {
      for (const el of [statusBtn, statusBox, whose, nets]) {
        if (el && el.parentElement !== extra) extra.append(el);
      }
      return;
    }
    if (whose && whose.parentElement !== wallet) wallet.insertBefore(whose, wallet.firstChild);
    const anchor = wallet.querySelector("#connect") ?? statusBtn ?? null;
    if (nets && nets.parentElement !== wallet) wallet.insertBefore(nets, anchor);
    if (statusBox && statusBox.parentElement !== wallet) wallet.append(statusBox);
    if (statusBtn && statusBtn.parentElement !== wallet) wallet.insertBefore(statusBtn, statusBox);
  };

  btn?.addEventListener("click", () => {
    const open = !head.classList.contains("open");
    setMenu(open);
    if (open) closeStatus();
  });
  more?.addEventListener("click", () => {
    const open = moreMenu?.hidden;
    closeStatus();
    if (!open) closeMore();
    else if (moreMenu) {
      moreMenu.hidden = false;
      more.setAttribute("aria-expanded", "true");
    }
  });
  statusBtn?.addEventListener("click", () => {
    const open = statusBox?.hidden;
    closeMore();
    setStatus(open);
  });
  nav?.addEventListener("click", (e) => {
    if (e.target.closest("a")) {
      setMenu(false);
      closeMore();
    }
  });
  document.addEventListener("click", (e) => {
    if (head.classList.contains("open") && !head.contains(e.target)) setMenu(false);
    if (moreMenu && !moreMenu.hidden && !e.target.closest(".more")) closeMore();
    if (statusBox && !statusBox.hidden && !e.target.closest(".statusBtn") && !e.target.closest(".statusBox")) closeStatus();
  });
  document.addEventListener("keydown", (e) => {
    if (e.key !== "Escape") return;
    setMenu(false);
    closeMore();
    closeStatus();
  });

  /* A page reached through More has no pill of its own in the top row, so the button
     carries a clay dot and says so to a screen reader. */
  if (more && moreMenu?.querySelector('a[aria-current="page"]')) {
    more.classList.add("on");
    more.setAttribute("aria-label", "More, this page is in the menu");
  }

  paintNavIcons(head);
  setMenu(false);
  closeMore();
  closeStatus();
  place();
  narrow.addEventListener?.("change", () => {
    setMenu(false);
    place();
  });
  document.addEventListener("masthead:layout", place);
}

if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", mountMasthead);
else mountMasthead();
