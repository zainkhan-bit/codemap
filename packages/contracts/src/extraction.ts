/**
 * Parser adapter contract. Adapters turn source bytes into path-independent
 * extraction facts. They never read disk, resolve imports, create graph IDs
 * or touch storage.
 */
import type { DiagnosticSeverity, SymbolKind } from "./graph.js";

/** Bumped whenever the shape or semantics of FileExtraction changes; part of the cache key. */
export const EXTRACTION_SCHEMA_VERSION = "1";

/** A span inside the parsed buffer. Same rules as SourceLocation but without a path. */
export interface SourceSpan {
  startByte: number;
  endByte: number;
  startLine: number;
  startColumn: number;
  endLine: number;
  endColumn: number;
}

export type ImportForm = "static_import" | "re_export" | "dynamic_import" | "commonjs_require" | "language_specific";

export interface ImportedName {
  /** Name as exported by the target ("default" and "*" are reserved). */
  name: string;
  /** Local binding name, when different from `name`. */
  alias?: string;
}

export interface ImportFact {
  /** Literal module specifier; absent when the specifier is not a string literal. */
  specifier?: string;
  form: ImportForm;
  importedNames: ImportedName[];
  /** Whole-module namespace binding (e.g. `import * as ns`, `import x` in Python). */
  namespaceAlias?: string;
  isTypeOnly: boolean;
  /** True when the specifier is computed at runtime; such imports are never resolved. */
  isDynamicExpression: boolean;
  /** Python relative import level (number of leading dots). */
  relativeLevel?: number;
  importAttributes?: Record<string, string>;
  /** Short syntax summary, bounded in length. */
  summary: string;
  span: SourceSpan;
}

export type ExportFactKind = "declaration" | "named" | "default" | "re_export" | "re_export_all";

export interface ExportFact {
  kind: ExportFactKind;
  /** Exported name ("default" for default exports, "*" for star re-exports). */
  name: string;
  /** Local symbol name the export refers to, when known. */
  localName?: string;
  /** Module specifier for re-exports. */
  specifier?: string;
  /** Index into FileExtraction.imports of the ImportFact carrying this re-export's module dependency. */
  importIndex?: number;
  isTypeOnly: boolean;
  summary: string;
  span: SourceSpan;
}

export interface SymbolFact {
  /** Adapter-local key, unique within one extraction (e.g. "s3"). Never a graph ID. */
  localId: string;
  name: string;
  /** Dotted name within the file (e.g. "Outer.inner"). */
  qualifiedName: string;
  symbolKind: SymbolKind;
  /** Optional language-specific kind (e.g. "arrow_function", "decorated_definition"). */
  languageKind?: string;
  /** Stable fingerprint of the declaration shape (e.g. parameter count), never line numbers. */
  signatureFingerprint?: string;
  span: SourceSpan;
  /** Span of the name identifier, if available. */
  nameSpan?: SourceSpan;
  parentLocalId?: string;
  exported: boolean | "unknown";
  modifiers: string[];
}

export type CallKind = "direct" | "member" | "constructor" | "dynamic";
export type CallReceiver = "none" | "this" | "super" | "identifier" | "other";

export interface CallFact {
  /** Enclosing symbol (localId); absent for file/module scope. */
  callerLocalId?: string;
  /** Bounded summary of the callee expression (e.g. "this.save", "fs.readFile"). */
  calleeSummary: string;
  /** Simple callee name — last identifier in the chain — when statically available. */
  calleeName?: string;
  /** Identifier chain, e.g. ["this", "repo", "save"]; absent for computed expressions. */
  memberChain?: string[];
  receiver: CallReceiver;
  argumentCount?: number;
  callKind: CallKind;
  span: SourceSpan;
}

export interface InheritanceFact {
  symbolLocalId: string;
  kind: "extends" | "implements";
  /** Dotted target name as written (e.g. "base.Model"). */
  targetName: string;
  summary: string;
  span: SourceSpan;
}

export interface AdapterDiagnostic {
  code: string;
  severity: DiagnosticSeverity;
  message: string;
  span?: SourceSpan;
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

export interface ParserLimits {
  /** Hard ceiling on source bytes an adapter will parse. */
  maxFileSizeBytes: number;
  /** Parse time budget per file. */
  parseTimeoutMs: number;
  /** Maximum syntax-tree depth walked by extraction (guards deeply nested input). */
  maxTreeDepth: number;
}

export const DEFAULT_PARSER_LIMITS: ParserLimits = {
  maxFileSizeBytes: 2_000_000,
  parseTimeoutMs: 10_000,
  maxTreeDepth: 2_000,
};

/** Language options that influence extraction (not resolution). Part of the cache key. */
export interface ProjectLanguageConfiguration {
  calls: boolean;
  inheritance: boolean;
}

export interface DetectionInput {
  relativePath: string;
}

export interface DetectionResult {
  supported: boolean;
  language?: string;
}

export interface ParseFileInput {
  relativePath: string;
  language: string;
  source: Uint8Array;
  contentHash: string;
  projectConfiguration: Readonly<ProjectLanguageConfiguration>;
  limits: Readonly<ParserLimits>;
}

export interface LanguageAdapter {
  readonly id: string;
  readonly version: string;
  readonly languages: readonly string[];
  readonly extensions: readonly string[];
  /** Grammar/runtime identity; part of the parse artifact cache key. */
  readonly grammarFingerprint: string;

  detect(input: DetectionInput): DetectionResult;
  parseFile(input: ParseFileInput): Promise<FileExtraction>;
}
