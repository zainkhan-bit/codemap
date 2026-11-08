# Stage-one release gate (blueprint §17.7) — status 2026-11-08

| # | Gate | Status | Evidence |
|---|---|---|---|
| 1 | Graph schema versioned; contract tests pass | ✅ | `packages/contracts/src/validation.test.ts` |
| 2 | JS/TS and Python adapters pass conformance | ✅ | `tests/conformance/adapter-conformance.test.ts` (31 pass; the re-export scenario is JS-only and skipped for Python) |
| 3 | Resolver fixtures cover success, external, unresolved, ambiguous | ✅ | `packages/resolvers/*/src/resolver.test.ts`, `fixture-unresolved` |
| 4 | Deterministic IDs and invariant checks | ✅ | graph-engine tests; e2e "identical across independent scans" |
| 5 | SQLite write/read/migration/rollback tests | ✅ | `packages/storage-sqlite/src/storage.test.ts` |
| 6 | CLI scans samples and exports JSON/SVG | ✅ | `tests/integration/cli.e2e.test.ts`; tarball install smoke test (manual, see below) |
| 7 | Cross-platform CI on Windows, macOS, Linux | ✅ | [CI run 42467717658](https://github.com/zainkhan-bit/codemap/actions/runs/42467717658): ubuntu, macOS, Windows × Node 24, 26 — 152 passed / 1 skipped on each, plus lint, build and packed-tarball smoke test (scan, SVG and PNG export) |
| 8 | No project code execution, no project writes | ✅ | `tests/security/security.test.ts` |
| 9 | Performance baseline documented | ✅ (1k, 10k, 50k) | `docs/development/performance-baseline.md` |
| 10 | README explains limitations and installation | ✅ | `README.md` |

All ten stage-one gates pass. Stage 6 (local API and dashboard) awaits separate approval.

## Local verification run

Windows 11, Node 24.12.0, pnpm 10.34.9:

- `pnpm build` — success.
- `pnpm lint` — "Package boundaries OK (13 packages, no cycles, no network/subprocess modules)".
- `pnpm test` — 11 files, 152 passed, 1 skipped (includes PNG export end to end).
- Packaging: every package packed with `pnpm pack`, installed from tarballs with `npm install` into
  an empty directory outside the monorepo; `codemap --version`, `codemap doctor` (all checks ✓),
  `codemap scan` and `codemap export --format svg` succeeded (before the PNG package existed; CI repeats it with PNG).
