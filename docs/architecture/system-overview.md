# System overview

CodeMap analyzes a local repository and produces a normalized, evidence-backed graph of its
architecture. Everything runs locally: no network calls, no telemetry, no execution of the
scanned project's code.

## Dependency direction

```text
apps/cli ──► @codemap/application  (composition root: the only package that wires the rest)
                 │
   ┌─────────────┼──────────────┬───────────────┬──────────────┬─────────────┐
   ▼             ▼              ▼               ▼              ▼             ▼
 scanner   adapters/*      resolvers/*     graph-engine   storage-sqlite   exporters
             │                                                               │
             ▼                                                               ▼
       parser-runtime                                                  graph-engine
   (all of the above depend on @codemap/contracts, which depends on nothing)
```

Rules (enforced by `pnpm lint` → `scripts/check-boundaries.mjs`):

| Package | May import | Must not import |
|---|---|---|
| `contracts` | nothing | any CodeMap package, fs, network |
| `graph-engine` | contracts | fs, path, SQLite, Tree-sitter |
| `scanner` | contracts | parsers, SQLite |
| `parser-runtime` | contracts | SQLite |
| `adapters/*` | contracts, parser-runtime | fs, SQLite |
| `resolvers/*` | contracts | fs, Tree-sitter, SQLite, `typescript` |
| `storage-sqlite` | contracts | Tree-sitter |
| `exporters` | contracts, graph-engine | fs, SQLite, Tree-sitter |
| `application` | everything above | — |
| `server` | application, contracts, dashboard (assets) | SQLite, Tree-sitter |
| `apps/cli` | application, server, contracts | SQLite, Tree-sitter |
| `apps/dashboard` | contracts (types only) | any `node:` module, SQLite, Tree-sitter |
| **all** | — | `child_process`, `http(s)`, `net`, `dgram`, `tls`, `vm`, `worker_threads` — except `packages/server/src/index.ts` (`node:http`) and `apps/cli/src/open-browser.ts` (`node:child_process`), see ADR-0011 |

The checker also verifies that every imported package is declared in `package.json`, that no
declared `@codemap/*` dependency is unused, and that package dependencies are acyclic.

## Package responsibilities

| Package | Responsibility |
|---|---|
| `@codemap/contracts` | CodeMap IR v1 types, adapter/resolver/storage contracts, diagnostic codes, runtime validation of graphs and configuration. |
| `@codemap/scanner` | Root validation, safe discovery (ignore layers, no symlinks, secret exclusion), allowlisted config snapshots, hashing, bounded concurrency. |
| `@codemap/parser-runtime` | `web-tree-sitter` lifecycle, packaged grammar loading, UTF-16→UTF-8 position mapping, parse time budget. |
| `@codemap/adapter-javascript-typescript` | JS/TS/JSX/TSX fact extraction. |
| `@codemap/adapter-python` | Python fact extraction. |
| `@codemap/resolver-javascript-typescript` | Static Node/TypeScript module resolution from config snapshots. |
| `@codemap/resolver-python` | Static Python import resolution (source roots, stdlib, declared deps). |
| `@codemap/graph-engine` | Deterministic IDs, graph builder + symbol linker, projections, algorithms, invariants. |
| `@codemap/storage-sqlite` | Migrations, immutable scan snapshots, artifact cache (`better-sqlite3`). |
| `@codemap/exporters` | JSON, SVG (own layered layout, no browser), Mermaid; PNG via the optional rasterizer. |
| `@codemap/application` | Scan pipeline and read use cases. |
| `@codemap/rasterizer-png` | Optional SVG→PNG rasterizer (isolated native dependency). |
| `@codemap/server` | Loopback-only, read-only HTTP API v1 + dashboard assets. |
| `@codemap/dashboard` | Static dashboard (TypeScript + Cytoscape.js, bundled). |
| `@codemap/cli` | `codemap` command. |

## Data flow of one scan

See [scanning-pipeline.md](scanning-pipeline.md). In short:
files → (adapter) `FileExtraction` facts → (resolver) `ResolutionResult`s → (graph-engine)
`CodeMapGraph` → invariants → (storage) one transaction → completed snapshot.

## Local dashboard

`codemap dashboard` → `@codemap/server` → `@codemap/application` use cases. The dashboard reads
only the API v1 (`@codemap/contracts` `api.ts`); it never parses source or reads SQLite. See
[local-api.md](local-api.md) and ADR-0011.
