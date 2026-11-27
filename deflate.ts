// An optimal-parsing DEFLATE encoder: hash-chain LZ77 match search, a
// shortest-path (dynamic programming) parse under a Huffman cost model,
// iterated Huffman refinement, and one dynamic-Huffman block. Written from
// the DEFLATE format itself (RFC 1951); no code is shared with any library.
// Returns a complete zlib stream (RFC 1950). Throws on any internal
// inconsistency, so the caller can fall back to the platform zlib instead.

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
function optimalParse(
  data: Uint8Array,
  litLen: Uint8Array,
  distLen: Uint8Array,
  opts: { maxChain?: number; earlyLen?: number; second?: boolean; stepCap?: number } = {},
): Token[] {
  const n = data.length;
  // A symbol the seed parse never used has no code yet; price it at the
  // maximum length so the parse does not treat it as free.
  const litCost = new Float64Array(286);
  for (let s = 0; s < 286; s++) litCost[s] = litLen[s] > 0 ? litLen[s] : MAX_BITS;
  const lenCost = new Float64Array(29);
  const lenExtraBits = new Float64Array(29);
  for (let s = 0; s < 29; s++) {
    lenCost[s] = litLen[257 + s] > 0 ? litLen[257 + s] : MAX_BITS;
    lenExtraBits[s] = LEN_EXTRA[s];
  }
  const distCost = new Float64Array(30);
  for (let s = 0; s < 30; s++) distCost[s] = distLen[s] > 0 ? distLen[s] : MAX_BITS;
  const cost = new Float64Array(n + 1).fill(Infinity);
  cost[0] = 0;
  // prevLen[j] / prevDist[j]: the edge into position j (0 = literal).
  const prevLen = new Int32Array(n + 1);
  const prevDist = new Int32Array(n + 1);
  const head = new Int32Array(HASH_SIZE).fill(-1);
  const prev = new Int32Array(n);
  for (let i = 0; i < n; i++) {
    const base = cost[i];
    // Literal.
    const lit = base + litCost[data[i]];
    if (lit < cost[i + 1]) {
      cost[i + 1] = lit;
      prevLen[i + 1] = 0;
    }
    // Matches.
    if (i + MIN_MATCH <= n) {
      const matches = findMatches(
        data,
        i,
        head,
        prev,
        opts.maxChain ?? MAX_CHAIN,
        opts.earlyLen ?? Infinity,
        opts.second ?? true,
      );
      for (const m of matches) {
        const dsym = distSymbolOf(m.dist);
        const dcost = distCost[dsym] + DIST_EXTRA[dsym];
        // Candidate lengths: every length-symbol boundary up to the match
        // length (capped at stepCap — long intermediate lengths rarely beat
        // the full match, and each one costs a transition per position),
        // plus the match length itself.
        const stepCap = opts.stepCap ?? Infinity;
        let last = -1;
        for (const step of LEN_STEPS) {
          if (step > m.len) break;
          if (step > stepCap) continue;
          last = step;
          const lsym = lenSymbolOf(step);
          const c = base + lenCost[lsym - 257] + lenExtraBits[lsym - 257] + dcost;
          if (c < cost[i + step]) {
            cost[i + step] = c;
            prevLen[i + step] = step;
            prevDist[i + step] = m.dist;
          }
        }
        if (last !== m.len) {
          const lsym = lenSymbolOf(m.len);
          const c = base + lenCost[lsym - 257] + lenExtraBits[lsym - 257] + dcost;
          if (c < cost[i + m.len]) {
            cost[i + m.len] = c;
            prevLen[i + m.len] = m.len;
            prevDist[i + m.len] = m.dist;
          }
        }
      }
    }
    // Insert this position into the chains for later positions.
    if (i + 2 < n) {
      const h = hash3(data, i);
      prev[i] = head[h];
      head[h] = i;
    }
  }
  // Reconstruct by walking the backpointers from the end.
  const tokens: Token[] = [];
  let j = n;
  while (j > 0) {
    const len = prevLen[j];
    if (len === 0) {
      tokens.push({ lit: data[j - 1], len: 0, dist: 0 });
      j--;
    } else {
      tokens.push({ lit: -1, len, dist: prevDist[j] });
      j -= len;
    }
  }
  tokens.reverse();
  return tokens;
}

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
function emitDynamic(tokens: Token[]): Uint8Array {
  const { litFreq, distFreq } = tokenFrequencies(tokens);
  const litLen = huffmanLengths(litFreq, MAX_BITS);
  const distLen = huffmanLengths(distFreq, MAX_BITS);
  checkKraft(litLen);
  checkKraft(distLen);
  // Trim trailing zero lengths (at least 257 lit/len codes, 1 dist code).
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
  checkKraft(clLen);
  let hclen = 19;
  while (hclen > 4 && clLen[CL_ORDER[hclen - 1]] === 0) hclen--;
  const litCode = canonicalCodes(litLen);
  const distCode = canonicalCodes(distLen);
  const clCode = canonicalCodes(clLen);
  const w = new BitWriter();
  w.write(1, 1); // BFINAL
  w.write(2, 2); // BTYPE = 10 (dynamic)
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
  for (const t of tokens) {
    if (t.lit >= 0) {
      w.write(litCode[t.lit], litLen[t.lit]);
    } else {
      const lsym = lenSymbolOf(t.len);
      w.write(litCode[lsym], litLen[lsym]);
      if (LEN_EXTRA[lsym - 257] > 0) {
        w.write(t.len - LEN_BASE[lsym - 257], LEN_EXTRA[lsym - 257]);
      }
      const dsym = distSymbolOf(t.dist);
      w.write(distCode[dsym], distLen[dsym]);
      if (DIST_EXTRA[dsym] > 0) {
        w.write(t.dist - DIST_BASE[dsym], DIST_EXTRA[dsym]);
      }
    }
  }
  w.write(litCode[256], litLen[256]); // end of block
  w.align();
  return new Uint8Array(w.bytes);
}

