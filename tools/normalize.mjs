/*
 * The generated plates sit on their own warm off-white, a few points darker than
 * --paper, so mix-blend-mode: multiply would darken a visible rectangle. Pushing
 * each plate's paper to pure white first makes multiply a no-op on the background
 * and leaves the ink where it was.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { inflateSync, deflateSync } from "node:zlib";

const SIG = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
const CRC_TABLE = (() => {
  const t = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c;
  }
  return t;
})();
function crc32(buf) {
  let c = -1;
  for (const b of buf) c = CRC_TABLE[(c ^ b) & 255] ^ (c >>> 8);
  return (c ^ -1) >>> 0;
}
function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
}

function decode(buf) {
  if (!buf.subarray(0, 8).equals(SIG)) throw new Error("not a png");
  let p = 8;
  let ihdr = null;
  const idat = [];
  while (p < buf.length) {
    const len = buf.readUInt32BE(p);
    const type = buf.toString("latin1", p + 4, p + 8);
    const data = buf.subarray(p + 8, p + 8 + len);
    if (type === "IHDR") ihdr = { w: data.readUInt32BE(0), h: data.readUInt32BE(4), depth: data[8], color: data[9], inter: data[12] };
    if (type === "IDAT") idat.push(data);
    if (type === "IEND") break;
    p += 12 + len;
  }
  if (!ihdr) throw new Error("no ihdr");
  if (ihdr.depth !== 8 || ihdr.inter !== 0 || ihdr.color !== 2) {
    throw new Error(`unsupported png ${JSON.stringify(ihdr)}`);
  }
  const { w, h } = ihdr;
  const stride = w * 3;
  const raw = inflateSync(Buffer.concat(idat));
  const out = Buffer.alloc(h * stride);
  const paeth = (a, b, c) => {
    const pp = a + b - c;
    const pa = Math.abs(pp - a), pb = Math.abs(pp - b), pc = Math.abs(pp - c);
    return pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
  };
  for (let y = 0; y < h; y++) {
    const filter = raw[y * (stride + 1)];
    const line = raw.subarray(y * (stride + 1) + 1, y * (stride + 1) + 1 + stride);
    const cur = out.subarray(y * stride, (y + 1) * stride);
    const up = y > 0 ? out.subarray((y - 1) * stride, y * stride) : null;
    for (let x = 0; x < stride; x++) {
      const a = x >= 3 ? cur[x - 3] : 0;
      const b = up ? up[x] : 0;
      const c = up && x >= 3 ? up[x - 3] : 0;
      const v = line[x];
      cur[x] =
        filter === 0 ? v :
        filter === 1 ? (v + a) & 255 :
        filter === 2 ? (v + b) & 255 :
        filter === 3 ? (v + ((a + b) >> 1)) & 255 :
        filter === 4 ? (v + paeth(a, b, c)) & 255 :
        (() => { throw new Error(`filter ${filter} at row ${y}`); })();
    }
  }
  return { w, h, px: out };
}

function encode({ w, h, px }) {
  const stride = w * 3;
  const raw = Buffer.alloc(h * (stride + 1));
  for (let y = 0; y < h; y++) {
    raw[y * (stride + 1)] = 0;
    px.copy(raw, y * (stride + 1) + 1, y * stride, (y + 1) * stride);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8; ihdr[9] = 2; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;
  return Buffer.concat([
    SIG,
    chunk("IHDR", ihdr),
    chunk("IDAT", deflateSync(raw, { level: 9 })),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

/* Sample the four corners of the source and take the lightest reading per channel,
   then overshoot by a few points so a shaded vignette also clips to white. */
function paperOf(img) {
  const { w, h, px } = img;
  const stride = w * 3;
  const at = (x, y) => px.subarray(y * stride + x * 3, y * stride + x * 3 + 3);
  const pts = [at(2, 2), at(w - 3, 2), at(2, h - 3), at(w - 3, h - 3), at((w / 2) | 0, 2)];
  const paper = [0, 0, 0].map((_, c) => Math.max(...pts.map((p) => p[c])));
  return paper.map((v) => Math.max(1, v - 8));
}

const [,, src, dst, width] = process.argv;
if (!src || !dst) throw new Error("usage: normalize.mjs in.png out.png [maxWidth]");
const buf = readFileSync(src);
const img = decode(buf);
let { w, h, px } = img;
if (width && Number(width) < w) {
  const nw = Number(width);
  const nh = Math.max(2, Math.round((h * nw) / w / 2) * 2);
  const next = Buffer.alloc(nw * nh * 3);
  for (let y = 0; y < nh; y++) {
    const sy = Math.min(h - 1, Math.floor((y * h) / nh));
    for (let x = 0; x < nw; x++) {
      const sx = Math.min(w - 1, Math.floor((x * w) / nw));
      const i = (sy * w + sx) * 3;
      const o = (y * nw + x) * 3;
      next[o] = px[i]; next[o + 1] = px[i + 1]; next[o + 2] = px[i + 2];
    }
  }
  w = nw; h = nh; px = next;
}

const paper = paperOf({ w: img.w, h: img.h, px: img.px });
const gain = paper.map((v) => 255 / v);
for (let i = 0; i < px.length; i++) px[i] = Math.min(255, Math.round(px[i] * gain[i % 3]));
writeFileSync(dst, encode({ w, h, px }));
console.log(`${dst} ${w}x${h} paper=[${paper.join(",")}] gain=${gain.map((g) => g.toFixed(3)).join(",")}`);
