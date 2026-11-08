/**
 * Reference resolver contract. Resolvers map module references to files or
 * packages using the static ProjectContext. They never read disk, run package
 * managers or load project code.
 */
import type { DiagnosticSeverity, Confidence, ResolutionStatus } from "./graph.js";
import type { ImportForm, ImportedName } from "./extraction.js";
import type { FileRecord, ProjectContext } from "./project.js";

export type PackageEcosystem = "npm" | "node_builtin" | "pypi" | "stdlib";

export type ResolvedTarget =
  | { kind: "file"; path: string }
  | { kind: "package"; name: string; ecosystem: PackageEcosystem };

export interface ModuleReferenceFact {
  /** Opaque key chosen by the orchestrator, echoed back in results. */
  referenceKey: string;
  fromPath: string;
  language: string;
  specifier?: string;
  form: ImportForm;
  isDynamicExpression: boolean;
  isTypeOnly: boolean;
  relativeLevel?: number;
  importedNames: readonly ImportedName[];
}

export interface ResolutionResult {
  referenceKey: string;
  status: ResolutionStatus;
  target?: ResolvedTarget;
  confidence?: Confidence;
  resolutionMethod?: string;
  candidateTargets?: ResolvedTarget[];
  /**
   * Imported names that are themselves modules (e.g. Python `from pkg import submodule`),
   * keyed by imported name. Each produces its own dependency edge from the same evidence.
   */
  nameTargets?: Record<string, { kind: "file"; path: string }>;
  message?: string;
  /** Diagnostic code for unresolved/ambiguous/partial results. */
  diagnosticCode?: string;
}

export interface ResolverDiagnostic {
  code: string;
  severity: DiagnosticSeverity;
  message: string;
  path?: string;
}

export interface ResolutionBatch {
  resolverId: string;
  resolverVersion: string;
  results: ResolutionResult[];
  diagnostics: ResolverDiagnostic[];
}

export interface ResolutionOptions {
  resolveExternalPackages: boolean;
}

export interface ResolverInput {
  fileInventory: readonly FileRecord[];
  references: readonly ModuleReferenceFact[];
  projectContext: Readonly<ProjectContext>;
  resolutionOptions: Readonly<ResolutionOptions>;
}

export interface ReferenceResolver {
  readonly id: string;
  readonly version: string;
  readonly languages: readonly string[];

  resolve(input: ResolverInput): Promise<ResolutionBatch>;
}