// ---- Entry point ------------------------------------------------------------
// (greedyParse / optimalParse are exported for offline testing.)
export { greedyParse, optimalParse, findMatches, emitDynamic };

// Compress `data` with the optimal-parsing encoder and return a zlib stream.
// `opts` bounds the match search (see findMatches). The default is one
// shortest-path pass under greedy-seeded Huffman costs: a second pass buys
// about 1% more size for twice the wall time, which the 60-second budget
// for eight screenshots does not afford.
// Throws on any inconsistency; the caller falls back to platform zlib.
export function deflateOptimal(
  data: Uint8Array,
  opts: { maxChain?: number; earlyLen?: number; second?: boolean; passes?: number; stepCap?: number } = {},
): Uint8Array {
  // Defaults: one shortest-path pass, intermediate match lengths tried only
  // up to 35 bytes (plus the match's own length). A second pass buys about
  // 1% more size for twice the wall time, and longer intermediate lengths
  // almost never beat the full match — both are unaffordable inside the
  // 60-second budget for eight screenshots.
  const runOpts = { passes: 1, stepCap: 35, ...opts };
  // Seed the cost model with a greedy parse, then refine it with
  // shortest-path passes under the costs each pass's tokens imply.
  const seed = greedyParse(data);
  let { litFreq, distFreq } = tokenFrequencies(seed);
  let litLen = huffmanLengths(litFreq, MAX_BITS);
  let distLen = huffmanLengths(distFreq, MAX_BITS);
  let tokens = optimalParse(data, litLen, distLen, runOpts);
  const passes = runOpts.passes;
  for (let p = 1; p < passes; p++) {
    ({ litFreq, distFreq } = tokenFrequencies(tokens));
    litLen = huffmanLengths(litFreq, MAX_BITS);
    distLen = huffmanLengths(distFreq, MAX_BITS);
    tokens = optimalParse(data, litLen, distLen, runOpts);
  }
  const raw = emitDynamic(tokens);
  const out = new Uint8Array(2 + raw.length + 4);
  out[0] = 0x78;
  out[1] = 0xda;
  out.set(raw, 2);
  const view = new DataView(out.buffer);
  view.setUint32(2 + raw.length, adler32(data), false);
  return out;
}
