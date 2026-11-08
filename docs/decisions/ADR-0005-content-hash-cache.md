# ADR-0005: Content-hash parser cache and full re-resolution per scan

- Status: accepted · Date: 2026-11-08

## Decision
Parse artifacts are cached by SHA-256 of (content hash, adapter id/version, grammar fingerprint,
extraction schema version, options hash). Artifacts are path-independent, so renamed or copied files
reuse them. Resolution, linking and graph materialization are recomputed on every scan.
Modification times are recorded but never trusted for correctness. No file watching in v0.1.0.

## Alternatives
- mtime-based invalidation: fast but incorrect after checkouts, copies and clock skew.
- Incremental re-resolution: complex to make correct; deferred until the full scan is benchmarked.

## Consequences
Verified end to end: an unchanged rescan parses 0 files; editing one file reparses exactly one; a
renamed import target leaves no stale edge. The cache is bounded (512 MiB, least recently used
evicted) and clearable with `codemap cache clear`.
