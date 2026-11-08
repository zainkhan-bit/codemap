/** Persistence contracts. Implemented by @codemap/storage-sqlite. */
import type { CodeMapGraph, NodeKind, EdgeKind, ResolutionStatus } from "./graph.js";
import type { FileExtraction } from "./extraction.js";
import type { FileRecord } from "./project.js";

export type ScanStatus = "running" | "completed" | "failed" | "cancelled";

export interface ProjectRecord {
  projectId: string;
  /** Local absolute root. Only stored locally; never exported. */
  canonicalRoot: string;
  displayName: string;
  createdAt: string;
  lastSeenAt: string;
}

export interface CreateProjectInput {
  projectId: string;
  canonicalRoot: string;
  displayName: string;
}

export interface ScanSummary {
  fileCount: number;
  parsedCount: number;
  reusedCount: number;
  skippedCount: number;
  failedCount: number;
  nodeCount: number;
  edgeCount: number;
  referenceCount: number;
  unresolvedCount: number;
  cycleCount: number;
  diagnosticCounts: { info: number; warning: number; error: number };
  durationsMs: Record<string, number>;
  languages: Record<string, number>;
}

export interface ScanFailure {
  code: string;
  message: string;
}

export interface ScanRecord {
  scanId: string;
  projectId: string;
  status: ScanStatus;
  startedAt: string;
  completedAt?: string;
  toolVersion: string;
  graphSchemaVersion: string;
  configurationHash: string;
  parserSetHash: string;
  summary: ScanSummary | null;
  error: ScanFailure | null;
}

export interface BeginScanInput {
  scanId: string;
  projectId: string;
  startedAt: string;
  toolVersion: string;
  graphSchemaVersion: string;
  configurationHash: string;
  parserSetHash: string;
}

export interface CachedArtifact {
  cacheKey: string;
  contentHash: string;
  adapterId: string;
  adapterVersion: string;
  extractionVersion: string;
  optionsHash: string;
  extraction: FileExtraction;
}

export interface GraphQuery {
  nodeKinds?: NodeKind[];
  edgeKinds?: EdgeKind[];
  referenceStatuses?: ResolutionStatus[];
}

export interface CacheClearOptions {
  /** When true, also delete all projects and scans (full reset of derived data). */
  all?: boolean;
}

export interface CacheStats {
  artifactCount: number;
  totalBytes: number;
}

export interface ScanWriter {
  readonly scanId: string;
  writeFileInventory(files: readonly FileRecord[]): Promise<void>;
  writeArtifacts(artifacts: readonly CachedArtifact[]): Promise<void>;
  writeGraph(graph: CodeMapGraph): Promise<void>;
  complete(summary: ScanSummary): Promise<void>;
  fail(error: ScanFailure): Promise<void>;
  cancel(reason?: string): Promise<void>;
}

export interface GraphStore {
  createProject(input: CreateProjectInput): Promise<ProjectRecord>;
  getProject(projectId: string): Promise<ProjectRecord | null>;
  findProjectByRoot(canonicalRoot: string): Promise<ProjectRecord | null>;
  listProjects(): Promise<ProjectRecord[]>;
  beginScan(input: BeginScanInput): Promise<ScanWriter>;
  getLatestCompletedScan(projectId: string): Promise<ScanRecord | null>;
  getScan(scanId: string): Promise<ScanRecord | null>;
  listScans(projectId: string): Promise<ScanRecord[]>;
  getScanFiles(scanId: string): Promise<FileRecord[]>;
  loadGraph(scanId: string, query?: GraphQuery): Promise<CodeMapGraph>;
  getArtifacts(cacheKeys: readonly string[]): Promise<Map<string, FileExtraction>>;
  clearArtifactCache(options?: CacheClearOptions): Promise<void>;
  getCacheStats(): Promise<CacheStats>;
  close(): Promise<void>;
}
