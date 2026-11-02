/*
 * One motion engine for the whole product.
 *
 * A story is a row of nodes on a rail. A packet travels from the first node to the
 * last, the rail fills behind it, each node fires as the packet arrives, and the
 * caption for that leg swaps in. Everything else on the page is static, so the eye
 * has exactly one thing to follow.
 *
 * Two ways to drive it.
 *   data-play="6000"  travels once when it arrives and stays finished
 *   data-scrub        ties progress to scroll, so the picture advances as you move
 *
 * Every node is also a control, because a reader who wants to linger on one leg
 * should not have to wait for a loop to bring it back around.
 *
 * With no JS the rail is fully filled and every caption is present, because a story
 * that vanishes when a script fails is worse than no story at all.
 */

const EASE = (t) => 1 - Math.pow(1 - t, 3);
const clamp = (v) => Math.max(0, Math.min(1, v));

/** Node centres as a fraction of the rail, measured rather than guessed, so the dot
 *  lands on the node instead of drifting past it. */
function centers(box) {
  const rail = box.querySelector(".rail");
  const nodes = [...box.querySelectorAll(".node")];
  if (!rail || !nodes.length) return [];
  const rect = rail.getBoundingClientRect();
  // An unmeasurable rail means the page has not been laid out yet, so the caller
  // gets nothing and paints later rather than writing nonsense into --p.
  if (!rect.width) return [];
  return nodes.map((n) => {
    const b = n.getBoundingClientRect();
    return (b.left + b.width / 2 - rect.left) / rect.width;
  });
}

function paint(box, p) {
  const nodes = [...box.querySelectorAll(".node")];
  const caps = [...box.querySelectorAll(".cap")];
  const cs = centers(box);
  if (!nodes.length || cs.length !== nodes.length) return;

  const last = nodes.length - 1;
  const seg = clamp(p) * last;
  const i = Math.min(last, Math.floor(seg));
  const f = seg - i;
  const pos = cs[i] + ((cs[Math.min(last, i + 1)] ?? cs[i]) - cs[i]) * EASE(Math.min(1, f * 2) * 0.5 + f * 0.5);
  const near = f > 0.5 ? Math.min(last, i + 1) : i;

  box.style.setProperty("--p", (pos * 100).toFixed(3) + "%");
  box.style.setProperty("--c0", (cs[0] * 100).toFixed(3) + "%");
  box.style.setProperty("--cEnd", (cs[last] * 100).toFixed(3) + "%");

  nodes.forEach((n, k) => {
    n.classList.toggle("reached", pos >= cs[k] - 0.004);
    n.classList.toggle("live", k === near);
  });
  caps.forEach((c, k) => c.classList.toggle("on", k === Math.min(caps.length - 1, near)));

  // The counters sit beside the rail and fill once the packet has arrived, so the
  // number you are meant to notice lands at the end of the run rather than at the start.
  const scope = box.parentElement ?? box;
  for (const num of scope.querySelectorAll("[data-count]")) {
    if (num.dataset.done === "1" || clamp(p) < 0.985) continue;
    const want = Number(num.dataset.count);
    if (!Number.isFinite(want)) continue;
    num.textContent = num.dataset.unit ? `${want} ${num.dataset.unit}` : String(want);
    num.dataset.done = "1";
    num.classList.remove("tick");
    void num.offsetWidth;
    num.classList.add("tick");
  }
}

function resetCounts(scope) {
  for (const n of (scope ?? document).querySelectorAll("[data-count]")) {
    n.dataset.done = "";
    n.classList.remove("tick");
    n.textContent = n.dataset.unit ? `0 ${n.dataset.unit}` : "0";
  }
}

/** Progress of an element travelling through the viewport, 0 on entry, 1 on exit. */
function scrubValue(box) {
  const r = box.getBoundingClientRect();
  const vh = window.innerHeight || 1;
  const lead = vh * 0.8;
  return clamp((lead - r.top) / (lead + r.height * 0.7));
}

export function stories(root = document) {
  const slow = matchMedia("(prefers-reduced-motion: reduce)").matches;
  const boxes = [...root.querySelectorAll("[data-story]")];
  if (!boxes.length) return;

  const settle = () => {
    for (const b of boxes) if (!b.hasAttribute("data-play") && !b.hasAttribute("data-scrub")) paint(b, 1);
  };
  settle();
  // Fonts and the mobile wrap change the measured centres, so a late layout pass is
  // worth doing before anything is allowed to animate.
  addEventListener("load", settle);

  if (slow) {
    for (const b of boxes) paint(b, 1);
    return;
  }

  const scrubbers = boxes.filter((b) => b.hasAttribute("data-scrub"));
  if (scrubbers.length) {
    let queued = false;
    const run = () => {
      for (const b of scrubbers) paint(b, scrubValue(b));
      queued = false;
    };
    addEventListener("scroll", () => {
      if (!queued) {
        queued = true;
        requestAnimationFrame(run);
      }
    }, { passive: true });
    addEventListener("resize", run);
    run();
  }

  for (const box of boxes) {
    const nodes = [...box.querySelectorAll(".node")];
    const ms = Number(box.dataset.play);
    if (nodes.length < 2 || !ms) continue;
    const last = nodes.length - 1;

    let at = 0;
    let frame = 0;

    const goto = (target, over) => {
      cancelAnimationFrame(frame);
      const from = at;
      const t0 = performance.now();
      const span = Math.max(120, over * Math.abs(target - from));
      const step = (now) => {
        const u = Math.min(1, (now - t0) / span);
        at = from + (target - from) * EASE(u);
        paint(box, at);
        if (u < 1) frame = requestAnimationFrame(step);
      };
      frame = requestAnimationFrame(step);
    };

    // One pass on arrival, then the picture stays finished. A workflow diagram that
    // loops forever turns the page into a screensaver and hides the answer.
    const seen = new IntersectionObserver((rows) => {
      if (!rows.some((r) => r.isIntersecting)) return;
      seen.disconnect();
      goto(1, ms);
    }, { rootMargin: "120px" });
    seen.observe(box);

    // Reading a workflow means wanting to linger on one leg, so every node is a
    // control. This is the only interaction on these rails and it is the one that
    // a static picture cannot offer.
    nodes.forEach((n, k) => {
      n.tabIndex = 0;
      n.setAttribute("role", "button");
      n.setAttribute("aria-label", `show step ${k + 1} of ${last + 1}, ${n.querySelector("b")?.textContent ?? ""}`);
      const jump = () => {
        if (k < last) resetCounts(box.parentElement ?? box);
        goto(k / last, 340);
      };
      n.addEventListener("click", jump);
      n.addEventListener("keydown", (e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          jump();
        }
      });
    });
    paint(box, 0);
  }
}
