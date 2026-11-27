// A stronger DEFLATE encoder for deflateStrong(): a match cache built once
// per stream (the Pareto frontier of (length, distance) pairs at every
// position, from a deep hash-chain walk), a shortest-path parse over that
// cache under a Huffman cost model with refinement passes, and emission as
// one or more blocks, each block dynamic- or fixed-Huffman, whichever is
// smaller. Written from the DEFLATE format itself (RFC 1951); no code is
// shared with any library. Returns a complete zlib stream (RFC 1950).
// Throws on any internal inconsistency, so the caller can fall back to the
// platform zlib instead.

// ---- DEFLATE tables ---------------------------------------------------------
// Length symbol 257..285: base length and extra bits.
const LEN_BASE = [
  3, 4, 5, 6, 7, 8, 9, 10, 11, 13, 15, 17, 19, 23, 27, 31, 35, 43, 51, 59, 67, 83, 99, 115,
  131, 163, 195, 227, 258,
];
const LEN_EXTRA = [
  0, 0, 0, 0, 0, 0, 0, 0, 1, 1, 1, 1, 2, 2, 2, 2, 3, 3, 3, 3, 4, 4, 4, 4, 5, 5, 5, 5, 0,
];
// Lengths at which the length symbol changes (plus 258 itself).
const LEN_STEPS = [
  3, 4, 5, 6, 7, 8, 9, 10, 11, 13, 15, 17, 19, 23, 27, 31, 35, 43, 51, 59, 67, 83, 99, 115,
  131, 163, 195, 227, 258,
];
// Distance symbol 0..29: base distance and extra bits.
const DIST_BASE = [
  1, 2, 3, 4, 5, 7, 9, 13, 17, 25, 33, 49, 65, 97, 129, 193, 257, 385, 513, 769, 1025, 1537,
  2049, 3073, 4097, 6145, 8193, 12289, 16385, 24577,
];
const DIST_EXTRA = [
  0, 0, 0, 0, 1, 1, 2, 2, 3, 3, 4, 4, 5, 5, 6, 6, 7, 7, 8, 8, 9, 9, 10, 10, 11, 11, 12, 12,
  13, 13,
];

function lenSymbolOf(len: number): number {
  for (let s = 0; s < 29; s++) {
    const next = s === 28 ? 259 : LEN_BASE[s + 1];
    if (len < next) return 257 + s;
  }
  return 285;
}

function distSymbolOf(dist: number): number {
  for (let s = 0; s < 30; s++) {
    const next = s === 29 ? 32769 : DIST_BASE[s + 1];
    if (dist < next) return s;
  }
  return 29;
}

// ---- Huffman codes ----------------------------------------------------------
const MAX_BITS = 15;

