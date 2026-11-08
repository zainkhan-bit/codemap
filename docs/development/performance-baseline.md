# Performance baseline

These are measurements on one machine, not guarantees. Thresholds and regression budgets should be
set only after the same benchmark has run on the documented CI reference machines.

## How to reproduce

```bash
pnpm build
node tests/performance/bench.mjs 1000 10000
```

The script generates a deterministic synthetic repository per requested size (≈75% TypeScript
classes/functions, ≈25% Python modules, each importing up to three other files, with calls,
interfaces and external imports), then runs a cold scan (empty data directory) and a warm scan
(parse cache populated) in-process. The generator adds `__init__.py` files and manifests, so the
scanned file count is slightly higher than requested.

## Reference machine (2026-11-08)

Windows 11 (10.0.26200), Intel Core i5-1145G7 (4 cores / 8 threads), 16 GiB RAM, NVMe SSD,
Node.js 24.12.0, CodeMap 0.1.0, default configuration (concurrency `auto` → 7).

## Results

| Files | Cold total | Warm total | Peak RSS (cold) | Cache hit rate (warm) | Nodes / edges / references |
|---|---|---|---|---|---|
| 1 289 | 2.6 s | 2.2 s | 217 MiB | 100% | 8 836 / 18 794 / 12 821 |
| 10 979 | 21.9 s | 18.2 s | 792 MiB | 100% | 77 132 / 177 675 / 129 497 |
| 50 000 ¹ | 93.8 s | 83.3 s | 2 554 MiB | 100% | 369 427 / 855 343 / 630 376 |

Cold phase breakdown (ms):

| Files | discover | hash | parse | resolve | build | analyze | persist |
|---|---|---|---|---|---|---|---|
| 1 289 | 552 | 88 | 530 | 35 | 364 | 80 | 931 |
| 10 979 | 1 643 | 778 | 4 283 | 274 | 3 464 | 889 | 10 542 |
| 50 000 ¹ | 6 267 | 2 902 | 14 721 | 945 | 14 042 | 4 249 | 50 674 |

¹ `node --max-old-space-size=8192 tests/performance/bench.mjs 50000`. The generator wrote ~54 000
files; the default `maxFiles` limit (50 000) stopped discovery with `SCAN005`, which is the intended
behaviour. Totals are the scan pipeline’s own timings (wall time including process overhead: 99.4 s
cold, 90.8 s warm). The run used an 8 GiB heap limit; whether the default heap suffices at this
size has not been tested.

Warm scans reuse every parse artifact (parse phase 1.8 s instead of 4.3 s at 10 979 files) but
still rebuild and persist the whole snapshot by design (ADR-0005).

## History

| Date | Change | 10 979-file cold scan |
|---|---|---|
| 2026-11-08 | Baseline schema from the blueprint | 53.7 s (persist 41.6 s) |
| 2026-11-08 | ADR-0010 storage changes | 21.9 s (persist 10.5 s) |

## Known headroom

- Persistence is still ~48% of a cold scan: JSON serialisation and per-row `json_valid` checks
  dominate. Batching JSON columns or storing compact binary encodings are candidates.
- Warm scans could skip writing an identical snapshot when the source fingerprint, configuration
  and parser set are unchanged.
- Parsing is single-threaded (ADR-0003); a worker pool would cut the parse phase on multi-core
  machines.
- Peak memory grows roughly linearly (~50–70 KiB per file on this corpus) because the whole graph
  is built in memory before persisting; 50 000 files needed 2.5 GiB. Streaming persistence would
  bound this.
