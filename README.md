# CodeMap

**Local-first architecture maps for JavaScript, TypeScript and Python repositories.**

CodeMap scans a repository on your machine and builds an evidence-backed graph of its
architecture: files, directories, packages, declarations, imports, exports, calls and inheritance.
It finds circular dependencies, shows hotspots, and exports JSON, SVG or Mermaid — offline, without
running your code and without writing to your project.

> Status: **v0.1.0 (pre-release)**. CLI only; the interactive dashboard is planned, not built.

## Why

Static architecture tools often draw confident arrows they cannot justify. CodeMap keeps every
source fact as a *reference* and only draws an *edge* when the target is proven. Unresolved,
ambiguous and external references stay visible with a reason, and every edge links back to the
source locations that justify it.

## Install

Requires **Node.js 24 or newer**.

From a clone (until the packages are published to npm):

```bash
corepack enable
pnpm install
pnpm build
node apps/cli/dist/index.js --help
```

`pnpm link --global` inside `apps/cli` puts `codemap` on your PATH. `better-sqlite3` installs a
prebuilt native binary for your platform; parsing uses WebAssembly grammars and needs no compiler.

If install fails on Windows with `Could not find any Visual Studio installation`, the prebuilt
SQLite binary download failed (it is intermittently flaky) and the installer fell back to compiling.
Re-run `pnpm install`; installing the Visual Studio C++ build tools also works.

## Quick start

```bash
codemap scan .
```

```text
CodeMap scanned scn_mw7ma9ik_85f986be (project prj_0be257bb0b585492716d819d4e85e3a9)
  files      6 (javascript 6)
  parsed     6 parsed, 0 reused from cache, 0 failed, 0 skipped
  graph      24 nodes, 45 edges, 29 references (2 unresolved/ambiguous)
  cycles     2 circular dependencies
  issues     0 errors, 0 warnings, 0 info
  time       62 ms
```

```bash
codemap summary                          # hotspots (fan-in/fan-out), cycles, unresolved counts
codemap analyze --cycles                 # every circular import, with a concrete path
codemap deps src/index.ts --depth 3      # what a file depends on (--reverse: who depends on it)
codemap export --format svg -o map.svg   # file dependency diagram, no browser needed
codemap export --format json -o graph.json
codemap export --format mermaid --view module_view
codemap export --format png -o map.png   # needs the optional rasterizer (prebuilt for common platforms)
```

```text
$ codemap analyze --cycles
2 circular dependencies (strongly connected components of resolved imports)
#1 2 files
   src/b.js → src/a.js → src/b.js
#2 self-import
   src/self.js → src/self.js
```

No configuration file is needed. Read commands pick the project for the current directory; use
`--project <id>` or `--scan <id>` to choose explicitly (`codemap projects` lists them).

## Commands

```text
codemap scan [path] [--json] [--max-file-size <bytes>] [--no-open]
codemap summary [--project <id>] [--scan <id>] [--json]
codemap analyze --cycles [--project <id>] [--scan <id>] [--exclude-type-only] [--json]
codemap export --format json|svg|mermaid|png [--output <file>] [--scan <id>] [--project <id>]
               [--view <view>] [--path <dir>] [--force]
codemap deps <file|symbol|node-id> [--reverse] [--depth <n>] [--json]
codemap projects [--json]
codemap cache clear [--all]
codemap data location
codemap doctor
codemap --version | --help
```

Views: `file_dependency_view` (default), `module_view`, `directory_view`, `symbol_view`, `call_view`.
Large diagrams are refused above 300 nodes unless you narrow them with `--path <dir>` or pass `--force`.

`--json` prints machine-readable output only (progress goes to stderr).
Exit codes: `0` ok · `1` scan completed with partial analysis (a file failed to parse or an error
diagnostic exists) · `2` invalid arguments/configuration · `3` path error · `4` storage error ·
`5` internal error · `130` cancelled (Ctrl+C).

## What is supported