// Build canonical Huffman code lengths from symbol frequencies, capped at
// maxBits. Returns lengths (0 = unused). The overflow redistribution keeps
// the code valid; the caller verifies the Kraft sum before emitting.
function huffmanLengths(freq: Uint32Array | number[], maxBits: number): Uint8Array {
  const n = freq.length;
  const lengths = new Uint8Array(n);
  // A binary heap of (frequency, node id). Leaves are symbol ids; internal
  // nodes get ids from n upward, with their frequencies kept in nodeFreq.
  const heapFreq: number[] = [];
  const heapSym: number[] = [];
  const nodeFreq: number[] = [];
  const push = (f: number, s: number): void => {
    heapFreq.push(f);
    heapSym.push(s);
    let i = heapFreq.length - 1;
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (heapFreq[p] <= heapFreq[i]) break;
      [heapFreq[p], heapFreq[i]] = [heapFreq[i], heapFreq[p]];
      [heapSym[p], heapSym[i]] = [heapSym[i], heapSym[p]];
      i = p;
    }
  };
  const pop = (): { sym: number; freq: number } => {
    const topSym = heapSym[0];
    const topFreq = heapFreq[0];
    const lastF = heapFreq.pop()!;
    const lastS = heapSym.pop()!;
    if (heapFreq.length > 0) {
      heapFreq[0] = lastF;
      heapSym[0] = lastS;
      let i = 0;
      for (;;) {
        const l = i * 2 + 1;
        const r = l + 1;
        let m = i;
        if (l < heapFreq.length && heapFreq[l] < heapFreq[m]) m = l;
        if (r < heapFreq.length && heapFreq[r] < heapFreq[m]) m = r;
        if (m === i) break;
        [heapFreq[m], heapFreq[i]] = [heapFreq[i], heapFreq[m]];
        [heapSym[m], heapSym[i]] = [heapSym[i], heapSym[m]];
        i = m;
      }
    }
    return { sym: topSym, freq: topFreq };
  };
  let used = 0;
  for (let s = 0; s < n; s++) {
    if (freq[s] > 0) {
      nodeFreq[s] = freq[s];
      push(freq[s], s);
      used++;
    }
  }
  if (used === 0) return lengths;
  if (used === 1) {
    // A single symbol still needs a one-bit code.
    lengths[heapSym[0]] = 1;
    return lengths;
  }
  let nextNode = n;
  const left: number[] = [];
  const right: number[] = [];
  while (heapFreq.length > 1) {
    const a = pop();
    const b = pop();
    left[nextNode] = a.sym;
    right[nextNode] = b.sym;
    nodeFreq[nextNode] = a.freq + b.freq;
    push(a.freq + b.freq, nextNode);
    nextNode++;
  }
  const root = pop().sym;
  // Depths by walking the tree.
  const stack: [number, number][] = [[root, 0]];
  while (stack.length > 0) {
    const [node, d] = stack.pop()!;
    if (node < n) {
      lengths[node] = d;
    } else {
      stack.push([left[node], d + 1]);
      stack.push([right[node], d + 1]);
    }
  }
  // Cap lengths at maxBits: clamp the too-long ones, then repair the Kraft
  // sum (which clamping may push over 1) by lengthening the least
  // frequent code that still has room, until the sum is back under 1.
  let kraft = 0;
  for (let s = 0; s < n; s++) {
    if (lengths[s] > maxBits) lengths[s] = maxBits;
    if (lengths[s] > 0) kraft += 2 ** -lengths[s];
  }
  while (kraft > 1) {
    let pick = -1;
    for (let s = 0; s < n; s++) {
      if (freq[s] === 0 || lengths[s] === 0 || lengths[s] >= maxBits) continue;
      if (
        pick === -1 ||
        freq[s] < freq[pick] ||
        (freq[s] === freq[pick] && lengths[s] > lengths[pick])
      ) {
        pick = s;
      }
    }
    if (pick === -1) throw new Error('huffman: cannot limit lengths');
    kraft -= 2 ** -(lengths[pick] + 1);
    lengths[pick]++;
  }
  // Reassign lengths from the corrected counts: the most frequent symbols
  // keep the shortest lengths.
  const blCount = new Int32Array(maxBits + 1);
  for (let s = 0; s < n; s++) if (lengths[s] > 0) blCount[lengths[s]]++;
  const order = [...Array(n).keys()]
    .filter((s) => freq[s] > 0)
    .sort((a, b) => freq[b] - freq[a] || a - b);
  let at = 0;
  for (let bits = 1; bits <= maxBits; bits++) {
    for (let k = 0; k < blCount[bits]; k++) {
      if (at >= order.length) throw new Error('huffman: length assignment overflow');
      lengths[order[at++]] = bits;
    }
  }
  return lengths;
}

// Canonical codes from lengths. Huffman codes are packed most-significant
// bit first, so each code is stored bit-reversed for the LSB-first writer.
function canonicalCodes(lengths: Uint8Array): Uint32Array {
  const max = Math.max(0, ...lengths);
  const blCount = new Int32Array(max + 1);
  for (const l of lengths) if (l > 0) blCount[l]++;
  const nextCode = new Int32Array(max + 1);
  let code = 0;
  for (let bits = 1; bits <= max; bits++) {
    code = (code + blCount[bits - 1]) << 1;
    nextCode[bits] = code;
  }
  const codes = new Uint32Array(lengths.length);
  for (let s = 0; s < lengths.length; s++) {
    const l = lengths[s];
    if (l > 0) {
      let c = nextCode[l]++;
      let reversed = 0;
      for (let i = 0; i < l; i++) {
        reversed = (reversed << 1) | ((c >> i) & 1);
      }
      codes[s] = reversed;
    }
  }
  return codes;
}

// ---- Bit writer -------------------------------------------------------------
class BitWriter {
  bytes: number[] = [];
  private bitBuf = 0;
  private bitLen = 0;

  write(code: number, len: number): void {
    this.bitBuf |= code << this.bitLen;
    this.bitLen += len;
    while (this.bitLen >= 8) {
      this.bytes.push(this.bitBuf & 0xff);
      this.bitBuf >>>= 8;
      this.bitLen -= 8;
    }
  }

  align(): void {
    if (this.bitLen > 0) {
      this.bytes.push(this.bitBuf & 0xff);
      this.bitBuf = 0;
      this.bitLen = 0;
    }
  }
}

