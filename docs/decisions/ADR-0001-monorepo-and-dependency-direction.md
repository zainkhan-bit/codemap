# ADR-0001: pnpm monorepo and package dependency direction

- Status: accepted · Date: 2026-11-08

## Context
CodeMap needs strict boundaries between discovery, parsing, resolution, graph computation,
persistence and presentation so that parsers, storage or the UI can change independently.

## Decision
A pnpm workspace (`pnpm@10.34.9`, pinned via `packageManager`) with one package per responsibility
(see [system-overview.md](../architecture/system-overview.md)). `@codemap/contracts` depends on
nothing; `@codemap/application` is the only composition root; the CLI calls use cases only.
TypeScript project references (`tsc -b`) build packages in dependency order.
`scripts/check-boundaries.mjs` (run by `pnpm lint` and CI) enforces allowed imports, forbidden
modules (no `child_process` or network modules anywhere), declared dependencies and acyclicity.
The build uses TypeScript 5.9.3 (stable JS compiler) rather than 7.x to keep the toolchain
conservative; no compiler API is used at runtime.

## Alternatives
- Single package with folders: boundaries unenforceable.
- ESLint `import/no-restricted-paths`: a heavier dependency tree for the same rules.
- Nx / Turborepo: unnecessary at this size.

## Consequences
More package manifests; publishing requires releasing all `@codemap/*` packages together (verified
by the tarball smoke test). Boundary violations fail CI.
