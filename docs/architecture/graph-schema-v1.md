# CodeMap IR v1 (graph schema `1.0`)

Source of truth: [`packages/contracts/src/graph.ts`](../../packages/contracts/src/graph.ts).
Runtime validation: `validateGraphSchema` (structure) and `validateGraphInvariants` (cross-entity).

## Entities

| Kind | Meaning | Key fields |
|---|---|---|
| `project` | The scanned repository. ID = `prj_` + hash of the canonical root (case-folded on Windows/macOS); the root itself never appears in the graph. | `name` = directory basename |
| `directory` | A directory containing scanned source files. | `path` |
| `file` | A scanned source file. | `path`, `language`, `attributes.{sizeBytes, contentHash, syntaxStatus}` |
| `module` | A logical package boundary from a manifest (`package.json` `name`, `pyproject.toml` `[project].name`). Membership = longest directory prefix. | `name`, `path`, `attributes.ecosystem` |
| `package` | External package or standard-library module. | `name`, `attributes.ecosystem` ∈ `npm`, `node_builtin`, `pypi`, `stdlib` |
| `symbol` | A declaration. | `symbolKind`, `qualifiedName`, `location`, `attributes.{exported, modifiers, languageKind, duplicateOrdinal}` |

`symbolKind` ∈ `class interface trait enum function method constructor field property variable type namespace module unknown`.

## Edges (only for resolved references)

| Kind | Source → target | Created when |
|---|---|---|
| `contains` | project/directory → directory/file; file/symbol → symbol | Always (structural; no evidence). |
| `imports` | file → file / package | An import (or re-export, literal `require`/`import()`) resolved with medium or high confidence. Attributes: `typeOnly`, `reExport`, `dynamic`, `submodule`. |
| `exports` | file → symbol | An export statement whose local or re-exported declaration was found. |
| `calls` | symbol (or file for top-level code) → symbol | A call resolved under the static call policy (see resolution-strategy.md). |
| `extends` / `implements` | symbol → symbol | Heritage clause resolved to a declaration. |

Every non-`contains` edge has ≥1 `evidenceReferenceIds`. Repeated relations are aggregated into
one edge whose ID is `hash(kind, source, target)` and whose evidence lists every reference.
`confidence` is the highest among its evidence.

## References

Every import, export, call, `extends` and `implements` fact becomes a `GraphReference`, resolved
or not. `status`:

| Status | Meaning |
|---|---|
| `resolved_internal` | Target is a node of this scan (`targetNodeId` set). |
| `resolved_external` | Target is a `package` node. |
| `unresolved` | No static target; `message` explains why. Never an edge. |
| `ambiguous` | Several equally valid targets; candidates in `attributes.candidateTargets` / `candidateNodeIds`. Never an edge. |
| `ignored` | Intentionally not resolved (asset imports, external resolution disabled). |
| `not_applicable` | Reserved. |

`rawText` is a bounded (≤200 chars) syntax summary — never a statement body. Absolute paths in
`rawText`, `specifier` and `message` are replaced with `<absolute-path>`.

## Confidence and resolution methods

`high` = deterministic (exact relative path, tsconfig `paths`, declared dependency, same-file
symbol). `medium` = convention (build-output→source mapping in workspace packages, script-directory
Python import, static member access through a class). `low` = never turned into an edge.

Methods: `relative_path`, `tsconfig_paths`, `tsconfig_base_url`, `package_exports`,
`package_imports`, `package_main`, `workspace_package`, `python_package_path`,
`python_source_root`, `stdlib`, `manifest_dependency`, `same_file_symbol`, `import_binding`,
`this_member`.

## Identifiers

`<prefix>_<first 32 hex of SHA-256(identity)>`; identity parts are length-prefixed to avoid
concatenation collisions. An `IdRegistry` verifies equal IDs come from equal identities.

| Entity | Identity |
|---|---|
| file / directory | `v1 · kind · repository-relative path` |
| symbol | `v1 · path · symbolKind · qualifiedName · signatureFingerprint · duplicateOrdinal` |
| edge | `v1 · kind · sourceId · targetId` |
| reference | `v1 · kind · path · startByte · endByte · payload` |
| package | `v1 · ecosystem · name` |

Symbol IDs do not depend on line numbers, so inserting unrelated lines does not change them.
Identical declarations get a deterministic ordinal and a `GRAPH001` diagnostic.

## Locations

Repository-relative POSIX paths (NFC). `startByte`/`endByte`: zero-based UTF-8 offsets, end
exclusive. Lines/columns: one-based; columns count UTF-16 code units. Files that are not valid
UTF-8 get a `PARSE004` diagnostic saying offsets are approximate.

## Projections

`directory_view`, `file_dependency_view`, `module_view` (derived, aggregated edges with
`attributes.derived = true`), `symbol_view`, `call_view`. Projections never modify the snapshot.
Default filter: `minConfidence = medium`.

## Versioning

`schemaVersion` changes only with a migration note in CHANGELOG. The database schema version is
independent (see storage).
