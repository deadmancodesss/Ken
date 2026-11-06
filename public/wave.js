/*
 * The voice scope.
 *
 * A paper recorder rather than a music player. The line is the actual shape of
 * whichever side is talking, taken from the microphone or from Ken's own audio
 * buffers. Older copies of that shape stay on the page for a moment and drift
 * back, which is the echo. The rest is measuring paper: a ruler, a centre line
 * and one number for the level.
 *
 * Nothing here is a decorative sine wave. Silence is a flat line, and the
 * drawing only moves when a voice moves it. Every colour is read from
 * theme.css, so there is no hex in this file to drift.
 */

const POINTS = 220;
const GHOSTS = 5;
const SNAPSHOT = 0.07;
const ECHO_SECONDS = 1.05;

const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));

export function createWave(canvas) {
  const ctx = canvas.getContext("2d");
  const css = getComputedStyle(canvas);
  const colour = (name) => css.getPropertyValue(`--${name}`).trim();
  const ink = colour("ink");
  const ink3 = colour("ink-3");
  const clay = colour("clay");
  const rule = colour("rule");
  const ruleStrong = colour("rule-strong");
  const wash = colour("clay-wash");
  const mono = css.getPropertyValue("--mono").trim() || "ui-monospace, Menlo, monospace";
  const reduce = matchMedia("(prefers-reduced-motion: reduce)").matches;

  let w = 0;
  let h = 0;
  let clock = 0;
  let last = performance.now();
  let raf = 0;
  let stopped = false;

  let mode = "idle";
  let speaker = "";
  let mic = 0;
  let out = 0;
  let level = 0;
  let heardAt = -10;
  let traceGain = 1;
  let traceWho = "";

  const from = new Float32Array(POINTS);
  const to = new Float32Array(POINTS);
  const shown = new Float32Array(POINTS);
  let morph = 1;
  let morphSpan = 0.08;
  let morphWho = "";
  let lastTrace = -10;
  let fading = false;

  const history = [];
  let lastSnap = -1;
  let fresh = false;
  let wasSpeech = false;
  const pings = [];

  function size() {
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    const cw = canvas.clientWidth;
    const ch = canvas.clientHeight;
    if (!cw || !ch) return false;
    if (cw === w && ch === h) return true;
    w = cw;
    h = ch;
    canvas.width = Math.round(cw * dpr);
    canvas.height = Math.round(ch * dpr);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    return true;
  }

  function easeMorph() {
    if (morph >= 1) return;
    const t = 1 - Math.pow(1 - clamp(morph, 0, 1), 3);
    for (let i = 0; i < POINTS; i++) shown[i] = from[i] + (to[i] - from[i]) * t;
  }

  function read(input, at) {
    const lo = Math.floor(at);
    const hi = Math.min(input.length - 1, lo + 1);
    const f = at - lo;
    const byte = input instanceof Uint8Array;
    const a = byte ? (input[lo] - 128) / 128 : input[lo];
    const b = byte ? (input[hi] - 128) / 128 : input[hi];
    return a + (b - a) * f;
  }

  /**
   * One frame of the voice itself. A Uint8Array is read the way an analyser
   * writes it, a float array the way a microphone hands it over, and both are
   * resampled onto the width of this scope.
   */
  function trace(input, who = "ken") {
    if (!input || input.length < 2) return;
    const n = input.length;
    let mean = 0;
    for (let i = 0; i < n; i++) mean += read(input, i);
    mean /= n;
    let peak = 0;
    for (let i = 0; i < n; i++) {
      const a = Math.abs(read(input, i) - mean);
      if (a > peak) peak = a;
    }
    // A live microphone and a decoded model buffer arrive at very different
    // volumes, so each side is lifted to a readable height. A new speaker snaps
    // to its own lift at once and only eases while the same side keeps talking,
    // otherwise the first word after a quiet stretch is crushed by the gain the
    // other side needed a moment earlier.
    const want = clamp(0.84 / Math.max(peak, 0.075), 0.9, 6.5);
    if (who !== traceWho) {
      traceGain = want;
      traceWho = who;
    } else {
      traceGain += (want - traceGain) * 0.2;
    }

    easeMorph();
    from.set(shown);
    for (let j = 0; j < POINTS; j++) {
      const v = (read(input, (j / (POINTS - 1)) * (n - 1)) - mean) * traceGain;
      to[j] = clamp(v, -1, 1);
    }
    morph = 0;
    morphSpan = who === "you" ? 0.12 : 0.055;
    morphWho = who;
    lastTrace = clock;
    fading = false;
    fresh = true;
  }

  function plot(points, dx, dy, scale) {
    ctx.beginPath();
    for (let i = 0; i < POINTS; i++) {
      const x = 1 + dx + (i / (POINTS - 1)) * (w - 2);
      const y = mid() + dy + points[i] * half() * scale;
      if (i === 0) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
    }
    ctx.stroke();
  }

  const top = () => (h > 72 ? 24 : 18);
  const mid = () => top() + (h - top() - 10) / 2;
  const half = () => (h - top() - 10) / 2;

  function paper() {
    ctx.strokeStyle = rule;
    ctx.globalAlpha = 0.75;
    ctx.lineWidth = 1;
    ctx.beginPath();
    for (let x = w % 48; x < w; x += 48) {
      ctx.moveTo(Math.round(x) + 0.5, top());
      ctx.lineTo(Math.round(x) + 0.5, h - 4);
    }
    ctx.stroke();

    ctx.strokeStyle = ruleStrong;
    ctx.globalAlpha = 0.9;
    ctx.setLineDash([1, 5]);
    ctx.beginPath();
    ctx.moveTo(0, Math.round(mid()) + 0.5);
    ctx.lineTo(w, Math.round(mid()) + 0.5);
    ctx.stroke();
    ctx.setLineDash([]);

    // The ruler along the bottom is what makes the strip read as an instrument
    // rather than as a decoration.
    ctx.strokeStyle = ruleStrong;
    ctx.globalAlpha = 0.55;
    ctx.beginPath();
    ctx.moveTo(0, h - 0.5);
    ctx.lineTo(w, h - 0.5);
    ctx.stroke();
    ctx.strokeStyle = ink3;
    ctx.globalAlpha = 0.32;
    ctx.beginPath();
    for (let x = 6, i = 0; x < w; x += 12, i++) {
      const tall = i % 4 === 0 ? 5 : 3;
      ctx.moveTo(x + 0.5, h - 1);
      ctx.lineTo(x + 0.5, h - 1 - tall);
    }
    ctx.stroke();
    ctx.globalAlpha = 1;
  }

  function echoes(scale) {
    for (let i = history.length - 1; i >= 0; i--) {
      const g = history[i];
      const age = clock - g.at;
      if (age > ECHO_SECONDS) continue;
      const fade = (1 - age / ECHO_SECONDS) * (1 - (i / (GHOSTS + 1)));
      if (fade <= 0.01) continue;
      ctx.globalAlpha = 0.02 + fade * 0.2;
      ctx.strokeStyle = g.who === "ken" ? clay : ink;
      ctx.lineWidth = 1;
      // The copy drifts away from the live line as it ages, so the echo is a
      // movement rather than five fixed offsets waiting to be replaced.
      plot(g.points, -(4 + age * 120), (i % 2 === 0 ? 1 : -1) * (1.5 + i * 1.2), scale);
    }
    ctx.globalAlpha = 1;
  }

  function live(scale) {
    if (mode === "idle" || !morphWho) return;
    const tone = speaker === "ken" || morphWho === "ken" ? clay : ink;

    // A pale body under the line, not a glow: the same flat wash the rest of
    // the site uses for a pressed or active surface.
    ctx.beginPath();
    for (let i = 0; i < POINTS; i++) {
      const x = 1 + (i / (POINTS - 1)) * (w - 2);
      const y = mid() + shown[i] * half() * scale;
      if (i === 0) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
    }
    ctx.lineTo(w - 1, mid());
    ctx.lineTo(1, mid());
    ctx.closePath();
    ctx.fillStyle = wash;
    ctx.globalAlpha = 0.55;
    ctx.fill();

    ctx.beginPath();
    for (let i = 0; i < POINTS; i++) {
      const x = 1 + (i / (POINTS - 1)) * (w - 2);
      const y = mid() + shown[i] * half() * scale;
      if (i === 0) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
    }
    ctx.strokeStyle = tone;
    ctx.globalAlpha = 0.95;
    ctx.lineWidth = 1.7;
    ctx.stroke();

    // The newest sample is the head of the strip.
    const head = mid() + shown[POINTS - 1] * half() * scale;
    ctx.fillStyle = tone;
    ctx.globalAlpha = 1;
    ctx.beginPath();
    ctx.arc(w - 3, head, 2.1, 0, Math.PI * 2);
    ctx.fill();
    ctx.globalAlpha = 0.22;
    ctx.strokeStyle = tone;
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(w - 1.5, top());
    ctx.lineTo(w - 1.5, h - 4);
    ctx.stroke();
    ctx.globalAlpha = 1;
  }

  function ripples() {
    for (let i = pings.length - 1; i >= 0; i--) {
      const t = (clock - pings[i]) / 1.5;
      if (t >= 1) {
        pings.splice(i, 1);
        continue;
      }
      const x = w - t * (w + 16);
      ctx.strokeStyle = clay;
      ctx.globalAlpha = (1 - t) * 0.2;
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(x, top());
      ctx.lineTo(x, h - 4);
      ctx.stroke();
    }
    ctx.globalAlpha = 1;
  }

  function chrome() {
    ctx.font = `500 9px ${mono}`;
    ctx.textBaseline = "middle";
    if ("letterSpacing" in ctx) ctx.letterSpacing = "1.2px";
    const liveNow = mode !== "idle";
    const name = !liveNow ? "STANDBY" : speaker === "ken" ? "KEN" : speaker === "you" ? "YOU" : "MIC";
    ctx.fillStyle = !liveNow ? ruleStrong : speaker === "ken" ? clay : ink;
    ctx.beginPath();
    ctx.arc(4, 10, 2.3, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = ink3;
    ctx.globalAlpha = liveNow ? 1 : 0.7;
    ctx.fillText(name, 12, 10);

    const db = level > 0.006 ? Math.max(-48, 20 * Math.log10(level)) : null;
    const readout = !liveNow || db === null ? "-48 dB" : `${Math.round(db)} dB`;
    ctx.textAlign = "right";
    ctx.fillStyle = ink3;
    ctx.globalAlpha = 0.75;
    ctx.fillText(readout, w - 2, 10);
    ctx.textAlign = "left";
    ctx.globalAlpha = 1;
    if ("letterSpacing" in ctx) ctx.letterSpacing = "0px";
  }

  function frame(now) {
    if (stopped) return;
    const dt = Math.min(0.05, (now - last) / 1000);
    last = now;
    clock += dt;

    if (mode === "idle" || clock - heardAt > 0.6) speaker = "";
    const target = Math.max(mic, out);
    level += (target - level) * (target > level ? 0.32 : 0.075);
    if (mode === "idle") level *= 0.9;

    if (morph < 1) {
      morph = Math.min(1, morph + dt / morphSpan);
      easeMorph();
      if (morph === 1) shown.set(to);
    }
    // A call keeps the last buffer on screen when nobody is talking. Left alone
    // that reads as a voice that never stopped, so the trace is brought back to
    // the centre line as soon as the stream goes quiet.
    if (mode === "live" && clock - lastTrace > 0.2 && !fading) {
      easeMorph();
      from.set(shown);
      to.fill(0);
      morph = 0;
      morphSpan = 0.24;
      fading = true;
    }
    if (mode === "live" && morphWho && fresh && clock - lastSnap >= SNAPSHOT) {
      history.unshift({ points: Float32Array.from(to), who: morphWho, at: clock });
      if (history.length > GHOSTS) history.pop();
      lastSnap = clock;
      fresh = false;
    }

    if (size()) {
      const scale = 0.45 + 0.55 * clamp(level * 2.2, 0, 1);
      ctx.clearRect(0, 0, w, h);
      paper();

      if (mode === "idle") {
        ctx.strokeStyle = ruleStrong;
        ctx.globalAlpha = 0.5;
        ctx.lineWidth = 1;
        ctx.beginPath();
        ctx.moveTo(1, Math.round(mid()) + 0.5);
        ctx.lineTo(w - 1, Math.round(mid()) + 0.5);
        ctx.stroke();
        ctx.globalAlpha = 1;
      } else {
        const speaking = level > 0.14;
        const quiet = !pings.length || clock - pings[pings.length - 1] > 0.7;
        if (speaking && !wasSpeech && quiet && !reduce) pings.push(clock);
        wasSpeech = speaking;
        if (pings.length > 3) pings.shift();
        ripples();
        echoes(scale);
        live(scale);
      }

      chrome();
    }
    raf = requestAnimationFrame(frame);
  }

  raf = requestAnimationFrame(frame);

  return {
    /** 0 to 1, from real audio. Nothing here is animated on a timer. */
    push(v, who = "ken") {
      const next = clamp(v || 0, 0, 1);
      if (who === "you") mic = next;
      else out = next;
      if (next > 0.035) {
        speaker = who;
        heardAt = clock;
      }
    },
    /** One frame of the waveform itself, from the microphone or the player. */
    trace,
    live() {
      mode = "live";
      heardAt = clock;
    },
    idle() {
      mode = "idle";
      speaker = "";
      mic = 0;
      out = 0;
      level = 0;
      morphWho = "";
      morph = 1;
      traceGain = 1;
      traceWho = "";
      lastTrace = -10;
      fading = false;
      fresh = false;
      history.length = 0;
      pings.length = 0;
      wasSpeech = false;
      for (let i = 0; i < POINTS; i++) {
        from[i] = 0;
        to[i] = 0;
        shown[i] = 0;
      }
    },
    destroy() {
      stopped = true;
      cancelAnimationFrame(raf);
    },
  };
}
