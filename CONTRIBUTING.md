# Contributing to CodeMap

Thanks for helping. CodeMap's value depends on being **truthful**: never draw an edge that cannot
be justified from source evidence, and never execute or modify the code being scanned.

## Setup

Node.js 24+ and pnpm (via `corepack enable`).

```bash
pnpm install
pnpm build
pnpm lint      # package boundary rules (scripts/check-boundaries.mjs)
pnpm test      # build + all test suites
```

Useful while developing: `pnpm test:unit` (skips the CLI end-to-end and security suites) and
`npx vitest run packages/graph-engine`.

## Where things go

Read [docs/architecture/system-overview.md](docs/architecture/system-overview.md) first.

- Language syntax → an adapter package (facts only; no file system, no resolution).
- Import/package rules → a resolver package (config snapshots only; no disk access).
- Graph rules, IDs, algorithms → `@codemap/graph-engine` (pure, no I/O).
- Persistence → `@codemap/storage-sqlite`; schema changes need a **new** numbered migration.
- Wiring → `@codemap/application`; user interface → `apps/cli`.

`pnpm lint` fails if a package imports something its layer may not use.

## Adding or changing a language adapter

1. Grammar `.wasm` from a pinned package; record version and license in `THIRD_PARTY_NOTICES.md`.
2. Add a `cases` entry to `tests/conformance/adapter-conformance.test.ts` — all scenarios must pass.
3. Add resolver tests and a fixture under `tests/fixtures/` with exact expected edges in
   `tests/integration/cli.e2e.test.ts`.
4. Update the capability matrix in `docs/architecture/parser-contract.md` and the README.

## Coding standards

- TypeScript strict mode; no `any` in public contracts.
- Deterministic output: sort before emitting; no randomness or timestamps in graph IDs.
- Unknown is a valid answer: prefer an `unresolved` reference with a reason over a guess.
- New diagnostics get a stable code in `packages/contracts/src/diagnostics.ts`; never renumber.
- Decisions that change contracts, package boundaries or persistence need an ADR in `docs/decisions/`.
- Don't claim performance numbers without the command, fixture size, hardware and raw output.

## Pull requests

Describe scope, tests run (with results), compatibility impact (graph schema, database schema,
CLI flags) and update `CHANGELOG.md`.
