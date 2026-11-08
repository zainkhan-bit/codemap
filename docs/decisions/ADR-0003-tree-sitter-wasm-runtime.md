# ADR-0003: Tree-sitter parser runtime, WASM-first packaging

- Status: accepted · Date: 2026-11-08

## Context
We need multi-language, error-tolerant parsing without a native toolchain at install time.

## Decision
`web-tree-sitter@0.25.10` behind `@codemap/parser-runtime`, with grammar `.wasm` files from the
official grammar packages (`tree-sitter-javascript@0.25.0`, `tree-sitter-typescript@0.23.2`,
`tree-sitter-python@0.25.0`; all MIT). Grammars load from local files; nothing is downloaded at
scan time.

Spike result (2026-11-08): all three grammars load and parse on Windows 11 with Node 24.12.0, and
the packed CLI works when installed from tarballs outside the monorepo. **macOS and Linux have not
been run yet**; they are covered by the CI matrix, which has not executed (no remote exists).

Parsing runs on the main thread with a per-file time budget (progress-callback cancellation) and
per-file error isolation instead of a worker-thread pool. Workers would re-initialise WASM per
worker and complicate packaging; the benchmark shows parsing is ~20% of a cold scan.

## Alternatives
- Native `tree-sitter` Node bindings: faster, but native builds per OS/Node version.
- The TypeScript compiler for JS/TS: couples to an API in transition (see ADR-0004).

## Consequences
The grammar packages also ship native sources and an install script CodeMap does not use (the
workspace ignores those scripts). A future release may vendor only the `.wasm` files. A hard WASM
trap (e.g. out of memory) can still abort the process; a worker pool is the planned mitigation if
this is seen in practice.
