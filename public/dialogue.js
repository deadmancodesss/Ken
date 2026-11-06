/*
 * The cartoon dialogue. When something happens to the money or the wallet, the
 * purse mouse leans out of a paper sheet and says what it did, one line at a
 * time, with the machine's own observations underneath in small print.
 *
 * It is a modal because a status line in a masthead is a place nobody reads, and
 * because the honest version of a failure needs four sentences and a list, not
 * four words. It is animated because a card that arrives all at once is a wall of
 * text, while the same card drawing itself in reads as a character talking.
 *
 * Motion is an upgrade, never a requirement. Without gsap, or with
 * prefers-reduced-motion, every element is simply present and correct.
 */
import { injections, report } from "./wallet.js";

const SHEET = { w: 1100, h: 628 };

/* The four animals live on one cut sheet, public/assets/cast-four-cut.webp, and are
   framed by the same inset fractions index.html uses. Positioning the sheet inside a
   box rather than using object-view-box means this works wherever CSS does. */
const CAST = {
  bird: { inset: { t: 0.09, r: 0.72, b: 0.1, l: 0 }, name: "the bird", job: "it reads the chain" },
  hedgehog: { inset: { t: 0.09, r: 0.48, b: 0.1, l: 0.28 }, name: "the hedgehog", job: "it carries the memory" },
  frog: { inset: { t: 0.09, r: 0.26, b: 0.1, l: 0.52 }, name: "the frog", job: "it chooses and speaks" },
  mouse: { inset: { t: 0.09, r: 0, b: 0.1, l: 0.74 }, name: "the purse mouse", job: "it holds the door on your money" },
};

const TAIL = "M6 4 C 30 12, 44 20, 62 26 C 42 30, 22 34, 8 40 C 12 28, 12 16, 6 4 Z";

const still = () => matchMedia("(prefers-reduced-motion: reduce)").matches;
const g = () => (still() ? null : window.gsap ?? null);

function el(tag, cls, text) {
  const node = document.createElement(tag);
  if (cls) node.className = cls;
  if (text !== undefined) node.textContent = text;
  return node;
}

/** Frames one animal out of the shared sheet, in plain CSS that every browser has. */
function placeAnimal(box, who) {
  const c = (CAST[who] ?? CAST.mouse).inset;
  const cropW = 1 - c.l - c.r;
  const cropH = 1 - c.t - c.b;
  box.style.aspectRatio = `${cropW * SHEET.w} / ${cropH * SHEET.h}`;
  const img = box.querySelector("img");
  img.style.width = `${100 / cropW}%`;
  img.style.height = `${100 / cropH}%`;
  img.style.left = `${(-100 * c.l) / cropW}%`;
  img.style.top = `${(-100 * c.t) / cropH}%`;
}

function build() {
  const root = el("div", "dlg");
  root.id = "dlg";
  root.setAttribute("role", "dialog");
  root.setAttribute("aria-modal", "true");

  const wash = el("div", "dlg-wash");
  const sheet = el("div", "dlg-sheet");

  const stage = el("div", "dlg-stage");
  const frame = el("span", "dlg-animal");
  const img = el("img");
  img.src = "/assets/cast-four-cut.webp";
  img.alt = "";
  img.width = SHEET.w;
  img.height = SHEET.h;
  img.decoding = "async";
  frame.append(img);
  const plate = el("span", "dlg-plate");
  plate.append(el("b"), el("em"));
  const tail = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  tail.setAttribute("class", "dlg-tail");
  tail.setAttribute("viewBox", "0 0 64 44");
  const path = document.createElementNS("http://www.w3.org/2000/svg", "path");
  path.setAttribute("d", TAIL);
  tail.append(path);
  stage.append(frame, plate, tail);

  const body = el("div", "dlg-body");
  const kicker = el("p", "dlg-kicker");
  const title = el("h2", "dlg-title");
  title.id = "dlg-title";
  const line = el("p", "dlg-line");
  const beats = el("ul", "dlg-beats");
  beats.setAttribute("aria-live", "polite");
  /* The verdict sits in the reading column, on its own line after the evidence, so
     it lands in the same place on a phone and on a desktop. A stamp that only exists
     in one breakpoint is a decoration, and a decoration that moves is a bug. */
  const stamp = el("span", "dlg-stamp");
  const smallBtn = el("button", "dlg-toggle");
  smallBtn.type = "button";
  const small = el("div", "dlg-small");
  const actions = el("div", "dlg-actions");
  body.append(kicker, title, line, beats, stamp, smallBtn, small, actions);

  const close = el("button", "dlg-close", "✕");
  close.type = "button";
  close.setAttribute("aria-label", "close");

  sheet.append(close, stage, body);
  root.append(wash, sheet);
  return { root, wash, sheet, stage, frame, plate, tail, path, body, kicker, title, line, beats, smallBtn, small, actions, stamp, close };
}

