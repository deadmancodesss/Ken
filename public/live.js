/*
 * The browser half of a live call. One event stream carries everything the agent
 * says, does and sounds like, and one small post per tenth of a second carries the
 * microphone the other way. The key never appears here, because the socket to the
 * model is held by the server.
 */

/*
 * The rule for what goes upstream while the agent is talking.
 *
 * A browser's echo cancellation is a best effort, and on a laptop speaker it regularly
 * fails. Anything that survives it reaches the model as the caller's own voice, which is
 * how a call ends up interrupting itself, hearing its own sentence as a question and
 * answering one turn late. So while the agent's audio is playing, and for a short tail
 * after the last chunk, the microphone is replaced with silence of the same length. The
 * uplink stays alive and the server's turn detection stays awake, but the model cannot
 * hear itself. Headphones break the loop at the source, so a caller wearing them can be
 * given the floor back mid sentence.
 */
const zeros = new Map();

/** A zeroed block the same length as the one it replaces, made once per size. */
export function silence(length) {
  let z = zeros.get(length);
  if (!z) zeros.set(length, (z = new Int16Array(length)));
  return z;
}

export function upstream(frame, haveTheFloor) {
  return haveTheFloor ? frame : silence(frame.length);
}

/**
 * Whether the caller currently owns the microphone. `speaking` is the agent's own audio,
 * and the tail exists because the room keeps ringing for a moment after the last buffer
 * has been handed to the speaker, which is exactly the window an echo likes.
 */
export function floorIsMine({ barge = false, speaking = false, now = 0, tailUntil = 0, tailMs = 400 }) {
  if (barge) return { open: true, tailUntil };
  if (speaking) return { open: false, tailUntil: now + tailMs };
  return { open: now >= tailUntil, tailUntil };
}

/**
 * The live model sends transcription in pieces that are sometimes cumulative and
 * sometimes only the words it has not sent yet. Appending both shapes blindly is
 * what printed one spoken sentence twice, which reads as the call having heard and
 * answered the same thing two times.
 */
export function mergeHeard(line, piece) {
  // Punctuation and the space a piece starts with are not new words, so they are
  // compared away. Without that, "Prakash" and " Prakash" are two utterances.
  const norm = (s) => s.toLowerCase().replace(/[.,!?…]+$/g, "").trim();
  if (!norm(piece)) return line;
  if (!norm(line)) return piece;
  const whole = norm(line);
  const part = norm(piece);
  if (part === whole || whole.endsWith(part)) return line;
  if (part.startsWith(whole)) return piece;
  return line + piece;
}

/**
 * Google's input transcription drops punctuation, so a price said as "eleven thirty
 * nine USDC" reaches the page as "11 39 USDC". The digits either side of the space are
 * one amount, and drawing them as a pair reads like two numbers. Only a pair followed
 * by a currency word is repaired, because a bare pair is a sentence and not a price.
 */
export function tidyHeard(line) {
  return line.replace(/\b(\d{1,6}) (\d{2})(?=\s(?:usdc|dollars?|bucks|sui)\b)/gi, "$1.$2");
}

/**
 * Microphone bytes at 16 kHz, which is what the model listens for. The browser's own
 * rate is whatever the hardware decided, so every block is resampled on the way out.
 */
export async function captureMic(onChunk, onLevel, onTrace) {
  const stream = await navigator.mediaDevices.getUserMedia({
    audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
  });
  const ctx = new AudioContext();
  const src = ctx.createMediaStreamSource(stream);
  const node = ctx.createScriptProcessor(4096, 1, 1);
  const silent = ctx.createGain();
  silent.gain.value = 0;
  let pending = new Int16Array(0);
  let phase = 0;
  let previous = 0;
  const shape = new Float32Array(192);

  node.onaudioprocess = (e) => {
    const input = e.inputBuffer.getChannelData(0);
    let peak = 0;
    for (let i = 0; i < input.length; i++) {
      const v = Math.abs(input[i]);
      if (v > peak) peak = v;
    }
    onLevel(Math.min(1, peak * 2.6));
    // The scope gets the shape of the block, not just its loudness, so it can
    // draw the voice rather than a curve that only looks like one.
    if (onTrace) {
      const span = input.length / shape.length;
      for (let b = 0; b < shape.length; b++) {
        const start = Math.floor(b * span);
        const end = Math.min(input.length, Math.floor((b + 1) * span));
        let loudest = 0;
        for (let k = start; k < end; k++) {
          if (Math.abs(input[k]) > Math.abs(loudest)) loudest = input[k];
        }
        shape[b] = loudest;
      }
      onTrace(shape);
    }
    // Step through the block at the ratio between the two rates and carry the fraction
    // into the next block, or the resampled audio drifts a few milliseconds behind the
    // speaker every time the microphone hands over a buffer.
    const step = ctx.sampleRate / 16000;
    const want = Math.max(0, Math.floor((input.length - 1 - phase) / step) + 1);
    const out = new Int16Array(pending.length + want);
    out.set(pending, 0);
    for (let i = 0; i < want; i++) {
      const at = phase + i * step;
      const lo = Math.floor(at);
      const a = input[lo] ?? previous;
      const b = input[Math.min(input.length - 1, lo + 1)] ?? a;
      const sample = Math.max(-1, Math.min(1, a + (b - a) * (at - lo)));
      out[pending.length + i] = sample * 32767;
      previous = sample;
    }
    phase = phase + want * step - input.length;
    pending = out;
    while (pending.length >= 1600) {
      onChunk(pending.subarray(0, 1600));
      pending = pending.subarray(1600);
    }
  };

  src.connect(node);
  node.connect(silent);
  silent.connect(ctx.destination);

  return () => {
    node.disconnect();
    src.disconnect();
    silent.disconnect();
    stream.getTracks().forEach((t) => t.stop());
    ctx.close().catch(() => {});
  };
}

