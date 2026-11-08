/** File inventory, static project configuration snapshots and CodeMap configuration. */

export type FileParseStatus = "parsed" | "reused" | "skipped" | "failed" | "unsupported";

export interface FileRecord {
  /** Repository-relative POSIX path. */
  relativePath: string;
  sizeBytes: number;
  mtimeMs?: number;
  /** "sha256:<hex>" of the file bytes; absent when the file was not read. */
  contentHash?: string;
  language?: string;
  adapterId?: string;
  adapterVersion?: string;
  parseStatus: FileParseStatus;
  /** Stable diagnostic code explaining a skip/failure. */
  skipReason?: string;
}

export type ConfigSnapshotKind =
  | "package_json"
  | "tsconfig"
  | "jsconfig"
  | "pyproject"
  | "pnpm_workspace"
  | "setup_cfg"
  | "requirements_txt";

/**
 * A static snapshot of an allowlisted configuration file. The raw text is bounded in size and
 * is only parsed by the resolver that understands it. Never contains environment files.
 */
export interface ConfigSnapshot {
  path: string;
  kind: ConfigSnapshotKind;
  text: string;
}

export interface ProjectContext {
  /** Sorted repository-relative paths of every discovered source file. */
  sourceFiles: readonly string[];
  /** Sorted repository-relative paths of every discovered directory containing source files. */
  directories: readonly string[];
  configs: readonly ConfigSnapshot[];
}

export interface CodeMapConfig {
  version: 1;
  include: string[];
  exclude: string[];
  maxFileSizeBytes: number;
  maxFiles: number;
  concurrency: "auto" | number;
  languages: string[];
  resolution: {
    typescript: boolean;
    python: boolean;
    resolveExternalPackages: boolean;
  };
  analysis: {
    calls: boolean;
    inheritance: boolean;
    cycles: boolean;
  };
}

export const SUPPORTED_LANGUAGES = ["javascript", "typescript", "python"] as const;

export const DEFAULT_CONFIG: CodeMapConfig = {
  version: 1,
  include: [],
  exclude: [],
  maxFileSizeBytes: 2_000_000,
  maxFiles: 50_000,
  concurrency: "auto",
  languages: [...SUPPORTED_LANGUAGES],
  resolution: { typescript: true, python: true, resolveExternalPackages: true },
  analysis: { calls: true, inheritance: true, cycles: true },
};

export const MAX_CONCURRENCY = 16;
