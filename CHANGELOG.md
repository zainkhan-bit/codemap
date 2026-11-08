# Changelog

All notable changes to this project are documented here. The project follows
[Semantic Versioning](https://semver.org/). Graph schema and database schema versions are listed
separately because they change independently of the tool version.

## [0.1.0] — unreleased

Graph schema `1.0` · database schema `1`.

### Added
- `codemap` CLI: `scan`, `summary`, `analyze --cycles`, `export` (JSON, SVG, Mermaid), `deps`,
  `projects`, `cache clear`, `data location`, `doctor`, with stable exit codes and `--json` output.
- JavaScript/TypeScript/JSX/TSX and Python adapters on Tree-sitter WebAssembly grammars.
- Static module resolution: relative paths, tsconfig/jsconfig `paths`/`baseUrl`, `package.json`
  `exports`/`imports`/`main`, workspace packages, Node builtins, declared npm dependencies; Python
  source roots, packages, submodules, standard library and declared dependencies.
- Static linking of exports, calls and inheritance with evidence, confidence and reasons for every
  unresolved or ambiguous reference.
- Optional PNG export through the isolated `@codemap/rasterizer-png` package (resvg); a clear error
  when it is unavailable on a platform.
- SVG layout routes multi-layer edges around nodes, separates 2-cycle edges and draws self-imports.
- Circular dependency detection (Tarjan SCC), fan-in/fan-out, reachability, projections.
- SQLite snapshots with content-hash parse cache, safe promotion of completed scans, retention.
- Safe scanning: no symlink following, secret-file exclusion, `.gitignore`/`.codemapignore`,
  size and count limits, parse time budget, no writes to the scanned project.

### Known limitations
See README “Limitations”. No dashboard, Java or Dart in this release.