function adler32(data: Uint8Array): number {
  let a = 1;
  let b = 0;
  for (let i = 0; i < data.length; i++) {
    a = (a + data[i]) % 65521;
    b = (b + a) % 65521;
  }
  return ((b << 16) | a) >>> 0;
}

// ---- LZ77 match search ------------------------------------------------------
// Hash chains over 3-byte sequences. MAX_CHAIN bounds the work (and so the
// wall time) at every position; the chain is walked newest-first, so the
// first hit is the closest candidate.
const HASH_BITS = 15;
const HASH_SIZE = 1 << HASH_BITS;
const HASH_MASK = HASH_SIZE - 1;
const MIN_MATCH = 3;
const MAX_MATCH = 258;
const WINDOW = 32768;
const MAX_CHAIN = 128;

function hash3(data: Uint8Array, i: number): number {
  return ((data[i] << 10) ^ (data[i + 1] << 5) ^ data[i + 2]) & HASH_MASK;
}

interface Match {
  len: number;
  dist: number;
}

// The longest match at position i (len 0 when none), plus, when different
// and `second` is set, the closest match of length >= 3. `head`/`prev` hold
// the chains of all positions before i; callers insert each position after
// processing it. The walk stops after `maxChain` candidates, or as soon as
// a match of length >= `earlyLen` is found (a long match near the front of
// the chain is rarely beaten by a later candidate).
function findMatches(
  data: Uint8Array,
  i: number,
  head: Int32Array,
  prev: Int32Array,
  maxChain = MAX_CHAIN,
  earlyLen = Infinity,
  second = true,
): Match[] {
  const n = data.length;
  const out: Match[] = [];
  if (i + MIN_MATCH > n) return out;
  const h = hash3(data, i);
  let j = head[h];
  let bestLen = 0;
  let bestDist = 0;
  let firstLen = 0;
  let firstDist = 0;
  let chain = 0;
  const maxLen = Math.min(MAX_MATCH, n - i);
  const earliest = i - WINDOW;
  while (j >= earliest && j >= 0 && chain < maxChain) {
    chain++;
    // Quick rejection: the byte past the current best length must match,
    // else this candidate cannot beat it.
    if (bestLen < maxLen && data[j + bestLen] !== data[i + bestLen]) {
      j = prev[j];
      continue;
    }
    let len = 0;
    while (len < maxLen && data[j + len] === data[i + len]) len++;
    if (len >= MIN_MATCH) {
      if (firstLen === 0) {
        firstLen = len;
        firstDist = i - j;
      }
      if (len > bestLen) {
        bestLen = len;
        bestDist = i - j;
        if (len === maxLen || len >= earlyLen) break;
      }
    }
    j = prev[j];
  }
  if (bestLen >= MIN_MATCH) {
    out.push({ len: bestLen, dist: bestDist });
    if (second && firstDist !== 0 && firstDist !== bestDist) {
      out.push({ len: firstLen, dist: firstDist });
    }
  }
  return out;
}

// ---- Tokenisation -----------------------------------------------------------
// A token is a literal byte, or a (length, distance) match.
interface Token {
  lit: number; // literal byte, or -1 for a match
  len: number;
  dist: number;
}

// Greedy longest-match parse, used only to seed the first Huffman costs.
function greedyParse(data: Uint8Array): Token[] {
  const n = data.length;
  const head = new Int32Array(HASH_SIZE).fill(-1);
  const prev = new Int32Array(n);
  const tokens: Token[] = [];
  let i = 0;
  while (i < n) {
    let token: Token | null = null;
    if (i + MIN_MATCH <= n) {
      const matches = findMatches(data, i, head, prev);
      if (matches.length > 0) {
        token = { lit: -1, len: matches[0].len, dist: matches[0].dist };
      }
    }
    if (token === null) token = { lit: data[i], len: 0, dist: 0 };
    tokens.push(token);
    const step = token.lit === -1 ? token.len : 1;
    for (let k = 0; k < step; k++) {
      if (i + k + 2 < n) {
        const h = hash3(data, i + k);
        prev[i + k] = head[h];
        head[h] = i + k;
      }
    }
    i += step;
  }
  return tokens;
}

function tokenFrequencies(tokens: Token[]): { litFreq: Uint32Array; distFreq: Uint32Array } {
  const litFreq = new Uint32Array(286);
  const distFreq = new Uint32Array(30);
  for (const t of tokens) {
    if (t.lit >= 0) litFreq[t.lit]++;
    else {
      litFreq[lenSymbolOf(t.len)]++;
      distFreq[distSymbolOf(t.dist)]++;
    }
  }
  litFreq[256]++; // end of block
  return { litFreq, distFreq };
}

