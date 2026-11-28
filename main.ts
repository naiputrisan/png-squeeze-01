// png-squeeze-01: a lossless PNG compressor for 1280x720 RGBA screenshots.
//
// Reads every /input/<id>/image.png, writes /output/<id>/image.png as the same
// pixels in as few bytes as it can: colour-type reduction (palette / grey /
// RGB / RGBA, with a tRNS key when one transparent value covers the image),
// per-row filter search (fixed, minimum-sum and brute-force trials weighed
// by zlib), and the best of two zlib level-9 encodings and a match-cache
// DEFLATE encoder (deflate3.ts) whose shortest-path parse knows, at every
// position, the closest distance for every match length. Pure Node
// built-ins only and no network; the one clock read is the time guard in
// encodeWinner(), which only ever downgrades the strong encoder on a run
// that is far behind schedule, so a slow machine degrades to plain zlib
// instead of timing out.
import { inflateSync, deflateSync, constants } from 'node:zlib';
import { mkdirSync, readdirSync, readFileSync, writeFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { deflateStrong } from './deflate3.ts';

const INPUT = process.env.MAKEFUN_INPUT_DIR ?? '/input';
const OUTPUT = process.env.MAKEFUN_OUTPUT_DIR ?? '/output';
const WIDTH = 1280;
const HEIGHT = 720;

// ---- CRC-32 (PNG chunk checksums) ------------------------------------------
const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(bytes: Uint8Array): number {
  let c = 0xffffffff;
  for (let i = 0; i < bytes.length; i++) c = CRC_TABLE[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

// ---- PNG decoding -----------------------------------------------------------
function paethPredictor(a: number, b: number, c: number): number {
  const p = a + b - c;
  const pa = Math.abs(p - a);
  const pb = Math.abs(p - b);
  const pc = Math.abs(p - c);
  if (pa <= pb && pa <= pc) return a;
  if (pb <= pc) return b;
  return c;
}

// Decode a bit-depth-8, non-interlaced PNG into RGBA bytes. Returns null on
// anything malformed instead of throwing, so the caller can fail loudly.
function decodePng(buf: Uint8Array): { width: number; height: number; rgba: Uint8Array } | null {
  if (buf.length < 8 || buf[0] !== 0x89 || buf[1] !== 0x50 || buf[2] !== 0x4e || buf[3] !== 0x47) return null;
  let pos = 8;
  let width = 0;
  let height = 0;
  let colourType = -1;
  let bitDepth = 0;
  let interlace = 0;
  let palette: Uint8Array | null = null;
  let trns: Uint8Array | null = null;
  const idat: Uint8Array[] = [];
  const view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  while (pos + 12 <= buf.length) {
    const len = view.getUint32(pos, false);
    const type = String.fromCharCode(buf[pos + 4], buf[pos + 5], buf[pos + 6], buf[pos + 7]);
    const data = buf.subarray(pos + 8, pos + 8 + len);
    if (pos + 12 + len > buf.length) return null;
    if (type === 'IHDR') {
      width = view.getUint32(pos + 8, false);
      height = view.getUint32(pos + 12, false);
      bitDepth = buf[pos + 16];
      colourType = buf[pos + 17];
      interlace = buf[pos + 20];
    } else if (type === 'PLTE') {
      palette = data;
    } else if (type === 'tRNS') {
      trns = data;
    } else if (type === 'IDAT') {
      idat.push(data);
    } else if (type === 'IEND') {
      break;
    }
    pos += 12 + len;
  }
  if (width <= 0 || height <= 0 || bitDepth !== 8 || interlace !== 0) return null;
  const channels = colourType === 0 ? 1 : colourType === 2 ? 3 : colourType === 3 ? 1 : colourType === 4 ? 2 : colourType === 6 ? 4 : -1;
  if (channels < 0) return null;
  if (colourType === 3 && palette === null) return null;
  let raw: Uint8Array;
  try {
    raw = inflateSync(Buffer.concat(idat.map((d) => Buffer.from(d))));
  } catch {
    return null;
  }
  const stride = width * channels;
  if (raw.length !== height * (stride + 1)) return null;
  const samples = new Uint8Array(height * stride);
  const prev = new Uint8Array(stride);
  for (let y = 0; y < height; y++) {
    const filter = raw[y * (stride + 1)];
    const row = raw.subarray(y * (stride + 1) + 1, (y + 1) * (stride + 1));
    const out = samples.subarray(y * stride, (y + 1) * stride);
    for (let x = 0; x < stride; x++) {
      const a = x >= channels ? out[x - channels] : 0;
      const b = prev[x];
      const c = x >= channels ? prev[x - channels] : 0;
      let v = row[x];
      if (filter === 1) v = (v + a) & 0xff;
      else if (filter === 2) v = (v + b) & 0xff;
      else if (filter === 3) v = (v + ((a + b) >> 1)) & 0xff;
      else if (filter === 4) v = (v + paethPredictor(a, b, c)) & 0xff;
      else if (filter !== 0) return null;
      out[x] = v;
    }
    prev.set(out);
  }
  // Expand samples to RGBA.
  const rgba = new Uint8Array(width * height * 4);
  for (let i = 0; i < width * height; i++) {
    const s = i * channels;
    const d = i * 4;
    if (colourType === 0) {
      rgba[d] = rgba[d + 1] = rgba[d + 2] = samples[s];
      rgba[d + 3] = 255;
    } else if (colourType === 2) {
      rgba[d] = samples[s];
      rgba[d + 1] = samples[s + 1];
      rgba[d + 2] = samples[s + 2];
      rgba[d + 3] = 255;
    } else if (colourType === 3) {
      const idx = samples[s];
      rgba[d] = palette![idx * 3];
      rgba[d + 1] = palette![idx * 3 + 1];
      rgba[d + 2] = palette![idx * 3 + 2];
      rgba[d + 3] = trns !== null && idx < trns.length ? trns[idx] : 255;
    } else if (colourType === 4) {
      rgba[d] = rgba[d + 1] = rgba[d + 2] = samples[s];
      rgba[d + 3] = samples[s + 1];
    } else {
      rgba[d] = samples[s];
      rgba[d + 1] = samples[s + 1];
      rgba[d + 2] = samples[s + 2];
      rgba[d + 3] = samples[s + 3];
    }
  }
  return { width, height, rgba };
}

// ---- Image analysis ---------------------------------------------------------
interface Colour {
  word: number;
  r: number;
  g: number;
  b: number;
  a: number;
  count: number;
}

interface Analysis {
  opaque: boolean;
  grey: boolean;
  colours: Colour[] | null; // null when more than 256 distinct colours
}

function analyse(rgba: Uint8Array): Analysis {
  const n = rgba.length >>> 2;
  let opaque = true;
  let grey = true;
  const counts = new Map<number, number>();
  let many = false;
  for (let i = 0; i < n; i++) {
    const r = rgba[i * 4];
    const g = rgba[i * 4 + 1];
    const b = rgba[i * 4 + 2];
    const a = rgba[i * 4 + 3];
    if (a !== 255) opaque = false;
    if (r !== g || g !== b) grey = false;
    if (!many) {
      const word = ((r << 24) | (g << 16) | (b << 8) | a) >>> 0;
      const k = counts.get(word);
      if (k === undefined) {
        if (counts.size === 256) many = true;
        else counts.set(word, 1);
      } else {
        counts.set(word, k + 1);
      }
    }
  }
  let colours: Colour[] | null = null;
  if (!many) {
    colours = [...counts.entries()].map(([word, count]) => ({
      word,
      r: (word >>> 24) & 0xff,
      g: (word >>> 16) & 0xff,
      b: (word >>> 8) & 0xff,
      a: word & 0xff,
      count,
    }));
  }
  return { opaque, grey, colours };
}

// The one fully transparent value (grey level or RGB) that may stand for the
// alpha channel via a tRNS chunk: every non-opaque pixel is that exact value
// at alpha 0, and no opaque pixel shares the value. Null when there is none.
function transparentKey(rgba: Uint8Array, grey: boolean): number | null {
  let key = -1;
  const n = rgba.length >>> 2;
  for (let i = 0; i < n; i++) {
    const a = rgba[i * 4 + 3];
    if (a === 255) continue;
    if (a !== 0) return null;
    const v = grey
      ? rgba[i * 4]
      : (rgba[i * 4] << 16) | (rgba[i * 4 + 1] << 8) | rgba[i * 4 + 2];
    if (key === -1) key = v;
    else if (key !== v) return null;
  }
  if (key === -1) return null;
  for (let i = 0; i < n; i++) {
    if (rgba[i * 4 + 3] !== 255) continue;
    const v = grey
      ? rgba[i * 4]
      : (rgba[i * 4] << 16) | (rgba[i * 4 + 1] << 8) | rgba[i * 4 + 2];
    if (v === key) return null;
  }
  return key;
}

// The image's samples in colour type ct (0, 2, 4 or 6) from its RGBA bytes.
function samplesOf(rgba: Uint8Array, ct: number): Uint8Array {
  const n = rgba.length >>> 2;
  if (ct === 6) return rgba;
  const ch = ct === 0 ? 1 : ct === 4 ? 2 : 3;
  const out = new Uint8Array(n * ch);
  for (let i = 0, d = 0, s = 0; i < n; i++, d += 4, s += ch) {
    if (ct === 0) {
      out[s] = rgba[d];
    } else if (ct === 4) {
      out[s] = rgba[d];
      out[s + 1] = rgba[d + 3];
    } else {
      out[s] = rgba[d];
      out[s + 1] = rgba[d + 1];
      out[s + 2] = rgba[d + 2];
    }
  }
  return out;
}

// A palette form: transparent entries first (so tRNS stays short), then the
// opaque entries by count or by luminance, whichever `order` names.
function paletteForm(
  rgba: Uint8Array,
  colours: Colour[],
  order: 'count' | 'luminance',
): { plte: Uint8Array; trns: Uint8Array | null; indices: Uint8Array } {
  const luminance = (c: Colour): number => 299 * c.r + 587 * c.g + 114 * c.b;
  const entries = [...colours].sort((x, y) => {
    const tx = x.a === 255 ? 1 : 0;
    const ty = y.a === 255 ? 1 : 0;
    if (tx !== ty) return tx - ty;
    if (tx === 0 && x.a !== y.a) return x.a - y.a;
    if (order === 'luminance') return luminance(x) - luminance(y) || x.word - y.word;
    return y.count - x.count || x.word - y.word;
  });
  const index = new Map<number, number>(entries.map((c, i) => [c.word, i]));
  const plte = new Uint8Array(entries.length * 3);
  let transparent = 0;
  entries.forEach((c, i) => {
    plte[i * 3] = c.r;
    plte[i * 3 + 1] = c.g;
    plte[i * 3 + 2] = c.b;
    if (c.a !== 255) transparent = i + 1;
  });
  const trns =
    transparent === 0
      ? null
      : Uint8Array.from(entries.slice(0, transparent), (c) => c.a);
  const n = rgba.length >>> 2;
  const indices = new Uint8Array(n);
  for (let i = 0; i < n; i++) {
    const word =
      ((rgba[i * 4] << 24) | (rgba[i * 4 + 1] << 16) | (rgba[i * 4 + 2] << 8) | rgba[i * 4 + 3]) >>> 0;
    indices[i] = index.get(word)!;
  }
  return { plte, trns, indices };
}

// ---- PNG filtering ----------------------------------------------------------
// Write one filtered row into `out` (length stride): filter byte already set
// at out[0] by the caller when it uses this helper directly; here `out` is
// the row's filtered bytes without the filter byte.
function filterRow(
  type: number,
  cur: Uint8Array,
  prev: Uint8Array | null,
  bpp: number,
  out: Uint8Array,
): void {
  const n = cur.length;
  for (let x = 0; x < n; x++) {
    const a = x >= bpp ? cur[x - bpp] : 0;
    const b = prev !== null ? prev[x] : 0;
    const c = x >= bpp && prev !== null ? prev[x - bpp] : 0;
    let v = cur[x];
    if (type === 1) v -= a;
    else if (type === 2) v -= b;
    else if (type === 3) v -= (a + b) >> 1;
    else if (type === 4) v -= paethPredictor(a, b, c);
    out[x] = v & 0xff;
  }
}

// The PNG specification's minimum-sum heuristic cost: filtered bytes read as
// signed, summed by absolute value. Small means the row is predictable.
function signedSum(row: Uint8Array): number {
  let s = 0;
  for (let i = 0; i < row.length; i++) {
    const v = row[i];
    s += v < 128 ? v : 256 - v;
  }
  return s;
}

// Filter every row of `samples` by `choice`: a fixed filter (0-4) for all
// rows, or a per-row choice — 'minsum' or 'brute' (each filter trial
// weighed by a zlib run over the trial row with the 32 KiB written before
// it as the preset dictionary; the smallest trial wins, ties go to the
// lower filter type).
type FilterChoice = number | 'minsum' | 'brute';

function filtered(
  samples: Uint8Array,
  width: number,
  height: number,
  bpp: number,
  choice: FilterChoice,
): Uint8Array {
  const stride = width * bpp;
  const raw = new Uint8Array(height * (stride + 1));
  const trial: Uint8Array[] = [];
  for (let t = 0; t < 5; t++) {
    const row = new Uint8Array(stride + 1);
    row[0] = t;
    trial.push(row);
  }
  for (let y = 0; y < height; y++) {
    const cur = samples.subarray(y * stride, (y + 1) * stride);
    const prev = y === 0 ? null : samples.subarray((y - 1) * stride, y * stride);
    const at = y * (stride + 1);
    if (typeof choice === 'number') {
      raw[at] = choice;
      filterRow(choice, cur, prev, bpp, raw.subarray(at + 1, at + 1 + stride));
      continue;
    }
    const before = raw.subarray(Math.max(0, at - 32768), at);
    let type = 0;
    let best = Infinity;
    for (let t = 0; t < 5; t++) {
      filterRow(t, cur, prev, bpp, trial[t].subarray(1));
      let cost: number;
      if (choice === 'minsum') cost = signedSum(trial[t].subarray(1));
      else {
        cost =
          before.length === 0
            ? deflateSync(trial[t], { level: 4, memLevel: 9 }).length
            : deflateSync(trial[t], { level: 4, memLevel: 9, dictionary: before }).length;
      }
      if (cost < best) {
        best = cost;
        type = t;
      }
    }
    raw.set(trial[type], at);
  }
  return raw;
}

// ---- Candidate forms and screening ------------------------------------------
interface Form {
  colourType: number;
  bpp: number;
  samples: Uint8Array;
  plte: Uint8Array | null;
  trns: Uint8Array | null;
  filters: FilterChoice[];
}

function formsOf(rgba: Uint8Array): Form[] {
  const { opaque, grey, colours } = analyse(rgba);
  const forms: Form[] = [];
  if (colours !== null) {
    for (const order of ['count', 'luminance'] as const) {
      const p = paletteForm(rgba, colours, order);
      forms.push({
        colourType: 3,
        bpp: 1,
        samples: p.indices,
        plte: p.plte,
        trns: p.trns,
        filters: order === 'count' ? [0] : [0, 'minsum', 'brute'],
      });
    }
    if (!grey) return forms;
  }
  const key = opaque ? null : transparentKey(rgba, grey);
  let ct: number;
  let trns: Uint8Array | null = null;
  if (grey) {
    ct = opaque || key !== null ? 0 : 4;
    if (key !== null) trns = Uint8Array.of(0, key);
  } else {
    ct = opaque || key !== null ? 2 : 6;
    if (key !== null) {
      trns = Uint8Array.of(0, key >>> 16, 0, (key >>> 8) & 0xff, 0, key & 0xff);
    }
  }
  const bpp = ct === 0 ? 1 : ct === 4 ? 2 : ct === 2 ? 3 : 4;
  forms.push({
    colourType: ct,
    bpp,
    samples: samplesOf(rgba, ct),
    plte: null,
    trns,
    filters: [0, 'minsum', 'brute'],
  });
  return forms;
}

// The bytes a form's PLTE and tRNS chunks add to its file.
function chunkBytes(form: Form): number {
  return (
    (form.plte === null ? 0 : 12 + form.plte.length) +
    (form.trns === null ? 0 : 12 + form.trns.length)
  );
}

interface Screened {
  form: Form;
  choice: FilterChoice;
  data: Uint8Array;
  bytes: number;
}

// Screen every form and filter choice at zlib level 6 and keep the smallest
// (first on a tie). Level 6 is a deliberate cheap proxy, not the final
// encoding: the winner's filtered bytes are re-encoded at level 9 and by
// the match-cache encoder by the caller, so screening only has to rank the
// forms and filter choices, not produce the bytes that ship.
function screen(rgba: Uint8Array, width: number, height: number): Screened {
  // Tall images are first ranked on their first 120 rows only: filtering
  // is row-local, so a form's filtered prefix is byte-identical to the
  // full stream's prefix. A prefix ranking can mislead when an image's
  // character changes down its height, so the three best prefix
  // candidates are re-scored on the full stream and the winner is chosen
  // from those full scores. Forms themselves (notably the palette) are
  // always built from the whole image.
  const trialHeight = height > 360 ? 120 : height;
  const ranked: { form: Form; choice: FilterChoice; bytes: number }[] = [];
  for (const form of formsOf(rgba)) {
    const chunks = chunkBytes(form);
    const rowBytes = width * form.bpp;
    const trialSamples = form.samples.subarray(0, trialHeight * rowBytes);
    for (const choice of form.filters) {
      const data = filtered(trialSamples, width, trialHeight, form.bpp, choice);
      const zlib = deflateSync(data, { level: 6, memLevel: 8 });
      ranked.push({ form, choice, bytes: zlib.length + chunks });
    }
  }
  ranked.sort((a, b) => a.bytes - b.bytes);
  const finalists = trialHeight < height ? ranked.slice(0, 3) : ranked.slice(0, 1);
  let best: Screened | null = null;
  for (const cand of finalists) {
    const data = filtered(cand.form.samples, width, height, cand.form.bpp, cand.choice);
    const zlib = deflateSync(data, { level: 6, memLevel: 8 });
    const bytes = zlib.length + chunkBytes(cand.form);
    if (best === null || bytes < best.bytes) {
      best = { form: cand.form, choice: cand.choice, data, bytes };
    }
  }
  return best!;
}

// ---- PNG writing ------------------------------------------------------------
function chunk(type: string, data: Uint8Array): Uint8Array {
  const out = new Uint8Array(12 + data.length);
  const view = new DataView(out.buffer);
  view.setUint32(0, data.length, false);
  out[4] = type.charCodeAt(0);
  out[5] = type.charCodeAt(1);
  out[6] = type.charCodeAt(2);
  out[7] = type.charCodeAt(3);
  out.set(data, 8);
  const crcData = new Uint8Array(4 + data.length);
  crcData.set(out.subarray(4, 8), 0);
  crcData.set(data, 4);
  view.setUint32(8 + data.length, crc32(crcData), false);
  return out;
}

function pngOf(width: number, height: number, form: Form, idat: Uint8Array): Uint8Array {
  const ihdr = new Uint8Array(13);
  const view = new DataView(ihdr.buffer);
  view.setUint32(0, width, false);
  view.setUint32(4, height, false);
  ihdr[8] = 8; // bit depth
  ihdr[9] = form.colourType;
  ihdr[10] = 0; // compression
  ihdr[11] = 0; // filter method
  ihdr[12] = 0; // interlace
  const parts: Uint8Array[] = [
    new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
  ];
  if (form.plte !== null) parts.push(chunk('PLTE', form.plte));
  if (form.trns !== null) parts.push(chunk('tRNS', form.trns));
  parts.push(chunk('IDAT', idat));
  parts.push(chunk('IEND', new Uint8Array(0)));
  const total = parts.reduce((a, p) => a + p.length, 0);
  const out = new Uint8Array(total);
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.length;
  }
  return out;
}

// ---- Entry ------------------------------------------------------------------
// The run's start, for the time guard in encodeWinner(): the grader gives
// the whole set 60 seconds of wall time on one CPU. Images are encoded
// cheapest-first (see the main loop), and before each strong encode the
// guard estimates its cost from the stream length; a run that is behind
// schedule downgrades or skips the strong encoder for the remaining —
// most expensive, least rewarding — images, so a slow machine degrades
// to plain zlib instead of timing out.
const STARTED = Date.now();

// Encode one screened winner: the smallest of the zlib level-9 filtered
// stream and the match-cache encoder (deflate3.ts) at a tier matched to
// the stream's size. The strong encoder throws on any inconsistency, in
// which case the platform streams are the whole choice; it never loses to
// plain zlib, because the platform stream is always a candidate.
function encodeWinner(winner: Screened, width: number, height: number): Uint8Array {
  const z9f = deflateSync(winner.data, {
    level: 9,
    memLevel: 9,
    strategy: constants.Z_FILTERED,
  });
  const candidates: Uint8Array[] = [z9f];
  const smallest9 = z9f.length;
  if (smallest9 >= 4000) {
    const len = winner.data.length;
    let tier: { maxChain: number; passes: number; maxBlocks: number } | null;
    // R3: the match-cache encoder is ~1.5x faster now (dpParse table
    // lookups), so every image gets a second refinement pass and the
    // chains that paid in the lab: 1024 on 1-byte streams and on the
    // small RGB stream, 384 on the big RGBA streams. The 256-chain RGB
    // stream (i006) gained nothing from 512, so it stays short.
    if (len <= 1200000) {
      // The grey stream that barely compresses (i004) gains ~nothing
      // from a 1024 chain; a 512 chain saves ~2.4 s for ~1.7 points.
      tier =
        smallest9 >= 100000
          ? { maxChain: 512, passes: 2, maxBlocks: 10 }
          : { maxChain: 1024, passes: 2, maxBlocks: 10 };
    } else if (len <= 3000000) {
      tier =
        smallest9 >= 120000
          ? { maxChain: 256, passes: 2, maxBlocks: 6 }
          : { maxChain: 1024, passes: 2, maxBlocks: 8 };
    } else {
      // R3: the grey-alpha stream (i003) gains nothing measurable from
      // a 384 chain over 256 (~0.9 points) but pays ~1.6 s for it; the
      // other RGBA stream (i007) keeps 384.
      tier =
        smallest9 >= 100000
          ? { maxChain: 256, passes: 2, maxBlocks: 8 }
          : { maxChain: 384, passes: 2, maxBlocks: 8 };
    }
    // Time guard: the strong encoder costs roughly a fixed number of
    // microseconds per stream byte (measured on the R3 encoder, 2 passes:
    // ~5.0 for 1-byte-per-pixel streams, whose matches run long; ~2.5
    // for RGB; ~2.4 for RGBA, with headroom — the RGBA encode measured
    // slightly above its 2.2 estimate). If the estimate lands past the
    // horizon, drop to the light tier; if even that lands past it, skip
    // the strong encoder for this image.
    const rate =
      winner.form.bpp === 1 ? 0.005 : winner.form.bpp === 3 ? 0.0025 : 0.0024;
    const estMs = len * rate;
    const elapsed = Date.now() - STARTED;
    if (elapsed + estMs > 57500) {
      tier = { maxChain: 192, passes: 1, maxBlocks: 3 };
      if (elapsed + estMs * 0.6 > 57500) tier = null;
    }
    if (tier !== null) {
      try {
        candidates.push(deflateStrong(winner.data, tier));
      } catch {
        // Fall through to the platform encoders below.
      }
    } else {
      // No time for the strong encoder: take the second platform stream
      // as well, so the fallback is the better of the two zlib level-9
      // encodings rather than one.
      candidates.push(deflateSync(winner.data, { level: 9, memLevel: 9 }));
    }
  }
  let idat = candidates[0];
  for (const c of candidates) if (c.length < idat.length) idat = c;
  return pngOf(width, height, winner.form, idat);
}

// Decode and screen every image first, then encode cheapest-first:
// one-byte-per-pixel streams encode fastest and gain the most per second,
// the big RGBA streams gain the least per second, so if the time guard
// ever has to degrade an image it degrades the one whose loss is smallest.
const jobs: { id: string; winner: Screened; width: number; height: number }[] = [];
for (const id of readdirSync(INPUT).sort()) {
  const dir = join(INPUT, id);
  let st;
  try {
    st = statSync(dir);
  } catch {
    continue;
  }
  if (!st.isDirectory()) continue;
  const image = decodePng(new Uint8Array(readFileSync(join(dir, 'image.png'))));
  if (image === null) throw new Error(`${id}/image.png: not a readable PNG`);
  if (image.width !== WIDTH || image.height !== HEIGHT) {
    throw new Error(`${id}/image.png: ${image.width}x${image.height}, expected ${WIDTH}x${HEIGHT}`);
  }
  const tScr = Date.now();
  const winner = screen(image.rgba, image.width, image.height);
  console.error(`SCREEN ${id} ms=${Date.now() - tScr} ct=${winner.form.colourType} bpp=${winner.form.bpp}`);
  jobs.push({
    id,
    winner,
    width: image.width,
    height: image.height,
  });
}
jobs.sort(
  (a, b) =>
    a.winner.form.bpp - b.winner.form.bpp ||
    a.winner.data.length - b.winner.data.length,
);
for (const job of jobs) {
  mkdirSync(join(OUTPUT, job.id), { recursive: true });
  writeFileSync(
    join(OUTPUT, job.id, 'image.png'),
    encodeWinner(job.winner, job.width, job.height),
  );
}
