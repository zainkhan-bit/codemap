# CodeMap — Engineering Blueprint & AI Agent Handoff

**Document status:** Approved architecture baseline  
**Document date:** 6 November 2026  
**Product:** CodeMap  
**Release target:** v0.1.0 (MVP)  
**Project type:** Local-first, open-source developer tool  
**License recommendation:** MIT  
**Primary distribution:** npm CLI package  
**Interfaces:** CLI first; local browser dashboard later  

> **Instruction to implementation agents:** This document is the architecture source of truth. Read it completely before editing the repository. Do not implement the dashboard in the initial execution stage. First deliver the scanner, parser adapters, dependency resolution, canonical graph model, persistence, graph algorithms, exports and CLI. The dashboard is a later consumer of the stable engine and API contracts.

---

# 1. Executive decision

CodeMap analyzes a local software repository and produces a normalized, evidence-backed model of its architecture. Developers can use the CLI to scan a project, inspect the resulting graph, identify dependencies and architectural issues, and export diagrams. A local browser dashboard will provide richer exploration after the core engine is proven stable.

The central architecture decision is:

**All languages must feed one canonical, language-neutral intermediate representation (IR). The graph engine must never depend on a parser implementation, and the user interface must never parse source code.**

This creates the following dependency direction:

```text
CLI / (later) Dashboard
          |
          v
Application Services
          |
          v
Scanner -> Parser Adapters -> Extraction IR
                              |
                              v
                    Dependency Resolvers
                              |
                              v
                       Graph Builder
                              |
                +-------------+-------------+
                |             |             |
                v             v             v
             Storage      Analysis       Exporters
```

The dashboard is deliberately excluded from the first implementation stage. It will consume the same application services and graph contracts as the CLI; it will not have its own parser or graph-building logic.

# 2. Final architecture decisions

| Area | Approved decision | Reason |
|---|---|---|
| Runtime | Node.js 24+; CI on Node 24 and 26 | Both are supported LTS lines as of this document date; Node 26 is Active LTS and Node 24 is Maintenance LTS. |
| Language | TypeScript with strict settings | One implementation language for the core, CLI and later web app. |
| Repository | pnpm monorepo | Independent packages with explicit boundaries and shared contracts. |
| Syntax parsing | Tree-sitter through a parser-runtime abstraction; prefer WebAssembly grammars initially | Multi-language parsing, syntax-error tolerance, incremental parsing capability and fewer OS-specific parser build requirements. |
| JavaScript/TypeScript | Tree-sitter syntax extraction plus a separately isolated TypeScript semantics/resolution provider | Avoid coupling the entire tool to a changing TypeScript compiler API. |
| Other languages | Tree-sitter grammar plus language-specific extraction and resolution adapter | Reuse the parsing foundation while preserving language-specific import rules. |
| Canonical data | Versioned CodeMap IR / graph schema | Enables multiple parsers, CLI, dashboard, storage and exporters to interoperate. |
| Dependency resolution | Separate project-aware resolver stage | Parsing and resolving are different responsibilities; config changes must not require reparsing every file. |
| Graph algorithms | Pure TypeScript package operating on normalized graph data | Deterministic, testable and independent of UI. |
| Persistence | SQLite behind a storage interface; use `better-sqlite3` initially | Reliable local snapshots and cache; database library can be replaced without changing the engine. |
| Cache | Content hash + adapter/parser version + extraction version | Modification timestamps alone are not a correctness guarantee. |
| Local service | Later, loopback-only HTTP service with ephemeral access token | Dashboard can be local without exposing the repository to a network. |
| Visualization | Cytoscape.js for the future interactive dashboard | Designed for graph/network visualization. |
| Layout/export | Separate layout and SVG-renderer package; PNG rasterizer is isolated | CLI exports must not require a browser or dashboard. |
| Network/AI | No network calls, telemetry, account, or AI API in core | Local-first privacy promise. |
| Source execution | Never execute scanned project code, scripts, package managers or build tools | Scanning an untrusted repository must be a read-only static operation. |

## 2.1 TypeScript API policy

Do not import or expose the TypeScript compiler API directly from the CodeMap core.

As of 6 November 2026, TypeScript 7.0 does not ship the previous programmatic API, while TypeScript 7.1 has introduced a new API that is still in beta. Therefore:

1. Tree-sitter is the baseline syntax parser for JavaScript and TypeScript.
2. JavaScript/TypeScript module resolution is isolated behind `TypeScriptResolutionProvider`.
3. The initial provider may use the stable TypeScript 6 compatibility API package (`@typescript/typescript6`) where its resolver offers material correctness benefits. It must be imported only inside the TypeScript provider package.
4. A provider based on the new TypeScript 7.1 API may be added only after that API reaches a stable release and passes CodeMap's adapter conformance suite.
5. If a project uses a TypeScript feature or resolution mode that the active provider cannot understand, CodeMap must report partial/unknown resolution. It must not silently guess.

This isolates the API transition and prevents a TypeScript upgrade from forcing a rewrite of the graph engine.

## 2.2 Parser runtime policy

Define a `ParserRuntime` interface. Prefer `web-tree-sitter` with packaged WebAssembly grammars for the first release to reduce native toolchain and OS-specific installation friction. The runtime must be replaceable by a native Tree-sitter binding later if benchmarks justify it.

Before committing to all grammars, the implementation agent must complete a small parser-runtime spike proving that the selected runtime and packaged grammars work on Windows, macOS and Linux with the supported Node versions. Record grammar licenses and exact versions. Do not download grammars at scan time.

## 2.3 SQLite policy

Use SQLite through `@codemap/storage-sqlite`, not directly from scanner/parser/graph packages. Start with `better-sqlite3` and keep the driver behind `GraphStore` interfaces. Do not make the core dependent on Node's `node:sqlite` API while the official Node documentation still marks it as Release Candidate.

Use WAL mode, foreign keys, a busy timeout and parameterized SQL. Since the stored graph and parse artifacts are derived data, `synchronous=NORMAL` is an acceptable default in WAL mode; document that the database is rebuildable and allow a stronger durability setting if later required.

# 3. Product boundaries and non-goals

## 3.1 In scope

- Scan a local repository without modifying it.
- Discover source files and project manifests.
- Parse supported languages into normalized extraction facts.
- Resolve internal imports and known external package references.
- Extract declarations: classes, interfaces, functions, methods and other supported symbols.
- Extract direct call sites and resolve only relationships that can be supported by static evidence.
- Build deterministic nodes, edges, references and diagnostics.
- Detect circular dependencies in the resolved file/module import graph.
- Persist immutable scan snapshots and reusable parse artifacts.
- Provide CLI commands and machine-readable output.
- Export at least JSON and SVG without a browser.
- Add a local dashboard in a later phase using the stable engine/API.

## 3.2 Explicitly out of scope for v0.1.0

- AI-generated explanations or LLM dependency.
- Cloud processing, source uploads, accounts and collaboration.
- Remote hosted dashboard.
- IDE extensions.
- Automatic code modification or automatic fixes.
- Running tests, builds, package scripts or project code.
- Complete runtime call graphs.
- Perfect reflection/dynamic dispatch resolution.
- Full semantic analysis of every language.
- Live multi-user collaboration.
- Java and Dart adapters in the initial MVP (they are planned adapters after the initial three-language release).

# 4. Architecture principles and quality attributes

1. **Separation of concerns:** Discovery, parsing, resolution, graph construction, persistence, visualization and export are independent modules.
2. **Language neutrality:** The graph schema must not contain AST objects, Tree-sitter node types or compiler-specific objects.
3. **Evidence first:** Every resolved relationship has source evidence and a resolution method. Unresolved references are preserved as unresolved facts, not fabricated edges.
4. **Determinism:** The same source tree, configuration and CodeMap versions must produce the same normalized graph IDs and equivalent graph content.
5. **Read-only scanning:** No project file is written, formatted, generated or changed.
6. **Local-first:** No network request is needed for scanning, graph analysis or exporting.
7. **Bounded work:** File size, worker count, parser time, memory, symlink traversal and graph result size must have explicit limits.
8. **Recoverability:** An interrupted scan must not replace the latest successful scan.
9. **Extensibility:** Adding a parser must not require a change to the graph schema for ordinary language-specific declarations.
10. **Truthful static analysis:** The product must show confidence and unresolved status instead of presenting heuristics as certainty.

# 5. Package architecture and responsibilities

Use a pnpm workspace. Avoid a generic `shared` package that accumulates unrelated code. Packages should have narrow responsibilities.

## 5.1 Approved package map