// The shortest-path parse under the given code lengths. At each position the
// choices are the literal, or, for each match found, the lengths at which
// the length symbol changes (plus the match's own length). Backpointers are
// kept per target position, so the reconstruction follows the cheapest path
// exactly. Returns the tokens of the cheapest path.


// ---- Emission ---------------------------------------------------------------
// The code-length alphabet's fixed order (RFC 1951 section 3.2.7).
const CL_ORDER = [16, 17, 18, 0, 8, 7, 9, 6, 10, 5, 11, 4, 12, 3, 13, 2, 14, 1, 15];

// Run-length encode the literal/length + distance code lengths into the
// code-length alphabet (symbols 0-18 with extra bits for 16/17/18).
function encodeLengths(lengths: Uint8Array): { symbols: number[]; extras: number[] } {
  const symbols: number[] = [];
  const extras: number[] = [];
  let i = 0;
  while (i < lengths.length) {
    const v = lengths[i];
    let run = 1;
    while (i + run < lengths.length && lengths[i + run] === v) run++;
    const total = run;
    if (v === 0) {
      let left = run;
      while (left >= 11) {
        const take = Math.min(left, 138);
        symbols.push(18);
        extras.push(take - 11);
        left -= take;
      }
      if (left >= 3) {
        symbols.push(17);
        extras.push(left - 3);
        left = 0;
      }
      while (left > 0) {
        symbols.push(0);
        extras.push(0);
        left--;
      }
    } else {
      symbols.push(v);
      extras.push(0);
      let left = run - 1;
      while (left >= 3) {
        const take = Math.min(left, 6);
        symbols.push(16);
        extras.push(take - 3);
        left -= take;
      }
      while (left > 0) {
        symbols.push(v);
        extras.push(0);
        left--;
      }
    }
    i += total;
  }
  return { symbols, extras };
}

function checkKraft(lengths: Uint8Array): void {
  let sum = 0;
  for (const l of lengths) if (l > 0) sum += 2 ** -l;
  if (sum > 1 + 1e-9) throw new Error('huffman: over-subscribed code');
}

// Emit the tokens as one dynamic-Huffman block (BFINAL=1, BTYPE=10).


// ---- Entry point ------------------------------------------------------------


// ---- Block splitting --------------------------------------------------------
// The bit cost of emitting `tokens` as ONE dynamic block, computed with the
// same accounting emitDynamic performs (header + code-length section +
// tokens + end-of-block), without writing any bits.
export function blockCostBits(tokens: Token[]): number {
  const { litFreq, distFreq } = tokenFrequencies(tokens);
  const litLen = huffmanLengths(litFreq, MAX_BITS);
  const distLen = huffmanLengths(distFreq, MAX_BITS);
  let hlit = 286;
  while (hlit > 257 && litLen[hlit - 1] === 0) hlit--;
  let hdist = 30;
  while (hdist > 1 && distLen[hdist - 1] === 0) hdist--;
  const allLengths = new Uint8Array(hlit + hdist);
  allLengths.set(litLen.subarray(0, hlit), 0);
  allLengths.set(distLen.subarray(0, hdist), hlit);
  const { symbols, extras } = encodeLengths(allLengths);
  const clFreq = new Uint32Array(19);
  for (const s of symbols) clFreq[s]++;
  const clLen = huffmanLengths(clFreq, 7);
  let hclen = 19;
  while (hclen > 4 && clLen[CL_ORDER[hclen - 1]] === 0) hclen--;
  let bits = 3 + 5 + 5 + 4 + 3 * hclen;
  for (let k = 0; k < symbols.length; k++) {
    const s = symbols[k];
    bits += clLen[s];
    if (s === 16) bits += 2;
    else if (s === 17) bits += 3;
    else if (s === 18) bits += 7;
  }
  for (const t of tokens) {
    if (t.lit >= 0) bits += litLen[t.lit];
    else {
      const lsym = lenSymbolOf(t.len);
      bits += litLen[lsym] + LEN_EXTRA[lsym - 257];
      const dsym = distSymbolOf(t.dist);
      bits += distLen[dsym] + DIST_EXTRA[dsym];
    }
  }
  bits += litLen[256];
  return bits;
}

// Emit tokens as a sequence of dynamic blocks; `splits` are token indices
// where a new block starts (ascending, each in (0, tokens.length)).


