/*
 * The voice ribbon.
 *
 * Google's mic animation reads as alive for three reasons, and none of them is
 * the blue. Several sine curves at different frequencies drift against each
 * other, the whole thing tapers to nothing at both ends so it floats rather than
 * spans, and the height is somebody's actual voice rather than a looping timer.
 *
 * All three are kept. The palette is the paper one, because a black rectangle of
 * neon pasted into this product would read as a screenshot of a different app.
 * Every colour is read from theme.css, so there is no hex in here to drift.
 */

/*
 * Frequencies are in cycles across the whole ribbon. Anything under about two
 * reads as a slow sag rather than a voice, and the reference sits near three
 * crests with two thinner curves running faster through it.
 */
const RIBBONS = [
  { freq: 1.5, speed: 0.34, amp: 0.62, wide: 1, tone: "ink", alpha: 0.26 },
  { freq: 3.1, speed: -0.72, amp: 0.4, wide: 1, tone: "ink", alpha: 0.2 },
  { freq: 4.6, speed: 1.15, amp: 0.22, wide: 1, tone: "moss", alpha: 0.42 },
  { freq: 2.2, speed: 0.5, amp: 0.95, wide: 2.1, tone: "clay", alpha: 1, core: true },
];

const GRAIN = 16;

export function createWave(canvas) {
  const ctx = canvas.getContext("2d");
  ctx.lineJoin = "round";
  ctx.lineCap = "round";
  const style = getComputedStyle(canvas);
  const colour = (name) => (name === "clay" ? style.getPropertyValue("--clay") : name === "moss" ? style.getPropertyValue("--moss") : style.getPropertyValue("--ink")).trim();
  const wash = style.getPropertyValue("--clay-wash").trim() || colour("clay");
  const flat = matchMedia("(prefers-reduced-motion: reduce)").matches;

  let w = 0;
  let h = 0;
  // Two separate signals. The microphone is the floor, and a word boundary is an
  // overlay that fades, so the agent's own voice can swell the ribbon without
  // overwriting what the ear is hearing at the same moment.
  let mic = 0;
  let overlay = 0;
  let level = 0;
  let clock = 0;
  let last = performance.now();
  let raf = 0;
  let stopped = false;

  const grain = Array.from({ length: GRAIN }, (_, i) => ({
    u: (i + 0.5) / GRAIN,
    drift: Math.random() * Math.PI * 2,
    rise: 0.4 + Math.random(),
  }));

  // Offsets are per instance so two ribbons on one page never march in step.
  const ribbons = RIBBONS.map((r) => ({ ...r, phase: Math.random() * Math.PI * 2 }));
  const core = ribbons[ribbons.length - 1];

  function size() {
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    const cw = canvas.clientWidth;
    const ch = canvas.clientHeight;
    // A page that has not been laid out yet measures zero. Skip the frame rather
    // than bake 0 into the transform and never recover.
    if (!cw || !ch) return false;
    if (cw === w && ch === h) return true;
    w = cw;
    h = ch;
    canvas.width = Math.round(cw * dpr);
    canvas.height = Math.round(ch * dpr);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    return true;
  }

  const taper = (u) => Math.pow(Math.sin(Math.PI * u), 0.85);

  function curve(ribbon, t, amp) {
    const half = h / 2;
    const reach = amp * ribbon.amp * half;
    ctx.beginPath();
    const steps = Math.max(60, Math.round(w / 3));
    for (let i = 0; i <= steps; i++) {
      const u = i / steps;
      const y = half + Math.sin(u * Math.PI * 2 * ribbon.freq + t * ribbon.speed * 2 + ribbon.phase) * reach * taper(u);
      if (i === 0) ctx.moveTo(u * w, y);
      else ctx.lineTo(u * w, y);
    }
  }

  function frame(now) {
    if (stopped) return;
    const dt = Math.min(0.05, (now - last) / 1000);
    last = now;
    clock += dt;
    // A voice attacks fast and falls away slowly, which is why it reads as speech
    // and a meter does not.
    overlay *= Math.pow(0.5, dt / 0.22);
    const target = Math.max(mic, overlay);
    level += (target - level) * (target > level ? 0.3 : 0.07);

    if (size()) {
      ctx.clearRect(0, 0, w, h);
      const amp = flat ? 0.16 : 0.06 + level * 0.94;
      for (const ribbon of ribbons) {
        if (ribbon.core) {
          // A wide pale stroke under a thin solid one gives the ribbon a body
          // without a glow, a gradient or a filter.
          curve(ribbon, clock, amp * 1.05);
          ctx.lineWidth = 7;
          ctx.strokeStyle = wash;
          ctx.stroke();
        }
        curve(ribbon, clock, amp);
        ctx.lineWidth = ribbon.wide;
        ctx.globalAlpha = ribbon.alpha;
        ctx.strokeStyle = colour(ribbon.tone);
        ctx.stroke();
        ctx.globalAlpha = 1;
      }

      if (!flat && level > 0.02) {
        const half = h / 2;
        const reach = amp * core.amp * half;
        ctx.fillStyle = colour("clay");
        for (const g of grain) {
          const y = half + Math.sin(g.u * Math.PI * 2 * core.freq + clock * core.speed * 2 + core.phase) * reach * taper(g.u);
          const lift = Math.sin(clock * 0.9 + g.drift) * 6 * g.rise * level;
          ctx.globalAlpha = 0.15 + level * 0.5 * taper(g.u);
          ctx.beginPath();
          ctx.arc(g.u * w, y - lift, 1.1, 0, Math.PI * 2);
          ctx.fill();
        }
        ctx.globalAlpha = 1;
      }
    }
    raf = requestAnimationFrame(frame);
  }

  raf = requestAnimationFrame(frame);

  return {
    /** 0 to 1, from real audio. Nothing here is animated on a timer. */
    push(v) {
      mic = Math.max(0, Math.min(1, v));
    },
    idle() {
      mic = flat ? 0 : 0.03;
      overlay = 0;
    },
    /** A short swell, used for each word the agent speaks. */
    pulse(v = 0.75) {
      overlay = Math.max(overlay, v);
    },
    destroy() {
      stopped = true;
      cancelAnimationFrame(raf);
    },
  };
}
