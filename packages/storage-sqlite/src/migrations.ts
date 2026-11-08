/**
 * Numbered, immutable migrations. NEVER edit a released migration — add a new one.
 * The checksum of each migration's SQL is recorded and verified on every open.
 *
 * Deviations from the blueprint baseline (measured; see docs/decisions/ADR-0010):
 * - Graph tables are rowid tables, not WITHOUT ROWID: rows carry JSON and exceed the
 *   small-row size where WITHOUT ROWID pays off.
 * - Graph rows reference their scan (ON DELETE CASCADE) but not individual nodes. Edge and
 *   reference endpoints are verified by the graph invariant check before the single write
 *   transaction; per-row node FKs cost ~25% of write time and require child indexes.
 * - Secondary query indexes are deferred until a consumer queries by them (dashboard API);
 *   v0.1 loads whole snapshots by scan_id through the primary key.
 * - `ordinal` columns preserve the deterministic order of nodes/edges/references/diagnostics.
 * - scans.metrics_json stores graph metrics alongside the summary.
 */
import { createHash } from "node:crypto";

export interface Migration {
  version: number;
  name: string;
  sql: string;
}

export const MIGRATIONS: readonly Migration[] = [
  {
    version: 1,
    name: "initial_schema",
    sql: `
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
  metrics_json TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(metrics_json)),
  error_json TEXT CHECK (error_json IS NULL OR json_valid(error_json))
) STRICT;

CREATE INDEX idx_scans_project_completed ON scans(project_id, status, completed_at DESC);

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
  ordinal INTEGER NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('project','directory','file','module','package','symbol')),
  name TEXT NOT NULL,
  qualified_name TEXT,
  language TEXT,
  path TEXT,
  symbol_kind TEXT,
  location_json TEXT CHECK (location_json IS NULL OR json_valid(location_json)),
  attributes_json TEXT NOT NULL CHECK (json_valid(attributes_json)),
  PRIMARY KEY (scan_id, node_id)
) STRICT;

CREATE TABLE graph_edges (
  scan_id TEXT NOT NULL REFERENCES scans(scan_id) ON DELETE CASCADE,
  edge_id TEXT NOT NULL,
  ordinal INTEGER NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('contains','imports','exports','calls','extends','implements')),
  source_node_id TEXT NOT NULL,
  target_node_id TEXT NOT NULL,
  confidence TEXT NOT NULL CHECK (confidence IN ('high','medium','low')),
  resolution_method TEXT,
  evidence_reference_ids_json TEXT NOT NULL CHECK (json_valid(evidence_reference_ids_json)),
  attributes_json TEXT NOT NULL CHECK (json_valid(attributes_json)),
  PRIMARY KEY (scan_id, edge_id)
) STRICT;

CREATE TABLE graph_references (
  scan_id TEXT NOT NULL REFERENCES scans(scan_id) ON DELETE CASCADE,
  reference_id TEXT NOT NULL,
  ordinal INTEGER NOT NULL,
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
  imported_names_json TEXT CHECK (imported_names_json IS NULL OR json_valid(imported_names_json)),
  message TEXT,
  attributes_json TEXT NOT NULL CHECK (json_valid(attributes_json)),
  PRIMARY KEY (scan_id, reference_id)
) STRICT;

CREATE TABLE diagnostics (
  scan_id TEXT NOT NULL REFERENCES scans(scan_id) ON DELETE CASCADE,
  diagnostic_id TEXT NOT NULL,
  ordinal INTEGER NOT NULL,
  code TEXT NOT NULL,
  severity TEXT NOT NULL CHECK (severity IN ('info','warning','error')),
  message TEXT NOT NULL,
  location_json TEXT CHECK (location_json IS NULL OR json_valid(location_json)),
  related_locations_json TEXT CHECK (related_locations_json IS NULL OR json_valid(related_locations_json)),
  attributes_json TEXT NOT NULL CHECK (json_valid(attributes_json)),
  PRIMARY KEY (scan_id, diagnostic_id)
) STRICT;
`,
  },
];

export function migrationChecksum(m: Migration): string {
  return createHash("sha256").update(`${m.version}\n${m.name}\n${m.sql}`).digest("hex");
}

/** Database schema version (independent of the graph schema version). */
export const DATABASE_SCHEMA_VERSION = MIGRATIONS[MIGRATIONS.length - 1]!.version;