// Choose block split points (token indices) greedily: start from one block,
// repeatedly add the candidate split that most reduces the analytic total
// cost, up to maxBlocks blocks. Candidates are token indices nearest to a
// set of input-byte positions: uniform fractions plus positions where the
// local literal histogram changes most between adjacent windows.
export function chooseSplits(tokens: Token[], dataLen: number, maxBlocks: number): number[] {
  // Token end offsets in the input.
  const ends = new Int32Array(tokens.length);
  let pos = 0;
  for (let i = 0; i < tokens.length; i++) {
    pos += tokens[i].lit >= 0 ? 1 : tokens[i].len;
    ends[i] = pos;
  }
  const tokenAt = (bytePos: number): number => {
    let lo = 0, hi = tokens.length - 1, ans = tokens.length - 1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (ends[mid] >= bytePos) { ans = mid; hi = mid - 1; } else lo = mid + 1;
    }
    return ans;
  };
  const cand = new Set<number>();
  for (const f of [0.2, 0.25, 0.33, 0.4, 0.5, 0.6, 0.67, 0.75, 0.8]) {
    const t = tokenAt(Math.floor(dataLen * f));
    if (t > 0 && t < tokens.length) cand.add(t);
  }
  // Histogram-change candidates: windows of ~1/24 of the tokens; distance
  // between adjacent windows' literal/length symbol histograms.
  const W = 24;
  const win = Math.max(1, Math.floor(tokens.length / W));
  const hist: number[][] = [];
  for (let wI = 0; wI < W; wI++) {
    const h = new Array(286).fill(0);
    const from = wI * win;
    const to = Math.min(tokens.length, from + win);
    for (let i = from; i < to; i++) {
      const t = tokens[i];
      h[t.lit >= 0 ? t.lit : lenSymbolOf(t.len)]++;
    }
    hist.push(h);
  }
  const changes: { at: number; d: number }[] = [];
  for (let wI = 0; wI + 1 < W; wI++) {
    let d = 0;
    for (let s = 0; s < 286; s++) d += Math.abs(hist[wI][s] - hist[wI + 1][s]);
    changes.push({ at: (wI + 1) * win, d });
  }
  changes.sort((a, b) => b.d - a.d);
  for (const c of changes.slice(0, 8)) if (c.at > 0 && c.at < tokens.length) cand.add(c.at);
  const candidates = [...cand].sort((a, b) => a - b);
  let splits: number[] = [];
  const totalCost = (sp: number[]): number => {
    const bounds = [0, ...sp, tokens.length];
    let sum = 0;
    for (let b = 0; b + 1 < bounds.length; b++) sum += blockCostBits(tokens.slice(bounds[b], bounds[b + 1]));
    return sum;
  };
  let best = totalCost(splits);
  while (splits.length + 1 < maxBlocks) {
    let bestGain = 0;
    let bestSplit = -1;
    let bestCost = best;
    for (const c of candidates) {
      if (splits.includes(c)) continue;
      const trial = [...splits, c].sort((a, b) => a - b);
      const cost = totalCost(trial);
      if (best - cost > bestGain) { bestGain = best - cost; bestSplit = c; bestCost = cost; }
    }
    if (bestSplit < 0) break;
    splits = [...splits, bestSplit].sort((a, b) => a - b);
    best = bestCost;
  }
  return splits;
}

// ---- deflate3: match cache + multi-pass DP ---------------------------------
// Zopfli's structural advantage over a plain optimal parser: at each
// position it knows, for EVERY match length, a distance achieving it (its
// sublen cache), so the shortest path can pick a shorter match at a closer
// distance when that is cheaper. A per-position match search returns at
// most a couple of (len, dist) pairs; the cache below stores the Pareto
// frontier of the chain walk instead: up to
// CACHE_K candidates per position with strictly increasing lengths (each is
// the closest distance achieving any length above the previous candidate's).
// The cache is built once; the DP passes then run over it without redoing
// any match search, which makes extra refinement passes affordable.

const CACHE_K = 4;

// Flat candidate storage: candLen/candDist hold CACHE_K slots per position.
interface MatchCache {
  count: Uint8Array;
  len: Uint16Array;
  dist: Int32Array;
}

