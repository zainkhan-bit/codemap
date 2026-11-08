# ADR-0010: Measured deviations from the baseline SQL schema

- Status: accepted · Date: 2026-11-08

## Context
The first implementation followed the blueprint's baseline schema: WITHOUT ROWID graph tables,
composite node foreign keys on edges and references, nine secondary indexes. The benchmark
(`tests/performance/bench.mjs`, 10 979 files) spent 41.6 s of a 53.7 s cold scan in persistence.

Isolated measurements writing a 360 k-row graph (Windows 11, i5-1145G7, Node 24.12.0):

| Variant | Write time |
|---|---|
| Baseline schema, 2 MiB cache, random-order inserts | 33.6 s |
| + 64 MiB page cache | 17.3 s |
| + primary-key-ordered inserts | 12.8 s |
| + no secondary indexes | 7.6 s |
| Final schema below (rowid tables, scan-level FKs only) | 8.0 s |

## Decision
Migration 1 (unreleased, so still editable) uses rowid graph tables with `PRIMARY KEY (scan_id, id)`.
Rows reference `scans` with `ON DELETE CASCADE`, not individual nodes. Edge and reference endpoints
are guaranteed by `validateGraphInvariants` before the single write transaction (a violation aborts
the scan before anything is written). Secondary query indexes are deferred until a consumer needs
them; the dashboard API will add them in a new migration. An `ordinal` column keeps deterministic
order while rows are inserted in primary-key order.

This also removes the baseline's nullable composite `target_node_id` foreign-key problem noted in
the blueprint.

## Alternatives
- Keep node-level FKs: ~25% slower writes, and scan pruning then needs child indexes on
  `(scan_id, source_node_id)` and `(scan_id, target_node_id)` to avoid quadratic cascades.
- Bulk-load via temporary tables and `INSERT … SELECT`: more complex for a smaller gain.

## Consequences
10 979-file cold scan: 53.7 s → 21.9 s (persist 41.6 s → 10.5 s). Foreign keys remain enabled and
enforced for scan/project ownership and cascade deletion (tested). Node-level referential integrity
is an application invariant rather than a database constraint.
