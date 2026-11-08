/**
 * Graph builder: turns per-file extraction facts plus module resolution results
 * into a deterministic CodeMap IR v1 graph. Pure computation — no I/O.
 *
 * Only references with a resolved internal target become edges. Everything else
 * is retained as a reference with its status so nothing is silently dropped.
 */
import {
  DiagnosticCodes,
  GRAPH_SCHEMA_VERSION,
  MAX_RAW_TEXT_LENGTH,
  type CallFact,
  type CodeMapGraph,
  type Confidence,
  type DiagnosticSeverity,
  type EdgeKind,
  type FileExtraction,
  type GraphDiagnostic,
  type GraphEdge,
  type GraphNode,
  type GraphReference,
  type ImportFact,
  type InheritanceFact,
  type NodeKind,
  type ResolutionResult,
  type ResolutionStatus,
  type SourceLocation,
  type SourceSpan,
  type SymbolFact,
  type SymbolKind,
} from "@codemap/contracts";
import { IdRegistry, Ids } from "./ids.js";

export interface BuildFileInput {
  path: string;
  language: string;
  contentHash?: string;
  sizeBytes: number;
  /** Absent when the file could not be parsed; the file node is still created. */
  extraction?: FileExtraction;
}

export interface ResolvedModuleReference {
  result: ResolutionResult;
  resolverId: string;
  resolverVersion: string;
}

export interface BuildDiagnosticInput {
  code: string;
  severity: DiagnosticSeverity;
  message: string;
  path?: string;
  span?: SourceSpan;
  attributes?: Record<string, unknown>;
}

/** A logical module boundary (e.g. a workspace package) rooted at a directory. */
export interface ModuleDefinition {
  /** Directory path ("" for the repository root). */
  path: string;
  name: string;
  ecosystem: string;
}

export interface BuildGraphInput {
  project: CodeMapGraph["project"];
  scan: CodeMapGraph["scan"];
  files: readonly BuildFileInput[];
  /** Keyed by moduleReferenceKey(path, importIndex). */
  resolutions: ReadonlyMap<string, ResolvedModuleReference>;
  modules?: readonly ModuleDefinition[];
  diagnostics?: readonly BuildDiagnosticInput[];
  options?: { calls?: boolean; inheritance?: boolean };
}

/** The key the orchestrator uses to correlate an ImportFact with its ResolutionResult. */
export function moduleReferenceKey(path: string, importIndex: number): string {
  return `${path}#import:${importIndex}`;
}

export const LINKER_ID = "codemap-symbol-linker";
export const LINKER_VERSION = "1.0.0";

const NODE_KIND_ORDER: Record<NodeKind, number> = { project: 0, module: 1, directory: 2, file: 3, symbol: 4, package: 5 };
const CALLABLE_KINDS: ReadonlySet<SymbolKind> = new Set(["function", "class"]);
const TYPE_KINDS: ReadonlySet<SymbolKind> = new Set(["class", "interface", "trait", "type", "enum"]);
const MAX_REEXPORT_DEPTH = 32;