function buildCache(data: Uint8Array, maxChain: number): MatchCache {
  const n = data.length;
  const count = new Uint8Array(n);
  const len = new Uint16Array(n * CACHE_K);
  const dist = new Int32Array(n * CACHE_K);
  const head = new Int32Array(HASH_SIZE).fill(-1);
  const prev = new Int32Array(n);
  for (let i = 0; i < n; i++) {
    if (i + MIN_MATCH <= n) {
      const h = hash3(data, i);
      let j = head[h];
      const maxLen = Math.min(MAX_MATCH, n - i);
      const earliest = i - WINDOW;
      let chain = 0;
      let bestLen = 0;
      const base = i * CACHE_K;
      let k = 0;
      while (j >= earliest && j >= 0 && chain < maxChain) {
        chain++;
        if (bestLen < maxLen && data[j + bestLen] !== data[i + bestLen]) {
          j = prev[j];
          continue;
        }
        let l = 0;
        while (l < maxLen && data[j + l] === data[i + l]) l++;
        if (l >= MIN_MATCH && l > bestLen) {
          // This candidate is the closest so far achieving lengths
          // (bestLen, l]; record it unless the table is full (the longest
          // candidate always lands in the last slot because lengths only
          // grow along the frontier).
          if (k < CACHE_K) {
            len[base + k] = l;
            dist[base + k] = i - j;
            k++;
          } else {
            len[base + CACHE_K - 1] = l;
            dist[base + CACHE_K - 1] = i - j;
          }
          bestLen = l;
          if (l === maxLen) break;
        }
        j = prev[j];
      }
      count[i] = k;
    }
    if (i + 2 < n) {
      const h = hash3(data, i);
      prev[i] = head[h];
      head[h] = i;
    }
  }
  return { count, len, dist };
}

// Shortest-path parse over the cache under the given code lengths.
function dpParse(
  data: Uint8Array,
  cache: MatchCache,
  litLen: Uint8Array,
  distLen: Uint8Array,
): Token[] {
  const n = data.length;
  const litCost = new Float64Array(286);
  for (let s = 0; s < 286; s++) litCost[s] = litLen[s] > 0 ? litLen[s] : MAX_BITS;
  const lenCost = new Float64Array(29);
  const lenExtraBits = new Float64Array(29);
  for (let s = 0; s < 29; s++) {
    lenCost[s] = litLen[257 + s] > 0 ? litLen[257 + s] : MAX_BITS;
    lenExtraBits[s] = LEN_EXTRA[s];
  }
  const distCost = new Float64Array(30);
  const distExtraBits = new Float64Array(30);
  for (let s = 0; s < 30; s++) {
    distCost[s] = distLen[s] > 0 ? distLen[s] : MAX_BITS;
    distExtraBits[s] = DIST_EXTRA[s];
  }
  const cost = new Float64Array(n + 1).fill(Infinity);
  cost[0] = 0;
  const prevLen = new Int32Array(n + 1);
  const prevDist = new Int32Array(n + 1);
  for (let i = 0; i < n; i++) {
    const base = cost[i];
    if (base === Infinity) continue;
    const lit = base + litCost[data[i]];
    if (lit < cost[i + 1]) {
      cost[i + 1] = lit;
      prevLen[i + 1] = 0;
    }
    const cnt = cache.count[i];
    if (cnt === 0) continue;
    const cb = i * CACHE_K;
    for (let c = 0; c < cnt; c++) {
      const mlen = cache.len[cb + c];
      const mdist = cache.dist[cb + c];
      const dsym = distSymbolOf(mdist);
      const dcost = distCost[dsym] + distExtraBits[dsym];
      for (const step of LEN_STEPS) {
        if (step > mlen) break;
        const lsym = lenSymbolOf(step);
        const cc = base + lenCost[lsym - 257] + lenExtraBits[lsym - 257] + dcost;
        if (cc < cost[i + step]) {
          cost[i + step] = cc;
          prevLen[i + step] = step;
          prevDist[i + step] = mdist;
        }
      }
      if (LEN_STEPS[LEN_STEPS.length - 1] < mlen || !LEN_STEPS.includes(mlen)) {
        const lsym = lenSymbolOf(mlen);
        const cc = base + lenCost[lsym - 257] + lenExtraBits[lsym - 257] + dcost;
        if (cc < cost[i + mlen]) {
          cost[i + mlen] = cc;
          prevLen[i + mlen] = mlen;
          prevDist[i + mlen] = mdist;
        }
      }
    }
  }
  const tokens: Token[] = [];
  let j = n;
  while (j > 0) {
    const l = prevLen[j];
    if (l === 0) {
      tokens.push({ lit: data[j - 1], len: 0, dist: 0 });
      j--;
    } else {
      tokens.push({ lit: -1, len: l, dist: prevDist[j] });
      j -= l;
    }
  }
  tokens.reverse();
  return tokens;
}

