# ADR-0004: Separate syntax extraction from project-aware resolution

- Status: accepted · Date: 2026-11-08

## Context
Parsing depends only on file bytes; resolution depends on the whole project (other files, config).

## Decision
Adapters emit path-independent facts. Resolvers map module references using the file inventory and
static config snapshots, returning `resolved_internal | resolved_external | unresolved | ambiguous |
ignored` with method, confidence and reason. Call, inheritance and export linking happens in the
graph engine from resolved imports and declarations.

The JS/TS resolver is a static implementation and does **not** use the TypeScript compiler API:
TypeScript 7.0 ships no programmatic API and 7.1's is beta, and the blueprint permits but does not
require `@typescript/typescript6`. Unsupported modes emit `RESOLVE003`.

## Alternatives
- Resolving during parsing: forces reparsing whenever configuration changes.
- Depending on `@typescript/typescript6`: a large dependency with little benefit for the path,
  `exports` and workspace resolution implemented directly.

## Consequences
Config changes re-resolve without reparsing. Some TypeScript resolution modes are partial; they are
listed in [resolution-strategy.md](../architecture/resolution-strategy.md).
