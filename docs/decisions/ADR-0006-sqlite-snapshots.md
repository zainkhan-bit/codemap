# ADR-0006: SQLite snapshots through the GraphStore abstraction

- Status: accepted · Date: 2026-11-08

## Decision
`@codemap/storage-sqlite` implements `GraphStore` with `better-sqlite3@12.11.1` (not `node:sqlite`,
which is not yet stable). The database lives in the platform data directory
(`%LOCALAPPDATA%/CodeMap`, `~/Library/Application Support/CodeMap`, `$XDG_DATA_HOME/codemap`;
`CODEMAP_DATA_DIR` overrides) — never in the scanned project.

Pragmas: `foreign_keys=ON`, `journal_mode=WAL`, `busy_timeout=5000`, `synchronous=NORMAL` (the data
is derived and rebuildable), `cache_size=64 MiB`. JSON support is verified on open. Migrations are
numbered and checksummed, and refuse to run against a newer or tampered database.

Each scan is written as `running` and promoted to `completed` only after its graph transaction
succeeds; failed or cancelled scans have their partial rows removed. Five completed scans per
project are retained.

## Alternatives
- `node:sqlite`: no native dependency, but marked Release Candidate.
- JSON files per snapshot: no transactions, no cache index, poor query path for the future API.

## Consequences
The database schema version (1) is independent of the graph schema version (`1.0`).
See ADR-0010 for measured deviations from the blueprint's baseline SQL.