| | JavaScript / TypeScript | Python |
|---|---|---|
| Files | `.js .mjs .cjs .jsx .ts .mts .cts .tsx` | `.py .pyi` |
| Imports | ESM, re-exports, literal `import()`/`require()`, type-only | `import`, `from … import`, relative, literal `importlib.import_module` |
| Resolution | relative + extension/index probing (incl. `.js→.ts`), tsconfig/jsconfig `paths` + `baseUrl`, `package.json` `exports`/`imports`/`main`, workspace packages, Node builtins, declared npm dependencies | source roots (`src/`, pyproject `where`/poetry `from`), packages and `__init__.py`, submodules, standard library, declared dependencies (pyproject, setup.cfg, requirements) |
| Declarations | classes, interfaces, enums, type aliases, namespaces, functions, arrow functions, methods, constructors, fields, module variables | classes, functions, methods, `__init__`, class fields, module variables |
| Calls (static only) | same-file, imported, namespace, `this.m()`, `new C()` | same-file, imported, module attribute, `self.m()`, `C()` |
| Inheritance | `extends`, `implements` | base classes |

Details: [resolution strategy](docs/architecture/resolution-strategy.md) ·
[parser capability matrix](docs/architecture/parser-contract.md) ·
[graph schema](docs/architecture/graph-schema-v1.md).

## Limitations (read these)

- **The call graph is incomplete by design.** Inherited members, `super`, dynamic dispatch,
  callbacks, dependency injection and reflection are reported as unresolved references, not edges.
- No type checking: the TypeScript compiler is not used. Some tsconfig features (package `extends`,
  `rootDirs`, project-reference builds) are partial and reported with `RESOLVE003`.
- Workspace packages whose `exports` point at `dist/` are mapped to `src/` by convention, with
  **medium** confidence.
- Python: runtime `sys.path` changes and namespace packages without the imported submodule are not
  resolved; standard-library detection uses a static list for CPython 3.9–3.13.
- Bare packages not declared in any manifest stay **unresolved** rather than being guessed.
- Java and Dart are not supported yet.
- Parsing runs on the main thread with a per-file time budget; there is no worker pool yet.
- CI covers Windows, macOS and Linux on Node 24 and 26.

## Privacy and safety

- No network requests, telemetry or accounts. The code base contains no network or subprocess
  modules (enforced in CI).
- Never executes project code, package scripts, package managers or build tools.
- Never writes inside the scanned directory. Data lives in `codemap data location`
  (`%LOCALAPPDATA%\CodeMap`, `~/Library/Application Support/CodeMap` or `~/.local/share/codemap`).
  It is derived data and safe to delete.
- `.env*`, private keys and similar files are never read. Exports contain repository-relative paths
  only; absolute paths that appear in source are replaced with `<absolute-path>`.
- Symbolic links are never followed.

## Configuration (optional)

`codemap.config.json` at the repository root:

```json
{
  "version": 1,
  "include": ["src/**"],
  "exclude": ["**/generated/**"],
  "maxFileSizeBytes": 2000000,
  "maxFiles": 50000,
  "concurrency": "auto",
  "languages": ["javascript", "typescript", "python"],
  "resolution": { "typescript": true, "python": true, "resolveExternalPackages": true },
  "analysis": { "calls": true, "inheritance": true, "cycles": true }
}
```

Unknown keys produce warnings; invalid values stop the scan with exit code 2. `.gitignore` and
`.codemapignore` (which can re-include with `!pattern`) are honoured. See
[scanning pipeline](docs/architecture/scanning-pipeline.md) for the exact precedence.

## Performance

Measured, not promised — see [docs/development/performance-baseline.md](docs/development/performance-baseline.md).
On a 4-core laptop (i5-1145G7, Windows 11): ~1 300 files in 2.6 s, ~11 000 files in 22 s cold
(18 s with a warm parse cache).

## Development

```bash
pnpm install
pnpm build            # tsc -b over all packages
pnpm lint             # package boundary rules
pnpm test             # build + unit, conformance, integration and security tests
node tests/performance/bench.mjs 1000 10000
```

Architecture: [system overview](docs/architecture/system-overview.md) ·
[decisions](docs/decisions) · [contributing](CONTRIBUTING.md) · [security](SECURITY.md).

## License

MIT — see [LICENSE](LICENSE) and [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).