// Fixed-Huffman lengths (RFC 1951 3.2.6).
function fixedLengths(): { litLen: Uint8Array; distLen: Uint8Array } {
  // The full fixed trees, including the symbols no token can use (286/287
  // and dists 30/31): canonical code assignment only matches the standard
  // fixed codes when every symbol of the tree is present with its length.
  const litLen = new Uint8Array(288);
  for (let s = 0; s < 288; s++) litLen[s] = s < 144 ? 8 : s < 256 ? 9 : s < 280 ? 7 : 8;
  const distLen = new Uint8Array(32).fill(5);
  return { litLen, distLen };
}

function tokensCostBits(tokens: Token[], litLen: Uint8Array, distLen: Uint8Array): number {
  let bits = 0;
  for (const t of tokens) {
    if (t.lit >= 0) bits += litLen[t.lit];
    else {
      const lsym = lenSymbolOf(t.len);
      bits += litLen[lsym] + LEN_EXTRA[lsym - 257];
      const dsym = distSymbolOf(t.dist);
      bits += distLen[dsym] + DIST_EXTRA[dsym];
    }
  }
  return bits + litLen[256];
}

// Emit one block (dynamic or fixed, whichever is cheaper in bits incl.
// header estimate) — returns the block's bytes without BFINAL handling:
// the caller stitches blocks by emitting all but the last with BFINAL=0.
// Implemented by re-emitting through BitWriter directly.

// Make a length-limited Huffman length assignment complete (Kraft sum
// exactly 1) by giving unused symbols dummy lengths. A tree that is merely
// clamped to the length limit can be incomplete, and strict decoders
// reject incomplete literal/length, distance and code-length trees (the
// one-symbol and no-symbol cases included). Dummy symbols are never
// emitted by any token; they only fill out the code space. Mutates and
// returns `lengths`.
function completeLengths(lengths: Uint8Array, maxBits: number): Uint8Array {
  let kraft = 0;
  for (let s = 0; s < lengths.length; s++) {
    if (lengths[s] > 0) kraft += 2 ** -lengths[s];
  }
  if (kraft >= 1) return lengths;
  if (kraft === 0) {
    // No used symbols at all: two dummy 1-bit codes form a complete tree.
    lengths[0] = 1;
    if (lengths.length > 1) lengths[1] = 1;
    return lengths;
  }
  // Add dummy codes for the dyadic pieces of the deficit 1 - kraft.
  let deficit = 1 - kraft;
  for (let s = 0; s < lengths.length && deficit > 0; s++) {
    if (lengths[s] !== 0) continue;
    let l = Math.ceil(-Math.log2(deficit));
    if (l < 1) l = 1;
    if (l > maxBits) l = maxBits;
    lengths[s] = l;
    deficit -= 2 ** -l;
    // Absorb floating point dust.
    if (deficit < 1e-12) deficit = 0;
  }
  return lengths;
}

function emitSegment(w: BitWriter, tokens: Token[], last: boolean): void {
  const { litFreq, distFreq } = tokenFrequencies(tokens);
  const dynLit = huffmanLengths(litFreq, MAX_BITS);
  const dynDist = huffmanLengths(distFreq, MAX_BITS);
  const dynBits = blockCostBits(tokens);
  const { litLen: fixLit, distLen: fixDist } = fixedLengths();
  const fixBits = 3 + tokensCostBits(tokens, fixLit, fixDist);
  const useDyn = dynBits <= fixBits;
  const litLen = useDyn ? completeLengths(dynLit, MAX_BITS) : fixLit;
  const distLen = useDyn ? completeLengths(dynDist, MAX_BITS) : fixDist;
  checkKraft(litLen);
  checkKraft(distLen);
  const litCode = canonicalCodes(litLen);
  const distCode = canonicalCodes(distLen);
  w.write(last ? 1 : 0, 1);
  if (!useDyn) {
    w.write(1, 2);
  } else {
    w.write(2, 2);
    let hlit = 286;
    while (hlit > 257 && litLen[hlit - 1] === 0) hlit--;
    let hdist = 30;
    while (hdist > 1 && distLen[hdist - 1] === 0) hdist--;
    const allLengths = new Uint8Array(hlit + hdist);
    allLengths.set(litLen.subarray(0, hlit), 0);
    allLengths.set(distLen.subarray(0, hdist), hlit);
    const { symbols, extras } = encodeLengths(allLengths);
    const clFreq = new Uint32Array(19);
    for (const s of symbols) clFreq[s]++;
    const clLen = completeLengths(huffmanLengths(clFreq, 7), 7);
    checkKraft(clLen);
    let hclen = 19;
    while (hclen > 4 && clLen[CL_ORDER[hclen - 1]] === 0) hclen--;
    const clCode = canonicalCodes(clLen);
    w.write(hlit - 257, 5);
    w.write(hdist - 1, 5);
    w.write(hclen - 4, 4);
    for (let k = 0; k < hclen; k++) w.write(clLen[CL_ORDER[k]], 3);
    for (let k = 0; k < symbols.length; k++) {
      const s = symbols[k];
      w.write(clCode[s], clLen[s]);
      if (s === 16) w.write(extras[k], 2);
      else if (s === 17) w.write(extras[k], 3);
      else if (s === 18) w.write(extras[k], 7);
    }
  }
  for (const t of tokens) {
    if (t.lit >= 0) {
      w.write(litCode[t.lit], litLen[t.lit]);
    } else {
      const lsym = lenSymbolOf(t.len);
      w.write(litCode[lsym], litLen[lsym]);
      if (LEN_EXTRA[lsym - 257] > 0) w.write(t.len - LEN_BASE[lsym - 257], LEN_EXTRA[lsym - 257]);
      const dsym = distSymbolOf(t.dist);
      w.write(distCode[dsym], distLen[dsym]);
      if (DIST_EXTRA[dsym] > 0) w.write(t.dist - DIST_BASE[dsym], DIST_EXTRA[dsym]);
    }
  }
  w.write(litCode[256], litLen[256]);
}