/**
 * The agent's reply arrives as raw 24 kHz pieces. Each one becomes a buffer scheduled
 * to start the moment the last finishes, so the sentence is continuous even though it
 * crossed the network in fragments.
 */
export function createPlayer(onLevel, onTrace) {
  const ctx = new AudioContext();
  const master = ctx.createGain();
  const analyser = ctx.createAnalyser();
  // Long enough to show a tenth of a second of speech at once, which is what
  // gives the scope its detail instead of one slow swell per syllable.
  analyser.fftSize = 2048;
  master.connect(analyser);
  analyser.connect(ctx.destination);
  // Time-domain data is one byte per fftSize sample, not one per frequency bin.
  const bytes = new Uint8Array(analyser.fftSize);
  let next = 0;
  const live = [];
  let raf = 0;
  let lastShape = 0;

  const tick = (now = performance.now()) => {
    analyser.getByteTimeDomainData(bytes);
    let peak = 0;
    for (let i = 0; i < bytes.length; i++) peak = Math.max(peak, Math.abs(bytes[i] - 128) / 128);
    onLevel(peak);
    // A fresh buffer on every animation frame is faster than any voice changes and
    // makes the scope flicker. Fourteen shapes a second keeps the line fluid.
    if (now - lastShape >= 70) {
      onTrace?.(bytes);
      lastShape = now;
    }
    raf = requestAnimationFrame(tick);
  };

  return {
    feed(pcm, rate) {
      // A context that the browser parked while the page was in the background would
      // swallow every frame it was given, so waking it is part of playing a chunk.
      if (ctx.state === "suspended") ctx.resume().catch(() => {});
      const s16 = new Int16Array(pcm);
      const buf = ctx.createBuffer(1, s16.length, rate);
      const ch = buf.getChannelData(0);
      for (let i = 0; i < s16.length; i++) ch[i] = s16[i] / 32768;
      const node = ctx.createBufferSource();
      node.buffer = buf;
      node.connect(master);
      // A chunk that arrives while the room is already quiet has to start now rather
      // than at a timestamp left over from the last sentence.
      next = Math.max(next, ctx.currentTime);
      node.start(next);
      next += buf.duration;
      live.push(node);
      node.onended = () => {
        const i = live.indexOf(node);
        if (i >= 0) live.splice(i, 1);
        if (!live.length) {
          next = 0;
          cancelAnimationFrame(raf);
          raf = 0;
          onLevel(0);
        }
      };
      if (!raf) raf = requestAnimationFrame(tick);
    },
    interrupt() {
      // Cutting off is only honest if the queue goes too, otherwise the agent finishes
      // saying everything the listener has already talked over.
      for (const node of live.splice(0)) {
        try {
          node.stop();
        } catch {
          /* already finished */
        }
      }
      next = 0;
      onLevel(0);
    },
    get speaking() {
      return live.length > 0;
    },
    close() {
      this.interrupt();
      cancelAnimationFrame(raf);
      ctx.close().catch(() => {});
    },
  };
}

/**
 * One open call. Returns the handle the page uses to push microphone frames, and the
 * server's own voice activity detection decides when a sentence has ended.
 */
