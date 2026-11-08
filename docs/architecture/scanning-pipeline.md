# Scanning pipeline

Implemented in [`packages/application/src/scan.ts`](../../packages/application/src/scan.ts).
Each phase reports progress (`discover`, `hash`, `parse`, `resolve`, `build`, `analyze`,
`persist`) and its duration is recorded in the scan summary.

| # | Step | Notes |
|---|---|---|
| 1 | Validate path | `realpath` once; must be a directory (`exit 3` otherwise). The canonical root is stored only in local project metadata. |
| 2 | Load config | `codemap.config.json` (optional). Unknown keys → warnings; invalid values → `exit 2`. `--max-file-size` overrides. |
| 3–5 | Discover & classify | See ignore rules below. Sorted, NFC, POSIX relative paths. |
| 6 | Read + hash | SHA-256 of bytes; binary (NUL in first 8000 bytes) → `SCAN001`; size re-checked on actual bytes → `SCAN002`. |
| 7 | Parse or reuse | Cache key = SHA-256(content hash · adapter id/version · grammar fingerprint · extraction schema version · options hash). Artifacts are path-independent. Failed parses are not cached. |
| 8 | Project context | Sorted source file list, directories, config snapshots. |
| 9 | Resolve | Per-language resolvers over all import facts. Recomputed every scan (a renamed target can never leave a stale edge). |
| 10 | Build graph | Deterministic IDs, containment, imports, exports, linking. |
| 11 | Algorithms | Tarjan SCC cycles over resolved `imports` edges; metrics. |
| 12 | Invariants | Schema + cross-entity checks; any violation fails the scan (`GRAPH002`, `exit 5`) and nothing is persisted. |
| 13 | Persist | `running` scan row → inventory, new artifacts, graph in one transaction → `completed`. Failure → `failed` (partial rows deleted); SIGINT → `cancelled`. Only completed scans are ever "latest". Old scans pruned (keep 5). |
| 14 | Summary | Counts, durations, languages; `exit 1` if any file failed to parse or any error diagnostic exists. |

## Ignore precedence

1. **Hard** (cannot be overridden): `.git`, `.hg`, `.svn`, `.bzr`, `_darcs`, `.jj`, `CVS`;
   secret-like files: `.env*`, `*.pem`, `*.key`, `*.p12`, `*.pfx`, `*.crt`, `id_rsa*`, `.npmrc`, `.pypirc`, `.netrc`.
   Symbolic links are never followed (`SCAN003`).
2. **Built-in**: `node_modules`, `dist`, `build`, `out`, `coverage`, `.next`, `.venv`, `venv`,
   `__pycache__`, `*.egg-info`, caches…, any directory containing `pyvenv.cfg`; `*.min.js`, `*.bundle.js`, `*.map`.
3. **`.gitignore`** files at any depth (relative to their directory).
4. **`.codemapignore`** files at any depth; `!pattern` can re-include what `.gitignore` excluded
   (not what layers 1–2 excluded, and not inside a directory already pruned).
5. **Config**: `exclude` always excludes; a non-empty `include` is an allowlist (globs).

Only allowlisted configuration files are read as text (≤1 MB): `package.json`, `tsconfig.json`,
`tsconfig.*.json`, `jsconfig.json`, `pyproject.toml`, `setup.cfg`, `requirements*.txt`,
`pnpm-workspace.yaml`. Their text is kept in memory for resolution only — never persisted or
exported. From `requirements*.txt` only package names are used.

## Concurrency and limits

Reading/hashing runs with `2 × concurrency` in flight; parsing with `concurrency` (default
`min(8, cores − 1)`, max 16). Parsing is CPU-bound on the main thread in v0.1.0 (ADR-0003): the
per-file time budget and error isolation bound the damage of a pathological file, and cancellation
(Ctrl+C) is checked between files and phases.

`maxFiles` (default 50 000) stops discovery with `SCAN005`; `maxFileSizeBytes` (2 MB) skips files with `SCAN002`.

## Diagnostics codes

`SCAN001` binary · `SCAN002` too large · `SCAN003` symlink · `SCAN004` access error ·
`SCAN005` file limit · `SCAN006` invalid config · `PARSE001` recovered syntax errors ·
`PARSE002` parser failure · `PARSE003` parse timeout · `PARSE004` unsupported construct ·
`RESOLVE001` unresolved · `RESOLVE002` ambiguous · `RESOLVE003` partial support ·
`GRAPH001` duplicate symbol identity · `GRAPH002` invariant violation · `STORE001` persistence failure.