/**
 * Opens a dialogue and hands back a controller. `status` appends one more thing the
 * page did while it waited, `replace` re-renders the same sheet for the outcome, and
 * both animate because the point is a character talking, not a page reloading.
 */
export function dialogue(spec = {}) {
  document.getElementById("dlg")?.remove();
  const d = build();
  document.body.append(d.root);

  let breath = null;
  let timeline = null;
  let snap = null;
  let safety = 0;
  let opened = Date.now();
  let lastFocus = document.activeElement;

  const who = () => (CAST[spec.who] ?? CAST.mouse);

  /* A sheet with no choices still has to hold the keyboard, or Tab walks straight out
     of the dialog and the person is typing into the page behind it. */
  function focusFirst() {
    (d.actions.querySelector("button") ?? d.close).focus?.();
  }

  function rows(facts) {
    d.small.replaceChildren();
    for (const f of facts ?? []) {
      const row = el("div", `dlg-fact${f.head ? " head" : ""}`);
      row.append(el("b", "", f.k), el("span", "", String(f.v)));
      d.small.append(row);
    }
  }

  function paint(next) {
    /* A new state replaces the old one rather than merging into it, so a beat or a
       fact from the previous state can never survive into the sheet that follows. */
    spec = { ...next, who: next.who ?? spec.who };
    const cast = who();
    const tone = spec.tone ?? "wait";
    d.root.dataset.tone = tone;

    d.frame.replaceChildren();
    const img = el("img");
    img.src = "/assets/cast-four-cut.webp";
    img.alt = cast.name;
    img.width = SHEET.w;
    img.height = SHEET.h;
    d.frame.append(img);
    placeAnimal(d.frame, spec.who);
    /* The nameplate says who is talking, so the kicker above the headline is freed up
       to say only what stage the page is at. Naming the animal twice in one card is
       how the sheet started reading like two drafts of the same sentence. */
    d.plate.querySelector("b").textContent = cast.name;
    d.plate.querySelector("em").textContent = cast.job;

    d.kicker.textContent = spec.kicker ?? "";
    d.title.textContent = spec.title ?? "";
    d.line.textContent = spec.line ?? "";

    d.beats.replaceChildren();
    for (const b of spec.beats ?? []) d.beats.append(el("li", `mark-${b.mark ?? "dot"}`, b.text));

    const facts = spec.facts ?? [];
    d.smallBtn.textContent = facts.length ? `what this page actually read (${facts.length})` : "";
    d.smallBtn.style.display = facts.length ? "" : "none";
    d.small.classList.toggle("open", false);
    rows(facts);

    d.stamp.textContent = spec.stamp ?? "";
    d.stamp.style.display = spec.stamp ? "" : "none";

    d.actions.replaceChildren();
    for (const a of spec.actions ?? []) {
      const b = el("button", a.primary ? "primary" : "", a.label);
      b.type = "button";
      /* A wallet's icon is its own data URL, and it is the fastest way for a person to
         recognise which extension holds their money. Only a data:image is ever used,
         and it goes on an img element rather than into markup. */
      if (typeof a.icon === "string" && /^data:image\//i.test(a.icon)) {
        const img = document.createElement("img");
        img.className = "wallet-icon";
        img.alt = "";
        img.src = a.icon;
        b.prepend(img);
      }
      /* the controller, not the element bag, since `d.close` is the little cross */
      b.onclick = () => a.onClick?.(api);
      d.actions.append(b);
    }

    play(tone);
  }

  function play(tone) {
    const gsap = g();
    if (!gsap) return;
    breath?.kill();
    snap?.();
    /* A state can replace another state before its arrival has finished, and two
       from()-tweens on one element disagree about where it should end up, which is
       how a sheet gets stranded at a fifth of its opacity. Every tween below states
       both ends and the previous timeline is killed first, so a fast replace always
       lands on the same finished picture. */
    timeline?.kill();
    timeline = gsap.timeline();
    timeline
      .fromTo(d.wash, { opacity: 0 }, { opacity: 0.92, duration: 0.2, ease: "power2.out" })
      .fromTo(d.sheet, { y: 30, scale: 0.93, rotate: -2.6, opacity: 0 }, { y: 0, scale: 1, rotate: -0.5, opacity: 1, duration: 0.55, ease: "back.out(1.5)" }, "<")
      .fromTo(d.stage, { x: -26, opacity: 0 }, { x: 0, opacity: 1, duration: 0.45, ease: "back.out(1.8)" }, "-=0.3");

    const len = d.path.getTotalLength?.() ?? 0;
    if (len) {
      gsap.set(d.path, { strokeDasharray: len });
      timeline.fromTo(d.path, { strokeDashoffset: len }, { strokeDashoffset: 0, duration: 0.34, ease: "power2.out" }, "-=0.22");
    }

    timeline
      .fromTo(d.kicker, { y: 8, opacity: 0 }, { y: 0, opacity: 1, duration: 0.24 }, "-=0.16")
      .fromTo(d.title, { y: 12, opacity: 0 }, { y: 0, opacity: 1, duration: 0.34, ease: "power3.out" }, "<")
      .fromTo(d.line, { y: 8, opacity: 0 }, { y: 0, opacity: 1, duration: 0.3 }, "<0.06")
      .fromTo([...d.beats.children], { y: 7, opacity: 0 }, { y: 0, opacity: 1, duration: 0.26, stagger: 0.07, ease: "power2.out" }, "<0.05");

    if (spec.stamp) {
      timeline
        .fromTo(d.stamp, { scale: 1.8, rotate: 14, opacity: 0 }, { scale: 1, rotate: -8, opacity: 1, duration: 0.36, ease: "back.out(2.6)" }, "-=0.12")
        .to(d.sheet, { x: -4, duration: 0.05, yoyo: true, repeat: 1 }, "<0.08");
    }
    timeline
      .fromTo(d.smallBtn, { opacity: 0 }, { opacity: 1, duration: 0.2 }, "-=0.1")
      .fromTo([...d.actions.children], { y: 6, opacity: 0 }, { y: 0, opacity: 1, duration: 0.24, stagger: 0.06 }, "<0.06");

    /* Every tween above starts from opacity 0, which means a tab that never gets a
       frame back - a backgrounded tab, a throttled one, a laptop mid-sleep - is left
       holding a sheet of invisible sentences. The arrival is an upgrade, so the
       finished state is also written down twice: once when the timeline lands and
       once on a timer that fires whether or not the compositor ever wakes up. */
    const animated = [d.wash, d.sheet, d.stage, d.kicker, d.title, d.line, d.smallBtn, ...d.beats.children, ...d.actions.children];
    if (spec.stamp) animated.push(d.stamp);
    snap = () => {
      clearTimeout(safety);
      gsap.set(animated, { clearProps: "opacity,transform" });
      gsap.set(d.path, { clearProps: "stroke-dashoffset,stroke-dasharray" });
    };
    timeline.eventCallback("onComplete", snap);
    safety = setTimeout(snap, 1600);
    if (tone === "wait") {
      breath = gsap.to(d.frame.querySelector("img"), { y: -5, duration: 1.25, ease: "sine.inOut", yoyo: true, repeat: -1 });
    }
  }

  function close(fast) {
    breath?.kill();
    timeline?.kill();
    snap?.();
    document.removeEventListener("keydown", onKey);
    const done = () => {
      d.root.remove();
      lastFocus?.focus?.();
    };
    const gsap = g();
    if (!gsap || fast) {
      done();
      return;
    }
    gsap
      .timeline({ onComplete: done })
      .to([d.sheet, d.stage], { y: 14, opacity: 0, duration: 0.22, ease: "power2.in" }, 0)
      .to(d.wash, { opacity: 0, duration: 0.24 }, 0);
    /* The same stall that can strand a sheet mid-arrival can strand it mid-exit, and
       a dialogue that refuses to leave is worse than one that never animated. */
    setTimeout(() => d.root.isConnected && done(), 500);
  }

  function onKey(e) {
    if (e.key === "Escape") close();
  }

  d.wash.onclick = () => close();
  d.close.onclick = () => close();
  d.smallBtn.onclick = () => d.small.classList.toggle("open");
  document.addEventListener("keydown", onKey);

  const api = {
    /** One more thing the page did, added while the dialogue is still open. */
    status(text, mark = "dot") {
      const li = el("li", `mark-${mark}`, text);
      d.beats.append(li);
      const gsap = g();
      if (gsap) {
        gsap.fromTo(li, { y: 7, opacity: 0 }, { y: 0, opacity: 1, duration: 0.26, ease: "power2.out" });
        setTimeout(() => gsap.set(li, { clearProps: "opacity,transform" }), 500);
      }
      return this;
    },
    /** Re-render the same sheet for the outcome, with the stamp and the small print. */
    replace(next) {
      paint(next);
      focusFirst();
      return this;
    },
    seconds() {
      return ((Date.now() - opened) / 1000).toFixed(1);
    },
    close,
    node: d.root,
  };

  paint(spec);
  focusFirst();

  return api;
}