```text
codemap/
├── apps/
│   └── cli/                         # Implement first
│       └── src/
│           ├── commands/
│           ├── output/
│           └── index.ts
│
├── packages/
│   ├── contracts/                   # Versioned public/internal data contracts
│   ├── scanner/                     # Safe filesystem discovery and file inventory
│   ├── parser-runtime/              # Tree-sitter runtime lifecycle and grammar loading
│   ├── adapters/
│   │   ├── javascript-typescript/   # JS/TS/JSX/TSX extraction
│   │   ├── python/                 # Python extraction
│   │   ├── java/                   # Later
│   │   └── dart/                   # Later
│   ├── resolvers/
│   │   ├── javascript-typescript/   # Node/TS package and path resolution
│   │   ├── python/                 # Python import resolution
│   │   ├── java/                   # Later
│   │   └── dart/                   # Later
│   ├── graph-engine/               # IDs, graph builder, projections, algorithms
│   ├── storage-sqlite/             # SQLite schema, migrations and repositories
│   ├── exporters/                  # JSON and SVG; PNG rasterizer isolated
│   └── application/                # Scan orchestration and use cases
│
├── docs/
│   ├── architecture/
│   ├── decisions/
│   ├── contracts/
│   ├── development/
│   └── security/
├── tests/
│   ├── fixtures/
│   ├── integration/
│   ├── performance/
│   └── security/
├── examples/
├── .github/
│   ├── workflows/
│   ├── ISSUE_TEMPLATE/
│   └── PULL_REQUEST_TEMPLATE.md
├── pnpm-workspace.yaml
├── package.json
├── tsconfig.base.json
├── eslint.config.js
├── vitest.workspace.ts
├── LICENSE
├── README.md
├── CONTRIBUTING.md
├── CODE_OF_CONDUCT.md
├── SECURITY.md
└── CHANGELOG.md
```

Reserve `apps/dashboard/` in documentation, but do not implement it in the first stage. Do not create empty UI scaffolding merely to make the directory tree look complete.

## 5.2 Dependency direction

```text
contracts
  ^
  |---- scanner
  |---- parser-runtime
  |       ^
  |       |---- adapters/*
  |---- resolvers/*
  |---- graph-engine
  |---- storage-sqlite
  |---- exporters
           ^
           |
       application
           ^
           |
          CLI
```

Rules:

- `contracts` imports no other CodeMap package.
- `scanner` does not import parser adapters.
- `adapters` do not access SQLite or the UI.
- `resolvers` consume extraction facts and project configuration; they do not parse source text themselves.
- `graph-engine` has no filesystem, HTTP, SQLite, Tree-sitter, React or CLI dependencies.
- `storage-sqlite` stores validated contracts and never performs parsing/resolution.
- `exporters` consume the canonical graph; they never rescan files.
- `application` is the composition root that wires packages together.
- `CLI` calls application use cases, not low-level repository methods.
- No circular package dependencies. Enforce this in lint/CI.

# 6. Canonical graph schema (CodeMap IR v1)

The IR is the most important long-term contract. It must be versioned, validated at runtime at process boundaries, serializable to JSON and independent of programming language.

## 6.1 Entity model

### Node kinds

- `project`: the scanned repository.
- `directory`: a directory within the repository.
- `file`: a source or relevant configuration file.
- `module`: an optional logical module/package boundary identified from project metadata or explicit user configuration.
- `package`: an external package or standard-library namespace.
- `symbol`: a declaration such as class, interface, function or method.

A symbol has a `symbolKind` attribute, not a separate graph node kind for every language declaration.

Supported `symbolKind` values in v1:

`class`, `interface`, `trait`, `enum`, `function`, `method`, `constructor`, `field`, `property`, `variable`, `type`, `namespace`, `module`, `unknown`.

Adapters may emit `unknown` when a grammar node is recognized but CodeMap has no stable cross-language semantic category. Do not discard useful facts simply because a language has a unique declaration form.

### Edge kinds

- `contains`: structural containment (project → directory → file → symbol, and symbol → nested symbol when applicable).
- `imports`: a resolved file/module dependency.
- `exports`: a declaration exposed by a module/file.
- `calls`: a statically supported call relationship.
- `extends`: class/type inheritance.
- `implements`: interface/trait implementation.

Do not add a new edge kind for a visualization convenience. Derived views should be projections over these canonical relations.

## 6.2 Reference facts versus graph edges

A **reference** is a source-code fact: an import statement, call expression, inheritance clause or export declaration. A **graph edge** is a relationship whose target has been resolved to a known graph node.

All references must be retained, including unresolved or ambiguous references. Only resolved references create graph edges. This distinction prevents fake arrows and allows the UI to show unresolved dependencies explicitly.

Reference status:

- `resolved_internal`
- `resolved_external`
- `unresolved`
- `ambiguous`
- `ignored`
- `not_applicable`

Every reference records its source node/file, source location, reference kind, raw specifier or expression summary, optional resolved target, resolver name/version and confidence.

## 6.3 Confidence and resolution method

Confidence is categorical, not a fabricated probability:

- `high`: deterministic static resolution (e.g. exact relative import path).
- `medium`: valid resolution using a project convention or constrained heuristic.
- `low`: weak/inferred association; low-confidence results must not be treated as guaranteed edges in default views.

Each resolved reference includes a `resolutionMethod`, such as `relative_path`, `package_exports`, `tsconfig_paths`, `python_package_path`, `java_package_name`, `dart_package_config`, `same_file_symbol`, `import_binding`, or `semantic_provider`.

## 6.4 TypeScript contract shape

The following is the intended contract shape. The implementation may split it into files, but must preserve these semantics and field meanings.

```ts
export type NodeKind =
  | "project"
  | "directory"
  | "file"
  | "module"
  | "package"
  | "symbol";

export type EdgeKind =
  | "contains"
  | "imports"
  | "exports"
  | "calls"
  | "extends"
  | "implements";

export type ReferenceKind =
  | "import"
  | "export"
  | "call"
  | "extends"
  | "implements"
  | "type_reference";

export type ResolutionStatus =
  | "resolved_internal"
  | "resolved_external"
  | "unresolved"
  | "ambiguous"
  | "ignored"
  | "not_applicable";

export type Confidence = "high" | "medium" | "low";

export interface SourceLocation {
  /** Repository-relative POSIX path. Never an absolute machine path. */
  path: string;
  /** UTF-8 byte offsets, zero-based, end-exclusive. */
  startByte: number;
  endByte: number;
  /** Human/editor positions, one-based. Columns count UTF-16 code units. */
  startLine: number;
  startColumn: number;
  endLine: number;
  endColumn: number;
}

export interface GraphNode {
  id: string;
  kind: NodeKind;
  name: string;
  qualifiedName?: string;
  language?: string;
  path?: string;
  symbolKind?: string;
  location?: SourceLocation;
  attributes: Record<string, unknown>;
}

export interface GraphEdge {
  id: string;
  kind: EdgeKind;
  sourceId: string;
  targetId: string;
  confidence: Confidence;
  resolutionMethod?: string;
  evidenceReferenceIds: string[];
  attributes: Record<string, unknown>;
}

export interface GraphReference {
  id: string;
  kind: ReferenceKind;
  sourceNodeId: string;
  sourceLocation: SourceLocation;
  rawText: string;
  specifier?: string;
  importedNames?: string[];
  targetNodeId?: string;
  status: ResolutionStatus;
  confidence?: Confidence;
  resolverId?: string;
  resolverVersion?: string;
  message?: string;
  attributes: Record<string, unknown>;
}

export interface GraphDiagnostic {
  id: string;
  code: string;
  severity: "info" | "warning" | "error";
  message: string;
  location?: SourceLocation;
  relatedLocations?: SourceLocation[];
  attributes?: Record<string, unknown>;
}

export interface CodeMapGraph {
  schemaVersion: "1.0";
  project: {
    id: string;
    displayName: string;
    rootLabel: string;
  };
  scan: {
    id: string;
    toolVersion: string;
    startedAt: string;
    completedAt: string;
    configurationHash: string;
    parserSetHash: string;
  };
  nodes: GraphNode[];
  edges: GraphEdge[];
  references: GraphReference[];
  diagnostics: GraphDiagnostic[];
  metrics: Record<string, number>;
}
```

`attributes` must be JSON-serializable, size-bounded, documented per field and free of arbitrary source-code contents. Do not store full file contents in graph nodes or edges.

## 6.5 Stable identifiers

IDs must be deterministic and stable across repeated scans of the same repository content.

