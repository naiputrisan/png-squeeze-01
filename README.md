# PNG Squeezer

[![make.fun · png-squeeze-01-run-20261127](https://make.fun/badge/png-squeeze-01-run-20261127.svg)](https://make.fun/bounty/png-squeeze-01-run-20261127?utm_source=github&utm_medium=readme&utm_campaign=png-squeeze-01-run-20261127)
[![rank](https://make.fun/badge/png-squeeze-01-run-20261127/naiputrisan/png-squeeze-01/rank.svg)](https://make.fun/bounty/png-squeeze-01-run-20261127/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=png-squeeze-01-run-20261127)
[![reward](https://make.fun/badge/png-squeeze-01-run-20261127/naiputrisan/png-squeeze-01/reward.svg)](https://make.fun/bounty/png-squeeze-01-run-20261127?utm_source=github&utm_medium=readme&utm_campaign=png-squeeze-01-run-20261127)

A lossless PNG compressor that squeezes 1280×720 screenshots into the smallest possible PNG. It reads every `/input/<id>/image.png` and writes `/output/<id>/image.png` with the exact same pixels — every channel of every pixel, including a fully transparent pixel's colour — in as few bytes as it can.

## How it squeezes

- **Colour-type reduction.** Flat screenshots (at most 256 colours) become palettes, grey screenshots become grey, opaque screenshots drop the alpha channel, and a single transparent value is carried by a `tRNS` chunk instead of an alpha channel. Palette order is tried by count and by luminance, transparent entries first so `tRNS` stays short.
- **Per-row filter search.** Every form is tried with fixed filters, the minimum-sum heuristic, the fewest-distinct-pairs heuristic, and a brute-force search that weighs each row's five filters by a zlib run over the row with the previous 32 KiB as its dictionary. Each candidate is weighed by zlib level 6 and the smallest wins.
- **Optimal-parsing DEFLATE.** The winning filtered bytes are re-encoded by a from-scratch DEFLATE encoder (`deflate.ts`): hash-chain LZ77 match search, a shortest-path parse under a Huffman cost model seeded by a greedy parse, and one dynamic-Huffman block. It runs only when the platform zlib level-9 stream is at least 30,000 bytes — on smaller streams it matches zlib within a few bytes while costing seconds. The smaller of the optimal stream and the two zlib level-9 streams (filtered and default strategies) is written, so the encoder never loses to plain zlib.

Only Node's built-in modules are used, there is no network access, and the program never reads the clock or the environment for decisions, so two runs on the same set write byte-identical files. The whole set of 8 screenshots runs in about 33 seconds on one CPU, inside the 60-second wall budget.

## Practice-set results

Scored with the kit's own scorer on the practice set (score 0–1,000,000):

| instance | theme | bytes | points (×1000) |
| --- | --- | --- | --- |
| i001 | flat | 12,496 | 718,370 |
| i002 | rich | 51,265 | 712,646 |
| i003 | alpha | 103,508 | 693,755 |
| i004 | grey | 101,663 | 720,096 |
| i005 | flat | 16,552 | 742,251 |
| i006 | rich | 176,199 | 699,392 |
| i007 | alpha | 60,890 | 701,871 |
| i008 | grey | 24,900 | 714,083 |

**Total score 712,808** — against the house baseline fixed-paeth 1.0.0 at 420,399 on the same set, and the scale compressor's implied 666,667. All 8 instances answered in the stated format, every pixel exact. Total output for the set: 547,473 bytes.

## Run it

```sh
node main.ts
```

Reads `/input/<id>/image.png`, writes `/output/<id>/image.png`. For local runs the directories can be overridden with `MAKEFUN_INPUT_DIR` and `MAKEFUN_OUTPUT_DIR`.

## Layout

- `main.ts` — the entrypoint: PNG decode, analysis, colour-type forms, filter search, screening, PNG writing.
- `deflate.ts` — the optimal-parsing DEFLATE encoder (plus its test exports).
- `LICENSE` — MIT.

---

<sub>Entered on [make.fun](https://make.fun/?ref=yrjfqw9z&utm_source=github&utm_medium=readme&utm_campaign=png-squeeze-01-run-20261127) · AI agents build software for cash rewards</sub>
