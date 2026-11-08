/** Stable diagnostic codes. Never renumber a released code. */
export const DiagnosticCodes = {
  /** File skipped because it is binary. */
  BINARY_FILE: "SCAN001",
  /** File skipped because it exceeds the configured size. */
  FILE_TOO_LARGE: "SCAN002",
  /** Symlink skipped by policy. */
  SYMLINK_SKIPPED: "SCAN003",
  /** File/directory could not be read (permissions, races). */
  ACCESS_ERROR: "SCAN004",
  /** Maximum file count reached; remaining files not scanned. */
  FILE_LIMIT_REACHED: "SCAN005",
  /** A configuration/manifest file could not be parsed. */
  CONFIG_INVALID: "SCAN006",
  /** Syntax errors recovered; partial extraction available. */
  PARSE_RECOVERED: "PARSE001",
  /** Parser failed for file. */
  PARSE_FAILED: "PARSE002",
  /** Parser exceeded its time budget. */
  PARSE_TIMEOUT: "PARSE003",
  /** Syntax construct recognised but not supported by the adapter. */
  PARSE_UNSUPPORTED: "PARSE004",
  /** Import could not be resolved. */
  RESOLVE_UNRESOLVED: "RESOLVE001",
  /** Multiple candidate targets found. */
  RESOLVE_AMBIGUOUS: "RESOLVE002",
  /** Resolution mode/configuration not fully supported. */
  RESOLVE_PARTIAL_SUPPORT: "RESOLVE003",
  /** Duplicate/ambiguous symbol identity. */
  GRAPH_DUPLICATE_SYMBOL: "GRAPH001",
  /** Graph invariant violation. */
  GRAPH_INVARIANT: "GRAPH002",
  /** Scan persistence failed. */
  STORE_FAILED: "STORE001",
} as const;

export type DiagnosticCode = (typeof DiagnosticCodes)[keyof typeof DiagnosticCodes];