- Project ID: stable hash of a normalized project identity stored locally. Do not expose an absolute path in exported graph files.
- File node ID: hash of `v1|file|<repository-relative-path>`.
- Directory node ID: hash of `v1|directory|<repository-relative-path>`.
- Symbol node ID: hash of `v1|symbol|<path>|<symbolKind>|<qualifiedName>|<signatureFingerprint>`.
- Edge ID: hash of relationship kind, source ID, target ID and evidence/reference identity.
- Reference ID: hash of reference kind, source path, source span and normalized reference payload.

Use SHA-256 (or a documented cryptographic digest) with a stable encoding. Store a readable prefix plus enough digest characters to make collisions negligible; collision handling must still verify the full identity. Do not use random UUIDs for graph node IDs.

Symbol IDs must not depend only on line number because adding a line near the top of a file would change every symbol ID. When two declarations have identical name/kind/signature, include a deterministic duplicate ordinal and emit a diagnostic.

## 6.6 Source location rules

- Paths are relative to project root and normalized to POSIX separators in all graph outputs.
- Absolute paths are kept only in local project metadata and never in default exports.
- Byte spans are UTF-8 byte offsets, zero-based, with an exclusive end.
- Display line and column are one-based; columns use UTF-16 code units for editor/browser interoperability.
- If a parser cannot provide an exact span, mark location quality as approximate in attributes or emit no location. Do not invent a precise location.

## 6.7 Aggregation and graph projections

The canonical graph is detailed. Views are computed projections:

- `directory_view`: project, directories and files.
- `file_dependency_view`: files and resolved import edges.
- `module_view`: logical modules and inter-module dependency edges.
- `symbol_view`: files, symbols and supported symbol relationships.
- `call_view`: resolved call edges with source/target symbols.

The core graph must not be permanently flattened to one view. The future dashboard may request a projection and apply filters without changing the canonical snapshot.

# 7. Parser adapter contract

Parsing extracts facts. It does not resolve cross-file imports and does not write to the database.

## 7.1 Adapter responsibilities

Each adapter must:

1. Identify the language and supported file extensions.
2. Parse source bytes without executing source code.
3. Extract declarations, import/export statements, call sites and inheritance/type references supported by its grammar.
4. Return source spans and language-specific attributes.
5. Return parse diagnostics, including recoverable syntax errors.
6. Work with incomplete or syntactically invalid files where the parser permits recovery.
7. Avoid global mutable parser state; parser instances are worker-scoped.
8. Report unsupported syntax/constructs rather than silently dropping them.

Adapters must not:

- Read files directly from disk.
- Resolve project aliases or external packages.
- Access SQLite.
- Create graph IDs.
- Import React/Cytoscape or any dashboard package.
- Execute subprocesses.

## 7.2 Contract shape

```ts
export interface LanguageAdapter {
  readonly id: string;
  readonly version: string;
  readonly languages: readonly string[];
  readonly extensions: readonly string[];

  detect(input: DetectionInput): DetectionResult;
  parseFile(input: ParseFileInput): Promise<FileExtraction>;
}

export interface ParseFileInput {
  relativePath: string;
  language: string;
  source: Uint8Array;
  contentHash: string;
  projectConfiguration: Readonly<ProjectLanguageConfiguration>;
  limits: Readonly<ParserLimits>;
}

export interface FileExtraction {
  adapterId: string;
  adapterVersion: string;
  language: string;
  syntaxStatus: "valid" | "recovered" | "failed";
  imports: ImportFact[];
  exports: ExportFact[];
  symbols: SymbolFact[];
  calls: CallFact[];
  inheritance: InheritanceFact[];
  diagnostics: AdapterDiagnostic[];
  extractionMetrics: {
    parseDurationMs: number;
    nodeCount?: number;
  };
}
```

The actual TypeScript contracts must define every nested fact type. Fact locations should store byte spans relative to the source buffer; the orchestrator attaches the repository-relative file path after reading the cached artifact.

## 7.3 Import fact

An import fact should preserve:

- Raw module specifier.
- Import form (`static_import`, `re_export`, `dynamic_import`, `commonjs_require`, `language_specific`).
- Imported symbol names and aliases, if syntactically available.
- Type-only status, if applicable.
- Import attributes, if present.
- Source span.

Dynamic imports with non-literal expressions must be recorded as dynamic/unresolved facts with a clear reason. Do not guess the target.

## 7.4 Symbol fact

A symbol fact should include:

- Name and qualified name.
- Cross-language `symbolKind`.
- Optional signature fingerprint.
- Declaration span.
- Parent symbol (if nested).
- Export visibility where known.
- Modifiers/attributes relevant to architecture (e.g. abstract, static, async, public/private), where available.

## 7.5 Call fact

A call fact must include:

- Caller symbol ID candidate or file-level scope marker.
- Callee expression summary (not arbitrary source excerpt).
- Optional simple callee name/member chain.
- Argument count if statically available.
- Source span.
- Whether it is direct, constructor, dynamic, or otherwise uncertain.

A parser identifies the call expression. A resolver decides whether it can be connected to a symbol.

## 7.6 Adapter conformance suite

Every adapter must pass the same shared tests:

- File with valid syntax.
- File with syntax error but recoverable declarations.
- Unicode characters before a declaration to verify byte and column mapping.
- Multiple declarations with the same simple name in different scopes.
- Nested declarations.
- Imports with aliases.
- Re-exports.
- Dynamic/non-literal imports.
- Empty file and comment-only file.
- Large file limit.
- Unsupported syntax diagnostic.
- Deterministic output across repeat runs.

# 8. Dependency-resolution strategy

Dependency resolution is project-aware and runs after parsing. It uses a `ProjectContext` assembled from static manifests/configuration files and the discovered file inventory.

## 8.1 Resolver contract

```ts
export interface ReferenceResolver {
  readonly id: string;
  readonly version: string;
  readonly languages: readonly string[];

  resolve(input: ResolverInput): Promise<ResolutionBatch>;
}

export interface ResolverInput {
  projectRoot: string;
  fileInventory: readonly FileRecord[];
  references: readonly UnresolvedReferenceFact[];
  projectContext: Readonly<ProjectContext>;
  resolutionOptions: Readonly<ResolutionOptions>;
}

export interface ResolutionResult {
  referenceId: string;
  status: ResolutionStatus;
  target?: ResolvedTarget;
  confidence?: Confidence;
  resolutionMethod?: string;
  candidateTargets?: ResolvedTarget[];
  message?: string;
}
```

Resolver interfaces must be pure with respect to project files: they may read already-discovered config snapshots passed in `ProjectContext`, but they must not run package managers or load project code.

## 8.2 Resolution order

For every reference:

1. Classify the reference kind and literal/dynamic status.
2. Apply language-specific built-in/standard-library recognition.
3. Try explicit relative path resolution.
4. Apply project alias and source-root configuration.
5. Apply package/module metadata resolution.
6. Resolve to a known external dependency/package when appropriate.
7. If multiple targets remain, mark `ambiguous` and list candidates.
8. Otherwise mark `unresolved` with a reason.

Never silently choose the first of multiple equally valid targets.

## 8.3 JavaScript and TypeScript

Support, in priority order:

- Relative imports and extension/index resolution.
- ESM `import` and `export ... from`.
- Literal dynamic `import()`.
- Literal CommonJS `require()`.
- `package.json` `exports` and `imports` fields with relevant conditions.
- Workspace packages and monorepo package boundaries.
- `tsconfig.json` `baseUrl` and `paths` mappings.
- `jsconfig.json` where applicable.
- `package.json` main/module/types fields when applicable.
- Type-only imports and re-exports.

Read configuration statically. Do not execute build scripts, bundlers or package scripts. Support explicit resolution modes and report when a mode is only partially implemented.

Use the isolated TypeScript semantics provider for compiler-compatible resolution when available. It must be versioned, replaceable and covered by resolver fixtures. The default graph engine must remain independent of TypeScript API types.

## 8.4 Python

Support:

- Relative imports.
- Absolute imports.
- Package directories and `__init__.py`.
- Recognized project source roots such as `src/`.
- Static `pyproject.toml` metadata when relevant.
- Standard-library recognition using a maintained static list aligned with supported Python versions.

Do not import Python modules or execute Python. Dynamic imports and runtime path mutations remain unresolved unless statically explicit.

## 8.5 Java (later adapter)

Support package declarations, explicit imports, wildcard imports where resolvable, source roots and nested project structure. Do not run Gradle/Maven. Build-system metadata is read statically only.

## 8.6 Dart (later adapter)

Support relative imports and `package:` imports using an existing `.dart_tool/package_config.json` when present. Do not run `dart pub get`. If package configuration is absent, report reduced resolution support rather than generating it.

## 8.7 External packages

External dependencies are represented as `package` nodes when the package identity is known from a manifest or resolver. Store package name and source ecosystem; do not store package source code. Standard library modules may use package-like nodes with `ecosystem: "stdlib"`.

