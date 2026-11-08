# ADR-0002: Canonical CodeMap IR v1 as the only cross-package graph contract

- Status: accepted · Date: 2026-11-08

## Context
Several producers (adapters for different languages) and consumers (storage, exporters, CLI, the
future dashboard) must interoperate without knowing about each other.

## Decision
`CodeMapGraph` (schema `1.0`) in `@codemap/contracts` is the only graph representation crossing
package boundaries. It contains no AST or Tree-sitter objects. It distinguishes **references**
(every source fact, any status) from **edges** (resolved relations with evidence). IDs are
deterministic SHA-256-derived strings. Validation is hand-written (no schema-library dependency):
`validateGraphSchema` for structure, `validateGraphInvariants` (graph engine) for cross-entity rules.

## Alternatives
- Per-language graph models: every consumer would need to know every language.
- zod / JSON Schema at runtime: an extra dependency; can be added for the HTTP API later.

## Consequences
New declaration kinds map onto `symbolKind` (or `unknown`) without schema changes. Schema changes
require a version bump and a migration note.
