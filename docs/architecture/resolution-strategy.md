# Resolution strategy

Resolution runs after parsing, every scan, from the file inventory plus static snapshots of
allowlisted config files (`package.json`, `tsconfig*.json`, `jsconfig.json`, `pyproject.toml`,
`setup.cfg`, `requirements*.txt`, `pnpm-workspace.yaml`). Resolvers never read disk, never look
inside `node_modules`/site-packages and never run package managers or compilers. Changing a config
file therefore re-resolves everything without reparsing unchanged sources.

Multiple equally valid targets are reported as `ambiguous` with candidates — never silently
picked. Anything not provable is `unresolved` with a reason.

## JavaScript / TypeScript (`resolver-javascript-typescript`)

Order for each specifier:

1. Non-literal → `unresolved` (`RESOLVE001`).
2. Node builtins (`node:fs`, `fs`, `fs/promises`) → `resolved_external` (`node_builtin`).
3. Relative (`./`, `../`): leaving the root → `unresolved`; asset extensions (`.css`, `.svg`, `.json`, …) → `ignored`; else probe.
4. Absolute paths / URLs → `unresolved`.
5. `#subpath` → nearest `package.json` `imports` (exact or single `*` pattern).
6. Nearest `tsconfig.json`/`jsconfig.json` `paths` (longest prefix wins; targets tried in order), then `baseUrl`.
7. Workspace package (any scanned `package.json` with that `name`): `exports` (conditions `types, import, module, require, node, default`, subpath patterns), then `source/types/typings/module/main`, then `index`, then `src/index`.
8. Declared dependency in any ancestor `package.json` (`dependencies`, `devDependencies`, `peer…`, `optional…`; `@types/x` for type-only imports) → `resolved_external` (`npm`).
9. Otherwise `unresolved`: “package is not declared in any package.json”.

**Probing** (tiered): exact file → extension candidates (incl. TypeScript's `.js→.ts/.tsx/.d.ts`,
`.mjs→.mts`, `.cjs→.cts`) → `package.json` entry of a directory → `index.*`. Within a tier the
importer's family wins (TS importer: `.ts/.tsx` › `.d.ts` › `.js`; JS importer: `.js` first);
remaining ties are `ambiguous` (e.g. `dup.ts` + `dup.tsx`).

**Build output mapping**: workspace `exports`/`main` usually point at `dist/`, which is excluded
from scanning. `dist|lib|build|out|esm|cjs/<x>.js` is mapped to `src/<x>.*` with **medium**
confidence.

**Partially supported** (reported with `RESOLVE003`): `extends` of a package tsconfig
(`@tsconfig/…`), `compilerOptions.rootDirs`. Not supported: project references' build graph,
`moduleSuffixes`, `customConditions`, Yarn PnP, import maps. TypeScript compiler semantics are
**not** used (ADR-0004): no `@typescript/typescript6` dependency in v0.1.0.

## Python (`resolver-python`)

Source roots: repository root, every directory with `pyproject.toml`/`setup.cfg`, their `src/`,
roots declared in pyproject (`where = [...]`, poetry `from = "..."`, `package-dir`), and a root
`src/` when the root holds no top-level modules.

1. Non-literal (`importlib.import_module(name)`) → `unresolved`.
2. Relative (`from ..x import y`): climb `level-1` directories from the importing file's directory.
3. Standard library (static list, CPython 3.9–3.13) → `resolved_external` (`stdlib`); a local
   module shadowing it → `ambiguous`.
4. Absolute: `root/a/b.py`, `.pyi`, or `root/a/b/__init__.py` in every source root; found in
   several roots → `ambiguous`. A directory without `__init__.py` is a namespace package → no file
   target (`RESOLVE003`) unless the imported names are submodules.
5. Script-directory fallback (importer's own directory) → **medium** confidence.
6. Declared distributions (`[project].dependencies`, optional/dependency groups, poetry tables,
   `setup.cfg install_requires`, `requirements*.txt`) mapped to import names (normalized, plus a
   small alias table such as `PyYAML→yaml`, `beautifulsoup4→bs4`) → `resolved_external` (`pypi`).
7. Otherwise `unresolved`.

`from pkg import name` where `name` is a submodule produces `nameTargets`: an extra import edge to
the submodule file and a module binding for call resolution. Runtime `sys.path` changes are not
followed.

## Symbol linking (graph engine)

Calls, inheritance and exports are linked after module resolution, using only static evidence:

| Pattern | Resolution | Confidence |
|---|---|---|
| `f()` with exactly one same-file function/class `f` | `same_file_symbol` | high |
| `f()` where `f` is an imported binding to a resolved export | `import_binding` | high |
| `ns.f()` where `ns` is a namespace import of a resolved module | `import_binding` | high |
| `this.m()` / `self.m()` with exactly one `m` declared in the enclosing class | `this_member` | high |
| `new C()` / `C()` with an unambiguous class | `same_file_symbol` / `import_binding` | high |
| `C.m()` where `C` resolves to a class declaring one `m` | — | medium |
| Several same-name candidates | `ambiguous` | — |
| Inherited members, `super`, dynamic dispatch, receivers that are expressions, computed names, callbacks, DI, reflection | `unresolved` with reason | — |
| Callee bound to an external package import | `resolved_external` (no edge) | high |

The call graph is **not complete** and is never presented as such.