A reference that cannot be resolved to an internal file or known external package remains a reference with `status: unresolved`; it does not create a fake graph edge.

## 8.8 Call relationship policy

Call graphs are inherently less certain than import graphs. For v0.1.0, resolve only:

- Same-file direct calls to a unique function/method declaration.
- Calls to explicitly imported named symbols when their export can be resolved.
- Simple `this.method()` calls when the current class contains one unambiguous method.
- Direct constructor calls when the class target is unambiguous.

Do not claim complete resolution for:

- Dynamic dispatch and polymorphic calls.
- Reflection.
- Dependency injection containers.
- Runtime monkey-patching.
- Higher-order callbacks where target cannot be proven.
- Computed member names.

Unresolved call facts remain searchable/inspectable. The default diagram should display only resolved call edges and provide a filter to show unresolved call references separately.

# 9. Scanning and analysis pipeline

This is the approved scan lifecycle. Each step must produce a typed result and progress event.

## 9.1 Pipeline sequence

```text
1. Validate input path
       |
2. Load CodeMap config + ignore rules
       |
3. Discover project manifests / workspace roots
       |
4. Enumerate candidate files safely
       |
5. Normalize paths + classify file types
       |
6. Read bytes + compute SHA-256 content hashes
       |
7. Reuse matching parser artifacts or parse changed files
       |
8. Build project context from static config snapshots
       |
9. Resolve imports / exports / inheritance / supported calls
       |
10. Build deterministic graph nodes, edges and references
       |
11. Run graph algorithms + diagnostics
       |
12. Validate graph invariants
       |
13. Persist scan in one transaction / promote successful scan
       |
14. Return scan summary + export or launch local service later
```

## 9.2 Scanner safety rules

- Default root is the path explicitly passed by the user; `.` means current directory.
- Resolve and validate the root once. Keep the canonical root only in local project metadata.
- Emit repository-relative POSIX paths into all contracts.
- Respect `.gitignore` by default and support `.codemapignore` for CodeMap-specific rules.
- Apply built-in exclusions for VCS internals, dependency directories, build output, coverage, caches and virtual environments.
- Never follow symbolic links by default. If support is added later, it must prevent loops and paths escaping the selected root.
- Detect binary files and skip them with a diagnostic or skip reason.
- Apply configurable maximum file size and maximum total file count.
- Do not read `.env` values into graph data. Configuration file discovery must use an explicit allowlist; never ingest secrets.
- Do not invoke npm, pnpm, yarn, pip, poetry, Maven, Gradle, Dart, Git or shell scripts as part of scanning.
- No writes inside the scanned repository. Cache and database live in the user's application-data directory.

## 9.3 Content hashing and incremental behavior

Correctness comes before a misleading fast path.

- Compute SHA-256 for candidate source file bytes.
- A parse artifact cache key includes content hash, adapter ID/version, grammar/runtime version, extraction schema version and adapter options hash.
- Reuse extraction artifacts only when the entire cache key matches.
- A file path is attached after loading a cached path-independent extraction artifact.
- Recompute project-level resolution and graph materialization on each scan in v0.1.0. This ensures a renamed/deleted file or changed config cannot leave stale import edges.
- A changed `tsconfig`, `package.json`, `pyproject.toml` or equivalent invalidates resolver context/graph resolution but does not force reparsing unchanged source files unless parser options changed.
- Remove files no longer present from the new scan snapshot; preserve old completed snapshots for history subject to retention policy.
- Do not implement file watching until the full-scan and cache behavior is correct and benchmarked.

## 9.4 Concurrency and resource limits

- Use a bounded worker pool; do not spawn one worker per file.
- Default concurrency should be conservative and configurable, based on available CPU with a hard maximum.
- Bound parser memory and file size. A parser timeout or worker crash becomes a diagnostic for that file, not a crash of the entire process.
- Support cancellation. A canceled scan is marked canceled and does not become the latest successful snapshot.
- Report progress by phase and file counts, not noisy per-node logs.
- Avoid retaining source buffers after extraction unless required for an active parser worker.

## 9.5 Graph invariants before persistence

- Every edge endpoint exists in the same scan.
- Every source reference node exists.
- A resolved reference target exists; unresolved/ambiguous references have no target node.
- All paths are normalized and relative.
- IDs are unique within a scan.
- Node/edge kinds belong to the schema enum.
- Locations satisfy byte-span and line/column rules.
- The graph schema version is supported by storage/export consumers.
- No source content, secrets or absolute project paths leak into exports.

# 10. Graph engine responsibilities and algorithms

`@codemap/graph-engine` is pure computation. It accepts validated IR input and returns validated IR output.

Responsibilities:

- Deterministic node and edge ID generation.
- Directory/file containment construction.
- Symbol containment construction.
- Reference-to-edge materialization.
- Graph projection and filtering.
- Incoming/outgoing dependency queries.
- Direct and transitive dependency traversal with depth limits.
- Circular dependency detection.
- Connected-component and isolated-node analysis.
- Basic coupling metrics.
- Graph invariant validation.

Algorithms:

- Tarjan's or Kosaraju's strongly connected components for cycles; document which is used and test it.
- BFS/DFS for dependency paths and reachability.
- Degree counts for fan-in/fan-out.
- Avoid calculating expensive all-pairs path metrics for large repositories.

Cycle detection must operate on resolved import/dependency edges only. Do not include `contains` edges or unresolved references in the dependency cycle algorithm.

A high fan-in/fan-out node is an indicator, not automatically a defect. Do not generate arbitrary health scores in v0.1.0. Show counts and explain the formula for every metric.

# 11. Database and persistence design

## 11.1 Storage location

Keep persistent files outside the scanned repository using a platform-aware user data directory:

- Windows: `%LOCALAPPDATA%/CodeMap/`
- macOS: `~/Library/Application Support/CodeMap/`
- Linux: `$XDG_DATA_HOME/codemap/` or `~/.local/share/codemap/`

Database and caches must not be committed to the user's project. Make `codemap cache clear` and `codemap data location` available.

## 11.2 Persistence model

Persist immutable scan snapshots. A new scan is written as `running`; after all graph invariants pass and the transaction completes, mark it `completed`. If analysis fails/cancels, retain the previous completed scan as the latest usable result.

Store:

- Projects and local root metadata.
- Scan metadata and tool/schema/parser versions.
- Per-scan file inventory and content hashes.
- Reusable path-independent parser artifacts.
- Per-scan graph nodes and edges.
- Per-scan references, including unresolved facts.
- Diagnostics and metrics.

Do not store source files themselves.

## 11.3 Initial SQL schema

This is the baseline migration design. The implementation agent may adjust indexes or column names when justified, but must preserve the semantics and document any deviation in an ADR.