const short = (a) => (a ? `${a.slice(0, 6)}…${a.slice(-4)}` : "a blank address");

/** The sheet that opens the moment a person presses Connect, before any answer. */
export function walletAsked(count) {
  return {
    who: "mouse",
    tone: "wait",
    kicker: "still waiting for an answer",
    title: count ? "asking this browser who you are" : "looking for a wallet in this browser",
    line: "Nothing moves until you approve it in your own wallet. This page only reads the answer back.",
    beats: [
      {
        text: count ? `it can see ${count} wallet${count === 1 ? "" : "s"} in this browser` : "nothing has announced itself to this page yet",
        mark: count ? "dot" : "cross",
      },
    ],
  };
}

/**
 * The room a person sits in while the wallet decides. It names the wallet that should
 * be open, says where a hidden window usually is, and keeps a button that asks again,
 * because "nothing happened" is nearly always a window behind the browser.
 */
export function walletWaiting(name, { onAgain, onDemo } = {}) {
  return {
    who: "mouse",
    tone: "wait",
    kicker: "the wallet has the floor",
    title: `${name} should be open now`,
    line: "Approve this page inside the wallet and this sheet will notice by itself. Nothing is shared until you say yes there.",
    beats: [{ text: "if no window appeared, it may be behind this tab", mark: "dot" }],
    stamp: "waiting",
    actions: [
      ...(onAgain
        ? [
            {
              label: "open the wallet",
              primary: true,
              onClick: (dlg) => {
                onAgain();
                dlg.status("asked the wallet again, so look for its window now");
              },
            },
          ]
        : []),
      ...(onDemo ? [{ label: "use the demo story", onClick: (dlg) => { dlg.close(true); onDemo(); } }] : []),
    ],
  };
}

