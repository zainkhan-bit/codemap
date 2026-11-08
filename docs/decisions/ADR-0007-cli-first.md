# ADR-0007: CLI-first implementation and deferred local dashboard

- Status: accepted · Date: 2026-11-08

## Decision
v0.1.0 ships only the `codemap` CLI: `scan`, `summary`, `analyze --cycles`, `export`, `deps`,
`projects`, `cache clear`, `data location`, `doctor`. Exports (JSON, SVG, Mermaid, PNG) need no browser. PNG goes through the optional
`@codemap/rasterizer-png` package (resvg, prebuilt native binaries) loaded lazily by the
application; when it cannot load, the command fails with a message pointing to SVG instead of
writing a blank image.
The loopback HTTP API and dashboard (blueprint §13, Stage 6) are not implemented and need separate
approval. `--no-open` is accepted now for forward compatibility.

Exit codes are stable: 0 ok · 1 completed with partial analysis (a file failed to parse or an
error diagnostic exists) · 2 invalid input/config/unknown project · 3 path access · 4 storage ·
5 internal · 130 cancelled.

## Consequences
All read paths (summary, analyze, export, deps) go through `@codemap/application`, so the future
API can reuse them unchanged.