```sql
PRAGMA foreign_keys = ON;
PRAGMA journal_mode = WAL;
PRAGMA busy_timeout = 5000;
PRAGMA synchronous = NORMAL;

CREATE TABLE schema_migrations (
  version INTEGER PRIMARY KEY,
  name TEXT NOT NULL,
  checksum TEXT NOT NULL,
  applied_at TEXT NOT NULL
) STRICT;

CREATE TABLE projects (
  project_id TEXT PRIMARY KEY,
  canonical_root TEXT NOT NULL UNIQUE,
  display_name TEXT NOT NULL,
  created_at TEXT NOT NULL,
  last_seen_at TEXT NOT NULL
) STRICT;

CREATE TABLE scans (
  scan_id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(project_id) ON DELETE CASCADE,
  status TEXT NOT NULL CHECK (status IN ('running','completed','failed','cancelled')),
  started_at TEXT NOT NULL,
  completed_at TEXT,
  tool_version TEXT NOT NULL,
  graph_schema_version TEXT NOT NULL,
  configuration_hash TEXT NOT NULL,
  parser_set_hash TEXT NOT NULL,
  source_fingerprint TEXT,
  summary_json TEXT NOT NULL CHECK (json_valid(summary_json)),
  error_json TEXT CHECK (error_json IS NULL OR json_valid(error_json))
) STRICT;

CREATE INDEX idx_scans_project_completed
  ON scans(project_id, status, completed_at DESC);

CREATE TABLE scan_files (
  scan_id TEXT NOT NULL REFERENCES scans(scan_id) ON DELETE CASCADE,
  relative_path TEXT NOT NULL,
  content_hash TEXT,
  size_bytes INTEGER NOT NULL CHECK (size_bytes >= 0),
  mtime_ms INTEGER,
  language TEXT,
  adapter_id TEXT,
  adapter_version TEXT,
  parse_status TEXT NOT NULL CHECK (parse_status IN ('parsed','reused','skipped','failed','unsupported')),
  skip_reason TEXT,
  PRIMARY KEY (scan_id, relative_path)
) STRICT, WITHOUT ROWID;

CREATE INDEX idx_scan_files_hash ON scan_files(content_hash);

CREATE TABLE artifact_cache (
  cache_key TEXT PRIMARY KEY,
  content_hash TEXT NOT NULL,
  adapter_id TEXT NOT NULL,
  adapter_version TEXT NOT NULL,
  extraction_version TEXT NOT NULL,
  options_hash TEXT NOT NULL,
  artifact_json TEXT NOT NULL CHECK (json_valid(artifact_json)),
  byte_size INTEGER NOT NULL CHECK (byte_size >= 0),
  created_at TEXT NOT NULL,
  last_used_at TEXT NOT NULL
) STRICT;

CREATE INDEX idx_artifact_cache_last_used ON artifact_cache(last_used_at);

CREATE TABLE graph_nodes (
  scan_id TEXT NOT NULL REFERENCES scans(scan_id) ON DELETE CASCADE,
  node_id TEXT NOT NULL,
  kind TEXT NOT NULL,
  name TEXT NOT NULL,
  qualified_name TEXT,
  language TEXT,
  path TEXT,
  symbol_kind TEXT,
  location_json TEXT CHECK (location_json IS NULL OR json_valid(location_json)),
  attributes_json TEXT NOT NULL CHECK (json_valid(attributes_json)),
  PRIMARY KEY (scan_id, node_id)
) STRICT, WITHOUT ROWID;

CREATE INDEX idx_graph_nodes_path ON graph_nodes(scan_id, path);
CREATE INDEX idx_graph_nodes_kind ON graph_nodes(scan_id, kind, symbol_kind);
CREATE INDEX idx_graph_nodes_name ON graph_nodes(scan_id, name);

CREATE TABLE graph_edges (
  scan_id TEXT NOT NULL,
  edge_id TEXT NOT NULL,
  kind TEXT NOT NULL,
  source_node_id TEXT NOT NULL,
  target_node_id TEXT NOT NULL,
  confidence TEXT NOT NULL CHECK (confidence IN ('high','medium','low')),
  resolution_method TEXT,
  evidence_reference_ids_json TEXT NOT NULL CHECK (json_valid(evidence_reference_ids_json)),
  attributes_json TEXT NOT NULL CHECK (json_valid(attributes_json)),
  PRIMARY KEY (scan_id, edge_id),
  FOREIGN KEY (scan_id, source_node_id)
    REFERENCES graph_nodes(scan_id, node_id) ON DELETE CASCADE,
  FOREIGN KEY (scan_id, target_node_id)
    REFERENCES graph_nodes(scan_id, node_id) ON DELETE CASCADE
) STRICT, WITHOUT ROWID;

CREATE INDEX idx_graph_edges_source ON graph_edges(scan_id, source_node_id, kind);
CREATE INDEX idx_graph_edges_target ON graph_edges(scan_id, target_node_id, kind);

CREATE TABLE graph_references (
  scan_id TEXT NOT NULL REFERENCES scans(scan_id) ON DELETE CASCADE,
  reference_id TEXT NOT NULL,
  kind TEXT NOT NULL,
  source_node_id TEXT NOT NULL,
  target_node_id TEXT,
  status TEXT NOT NULL CHECK (status IN ('resolved_internal','resolved_external','unresolved','ambiguous','ignored','not_applicable')),
  confidence TEXT CHECK (confidence IS NULL OR confidence IN ('high','medium','low')),
  resolver_id TEXT,
  resolver_version TEXT,
  source_location_json TEXT NOT NULL CHECK (json_valid(source_location_json)),
  raw_text TEXT NOT NULL,
  specifier TEXT,
  attributes_json TEXT NOT NULL CHECK (json_valid(attributes_json)),
  PRIMARY KEY (scan_id, reference_id),
  FOREIGN KEY (scan_id, source_node_id)
    REFERENCES graph_nodes(scan_id, node_id) ON DELETE CASCADE,
  FOREIGN KEY (scan_id, target_node_id)
    REFERENCES graph_nodes(scan_id, node_id) ON DELETE SET NULL
) STRICT, WITHOUT ROWID;

CREATE INDEX idx_graph_references_source ON graph_references(scan_id, source_node_id, kind);
CREATE INDEX idx_graph_references_status ON graph_references(scan_id, status, kind);

CREATE TABLE diagnostics (
  scan_id TEXT NOT NULL REFERENCES scans(scan_id) ON DELETE CASCADE,
  diagnostic_id TEXT NOT NULL,
  code TEXT NOT NULL,
  severity TEXT NOT NULL CHECK (severity IN ('info','warning','error')),
  message TEXT NOT NULL,
  location_json TEXT CHECK (location_json IS NULL OR json_valid(location_json)),
  related_locations_json TEXT CHECK (related_locations_json IS NULL OR json_valid(related_locations_json)),
  attributes_json TEXT NOT NULL CHECK (json_valid(attributes_json)),
  PRIMARY KEY (scan_id, diagnostic_id)
) STRICT, WITHOUT ROWID;

CREATE INDEX idx_diagnostics_severity ON diagnostics(scan_id, severity, code);
```

Important implementation notes:

- Confirm that the selected SQLite build supports JSON functions before relying on `json_valid`; fail with a clear storage initialization error if it does not.
- The nullable `target_node_id` makes the composite foreign key inactive for unresolved references. Use `ON DELETE NO ACTION` for the target relation; do not use `SET NULL` on the composite key because that could also null the non-null `scan_id`. Snapshot replacement/deletion must be handled through the scan-level transaction.
- Enable foreign keys on every connection.
- Use prepared statements and transactions for bulk snapshot inserts.
- Use numbered, immutable migrations with checksums. Never rewrite an already released migration.
- Keep graph schema version separate from database schema version.
- SQLite JSON columns are validated JSON text; application-level schema validation is still mandatory.
- FTS5 may be used as an optional search acceleration after verifying availability. Search must still work without it.

## 11.4 Storage interfaces

```ts
export interface GraphStore {
  createProject(input: CreateProjectInput): Promise<ProjectRecord>;
  beginScan(input: BeginScanInput): Promise<ScanWriter>;
  getLatestCompletedScan(projectId: string): Promise<ScanRecord | null>;
  getScan(scanId: string): Promise<ScanRecord | null>;
  loadGraph(scanId: string, query?: GraphQuery): Promise<CodeMapGraph>;
  listProjects(): Promise<ProjectRecord[]>;
  clearArtifactCache(options?: CacheClearOptions): Promise<void>;
  close(): Promise<void>;
}

export interface ScanWriter {
  writeFileInventory(files: readonly ScanFileRecord[]): Promise<void>;
  writeArtifacts(artifacts: readonly CachedArtifact[]): Promise<void>;
  writeGraph(graph: CodeMapGraph): Promise<void>;
  complete(summary: ScanSummary): Promise<void>;
  fail(error: ScanFailure): Promise<void>;
  cancel(reason?: string): Promise<void>;
}
```

The concrete driver may be synchronous internally, but package interfaces should use the async contract where this improves future portability and keeps the application layer independent from the storage implementation.

# 12. Application services and CLI

## 12.1 Application use cases

Create application services such as:

- `ScanProjectUseCase`
- `GetProjectSummaryUseCase`
- `GetGraphProjectionUseCase`
- `GetNodeDetailsUseCase`
- `GetNodeDependenciesUseCase`
- `ExportGraphUseCase`
- `ClearCacheUseCase`
- `DoctorUseCase`

The application package coordinates scanner, adapters, resolver, graph engine and storage. It is the only package allowed to compose those dependencies.

## 12.2 CLI commands

MVP command contract:

```bash
codemap scan [path] [--no-open] [--json] [--max-file-size <bytes>]
codemap summary [--project <id>] [--scan <id>]
codemap analyze --cycles [--project <id>]
codemap export --format json|svg [--output <file>] [--scan <id>]
codemap projects
codemap cache clear [--all]
codemap data location
codemap doctor
codemap --version
codemap --help
```

`codemap scan .` must work from a normal shell. The first scan should not require a config file. If the user has a dashboard later enabled, the command may launch it by default; in the initial CLI-only delivery, it should display the scan summary and export instructions without pretending a dashboard exists.

CLI rules:

- Use actionable errors and stable exit codes.
- Human output is concise; `--json` produces machine-readable output with no terminal decoration.
- Progress goes to stderr when JSON output is requested.
- Support `--no-open` even after the dashboard exists.
- Never print secret values or full source file contents.
- Preserve the exit code for scan failures and cancellations.