function emitBest(tokens: Token[], splits: number[]): Uint8Array {
  const w = new BitWriter();
  const bounds = [0, ...splits, tokens.length];
  for (let b = 0; b + 1 < bounds.length; b++) {
    emitSegment(w, tokens.slice(bounds[b], bounds[b + 1]), b + 2 === bounds.length);
  }
  w.align();
  return new Uint8Array(w.bytes);
}



// Shortest-path parse restricted to the byte range [start, end), under the
// given code lengths. Matches may reference data before `start` (the cache
// is global); tokens never cross `end`.


// deflate3 with zopfli's split-then-squeeze structure: a global parse picks
// the split points, then each segment is re-parsed under its own local
// symbol statistics (matches still reach back across segment boundaries).


// DP variant that tries EVERY length 3..mlen per candidate (zopfli-style),
// to measure how much the LEN_STEPS restriction costs.




// ---- deflate6: statistical cost model ---------------------------------------
// The DP above prices symbols at their integer Huffman lengths from the
// previous parse. Zopfli's squeeze instead prices them at their statistical
// cost, -log2(freq/total), which tracks the true expected code length and
// does not quantise rare symbols to 15 bits or common ones to whole bits.
// The parse is iterated: frequencies -> statistical costs -> DP -> tokens.








// Compress `data` with the match-cache encoder and return a zlib stream.
// `maxChain` bounds the cache's chain walk, `passes` is the number of
// shortest-path parses (the first under greedy-seeded costs, the rest under
// costs re-estimated from the previous parse), and `maxBlocks` caps the
// block splitting tried at emission. Throws on any inconsistency; the
// caller falls back to platform zlib.
export function deflateStrong(
  data: Uint8Array,
  opts: { maxChain?: number; passes?: number; maxBlocks?: number } = {},
): Uint8Array {
  const maxChain = opts.maxChain ?? 512;
  const passes = opts.passes ?? 2;
  const maxBlocks = opts.maxBlocks ?? 10;
  const cache = buildCache(data, maxChain);
  const seed = greedyParse(data);
  let { litFreq, distFreq } = tokenFrequencies(seed);
  let litLen = huffmanLengths(litFreq, MAX_BITS);
  let distLen = huffmanLengths(distFreq, MAX_BITS);
  let tokens = dpParse(data, cache, litLen, distLen);
  for (let p = 1; p < passes; p++) {
    ({ litFreq, distFreq } = tokenFrequencies(tokens));
    litLen = huffmanLengths(litFreq, MAX_BITS);
    distLen = huffmanLengths(distFreq, MAX_BITS);
    tokens = dpParse(data, cache, litLen, distLen);
  }
  let raw = emitBest(tokens, []);
  if (maxBlocks > 1) {
    const splits = chooseSplits(tokens, data.length, maxBlocks);
    if (splits.length > 0) {
      const splitRaw = emitBest(tokens, splits);
      if (splitRaw.length < raw.length) raw = splitRaw;
    }
  }
  const out = new Uint8Array(2 + raw.length + 4);
  out[0] = 0x78;
  out[1] = 0xda;
  out.set(raw, 2);
  const view = new DataView(out.buffer);
  view.setUint32(2 + raw.length, adler32(data), false);
  return out;
}
