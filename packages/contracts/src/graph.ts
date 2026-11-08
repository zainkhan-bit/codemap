/**
 * CodeMap IR v1 — the canonical, language-neutral graph contract.
 * See docs/architecture/graph-schema-v1.md for field documentation.
 */

export const GRAPH_SCHEMA_VERSION = "1.0" as const;
export type GraphSchemaVersion = typeof GRAPH_SCHEMA_VERSION;

export const NODE_KINDS = ["project", "directory", "file", "module", "package", "symbol"] as const;
export type NodeKind = (typeof NODE_KINDS)[number];

export const EDGE_KINDS = ["contains", "imports", "exports", "calls", "extends", "implements"] as const;
export type EdgeKind = (typeof EDGE_KINDS)[number];

export const REFERENCE_KINDS = ["import", "export", "call", "extends", "implements", "type_reference"] as const;
export type ReferenceKind = (typeof REFERENCE_KINDS)[number];

export const RESOLUTION_STATUSES = [
  "resolved_internal",
  "resolved_external",
  "unresolved",
  "ambiguous",
  "ignored",
  "not_applicable",
] as const;
export type ResolutionStatus = (typeof RESOLUTION_STATUSES)[number];

export const CONFIDENCES = ["high", "medium", "low"] as const;
export type Confidence = (typeof CONFIDENCES)[number];

export const SYMBOL_KINDS = [
  "class",
  "interface",
  "trait",
  "enum",
  "function",
  "method",
  "constructor",
  "field",
  "property",
  "variable",
  "type",
  "namespace",
  "module",
  "unknown",
] as const;
export type SymbolKind = (typeof SYMBOL_KINDS)[number];

export const DIAGNOSTIC_SEVERITIES = ["info", "warning", "error"] as const;
export type DiagnosticSeverity = (typeof DIAGNOSTIC_SEVERITIES)[number];

/** Known resolution methods. Adapters/resolvers may add more; these are the documented ones. */
export type ResolutionMethod =
  | "relative_path"
  | "package_exports"
  | "package_imports"
  | "package_main"
  | "workspace_package"
  | "tsconfig_paths"
  | "tsconfig_base_url"
  | "python_package_path"
  | "python_source_root"
  | "stdlib"
  | "manifest_dependency"
  | "same_file_symbol"
  | "import_binding"
  | "this_member"
  | "semantic_provider";

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
  symbolKind?: SymbolKind;
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
  /** Bounded summary of the referencing syntax (never a whole statement body). */
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
  severity: DiagnosticSeverity;
  message: string;
  location?: SourceLocation;
  relatedLocations?: SourceLocation[];
  attributes?: Record<string, unknown>;
}

export interface CodeMapGraph {
  schemaVersion: GraphSchemaVersion;
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

export const GRAPH_VIEWS = ["directory_view", "file_dependency_view", "module_view", "symbol_view", "call_view"] as const;
export type GraphView = (typeof GRAPH_VIEWS)[number];

/** Maximum length of GraphReference.rawText; longer summaries are truncated with an ellipsis. */
export const MAX_RAW_TEXT_LENGTH = 200;