Suggested exit codes:

- `0`: success.
- `1`: scan completed with errors/partial analysis (document exact semantics).
- `2`: invalid arguments/configuration.
- `3`: repository/path access error.
- `4`: storage error.
- `5`: internal/unexpected failure.
- `130`: user cancellation (SIGINT).

# 13. Local dashboard/API boundary (design only; no implementation in stage one)

The future dashboard consumes versioned read APIs backed by the application layer. It does not read SQLite directly and does not call parser adapters.

Planned endpoints:

- `GET /api/v1/health`
- `GET /api/v1/projects`
- `GET /api/v1/projects/:projectId/scans`
- `GET /api/v1/scans/:scanId/summary`
- `GET /api/v1/scans/:scanId/graph?view=file_dependency&filters=...`
- `GET /api/v1/scans/:scanId/nodes/:nodeId`
- `GET /api/v1/scans/:scanId/nodes/:nodeId/dependencies`
- `GET /api/v1/scans/:scanId/references?status=unresolved`
- `GET /api/v1/scans/:scanId/diagnostics`
- `GET /api/v1/scans/:scanId/export?format=svg`

Security requirements for the later local server:

- Bind only to `127.0.0.1` by default; never bind to `0.0.0.0` by default.
- Choose an ephemeral available port.
- Generate a high-entropy per-process token. Pass it to the browser through a URL fragment, then send it as a Bearer token; do not put tokens in query strings or logs.
- Validate Host and Origin; do not enable permissive CORS.
- Use a restrictive Content Security Policy and `Referrer-Policy: no-referrer`.
- Reject path traversal and arbitrary filesystem/API access.
- Do not expose a write endpoint for project files.
- Provide a clear shutdown command/process signal handler.

The API is read-only for the first dashboard iteration. Scans remain initiated by the CLI until a later, separately reviewed change.

# 14. Export and layout architecture

- JSON export serializes the versioned canonical graph and validates it before writing.
- SVG export uses a separate layout package and a deterministic SVG renderer; it must work without a browser.
- PNG export rasterizes the generated SVG through an isolated optional rasterizer package. If the platform cannot load the rasterizer, return a clear error and offer SVG as the portable alternative; do not silently emit a blank image.
- Mermaid export is a text export and must document that Mermaid supports fewer relationship/display features than the canonical graph.
- Exports must not contain absolute paths, environment variable values, source-code bodies or private machine metadata by default.
- Deterministic exports should use stable sort order and stable layout settings.
- For large graphs, export a selected projection or require explicit confirmation rather than producing an unreadable giant diagram.

# 15. Configuration design

Default behavior must work without a config file.

Optional project config: `codemap.config.json` at the project root.

Proposed config fields:

```json
{
  "version": 1,
  "include": ["src/**", "apps/**"],
  "exclude": ["**/generated/**", "**/*.min.js"],
  "maxFileSizeBytes": 2000000,
  "maxFiles": 50000,
  "concurrency": "auto",
  "languages": ["javascript", "typescript", "python"],
  "resolution": {
    "typescript": true,
    "python": true,
    "resolveExternalPackages": true
  },
  "analysis": {
    "calls": true,
    "inheritance": true,
    "cycles": true
  }
}
```

This is a proposed example; final schema must be runtime-validated and documented. Unknown config keys should produce a warning or validation error rather than being silently accepted. Never store secrets in CodeMap configuration.

Ignore precedence:

1. Hard safety exclusions (cannot be overridden for v0.1.0): VCS internals and unsafe paths.
2. Built-in generated/dependency exclusions.
3. `.gitignore` rules.
4. `.codemapignore` rules.
5. Explicit CodeMap include/exclude config, with precedence documented and tested.

# 16. Diagnostics and error model

Every partial result must explain why it is partial.

Diagnostic codes should be stable identifiers, for example:

- `SCAN001`: file skipped because it is binary.
- `SCAN002`: file skipped because it exceeds configured size.
- `SCAN003`: symlink skipped by policy.
- `PARSE001`: syntax errors recovered; partial extraction available.
- `PARSE002`: parser failed for file.
- `RESOLVE001`: import could not be resolved.
- `RESOLVE002`: multiple candidate targets found.
- `RESOLVE003`: resolution mode/configuration not fully supported.
- `GRAPH001`: duplicate/ambiguous symbol identity.
- `GRAPH002`: graph invariant violation.
- `STORE001`: scan persistence failed.

Do not expose raw stack traces to normal users. Provide `--verbose` or a diagnostic log file for debugging. Never write source contents into logs.

# 17. Testing strategy and release gates

Testing must be part of the architecture, not postponed until after implementation.

## 17.1 Unit tests

### Contracts
- Schema validation of valid and invalid graph payloads.
- Unknown node/edge kinds rejected.
- Missing endpoints rejected.
- Path and source-location normalization.
- Serialization round-trip.

### Scanner
- Nested folders and workspace projects.
- `.gitignore` and `.codemapignore` behavior.
- Binary detection.
- Max file size and max file count.
- Symlinks skipped; symlink loops do not hang.
- Windows path separators normalized to POSIX.
- Unicode filenames.
- Permission errors become diagnostics.
- No write operations in the selected project.

### Parser adapters
- Shared conformance suite in Section 7.6.
- Fixtures for every supported syntax form.
- Parser crashes/timeouts isolated to the affected file.
- Deterministic extraction output.

### Resolvers
- Relative imports.
- Extension/index resolution.
- Package exports/imports.
- Alias/path mappings.
- Workspace package boundaries.
- Python relative/absolute imports and source roots.
- External package identification.
- Ambiguous and unresolved cases.
- Dynamic imports with non-literal expressions.

### Graph engine
- Stable IDs across scans.
- IDs change when identity changes, not merely because an unrelated line was inserted.
- Multiple evidence references for repeated relations.
- Correct cycle detection, including self-cycle and multi-node cycle.
- No false cycle from containment or unresolved references.
- Correct graph projection and filters.
- High fan-in/fan-out metrics.

### Storage
- Fresh database migration.
- Migration checksum validation.
- Foreign keys enabled and enforced.
- Transaction rollback on injected failure.
- Interrupted scan does not replace latest completed scan.
- Cache hit/miss correctness.
- Pruning and cache clear behavior.
- Database reopen and integrity check.

## 17.2 Integration fixtures

Maintain small, deterministic sample repositories:

- `fixture-js-esm`: ESM imports, exports, re-exports and cycles.
- `fixture-ts-paths`: tsconfig paths, type-only imports, project references if supported.
- `fixture-python`: packages, relative imports and `src/` layout.
- `fixture-monorepo`: workspaces and cross-package imports.
- `fixture-unresolved`: missing, ambiguous and dynamic references.
- `fixture-invalid-syntax`: recoverable parse errors.
- `fixture-unicode`: non-ASCII names and source before declarations.

Assert expected graph nodes, edges, references, diagnostics and IDs—not just “scan completed.”

## 17.3 End-to-end tests

- Install/link CLI in a temporary environment.
- Run `codemap scan <fixture>`.
- Assert exit code and JSON summary.
- Run `codemap analyze --cycles`.
- Export JSON and SVG and validate both files.
- Re-run scan without source changes and assert parse-cache hits.
- Change one source file and assert only relevant parser artifacts are invalidated while project-level resolution is refreshed.
- Delete/rename a target file and assert old imports do not remain resolved.

## 17.4 Security tests

- Malicious path traversal input.
- Symlink outside project root.
- Symlink cycle.
- Very large file and deeply nested syntax.
- Malformed JSON/TOML/project manifests.
- Secret-like filenames and `.env` files are ignored by policy.
- Parser output containing HTML/JS payload is treated as data.
- No subprocess execution during scan (test with a fixture script that would create a marker file if run; marker must not appear).
- Local service tests added before dashboard launch.

## 17.5 Performance tests

Create repeatable fixtures around 1,000, 10,000 and 50,000 candidate files, with controlled source sizes and dependency density. Record:

- discovery duration;
- hashing duration;
- parse duration;
- resolver duration;
- graph build/algorithm duration;
- persistence duration;
- total wall time;
- peak RSS;
- parser cache hit rate.

The previously suggested scan time numbers are aspirations, not guarantees. Establish baselines on documented reference machines and only then set release thresholds. Add regression budgets after a stable baseline exists.

## 17.6 CI matrix

At minimum:

- Operating systems: Windows, macOS and Ubuntu Linux.
- Node versions: 24 and 26.
- Jobs: install, formatting/lint, typecheck, unit tests, integration tests, build, package smoke test.
- Run native SQLite and WASM parser installation paths on all supported OS targets.
- Verify packed npm artifact contains the required grammar/WASM assets, migrations and executable entry point.