/** What came back when a wallet did answer, including the one thing that matters:
    whether that account can sign, and which network it is sitting on. */
export function walletOpen(picked, { seconds, onDemo, payNet = "mainnet" }) {
  /* Wallets name their network with different capitalisation, and "not testnet" over
     a sui:Testnet account is a scare claim about somebody's real money. The name being
     checked is the one the server pays on, never a hard coded one. */
  const onPayNet = String(picked.chain).toLowerCase().includes(payNet);
  return {
    who: "mouse",
    tone: "good",
    kicker: "one account came back",
    title: `this page now speaks for ${short(picked.address)}`,
    line: picked.canSign
      ? "Money moves only when you approve the transaction inside the wallet, so nothing here can spend without you."
      : "This account will not sign a transaction, so the page can read it and no payment can leave it.",
    beats: [
      { text: `${picked.name || "your wallet"} answered on ${picked.chain}`, mark: onPayNet ? "check" : "cross" },
      {
        text: onPayNet
          ? payNet === "mainnet"
            ? "mainnet, which is real money, and only your approval inside the wallet moves it"
            : "testnet, so none of this is real money"
          : `${payNet} is the network this build pays on, and this account is on the other one`,
        mark: "dot",
      },
      /* Under a second there was no popup to approve, and that is worth saying in
         words. "the whole exchange took 0.0 seconds" reads like a broken clock. */
      { text: parseFloat(seconds) >= 1 ? `the whole exchange took ${seconds} seconds` : "it answered straight away, with nothing to approve", mark: "dot" },
    ],
    stamp: "open",
    actions: onDemo ? [{ label: "disconnect", primary: true, onClick: (dlg) => { dlg.close(true); onDemo(); } }] : [],
  };
}

/**
 * What a wallet said no to, and the evidence. The headline is one short human
 * sentence, the beats are the steps this page actually took, and every raw field the
 * extension published goes in the small print so a broken wallet can be named rather
 * than described.
 *
 * One field per line, because the first version crammed a wallet's whole identity
 * into one sentence of dots and a forty-character extension id wrapped in the middle
 * of itself. A person reading a failure needs to point at a line, not decode one.
 */
