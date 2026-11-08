# Third-party notices

Runtime dependencies shipped with or installed by CodeMap v0.1.0. Audited 2026-11-08 from the
installed packages' `package.json` and license files. All are MIT-licensed except the optional PNG rasterizer (MPL-2.0, used unmodified as a library).

| Package | Version | License | Copyright | Used by |
|---|---|---|---|---|
| web-tree-sitter | 0.25.10 | MIT | © 2018-2024 Max Brunsfeld | parser-runtime (WASM runtime) |
| tree-sitter-javascript | 0.25.0 | MIT | © 2014 Max Brunsfeld | JS/TS adapter (`tree-sitter-javascript.wasm`) |
| tree-sitter-typescript | 0.23.2 | MIT | © 2017 Max Brunsfeld | JS/TS adapter (`tree-sitter-typescript.wasm`, `tree-sitter-tsx.wasm`) |
| tree-sitter-python | 0.25.0 | MIT | © 2016 Max Brunsfeld | Python adapter (`tree-sitter-python.wasm`) |
| better-sqlite3 | 12.11.1 | MIT | © 2017 Joshua Wise | storage-sqlite (bundles SQLite, public domain) |
| bindings | 1.5.0 | MIT | © 2012 Nathan Rajlich | better-sqlite3 |
| file-uri-to-path | 1.0.0 | MIT | © 2014 Nathan Rajlich | bindings |
| @resvg/resvg-js | 2.6.2 | MPL-2.0 | resvg-js contributors (github.com/yisibl/resvg-js; no copyright line in the package) | rasterizer-png (optional; prebuilt per-platform binary) |
| ignore | 7.0.5 | MIT | © 2013 Kael Zhang and contributors | scanner (`.gitignore` semantics) |

Install-time only: `prebuild-install` (MIT) downloads the prebuilt `better-sqlite3` binary when
the CLI is installed. CodeMap itself makes no network requests at scan time.

`tree-sitter-typescript@0.23.2` declares `tree-sitter-javascript@0.23.1` as a dependency (its
grammar source); CodeMap loads only the 0.25.0 JavaScript grammar.