## 17.7 Stage-one release gate (no dashboard)

Do not begin dashboard implementation until all items pass:

1. Graph schema is versioned and contract tests pass.
2. JavaScript/TypeScript and Python adapters pass conformance tests.
3. Resolver fixtures cover success, external, unresolved and ambiguous outcomes.
4. Deterministic graph IDs and graph invariant checks pass.
5. SQLite snapshot write/read/migration/rollback tests pass.
6. CLI can scan sample projects and export JSON/SVG.
7. Cross-platform CI passes on Windows, macOS and Linux.
8. Security tests confirm no project code execution and no project writes.
9. Performance baseline is documented.
10. README explains limitations and installation.

# 18. Development roadmap

The roadmap is milestone-based. Do not start a later milestone while a prior milestone's acceptance criteria are failing.

## Stage 0 — Repository audit and decision records

Tasks:
- Inspect existing repository and git status.
- Preserve all user data and uncommitted work.
- Record existing architecture, tooling and constraints.
- Create ADRs for the approved choices in this document.
- Create package dependency rules and CI baseline.
- Confirm Tree-sitter WASM runtime and grammar licensing/compatibility through a cross-platform spike.
- Confirm SQLite driver installation on Windows/macOS/Linux and supported Node versions.

Deliverables:
- `docs/architecture/system-overview.md`
- `docs/architecture/graph-schema-v1.md`
- `docs/architecture/parser-contract.md`
- `docs/architecture/resolution-strategy.md`
- `docs/architecture/scanning-pipeline.md`
- `docs/decisions/ADR-0001...`
- pnpm workspace, strict TypeScript baseline, CI skeleton.

Exit gate: architecture docs and small runtime spikes are approved by tests; no dashboard code.

## Stage 1 — Contracts and graph engine

Tasks:
- Implement graph contracts and runtime validation.
- Implement deterministic IDs.
- Implement graph builder and invariant validator.
- Implement graph projections and cycle algorithms.
- Create hand-authored fixture graphs and tests.

Deliverables:
- `@codemap/contracts`
- `@codemap/graph-engine`
- Contract and algorithm test suites.

Exit gate: deterministic graph tests and invariant tests pass.

## Stage 2 — Scanner and parser runtime

Tasks:
- Implement safe file discovery and ignore semantics.
- Implement file hashing and inventory records.
- Implement bounded worker pool and cancellation.
- Integrate Tree-sitter WASM runtime.
- Package and load JavaScript/TypeScript and Python grammars.
- Create adapter conformance suite.

Deliverables:
- `@codemap/scanner`
- `@codemap/parser-runtime`
- `@codemap/adapter-javascript-typescript`
- `@codemap/adapter-python`

Exit gate: fixture parsing works on Windows, macOS and Linux and never executes project code.

## Stage 3 — Resolvers and project context

Tasks:
- Read project manifests/configuration statically.
- Build project context and workspace index.
- Implement JS/TS resolver and isolated TypeScript semantics provider.
- Implement Python resolver.
- Track resolved, external, unresolved and ambiguous references.
- Add resolver fixtures and diagnostics.

Deliverables:
- `@codemap/resolver-javascript-typescript`
- `@codemap/resolver-python`
- documented supported resolution matrix.

Exit gate: resolution fixture expectations pass; unsupported modes are explicitly diagnosed.

## Stage 4 — Storage and scan orchestration

Tasks:
- Implement database migrations and `GraphStore`.
- Implement artifact cache.
- Implement immutable scan snapshots and safe promotion of latest successful scan.
- Implement `ScanProjectUseCase` and related application services.
- Add failure injection tests and storage recovery tests.

Deliverables:
- `@codemap/storage-sqlite`
- `@codemap/application`

Exit gate: repeated scans, changed files, deleted files, interrupted scans and cache clearing all behave correctly.

## Stage 5 — CLI and exports

Tasks:
- Implement CLI commands and stable exit codes.
- Add human and JSON output.
- Implement JSON and SVG exporters independent of the browser.
- Add PNG rasterization as an isolated dependency with fallback behavior.
- Build npm package and smoke-test it outside the monorepo.

Deliverables:
- `@codemap/cli`
- `@codemap/exporters`
- README, install guide, examples, changelog and release workflow.

Exit gate: stage-one release gate in Section 17.7 passes.

## Stage 6 — Local API and dashboard (deferred)

This stage must not begin during the first agent execution unless the user explicitly authorizes it after Stage 5 is complete.

Tasks after approval:
- Design and implement the read-only versioned local API.
- Implement loopback-only server and ephemeral token security.
- Build dashboard overview, folder tree and graph explorer.
- Add dependency details, symbol inspector and filters.
- Add Playwright tests and local-server security tests.
- Ensure UI reads only the canonical API/IR.

## Stage 7 — Ecosystem and v1.0

- Add Java and Dart adapters/resolvers.
- Improve call graph resolution with optional semantic providers.
- Add incremental/watch mode after cache correctness is proven.
- Add a documented parser plugin interface.
- Add GitHub Actions integration.
- Improve large graph rendering and incremental projections.
- Stabilize public CLI and IR contracts for v1.0.

# 19. Repository documentation and open-source readiness

Required repository files:

- `README.md`: problem, value proposition, install, quick start, screenshots later, supported languages, limitations, privacy and examples.
- `LICENSE`: MIT, after checking all bundled grammar/parser licenses.
- `CONTRIBUTING.md`: setup, tests, parser-adapter contribution path and coding standards.
- `CODE_OF_CONDUCT.md`: standard contributor expectations.
- `SECURITY.md`: private vulnerability reporting instructions; do not invent a contact address.
- `CHANGELOG.md`: user-visible changes.
- `docs/`: architecture, schema, adapters, resolver matrix, performance and security.
- GitHub issue templates: bug report, feature request, new language adapter.
- Pull request template: scope, tests, compatibility and screenshots where UI exists.

Open-source rules:

- Pin toolchain and package-manager versions.
- Commit lockfile.
- Use semantic versioning.
- Publish schema changes with migration notes.
- Audit licenses of every bundled Tree-sitter grammar and WASM asset.
- Do not claim a language is “fully supported” based only on parsing; publish a capability matrix for imports, symbols, calls and resolution.
- Do not claim a benchmark without publishing fixture size, hardware, command and raw output.

# 20. Agent execution instructions

The implementation agent must follow these instructions exactly.

## 20.1 First action: inspect, do not overwrite

1. Inspect the repository root, package files, existing code, tests and current Git status.
2. Identify existing branches and uncommitted changes.
3. Do not delete, reset, overwrite or reformat unrelated existing work.
4. If the repository is empty, scaffold the approved monorepo.
5. If the repository already contains a project, adapt the architecture without destroying useful work and document the mapping.
6. Never run destructive Git commands such as `git reset --hard`, `git clean -fd`, forced checkout or force push.

## 20.2 Work incrementally

For each milestone:

1. Read the relevant architecture section.
2. Write/update the decision or contract document first.
3. Implement the smallest coherent package slice.
4. Add tests before or alongside implementation.
5. Run formatting, lint, typecheck, tests and build.
6. Fix regressions before moving to the next milestone.
7. Update README and progress checklist.
8. Report changed files, commands run, test results and known limitations.

Do not create empty placeholder files for every future feature. Implement only packages required by the current milestone.

## 20.3 Non-negotiable constraints

- Do not implement dashboard, React UI, Cytoscape UI or local HTTP server in Stages 0–5.
- Do not use an LLM or remote API in the core.
- Do not execute project code or package scripts during scanning.
- Do not write into the scanned repository.
- Do not couple graph contracts to Tree-sitter or TypeScript AST types.
- Do not put SQL in scanner/parser/graph-engine packages.
- Do not make unresolved imports into resolved graph edges.
- Do not claim complete call-graph analysis.
- Do not add Java/Dart to MVP until JS/TS/Python passes the release gate.
- Do not add a public plugin API before the internal adapter contract is stable.
- Do not invent test results, performance numbers or cross-platform support.

## 20.4 Technical decision discipline

When a choice is not explicit in this blueprint:

1. Prefer the simplest option that preserves modularity, security and correctness.
2. Verify current library compatibility and licenses before adding dependencies.
3. Avoid unnecessary dependencies and native build requirements.
4. Record a short ADR for decisions affecting public contracts, package boundaries, persistence or compatibility.
5. If a dependency is beta/RC, do not make it mandatory for v0.1.0 without an explicit decision and risk note.
6. If a feature cannot be implemented reliably, deliver a clear partial capability and diagnostic instead of a fabricated result.