/** Machine-specific absolute paths that may appear in source facts (e.g. `import "/home/me/x"`). */
const ABSOLUTE_PATH_TEXT = /(?:\b[A-Za-z]:[\\/]|\\\\[^\\\s"'`]+\\|\/(?:home|Users|root|var|tmp|private|mnt|opt|etc)\/)[^\s"'`)]*/g;

/** Replaces absolute paths with a placeholder so exports never carry machine paths. */
export function redactAbsolutePaths(text: string): string {
  return text.replace(ABSOLUTE_PATH_TEXT, "<absolute-path>");
}

function truncate(text: string): string {
  const oneLine = redactAbsolutePaths(text.replace(/\s+/g, " ").trim());
  return oneLine.length <= MAX_RAW_TEXT_LENGTH ? oneLine : `${oneLine.slice(0, MAX_RAW_TEXT_LENGTH - 1)}…`;
}

function toLocation(path: string, span: SourceSpan): SourceLocation {
  return {
    path,
    startByte: span.startByte,
    endByte: span.endByte,
    startLine: span.startLine,
    startColumn: span.startColumn,
    endLine: span.endLine,
    endColumn: span.endColumn,
  };
}

function basename(path: string): string {
  const i = path.lastIndexOf("/");
  return i < 0 ? path : path.slice(i + 1);
}

function dirname(path: string): string {
  const i = path.lastIndexOf("/");
  return i < 0 ? "" : path.slice(0, i);
}

interface SymbolEntry {
  nodeId: string;
  fact: SymbolFact;
}

interface FileState {
  input: BuildFileInput;
  nodeId: string;
  symbolsByLocal: Map<string, SymbolEntry>;
  symbolsByName: Map<string, SymbolEntry[]>;
  /** Resolution of each import fact by index. */
  importResolutions: (ResolvedModuleReference | undefined)[];
}

/** What a name in a file's scope refers to. */
type Binding =
  | { kind: "symbol"; entry: SymbolEntry; method: string }
  | { kind: "file"; path: string }
  | { kind: "package"; nodeId: string }
  | { kind: "unresolved"; reason: string };

interface LinkOutcome {
  status: ResolutionStatus;
  targetNodeId?: string;
  confidence?: Confidence;
  method?: string;
  message?: string;
  candidates?: string[];
}

class GraphBuilder {
  private readonly registry = new IdRegistry();
  private readonly nodes = new Map<string, GraphNode>();
  private readonly edges = new Map<string, GraphEdge>();
  private readonly references: GraphReference[] = [];
  private readonly diagnostics = new Map<string, GraphDiagnostic>();
  private readonly files = new Map<string, FileState>();
  private readonly exportCache = new Map<string, Map<string, Binding>>();
  private readonly bindingCache = new Map<string, Map<string, Binding>>();

  constructor(private readonly input: BuildGraphInput) {}

  build(): CodeMapGraph {
    const { project } = this.input;
    this.addNode({ id: project.id, kind: "project", name: project.displayName, attributes: { rootLabel: project.rootLabel } }, project.id);

    const files = [...this.input.files].sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
    for (const f of files) this.addFile(f);
    for (const m of this.input.modules ?? []) this.addModule(m);
    for (const state of this.files.values()) this.addImports(state);
    for (const state of this.files.values()) this.addExports(state);
    if (this.input.options?.inheritance !== false) for (const state of this.files.values()) this.addInheritance(state);
    if (this.input.options?.calls !== false) for (const state of this.files.values()) this.addCalls(state);
    for (const d of this.input.diagnostics ?? []) this.addDiagnostic(d);

    const nodes = [...this.nodes.values()].sort(
      (a, b) =>
        NODE_KIND_ORDER[a.kind] - NODE_KIND_ORDER[b.kind] ||
        (a.path ?? "").localeCompare(b.path ?? "", "en") ||
        (a.location?.startByte ?? 0) - (b.location?.startByte ?? 0) ||
        (a.id < b.id ? -1 : 1),
    );
    const edges = [...this.edges.values()].sort((a, b) => (a.kind < b.kind ? -1 : a.kind > b.kind ? 1 : a.id < b.id ? -1 : 1));
    for (const e of edges) e.evidenceReferenceIds.sort();
    const diagnostics = [...this.diagnostics.values()].sort((a, b) => (a.id < b.id ? -1 : 1));

    const graph: CodeMapGraph = {
      schemaVersion: GRAPH_SCHEMA_VERSION,
      project: { ...project },
      scan: { ...this.input.scan },
      nodes,
      edges,
      references: this.references,
      diagnostics,
      metrics: {},
    };
    graph.metrics = computeBasicMetrics(graph);
    return graph;
  }

  // ---------------------------------------------------------------- nodes

  private addNode(node: GraphNode, identity: string | { id: string; identity: string }): boolean {
    const entry = typeof identity === "string" ? { id: node.id, identity } : identity;
    if (!this.registry.register(entry)) return false;
    this.nodes.set(node.id, node);
    return true;
  }

  private ensureDirectory(path: string): string {
    if (path === "") return this.input.project.id;
    const ident = Ids.directory(path);
    if (!this.nodes.has(ident.id)) {
      const parentId = this.ensureDirectory(dirname(path));
      this.addNode({ id: ident.id, kind: "directory", name: basename(path), path, attributes: {} }, ident);
      this.addEdge("contains", parentId, ident.id, "high", undefined, undefined, {});
    }
    return ident.id;
  }

  private addModule(m: ModuleDefinition): void {
    const ident = Ids.module(m.path, m.name);
    this.addNode({ id: ident.id, kind: "module", name: m.name, ...(m.path ? { path: m.path } : {}), attributes: { ecosystem: m.ecosystem } }, ident);
  }

  private ensurePackage(ecosystem: string, name: string): string {
    const ident = Ids.package(ecosystem, name);
    if (!this.nodes.has(ident.id)) this.addNode({ id: ident.id, kind: "package", name, attributes: { ecosystem } }, ident);
    return ident.id;
  }

  private addFile(f: BuildFileInput): void {
    const parentId = this.ensureDirectory(dirname(f.path));
    const ident = Ids.file(f.path);
    const ex = f.extraction;
    this.addNode(
      {
        id: ident.id,
        kind: "file",
        name: basename(f.path),
        path: f.path,
        language: f.language,
        attributes: {
          sizeBytes: f.sizeBytes,
          ...(f.contentHash ? { contentHash: f.contentHash } : {}),
          syntaxStatus: ex?.syntaxStatus ?? "failed",
        },
      },
      ident,
    );
    this.addEdge("contains", parentId, ident.id, "high", undefined, undefined, {});

    const state: FileState = { input: f, nodeId: ident.id, symbolsByLocal: new Map(), symbolsByName: new Map(), importResolutions: [] };
    this.files.set(f.path, state);
    if (!ex) return;

    for (const d of ex.diagnostics) this.addDiagnostic({ ...d, path: f.path });

    const ordinals = new Map<string, number>();
    for (const s of ex.symbols) {
      const fingerprint = s.signatureFingerprint ?? "";
      const dupKey = `${s.symbolKind}|${s.qualifiedName}|${fingerprint}`;
      const ordinal = ordinals.get(dupKey) ?? 0;
      ordinals.set(dupKey, ordinal + 1);
      if (ordinal > 0) {
        this.addDiagnostic({
          code: DiagnosticCodes.GRAPH_DUPLICATE_SYMBOL,
          severity: "info",
          message: `duplicate declaration of ${s.symbolKind} "${s.qualifiedName}"; disambiguated by ordinal ${ordinal}`,
          path: f.path,
          span: s.span,
        });
      }
      const sid = Ids.symbol(f.path, s.symbolKind, s.qualifiedName, fingerprint, ordinal);
      const node: GraphNode = {
        id: sid.id,
        kind: "symbol",
        name: s.name,
        qualifiedName: s.qualifiedName,
        language: ex.language,
        path: f.path,
        symbolKind: s.symbolKind,
        location: toLocation(f.path, s.span),
        attributes: {
          exported: s.exported,
          ...(s.modifiers.length ? { modifiers: [...s.modifiers] } : {}),
          ...(s.languageKind ? { languageKind: s.languageKind } : {}),
          ...(ordinal > 0 ? { duplicateOrdinal: ordinal } : {}),
        },
      };
      this.addNode(node, sid);
      const entry: SymbolEntry = { nodeId: sid.id, fact: s };
      state.symbolsByLocal.set(s.localId, entry);
      const list = state.symbolsByName.get(s.name) ?? [];
      list.push(entry);
      state.symbolsByName.set(s.name, list);
    }
    for (const s of ex.symbols) {
      const child = state.symbolsByLocal.get(s.localId);
      const parent = s.parentLocalId ? state.symbolsByLocal.get(s.parentLocalId) : undefined;
      if (child) this.addEdge("contains", parent?.nodeId ?? ident.id, child.nodeId, "high", undefined, undefined, {});
    }
  }

  // ---------------------------------------------------------------- edges / references

  private addEdge(
    kind: EdgeKind,
    sourceId: string,
    targetId: string,
    confidence: Confidence,
    method: string | undefined,
    evidenceId: string | undefined,
    attributes: Record<string, unknown>,
  ): void {
    const ident = Ids.edge(kind, sourceId, targetId);
    const existing = this.edges.get(ident.id);
    if (existing) {
      if (evidenceId && !existing.evidenceReferenceIds.includes(evidenceId)) existing.evidenceReferenceIds.push(evidenceId);
      if (rank(confidence) > rank(existing.confidence)) existing.confidence = confidence;
      if (existing.attributes.typeOnly === true && attributes.typeOnly !== true) existing.attributes.typeOnly = false;
      return;
    }
    this.registry.register(ident);
    this.edges.set(ident.id, {
      id: ident.id,
      kind,
      sourceId,
      targetId,
      confidence,
      ...(method ? { resolutionMethod: method } : {}),
      evidenceReferenceIds: evidenceId ? [evidenceId] : [],
      attributes,
    });
  }

  private addReference(ref: Omit<GraphReference, "id">, payload: string): GraphReference {
    const ident = Ids.reference(ref.kind, ref.sourceLocation.path, ref.sourceLocation.startByte, ref.sourceLocation.endByte, payload);
    if (!this.registry.register(ident)) {
      // Same reference identity emitted twice (should not happen for well-formed adapters); keep the first.
      return this.references.find((r) => r.id === ident.id)!;
    }
    const full: GraphReference = {
      id: ident.id,
      ...ref,
      rawText: truncate(ref.rawText),
      ...(ref.specifier !== undefined ? { specifier: redactAbsolutePaths(ref.specifier) } : {}),
      ...(ref.message !== undefined ? { message: redactAbsolutePaths(ref.message) } : {}),
    };
    this.references.push(full);
    return full;
  }

  private addDiagnostic(d: BuildDiagnosticInput): void {
    const ident = Ids.diagnostic(d.code, d.path ?? "", d.span?.startByte ?? -1, d.message);
    if (this.diagnostics.has(ident.id)) return;
    this.diagnostics.set(ident.id, {
      id: ident.id,
      code: d.code,
      severity: d.severity,
      message: redactAbsolutePaths(d.message),
      ...(d.path !== undefined && d.span ? { location: toLocation(d.path, d.span) } : {}),
      attributes: { ...(d.path !== undefined ? { path: d.path } : {}), ...(d.attributes ?? {}) },
    });
  }

  // ---------------------------------------------------------------- imports

  private addImports(state: FileState): void {
    const ex = state.input.extraction;
    if (!ex) return;
    ex.imports.forEach((imp, index) => {
      const resolved = this.input.resolutions.get(moduleReferenceKey(state.input.path, index));
      state.importResolutions[index] = resolved;
      const result = resolved?.result;
      let targetNodeId: string | undefined;
      if (result?.status === "resolved_internal" && result.target?.kind === "file") targetNodeId = this.files.get(result.target.path)?.nodeId;
      if (result?.status === "resolved_external" && result.target?.kind === "package") targetNodeId = this.ensurePackage(result.target.ecosystem, result.target.name);

      let status: ResolutionStatus = result?.status ?? "unresolved";
      let message = result?.message ?? (resolved ? undefined : "no resolver available for this reference");
      // A resolver claiming an internal target that is not in this scan is downgraded, never trusted.
      if ((status === "resolved_internal" || status === "resolved_external") && !targetNodeId) {
        status = "unresolved";
        message = "resolved target is not part of this scan";
      }

      const ref = this.addReference(
        {
          kind: "import",
          sourceNodeId: state.nodeId,
          sourceLocation: toLocation(state.input.path, imp.span),
          rawText: imp.summary,
          ...(imp.specifier !== undefined ? { specifier: imp.specifier } : {}),
          ...(imp.importedNames.length ? { importedNames: imp.importedNames.map((n) => (n.alias ? `${n.name} as ${n.alias}` : n.name)) } : {}),
          ...(targetNodeId ? { targetNodeId } : {}),
          status,
          ...(targetNodeId && result?.confidence ? { confidence: result.confidence } : {}),
          ...(resolved ? { resolverId: resolved.resolverId, resolverVersion: resolved.resolverVersion } : {}),
          ...(message ? { message } : {}),
          attributes: importAttributes(imp, result),
        },
        `${imp.form}|${imp.specifier ?? "<dynamic>"}`,
      );

      if (result?.diagnosticCode) {
        this.addDiagnostic({
          code: result.diagnosticCode,
          severity: result.status === "unresolved" || result.status === "ambiguous" ? "warning" : "info",
          message: `${imp.specifier ?? "<dynamic import>"}: ${result.message ?? result.status}`,
          path: state.input.path,
          span: imp.span,
        });
      }

      if (targetNodeId && status !== "unresolved" && result?.confidence !== "low") {
        this.addEdge("imports", state.nodeId, targetNodeId, result?.confidence ?? "high", result?.resolutionMethod, ref.id, {
          typeOnly: imp.isTypeOnly,
          ...(imp.form === "re_export" ? { reExport: true } : {}),
          ...(imp.form === "dynamic_import" ? { dynamic: true } : {}),
        });
      }
      if (status === "resolved_internal" && result?.confidence !== "low") {
        for (const t of Object.values(result?.nameTargets ?? {})) {
          const sub = this.files.get(t.path)?.nodeId;
          if (sub) this.addEdge("imports", state.nodeId, sub, result?.confidence ?? "high", result?.resolutionMethod, ref.id, { typeOnly: imp.isTypeOnly, submodule: true });
        }
      }
    });
  }

  // ---------------------------------------------------------------- symbol linking

  /** Names a file makes available to importers. */
  private exportTable(path: string, depth = 0): Map<string, Binding> {
    const cached = this.exportCache.get(path);
    if (cached) return cached;
    const table = new Map<string, Binding>();
    const state = this.files.get(path);
    if (!state?.input.extraction || depth > MAX_REEXPORT_DEPTH) return table;
    this.exportCache.set(path, table); // provisional entry breaks re-export cycles
    const ex = state.input.extraction;

    if (ex.language === "python") {
      // Python has no export statement: every module-level name, including imported names, is importable.
      for (const [name, entries] of state.symbolsByName) {
        const top = entries.filter((e) => !e.fact.parentLocalId);
        if (top.length === 1) table.set(name, { kind: "symbol", entry: top[0]!, method: "import_binding" });
      }
      for (const [name, binding] of this.importBindings(state, depth)) if (!table.has(name)) table.set(name, binding);
      return table;
    }

    for (const exp of ex.exports) {
      if (exp.kind === "re_export_all" || exp.kind === "re_export") {
        const res = exp.importIndex !== undefined ? state.importResolutions[exp.importIndex]?.result : undefined;
        const target = this.bindingForModule(res);
        if (exp.kind === "re_export_all") {
          if (target.kind === "file") for (const [n, b] of this.exportTable(target.path, depth + 1)) if (n !== "default" && !table.has(n)) table.set(n, b);
          continue;
        }
        if (exp.localName === "*") table.set(exp.name, target);
        else table.set(exp.name, target.kind === "file" ? this.exportTable(target.path, depth + 1).get(exp.localName ?? exp.name) ?? { kind: "unresolved", reason: `"${exp.localName ?? exp.name}" is not exported by the target module` } : target);
        continue;
      }
      const local = exp.localName ?? exp.name;
      const top = (state.symbolsByName.get(local) ?? []).filter((e) => !e.fact.parentLocalId);
      if (top.length === 1) table.set(exp.name, { kind: "symbol", entry: top[0]!, method: "import_binding" });
      else {
        const viaImport = this.importBindings(state, depth).get(local);
        if (viaImport) table.set(exp.name, viaImport);
      }
    }
    return table;
  }

  private bindingForModule(result: ResolutionResult | undefined): Binding {
    if (result?.status === "resolved_internal" && result.target?.kind === "file" && this.files.has(result.target.path)) return { kind: "file", path: result.target.path };
    if (result?.status === "resolved_external" && result.target?.kind === "package") return { kind: "package", nodeId: this.ensurePackage(result.target.ecosystem, result.target.name) };
    return { kind: "unresolved", reason: "the imported module is not resolved" };
  }

  /** Local names bound by a file's import statements. */
  private importBindings(state: FileState, depth = 0): Map<string, Binding> {
    const cached = this.bindingCache.get(state.input.path);
    if (cached) return cached;
    const bindings = new Map<string, Binding>();
    this.bindingCache.set(state.input.path, bindings);
    const ex = state.input.extraction;
    if (!ex) return bindings;
    ex.imports.forEach((imp, index) => {
      if (imp.form === "re_export") return;
      const result = state.importResolutions[index]?.result;
      const mod = this.bindingForModule(result);
      if (imp.namespaceAlias) bindings.set(imp.namespaceAlias, mod);
      for (const n of imp.importedNames) {
        const local = n.alias ?? n.name;
        if (n.name === "*") continue;
        const submodule = result?.nameTargets?.[n.name];
        if (submodule && this.files.has(submodule.path)) {
          bindings.set(local, { kind: "file", path: submodule.path });
          continue;
        }
        if (mod.kind !== "file") {
          bindings.set(local, mod);
          continue;
        }
        const exported = this.exportTable(mod.path, depth + 1).get(n.name);
        // Python `from pkg import submodule` binds a module, not a symbol.
        bindings.set(local, exported ?? { kind: "unresolved", reason: `"${n.name}" is not exported by ${mod.path}` });
      }
    });
    return bindings;
  }

  /** Resolves a (possibly dotted) name as seen from `state`'s scope. */
  private resolveName(state: FileState, chain: readonly string[], acceptedKinds: ReadonlySet<SymbolKind>): LinkOutcome {
    const [head, ...rest] = chain;
    if (head === undefined) return { status: "unresolved", message: "empty name" };

    let binding: Binding | undefined;
    const local = (state.symbolsByName.get(head) ?? []).filter((e) => (rest.length ? TYPE_KINDS.has(e.fact.symbolKind) || e.fact.symbolKind === "namespace" : acceptedKinds.has(e.fact.symbolKind)));
    if (local.length > 1) return { status: "ambiguous", message: `${local.length} declarations named "${head}" in this file`, candidates: local.map((e) => e.nodeId) };
    if (local.length === 1) binding = { kind: "symbol", entry: local[0]!, method: "same_file_symbol" };
    else binding = this.importBindings(state).get(head);
    if (!binding) return { status: "unresolved", message: `no static declaration or import found for "${head}"` };

    for (const member of rest) {
      if (binding.kind === "file") {
        binding = this.exportTable(binding.path).get(member) ?? { kind: "unresolved", reason: `"${member}" is not exported by ${binding.path}` };
      } else if (binding.kind === "symbol" && TYPE_KINDS.has(binding.entry.fact.symbolKind)) {
        const owner = binding.entry;
        const file = this.files.get(this.nodes.get(owner.nodeId)!.path!)!;
        const members = (file.symbolsByName.get(member) ?? []).filter((e) => e.fact.parentLocalId === owner.fact.localId);
        if (members.length !== 1) return members.length > 1 ? { status: "ambiguous", message: `${members.length} members named "${member}"`, candidates: members.map((e) => e.nodeId) } : { status: "unresolved", message: `no member "${member}" declared on ${owner.fact.qualifiedName}` };
        // Static member access through a class name is a convention-based link, not proof of the runtime target.
        return { status: "resolved_internal", targetNodeId: members[0]!.nodeId, confidence: "medium", method: binding.method };
      } else break;
    }

    switch (binding.kind) {
      case "symbol":
        if (!acceptedKinds.has(binding.entry.fact.symbolKind) && rest.length === 0) return { status: "unresolved", message: `"${head}" is a ${binding.entry.fact.symbolKind}, not a supported target` };
        return { status: "resolved_internal", targetNodeId: binding.entry.nodeId, confidence: "high", method: binding.method };
      case "package":
        return { status: "resolved_external", targetNodeId: binding.nodeId, confidence: "high", method: "import_binding" };
      case "file":
        return { status: "unresolved", message: `"${chain.join(".")}" refers to a module, not a declaration` };
      case "unresolved":
        return { status: "unresolved", message: binding.reason };
    }
  }

  private addExports(state: FileState): void {
    const ex = state.input.extraction;
    if (!ex || ex.language === "python") return;
    const table = this.exportTable(state.input.path);
    for (const exp of ex.exports) {
      const binding = exp.kind === "re_export_all" ? this.bindingForModule(exp.importIndex !== undefined ? state.importResolutions[exp.importIndex]?.result : undefined) : table.get(exp.name);
      let outcome: LinkOutcome;
      if (!binding) outcome = { status: "unresolved", message: `no declaration found for exported name "${exp.localName ?? exp.name}"` };
      else if (binding.kind === "symbol") outcome = { status: "resolved_internal", targetNodeId: binding.entry.nodeId, confidence: "high", method: exp.kind === "re_export" ? "import_binding" : "same_file_symbol" };
      else if (binding.kind === "file") outcome = { status: "resolved_internal", targetNodeId: this.files.get(binding.path)!.nodeId, confidence: "high", method: "relative_path" };
      else if (binding.kind === "package") outcome = { status: "resolved_external", targetNodeId: binding.nodeId, confidence: "high", method: "import_binding" };
      else outcome = { status: "unresolved", message: binding.reason };

      const ref = this.addReference(
        {
          kind: "export",
          sourceNodeId: state.nodeId,
          sourceLocation: toLocation(state.input.path, exp.span),
          rawText: exp.summary,
          ...(exp.specifier !== undefined ? { specifier: exp.specifier } : {}),
          importedNames: [exp.localName && exp.localName !== exp.name ? `${exp.localName} as ${exp.name}` : exp.name],
          ...this.outcomeFields(outcome),
          attributes: { exportKind: exp.kind, typeOnly: exp.isTypeOnly },
        },
        `${exp.kind}|${exp.name}|${exp.specifier ?? ""}`,
      );
      const target = outcome.targetNodeId ? this.nodes.get(outcome.targetNodeId) : undefined;
      if (outcome.status === "resolved_internal" && target?.kind === "symbol") {
        this.addEdge("exports", state.nodeId, target.id, outcome.confidence ?? "high", outcome.method, ref.id, { exportedAs: exp.name, ...(exp.kind === "re_export" ? { reExport: true } : {}) });
      }
    }
  }

  private outcomeFields(o: LinkOutcome): Pick<GraphReference, "status" | "targetNodeId" | "confidence" | "resolverId" | "resolverVersion" | "message"> {
    return {
      status: o.status,
      ...(o.targetNodeId ? { targetNodeId: o.targetNodeId, confidence: o.confidence ?? "high" } : {}),
      resolverId: LINKER_ID,
      resolverVersion: LINKER_VERSION,
      ...(o.message ? { message: o.message } : {}),
    };
  }

  private addInheritance(state: FileState): void {
    for (const inh of state.input.extraction?.inheritance ?? []) {
      const owner = state.symbolsByLocal.get(inh.symbolLocalId);
      if (!owner) continue;
      const outcome = this.resolveName(state, inh.targetName.split("."), TYPE_KINDS);
      const ref = this.addReference(
        {
          kind: inh.kind,
          sourceNodeId: owner.nodeId,
          sourceLocation: toLocation(state.input.path, inh.span),
          rawText: inh.summary,
          specifier: inh.targetName,
          ...this.outcomeFields(outcome),
          attributes: outcome.candidates ? { candidateNodeIds: outcome.candidates } : {},
        },
        `${inh.kind}|${inh.targetName}|${inh.symbolLocalId}`,
      );
      this.linkEdge(inheritanceEdgeKind(inh), owner.nodeId, outcome, ref.id);
    }
  }

  private addCalls(state: FileState): void {
    for (const call of state.input.extraction?.calls ?? []) {
      const caller = call.callerLocalId ? state.symbolsByLocal.get(call.callerLocalId) : undefined;
      const sourceNodeId = caller?.nodeId ?? state.nodeId;
      const outcome = this.resolveCall(state, call, caller);
      const ref = this.addReference(
        {
          kind: "call",
          sourceNodeId,
          sourceLocation: toLocation(state.input.path, call.span),
          rawText: call.calleeSummary,
          ...(call.calleeName ? { specifier: call.calleeName } : {}),
          ...this.outcomeFields(outcome),
          attributes: {
            callKind: call.callKind,
            receiver: call.receiver,
            ...(call.argumentCount !== undefined ? { argumentCount: call.argumentCount } : {}),
            ...(outcome.candidates ? { candidateNodeIds: outcome.candidates } : {}),
          },
        },
        `call|${call.calleeSummary}|${call.callerLocalId ?? ""}`,
      );
      this.linkEdge("calls", sourceNodeId, outcome, ref.id);
    }
  }

  private resolveCall(state: FileState, call: CallFact, caller: SymbolEntry | undefined): LinkOutcome {
    if (call.receiver === "other" && call.callKind !== "dynamic") return { status: "unresolved", message: "receiver is an expression; dynamic dispatch is not resolved" };
    if (call.callKind === "dynamic" || !call.memberChain || call.memberChain.length === 0) return { status: "unresolved", message: "callee is computed at runtime; not statically resolvable" };
    const chain = call.memberChain;
    if (call.receiver === "this") {
      if (chain.length !== 2) return { status: "unresolved", message: "only direct this.method() calls are resolved" };
      const cls = enclosingClass(state, caller);
      if (!cls) return { status: "unresolved", message: "no enclosing class for this/self call" };
      const methods = (state.symbolsByName.get(chain[1]!) ?? []).filter((e) => e.fact.parentLocalId === cls.fact.localId && (e.fact.symbolKind === "method" || e.fact.symbolKind === "function"));
      if (methods.length === 1) return { status: "resolved_internal", targetNodeId: methods[0]!.nodeId, confidence: "high", method: "this_member" };
      if (methods.length > 1) return { status: "ambiguous", message: `${methods.length} methods named "${chain[1]}"`, candidates: methods.map((m) => m.nodeId) };
      return { status: "unresolved", message: `"${chain[1]}" is not declared on ${cls.fact.qualifiedName} (it may be inherited or dynamic)` };
    }
    if (call.receiver === "super") return { status: "unresolved", message: "super calls are not resolved in v0.1" };
    if (call.receiver === "other") return { status: "unresolved", message: "receiver is an expression; dynamic dispatch is not resolved" };
    if (chain.length > 2) return { status: "unresolved", message: "long member chains are not resolved" };
    return this.resolveName(state, chain, call.callKind === "constructor" ? new Set<SymbolKind>(["class"]) : CALLABLE_KINDS);
  }

  private linkEdge(kind: EdgeKind, sourceNodeId: string, outcome: LinkOutcome, refId: string): void {
    if (outcome.status !== "resolved_internal" || !outcome.targetNodeId || outcome.confidence === "low") return;
    if (this.nodes.get(outcome.targetNodeId)?.kind !== "symbol") return;
    this.addEdge(kind, sourceNodeId, outcome.targetNodeId, outcome.confidence ?? "high", outcome.method, refId, {});
  }
}

function inheritanceEdgeKind(inh: InheritanceFact): EdgeKind {
  return inh.kind === "implements" ? "implements" : "extends";
}

function enclosingClass(state: FileState, from: SymbolEntry | undefined): SymbolEntry | undefined {
  let cur = from;
  while (cur) {
    if (cur.fact.symbolKind === "class") return cur;
    cur = cur.fact.parentLocalId ? state.symbolsByLocal.get(cur.fact.parentLocalId) : undefined;
  }
  return undefined;
}

function importAttributes(imp: ImportFact, result: ResolutionResult | undefined): Record<string, unknown> {
  return {
    form: imp.form,
    typeOnly: imp.isTypeOnly,
    ...(imp.isDynamicExpression ? { dynamicExpression: true } : {}),
    ...(imp.relativeLevel ? { relativeLevel: imp.relativeLevel } : {}),
    ...(imp.importAttributes ? { importAttributes: imp.importAttributes } : {}),
    ...(result?.resolutionMethod ? { resolutionMethod: result.resolutionMethod } : {}),
    ...(result?.candidateTargets?.length ? { candidateTargets: result.candidateTargets.map((t) => (t.kind === "file" ? t.path : `${t.ecosystem}:${t.name}`)) } : {}),
    ...(result?.target?.kind === "package" ? { packageName: result.target.name, ecosystem: result.target.ecosystem } : {}),
  };
}

function rank(c: Confidence): number {
  return c === "high" ? 2 : c === "medium" ? 1 : 0;
}

export function computeBasicMetrics(graph: CodeMapGraph): Record<string, number> {
  const m: Record<string, number> = {};
  const inc = (k: string) => (m[k] = (m[k] ?? 0) + 1);
  for (const n of graph.nodes) inc(`nodes.${n.kind}`);
  for (const e of graph.edges) inc(`edges.${e.kind}`);
  for (const r of graph.references) inc(`references.${r.kind}.${r.status}`);
  for (const d of graph.diagnostics) inc(`diagnostics.${d.severity}`);
  m["nodes.total"] = graph.nodes.length;
  m["edges.total"] = graph.edges.length;
  m["references.total"] = graph.references.length;
  return Object.fromEntries(Object.entries(m).sort(([a], [b]) => (a < b ? -1 : 1)));
}

export function buildGraph(input: BuildGraphInput): CodeMapGraph {
  return new GraphBuilder(input).build();
}

