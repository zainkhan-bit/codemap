# Parser adapter contract

Source: [`packages/contracts/src/extraction.ts`](../../packages/contracts/src/extraction.ts).

An adapter turns **source bytes** into a path-independent `FileExtraction`:
imports, exports, symbols, calls, inheritance facts and diagnostics, each with a `SourceSpan`
relative to the buffer. The orchestrator attaches paths; the graph builder creates IDs.

Adapters **must not** read disk, resolve modules, touch SQLite, create graph IDs, spawn processes
or import UI code. Parsers are created per adapter instance (worker-scoped), never shared global state.

## Runtime

`@codemap/parser-runtime` wraps `web-tree-sitter` 0.25.10 with grammars loaded from packaged
`.wasm` files (never downloaded at scan time):

| Grammar | Version | License |
|---|---|---|
| tree-sitter-javascript | 0.25.0 | MIT |
| tree-sitter-typescript (typescript + tsx) | 0.23.2 | MIT |
| tree-sitter-python | 0.25.0 | MIT |

Limits (`ParserLimits`): `maxFileSizeBytes` (default 2 MB), `parseTimeoutMs` (10 s, enforced via
Tree-sitter's progress callback → `PARSE003`), `maxTreeDepth` (2000; deeper nesting is skipped with
`PARSE004`). A crash while parsing one file becomes a `PARSE002` diagnostic for that file only.

## Capability matrix (v0.1.0)

| Capability | JavaScript / TypeScript | Python |
|---|---|---|
| Imports | ESM `import`, `export … from`, literal `import()`, literal `require()`, `import x = require()`, type-only, aliases, namespace imports, import attributes (raw) | `import a.b`, `import a as b`, `from … import`, relative levels, wildcard, literal `importlib.import_module()` / `__import__()` |
| Non-literal dynamic imports | recorded as dynamic, never resolved | recorded as dynamic, never resolved |
| Exports | declarations, `export {}`, default (named/anonymous), re-exports (`{}`, `*`, `* as ns`), CommonJS `module.exports`/`exports.x` | implicit: module-level names; `_private` marked not exported |
| Symbols | function, generator, arrow/function-expression bindings, class (incl. abstract & class expressions), method, constructor, field, interface, type alias, enum, namespace, module-level variables, TS overload signatures | function, async, class, method, constructor (`__init__`), class fields, module variables, decorators (as modifiers) |
| Calls | direct, member chains, `this.x()`, `super`, `new X()`; computed callees recorded as dynamic | direct, attribute chains, `self/cls.x()`; computed callees recorded as dynamic |
| Inheritance | `extends`, `implements`, interface `extends` | base classes (keyword args like `metaclass=` ignored) |
| Recovery | partial extraction from Tree-sitter's error-recovered tree, `PARSE001` | same |
| Unsupported constructs | computed method names, expression heritage → `PARSE004` | expression base classes → `PARSE004` |

## Conformance suite

[`tests/conformance/adapter-conformance.test.ts`](../../tests/conformance/adapter-conformance.test.ts)
runs the same 16 scenarios against every adapter: valid file, recoverable syntax error, Unicode
before a declaration (exact byte offset + UTF-16 column), same simple names in different scopes,
nesting, import aliases, re-exports, non-literal dynamic imports, empty/comment-only files, size
limit, time budget (and parser reuse after a cancelled parse), deep nesting guard, unsupported
syntax diagnostic, deterministic repeat output, bounded summaries.

## Adding a language

1. Add a grammar `.wasm` dependency (exact version, license audit) and an adapter package
   depending only on `contracts` + `parser-runtime`.
2. Pass the conformance suite by adding a `cases` entry.
3. Add a resolver package and fixtures.
4. Register both in `@codemap/application`.