export function openLive(handlers) {
  // A numeric voice value is an index into this browser's own list, which the live
  // socket has no use for, so only a real speaker name is sent upstream. The session
  // travels with the stream so a ticket earned by voice lands in the thread the
  // person actually had open.
  const qs = new URLSearchParams();
  if (handlers.voice && !/^\d+$/.test(handlers.voice)) qs.set("voice", handlers.voice);
  if (handlers.session) qs.set("session", handlers.session);
  const tail = qs.toString();
  const es = new EventSource("/live/stream" + (tail ? `?${tail}` : ""));
  let id = "";
  let queue = [];
  let busy = false;
  let dead = false;
  let dropping = false;
  // A server that is down or redeploying leaves the browser retrying an event stream
  // that never opens, with the microphone already hot. The guard turns that into a
  // sentence the room can act on instead of a spinner that never ends.
  const openGuard = setTimeout(() => {
    if (id || dead) return;
    dead = true;
    es.close();
    handlers.onError?.("the live call did not open in 15 seconds. Check the server and start again");
    handlers.onClose?.("the live call did not open");
  }, 15_000);

  const pump = async () => {
    if (busy || !id || dead) return;
    busy = true;
    // A slow uplink is caught by merging frames, not by letting them pile up behind
    // a conversation that has already moved on.
    const merged = queue.length > 1 ? concat(queue.splice(0, Math.min(queue.length, 6))) : queue.shift();
    try {
      const res = await fetch(`/live/mic?id=${id}`, { method: "POST", body: merged });
      if (!res.ok && res.status !== 404) handlers.onError?.(`mic ${res.status}`);
    } catch {
      handlers.onError?.("the microphone could not reach the server");
    }
    busy = false;
    if (queue.length) pump();
  };

  const concat = (frames) => {
    const total = frames.reduce((n, f) => n + f.length, 0);
    const all = new Int16Array(total);
    let at = 0;
    for (const f of frames) {
      all.set(f, at);
      at += f.length;
    }
    return all.buffer;
  };

  es.onmessage = (e) => {
    const m = JSON.parse(e.data);
    if (m.kind === "open") {
      clearTimeout(openGuard);
      id = m.id;
      handlers.onOpen?.(m.model, m.voice);
      return;
    }
    if (m.kind === "audio") {
      // Once the listener has talked over an answer, the rest of that answer is words
      // they have already decided to interrupt, so it is thrown away rather than queued.
      if (dropping) return;
      const bin = atob(m.data);
      const u8 = new Uint8Array(bin.length);
      for (let i = 0; i < bin.length; i++) u8[i] = bin.charCodeAt(i);
      handlers.onAudio?.(u8.buffer, m.rate ?? 24000);
      return;
    }
    if (m.kind === "heard") {
      dropping = false;
      handlers.onHeard?.(m.text);
    } else if (m.kind === "said") handlers.onSaid?.(m.text);
    else if (m.kind === "tool") handlers.onTool?.(m);
    else if (m.kind === "tool-start") handlers.onToolStart?.(m);
    else if (m.kind === "activity") handlers.onActivity?.(m.type);
    else if (m.kind === "turn") {
      dropping = false;
      handlers.onTurn?.();
    }
    else if (m.kind === "error") handlers.onError?.(m.message);
    else if (m.kind === "close") {
      dead = true;
      es.close();
      handlers.onClose?.(m.reason);
    }
  };
  es.onerror = () => {
    if (dead) return;
    handlers.onError?.("the call stream dropped");
  };

  return {
    get connected() {
      return !!id && !dead;
    },
    push(frame) {
      if (dead) return;
      queue.push(frame);
      // Two frames of backlog is already a fifth of a second behind the speaker, and
      // anything older than that is a sentence the agent should not hear.
      while (queue.length > 3) queue.shift();
      pump();
    },
    /**
     * A typed note for the live model. The microphone path carries speech, and an
     * address is the one thing this page refuses to carry that way, so the sentence
     * that says an address was typed travels through here instead.
     */
    say(text) {
      if (!id || dead) return Promise.resolve(false);
      return fetch(`/live/text?id=${encodeURIComponent(id)}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ text }),
      })
        .then((r) => r.ok)
        .catch(() => false);
    },
    /**
     * Ends the call on both sides and hands back something a caller can wait on. Closing
     * the stream is what actually frees the server's socket, so the post below is the polite
     * version of the same instruction rather than the only one, and an id that was never
     * issued is not a leak waiting behind it.
     */
    hangup() {
      clearTimeout(openGuard);
      dead = true;
      es.close();
      if (!id) return Promise.resolve();
      return fetch(`/live/hangup?id=${encodeURIComponent(id)}`, { method: "POST" })
        .then(() => {})
        .catch(() => {});
    },
    hold() {
      dropping = true;
    },
  };
}
