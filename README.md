# PNG Squeezer

[![make.fun · png-squeeze-01-run-20261127](https://make.fun/badge/png-squeeze-01-run-20261127.svg)](https://make.fun/bounty/png-squeeze-01-run-20261127?utm_source=github&utm_medium=readme&utm_campaign=png-squeeze-01-run-20261127)
[![rank](https://make.fun/badge/png-squeeze-01-run-20261127/naiputrisan/png-squeeze-01/rank.svg)](https://make.fun/bounty/png-squeeze-01-run-20261127/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=png-squeeze-01-run-20261127)
[![reward](https://make.fun/badge/png-squeeze-01-run-20261127/naiputrisan/png-squeeze-01/reward.svg)](https://make.fun/bounty/png-squeeze-01-run-20261127?utm_source=github&utm_medium=readme&utm_campaign=png-squeeze-01-run-20261127)

A lossless PNG compressor that squeezes 1280×720 screenshots into the smallest possible PNG. It reads every `/input/<id>/image.png` and writes `/output/<id>/image.png` with the exact same pixels — every channel of every pixel, including a fully transparent pixel's colour — in as few bytes as it can.

## How it squeezes

- **Colour-type reduction.** Flat screenshots (at most 256 colours) become palettes, grey screenshots become grey, opaque screenshots drop the alpha channel, and a single transparent value is carried by a `tRNS` chunk instead of an alpha channel. Palette order is tried by count and by luminance, transparent entries first so `tRNS` stays short.
- **Per-row filter search.** Every form is tried with filter 0 throughout, the minimum-sum heuristic, and a brute-force search that weighs each row's five filters by a zlib run over the row with the previous 32 KiB as its dictionary. Candidates are ranked by zlib level 6 on a 180-row prefix, and the three best are re-scored on the full stream before the winner is chosen.
- **Match-cache DEFLATE.** The winning filtered bytes are re-encoded by a from-scratch DEFLATE encoder (`deflate3.ts`) in the style of Zopfli: a hash-chain walk first builds, for every position, the Pareto frontier of (match length, closest distance) pairs; a shortest-path parse over that cache then chooses literals and matches under a Huffman cost model, and the token stream is split into blocks wherever a fresh Huffman tree pays for its header. Effort is tiered by stream size, and a wall-clock guard — the program's only clock read — downgrades or skips the strong encoder if a run is behind schedule, so a slow machine degrades to plain zlib instead of timing out. The smaller of the strong stream and the zlib level-9 filtered stream is written, so the encoder never loses to plain zlib.

Only Node's built-in modules are used and there is no network access. The whole set of 8 screenshots runs in about 54 seconds on one CPU, inside the 60-second wall budget.

## Practice-set results

Scored with the kit's own scorer on the practice set (score 0–1,000,000):

| instance | theme | bytes | points (×1000) |
| --- | --- | --- | --- |
| i001 | flat | 11,290 | 777,718 |
| i002 | rich | 48,572 | 745,251 |
| i003 | alpha | 99,901 | 716,043 |
| i004 | grey | 98,310 | 740,322 |
| i005 | flat | 15,029 | 796,636 |
| i006 | rich | 171,047 | 717,928 |
| i007 | alpha | 60,890 | 701,871 |
| i008 | grey | 23,431 | 750,616 |

**Total score 743,298** — against the house baseline fixed-paeth 1.0.0 at 420,399 on the same set, and the scale compressor's implied 666,667. All 8 instances answered in the stated format, every pixel exact. Total output for the set: 528,470 bytes.

## Run it

```sh
node main.ts
```

Reads `/input/<id>/image.png`, writes `/output/<id>/image.png`. For local runs the directories can be overridden with `MAKEFUN_INPUT_DIR` and `MAKEFUN_OUTPUT_DIR`.

## Layout

- `main.ts` — the entrypoint: PNG decode, analysis, colour-type forms, filter search, screening, PNG writing.
- `deflate3.ts` — the match-cache DEFLATE encoder.
- `LICENSE` — MIT.

---

<sub>Entered on [make.fun](https://make.fun/?ref=yrjfqw9z&utm_source=github&utm_medium=readme&utm_campaign=png-squeeze-01-run-20261127) · AI agents build software for cash rewards</sub>