## 20.5 Required final report from the agent

At the end of Stage 5, return:

- Repository tree.
- Implemented packages and responsibilities.
- Graph schema version and contract summary.
- Supported language capability matrix.
- Resolver coverage and known limitations.
- Scan pipeline summary.
- Database schema/migration version.
- CLI commands and sample outputs.
- Tests executed and actual pass/fail results.
- CI matrix status.
- Security checks completed.
- Performance benchmark setup and measured results (if run).
- Known issues and next recommended milestone.
- Explicit statement that the dashboard was not implemented.

Stop after Stage 5 and wait for the user's separate approval before starting Stage 6.

# 21. Definition of done for v0.1.0

CodeMap v0.1.0 is ready only when:

- A developer can install the published or locally packed CLI on supported platforms.
- `codemap scan <path>` works without a config file.
- JavaScript, TypeScript and Python sample repositories are parsed.
- Internal imports are resolved according to the documented resolution matrix.
- External, unresolved and ambiguous references remain distinguishable.
- Classes/functions and supported call relationships are represented with evidence.
- Circular dependencies are detected over resolved dependency edges.
- Graph IDs are deterministic.
- Scan snapshots are persisted safely and can be reopened.
- Parse artifacts are reused when content and parser inputs are unchanged.
- JSON and SVG export work without a browser.
- Source repositories remain unchanged.
- The scan works offline and executes no project code.
- CI passes on Windows, macOS and Linux for Node 24 and 26.
- Documentation clearly states supported features and limitations.
- No dashboard code has been added in this release stage.

# 22. Architecture decision records to create

Create at least these ADRs during Stage 0:

- **ADR-0001:** pnpm monorepo and package dependency direction.
- **ADR-0002:** Canonical CodeMap IR v1 as the only cross-package graph contract.
- **ADR-0003:** Tree-sitter parser runtime and WASM-first packaging policy.
- **ADR-0004:** Separate syntax extraction from project-aware dependency resolution.
- **ADR-0005:** Content-hash parser cache and full re-resolution per scan.
- **ADR-0006:** SQLite snapshots through `GraphStore` abstraction.
- **ADR-0007:** CLI-first implementation and deferred local dashboard.
- **ADR-0008:** Local-first security and no project-code execution.
- **ADR-0009:** Static call-graph confidence policy.

Each ADR includes context, decision, alternatives considered, consequences and date.

# 23. Reference material

These references were checked while preparing the architecture baseline. Re-check compatibility and release status when selecting exact package versions during implementation.

1. Tree-sitter introduction and design goals: https://tree-sitter.github.io/tree-sitter/
2. Tree-sitter WebAssembly binding: https://github.com/tree-sitter/tree-sitter/tree/master/lib/binding_web
3. Node.js release schedule: https://github.com/nodejs/Release/blob/main/README.md
4. Node.js SQLite API and stability status: https://nodejs.org/download/release/v26.12.0/docs/api/sqlite.html
5. TypeScript 7.0 release/API transition: https://devblogs.microsoft.com/typescript/announcing-typescript-7-0/
6. TypeScript 7.1 beta API: https://devblogs.microsoft.com/typescript/announcing-typescript-7-1-beta/
7. better-sqlite3 package and installation notes: https://www.npmjs.com/package/better-sqlite3
8. SQLite WAL and synchronous settings: https://sqlite.org/pragma.html
9. SQLite STRICT tables: https://sqlite.org/stricttables.html
10. SQLite FTS5 (optional search acceleration): https://www.sqlite.org/fts5.html
11. Cytoscape.js graph visualization: https://js.cytoscape.org/
12. pnpm workspace catalogs: https://pnpm.io/catalogs

---

# 24. Copy-ready master prompt for an AI coding agent

The following block can be copied into Codex, Claude Code, Cursor Agent or another repository-aware coding agent together with this file.

```text
You are the senior software architect and implementation engineer for CodeMap, an open-source, local-first codebase architecture visualizer.

SOURCE OF TRUTH
Read the complete file CODEMAP_ENGINEERING_BLUEPRINT.md before changing anything. Treat it as the approved technical specification. Do not substitute a simpler architecture just to finish faster. Do not begin with the dashboard.

MISSION
Implement CodeMap v0.1.0 through Stage 5 of the blueprint: repository foundation, contracts, graph engine, scanner, parser runtime, JavaScript/TypeScript and Python adapters, dependency resolvers, SQLite persistence, application orchestration, CLI, JSON/SVG exports, tests, documentation and cross-platform CI.

STRICTLY DEFERRED
Do not implement the React dashboard, Cytoscape user interface, local HTTP server, remote features, accounts, AI integration, Java adapter or Dart adapter in this execution. The dashboard is Stage 6 and requires separate user approval after Stage 5 passes its release gate.

FIRST: REPOSITORY AUDIT
- Inspect the repository structure and Git status.
- Preserve existing files, branches and uncommitted changes.
- Never run destructive Git commands or force-push.
- If the repo is empty, scaffold the monorepo from the blueprint.
- If it already has useful work, adapt it safely and explain the mapping.

ARCHITECTURE RULES
- Use TypeScript strict mode and pnpm workspaces.
- Maintain the package dependency direction in the blueprint.
- Use a versioned, language-neutral CodeMap IR.
- Use Tree-sitter behind a ParserRuntime abstraction; verify WASM runtime and grammar support on Windows, macOS and Linux before committing to the implementation.
- Keep all parser-specific types inside the adapter packages.
- Keep syntax extraction separate from module/call resolution.
- Keep TypeScript semantic analysis behind an isolated provider; do not make core depend on an unstable compiler API.
- Use a content-hash parser artifact cache. Recompute project-level dependency resolution on each scan in v0.1.0.
- Use SQLite behind GraphStore; do not put SQL in core, parser or scanner packages.
- Preserve unresolved/ambiguous references. Never draw a resolved edge without a resolved target and evidence.
- Generate deterministic IDs.
- Never execute scanned code, package scripts, build tools or package managers.
- Never write into the scanned repository.
- Keep absolute machine paths and secret values out of exported graph data.

IMPLEMENTATION ORDER
1. Stage 0: audit, ADRs, workspace, strict tooling, cross-platform parser/SQLite spikes.
2. Stage 1: contracts, runtime validation, graph IDs, graph builder, projections, graph algorithms and invariants.
3. Stage 2: safe scanner, ignore rules, hashing, bounded workers, Tree-sitter runtime, JS/TS and Python adapters, shared adapter conformance suite.
4. Stage 3: project context, JS/TS resolver, Python resolver, unresolved/ambiguous diagnostics and resolver fixture suite.
5. Stage 4: SQLite migrations, artifact cache, scan snapshots, safe completion/promotion, application use cases.
6. Stage 5: CLI, JSON/SVG exports, optional PNG rasterizer, docs, packaging, CI and smoke tests.

QUALITY PROCESS
For each milestone, write/update the design contract, implement a vertical slice, add tests, run lint, typecheck, unit tests, integration tests and build, fix failures, update docs and report actual results. Do not proceed while an earlier milestone is failing.

TESTING REQUIREMENTS
Use the full test matrix in Section 17. Include realistic fixture repositories for JavaScript, TypeScript, Python, monorepos, unresolved imports, invalid syntax and Unicode source positions. Validate graph outputs and expected relationships, not just process exit codes. CI must test Windows, macOS and Ubuntu on Node 24 and 26. Measure performance rather than inventing performance claims.

DEPENDENCY POLICY
Before adding a library, verify current maintenance status, supported Node versions, license and platform installation behavior. Avoid beta/RC dependencies in mandatory runtime paths. Pin versions through the lockfile. Audit licenses for all bundled Tree-sitter grammars and WASM files.

DELIVERABLES
Produce working packages and tests, not just placeholder files. Document every supported language capability and every important limitation. Include the CLI help output and sample scan/export instructions in README. Add ADRs for decisions that change this blueprint.

RELEASE GATE
Do not declare v0.1.0 done until every item in Section 17.7 and Section 21 passes. If an item cannot be completed, state exactly what is incomplete and why. Do not fabricate passing tests or cross-platform results.

STOP CONDITION
After Stage 5, provide the full final report required by Section 20.5. Explicitly confirm that no dashboard has been implemented. Stop there and wait for separate user approval before Stage 6.

WORK STYLE
Make the best engineering decisions without asking avoidable questions. Prefer correctness, maintainability, privacy, portability and clear boundaries over speed. Do not reduce scope silently. If a requirement is technically infeasible with the selected stack, explain the issue, propose the safest alternative, record an ADR and continue with the rest of the work.
```

**End of specification.**