export function walletFailed(err, { seconds, retry, onDemo } = {}) {
  /* A failure can come from two different places. A wallet that said no carries its
     own census with it, but a 500 from this page's own server carries nothing, and
     printing "no wallet answers" over that is a lie about somebody's browser. So the
     census is taken again here when the error did not bring one. */
  const detail = err?.detail?.length ? err.detail : report();
  const alsoSeen = injections();
  const yesno = (b) => (b ? "yes" : "no");
  const facts = [];
  for (const w of detail) {
    facts.push(
      { k: "wallet", v: w.name, head: true },
      { k: "version", v: w.version || "none published" },
      { k: "extension", v: w.extension || "no icon, so nothing to read an id from" },
      { k: "a page can press it", v: `${yesno(w.canBeAsked)}, and the connect step looks like ${w.connectShape}` },
      { k: "accounts list", v: yesno(w.keepsAccounts) },
      {
        k: "accounts",
        v: w.accounts.length
          ? w.accounts.map((a) => `${short(a.address)} on ${a.chains.join(" ")}${a.canSign ? "" : ", cannot sign"}`).join(" · ")
          : "zero shared with this page",
      },
      ...w.accounts.map((a, i) => ({ k: `fields ${w.name}${w.accounts.length > 1 ? ` ${i + 1}` : ""}`, v: a.keys?.join(", ") || "nothing readable" })),
      { k: "features", v: w.features.length ? w.features.join(" · ") : "registers with no features at all" },
    );
  }
  if (!detail.length) {
    facts.push({ k: "this page heard", v: "nothing, because no wallet announced itself", head: true });
    if (alsoSeen.length) facts.push({ k: "but present", v: alsoSeen.join(", ") });
  }

  /* Machine words belong in the small print. A visitor who is shown "feature.invoke is
     not a function" has been handed a stack trace and no door, which is how a page
     loses the person it was trying to onboard. */
  const machine = /is not a function|undefined is not|cannot read|not declared|not defined|TypeError|ReferenceError|http \d|json|chrome-extension|data:image/i;
  const notes = [...new Set(err?.notes ?? [])];
  const words = notes.filter((t) => machine.test(t));
  const beats = notes.filter((t) => !machine.test(t)).map((t) => ({ text: t, mark: "cross" }));
  /* A wait of nothing is not a fact. The first version printed "it waited 0.0
     seconds before giving up" over a refusal that arrived in the same tick, which
     is a sentence that describes a hang that did not happen. */
  if (parseFloat(seconds) >= 1) beats.push({ text: `it waited ${seconds} seconds before giving up`, mark: "dot" });

  /* A census of wallets is not an answer from one. The first version called the sheet
     "the wallet answered" whenever any extension was installed, which blamed a wallet
     that had never been spoken to and told a person the opposite of what happened. */
  const answered = !!err?.answered;
  const silent = !answered && detail.length > 0;
  const headline = {
    answered: "your wallet answered, and this page could not use what came back",
    silent: "a wallet is in this browser and it never answered",
    none: "nothing in this browser told this page it holds a Sui wallet",
  };
  const nextStep = {
    answered: "Nothing is lost, and nothing was spent. The demo story keeps working while this gets fixed.",
    silent: "Reload the page once your wallet is open and unlocked, then try again. That is what makes a quiet wallet speak.",
    none: "You do not need a wallet to read this. The demo story has its own money and its own people.",
  };
  const plain = (t) => (t && !machine.test(t) ? t : "");
  const title = plain(err?.message) || headline[answered ? "answered" : silent ? "silent" : "none"];
  if (!plain(err?.message)) words.push(`the page's own words: ${err?.message ?? "none"}`);
  if (words.length) facts.push({ k: "words this page is not putting in front of you", v: words.join(" · "), head: !facts.length });

  return {
    who: "mouse",
    tone: "bad",
    kicker: answered ? "the wallet answered, with nothing usable" : silent ? "a wallet is here but stayed quiet" : "no wallet answered",
    title,
    line: plain(err?.hint) || nextStep[answered ? "answered" : silent ? "silent" : "none"],
    beats,
    facts,
    stamp: "no account",
    actions: [
      ...(retry ? [{ label: "try again", primary: true, onClick: (dlg) => { dlg.close(true); retry(); } }] : []),
      ...(onDemo ? [{ label: "use the demo story", onClick: (dlg) => { dlg.close(true); onDemo(); } }] : []),
      {
        label: "copy the small print",
        onClick: (dlg) => {
          const text = facts.map((f) => `${f.k}: ${f.v}`).join("\n");
          navigator.clipboard?.writeText(`${err.message ?? ""}\n${err.hint ?? ""}\n${text}`).then(
            () => dlg.status("copied, paste it to whoever is helping you", "check"),
            () => dlg.status("this browser refused to copy, so open the small print and read it out", "cross"),
          );
        },
      },
    ],
  };
}
