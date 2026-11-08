/**
 * SQLite implementation of GraphStore (better-sqlite3).
 *
 * - WAL, foreign keys, busy timeout, synchronous=NORMAL (the database holds derived,
 *   rebuildable data — see docs/decisions/ADR-0006).
 * - Every bulk write runs in one transaction with prepared statements.
 * - A scan is `running` until complete(); only completed scans are ever "latest".
 */
import { mkdirSync } from "node:fs";
import path from "node:path";
import Database from "better-sqlite3";
import {
  GRAPH_SCHEMA_VERSION,
  type BeginScanInput,
  type CacheClearOptions,
  type CacheStats,
  type CachedArtifact,
  type CodeMapGraph,
  type CreateProjectInput,
  type FileExtraction,
  type FileRecord,
  type GraphEdge,
  type GraphNode,
  type GraphQuery,
  type GraphReference,
  type GraphStore,
  type ProjectRecord,
  type ScanFailure,
  type ScanRecord,
  type ScanStatus,
  type ScanSummary,
  type ScanWriter,
} from "@codemap/contracts";
import { MIGRATIONS, migrationChecksum } from "./migrations.js";

type DB = Database.Database;

export class StorageError extends Error {
  constructor(
    message: string,
    override readonly cause?: unknown,
  ) {
    super(message);
  }
}

export interface SqliteStoreOptions {
  /** Database file path, or ":memory:". */
  filename: string;
  /** Completed scans retained per project (older ones are pruned). Default 5. */
  retainScans?: number;
  /** Artifact cache budget in bytes; least-recently-used entries beyond it are pruned. Default 512 MiB. */
  cacheBudgetBytes?: number;
  /** Test hook: throw inside writeGraph after N rows to exercise rollback. */
  failAfterRows?: number;
}

const now = () => new Date().toISOString();
const json = (v: unknown) => JSON.stringify(v);
const parse = <T>(s: string | null | undefined): T | undefined => (s == null ? undefined : (JSON.parse(s) as T));

interface ProjectRow {
  project_id: string;
  canonical_root: string;
  display_name: string;
  created_at: string;
  last_seen_at: string;
}

interface ScanRow {
  scan_id: string;
  project_id: string;
  status: ScanStatus;
  started_at: string;
  completed_at: string | null;
  tool_version: string;
  graph_schema_version: string;
  configuration_hash: string;
  parser_set_hash: string;
  summary_json: string;
  metrics_json: string;
  error_json: string | null;
}

function toProject(r: ProjectRow): ProjectRecord {
  return { projectId: r.project_id, canonicalRoot: r.canonical_root, displayName: r.display_name, createdAt: r.created_at, lastSeenAt: r.last_seen_at };
}

function toScan(r: ScanRow): ScanRecord {
  const summary = parse<ScanSummary | Record<string, never>>(r.summary_json);
  return {
    scanId: r.scan_id,
    projectId: r.project_id,
    status: r.status,
    startedAt: r.started_at,
    ...(r.completed_at ? { completedAt: r.completed_at } : {}),
    toolVersion: r.tool_version,
    graphSchemaVersion: r.graph_schema_version,
    configurationHash: r.configuration_hash,
    parserSetHash: r.parser_set_hash,
    summary: summary && "fileCount" in summary ? (summary as ScanSummary) : null,
    error: parse<ScanFailure>(r.error_json) ?? null,
  };
}

export function openDatabase(filename: string): DB {
  if (filename !== ":memory:") mkdirSync(path.dirname(filename), { recursive: true });
  let db: DB;
  try {
    db = new Database(filename);
  } catch (err) {
    throw new StorageError(`cannot open database ${filename}: ${(err as Error).message}`, err);
  }
  db.pragma("foreign_keys = ON");
  if (filename !== ":memory:") db.pragma("journal_mode = WAL");
  db.pragma("busy_timeout = 5000");
  db.pragma("synchronous = NORMAL");
  // 64 MiB page cache: snapshot writes touch large B-trees; the 2 MiB default thrashes (measured 2.6x slower).
  db.pragma("cache_size = -65536");
  try {
    const ok = db.prepare("SELECT json_valid('{}') AS ok").get() as { ok: number };
    if (ok.ok !== 1) throw new Error("json_valid returned unexpected result");
  } catch (err) {
    db.close();
    throw new StorageError("this SQLite build does not support JSON functions, which CodeMap requires", err);
  }
  return db;
}

export function migrate(db: DB): void {
  db.exec(`CREATE TABLE IF NOT EXISTS schema_migrations (
    version INTEGER PRIMARY KEY,
    name TEXT NOT NULL,
    checksum TEXT NOT NULL,
    applied_at TEXT NOT NULL
  ) STRICT;`);
  const applied = new Map((db.prepare("SELECT version, checksum FROM schema_migrations").all() as { version: number; checksum: string }[]).map((r) => [r.version, r.checksum]));
  const known = new Set(MIGRATIONS.map((m) => m.version));
  for (const v of applied.keys()) if (!known.has(v)) throw new StorageError(`database was created by a newer CodeMap (migration ${v}); upgrade CodeMap or run "codemap cache clear --all"`);
  for (const m of MIGRATIONS) {
    const checksum = migrationChecksum(m);
    const existing = applied.get(m.version);
    if (existing !== undefined) {
      if (existing !== checksum) throw new StorageError(`migration ${m.version} (${m.name}) checksum mismatch; the database or migration was modified`);
      continue;
    }
    db.transaction(() => {
      db.exec(m.sql);
      db.prepare("INSERT INTO schema_migrations (version, name, checksum, applied_at) VALUES (?, ?, ?, ?)").run(m.version, m.name, checksum, now());
    })();
  }
}

export class SqliteGraphStore implements GraphStore {
  readonly db: DB;
  private readonly retainScans: number;
  private readonly cacheBudgetBytes: number;

  constructor(private readonly options: SqliteStoreOptions) {
    this.db = openDatabase(options.filename);
    try {
      migrate(this.db);
    } catch (err) {
      this.db.close();
      throw err;
    }
    this.retainScans = options.retainScans ?? 5;
    this.cacheBudgetBytes = options.cacheBudgetBytes ?? 512 * 1024 * 1024;
  }

  async createProject(input: CreateProjectInput): Promise<ProjectRecord> {
    const ts = now();
    this.db
      .prepare(
        `INSERT INTO projects (project_id, canonical_root, display_name, created_at, last_seen_at) VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(project_id) DO UPDATE SET last_seen_at = excluded.last_seen_at, display_name = excluded.display_name`,
      )
      .run(input.projectId, input.canonicalRoot, input.displayName, ts, ts);
    return (await this.getProject(input.projectId))!;
  }

  async getProject(projectId: string): Promise<ProjectRecord | null> {
    const r = this.db.prepare("SELECT * FROM projects WHERE project_id = ?").get(projectId) as ProjectRow | undefined;
    return r ? toProject(r) : null;
  }

  async findProjectByRoot(canonicalRoot: string): Promise<ProjectRecord | null> {
    const r = this.db.prepare("SELECT * FROM projects WHERE canonical_root = ?").get(canonicalRoot) as ProjectRow | undefined;
    return r ? toProject(r) : null;
  }

  async listProjects(): Promise<ProjectRecord[]> {
    return (this.db.prepare("SELECT * FROM projects ORDER BY last_seen_at DESC, project_id").all() as ProjectRow[]).map(toProject);
  }

  async beginScan(input: BeginScanInput): Promise<ScanWriter> {
    this.db
      .prepare(
        `INSERT INTO scans (scan_id, project_id, status, started_at, tool_version, graph_schema_version, configuration_hash, parser_set_hash, summary_json)
         VALUES (?, ?, 'running', ?, ?, ?, ?, ?, '{}')`,
      )
      .run(input.scanId, input.projectId, input.startedAt, input.toolVersion, input.graphSchemaVersion, input.configurationHash, input.parserSetHash);
    return new SqliteScanWriter(this, input.scanId, input.projectId, this.options.failAfterRows);
  }

  async getLatestCompletedScan(projectId: string): Promise<ScanRecord | null> {
    const r = this.db.prepare("SELECT * FROM scans WHERE project_id = ? AND status = 'completed' ORDER BY completed_at DESC, scan_id DESC LIMIT 1").get(projectId) as ScanRow | undefined;
    return r ? toScan(r) : null;
  }

  async getScan(scanId: string): Promise<ScanRecord | null> {
    const r = this.db.prepare("SELECT * FROM scans WHERE scan_id = ?").get(scanId) as ScanRow | undefined;
    return r ? toScan(r) : null;
  }

  async listScans(projectId: string): Promise<ScanRecord[]> {
    return (this.db.prepare("SELECT * FROM scans WHERE project_id = ? ORDER BY started_at DESC, scan_id DESC").all(projectId) as ScanRow[]).map(toScan);
  }

  async getScanFiles(scanId: string): Promise<FileRecord[]> {
    const rows = this.db.prepare("SELECT * FROM scan_files WHERE scan_id = ? ORDER BY relative_path").all(scanId) as Record<string, unknown>[];
    return rows.map((r) => ({
      relativePath: r.relative_path as string,
      sizeBytes: r.size_bytes as number,
      ...(r.mtime_ms != null ? { mtimeMs: r.mtime_ms as number } : {}),
      ...(r.content_hash ? { contentHash: r.content_hash as string } : {}),
      ...(r.language ? { language: r.language as string } : {}),
      ...(r.adapter_id ? { adapterId: r.adapter_id as string } : {}),
      ...(r.adapter_version ? { adapterVersion: r.adapter_version as string } : {}),
      parseStatus: r.parse_status as FileRecord["parseStatus"],
      ...(r.skip_reason ? { skipReason: r.skip_reason as string } : {}),
    }));
  }

  async loadGraph(scanId: string, query: GraphQuery = {}): Promise<CodeMapGraph> {
    const scanRow = this.db.prepare("SELECT * FROM scans WHERE scan_id = ?").get(scanId) as ScanRow | undefined;
    if (!scanRow) throw new StorageError(`scan ${scanId} not found`);
    if (scanRow.status !== "completed") throw new StorageError(`scan ${scanId} is ${scanRow.status}, not completed`);
    const project = this.db.prepare("SELECT * FROM projects WHERE project_id = ?").get(scanRow.project_id) as ProjectRow;
    const inList = (col: string, vals?: readonly string[]) => (vals?.length ? ` AND ${col} IN (${vals.map(() => "?").join(",")})` : "");

    const nodes = (this.db.prepare(`SELECT * FROM graph_nodes WHERE scan_id = ?${inList("kind", query.nodeKinds)} ORDER BY ordinal`).all(scanId, ...(query.nodeKinds ?? [])) as Record<string, string | null>[]).map(
      (r): GraphNode => ({
        id: r.node_id!,
        kind: r.kind as GraphNode["kind"],
        name: r.name!,
        ...(r.qualified_name != null ? { qualifiedName: r.qualified_name } : {}),
        ...(r.language != null ? { language: r.language } : {}),
        ...(r.path != null ? { path: r.path } : {}),
        ...(r.symbol_kind != null ? { symbolKind: r.symbol_kind as GraphNode["symbolKind"] } : {}),
        ...(r.location_json != null ? { location: JSON.parse(r.location_json) } : {}),
        attributes: JSON.parse(r.attributes_json!),
      }),
    );
    const nodeIds = query.nodeKinds ? new Set(nodes.map((n) => n.id)) : undefined;
    const edges = (this.db.prepare(`SELECT * FROM graph_edges WHERE scan_id = ?${inList("kind", query.edgeKinds)} ORDER BY ordinal`).all(scanId, ...(query.edgeKinds ?? [])) as Record<string, string | null>[])
      .map(
        (r): GraphEdge => ({
          id: r.edge_id!,
          kind: r.kind as GraphEdge["kind"],
          sourceId: r.source_node_id!,
          targetId: r.target_node_id!,
          confidence: r.confidence as GraphEdge["confidence"],
          ...(r.resolution_method != null ? { resolutionMethod: r.resolution_method } : {}),
          evidenceReferenceIds: JSON.parse(r.evidence_reference_ids_json!),
          attributes: JSON.parse(r.attributes_json!),
        }),
      )
      .filter((e) => !nodeIds || (nodeIds.has(e.sourceId) && nodeIds.has(e.targetId)));
    const references = (this.db.prepare(`SELECT * FROM graph_references WHERE scan_id = ?${inList("status", query.referenceStatuses)} ORDER BY ordinal`).all(scanId, ...(query.referenceStatuses ?? [])) as Record<string, string | null>[]).map(
      (r): GraphReference => ({
        id: r.reference_id!,
        kind: r.kind as GraphReference["kind"],
        sourceNodeId: r.source_node_id!,
        sourceLocation: JSON.parse(r.source_location_json!),
        rawText: r.raw_text!,
        ...(r.specifier != null ? { specifier: r.specifier } : {}),
        ...(r.imported_names_json != null ? { importedNames: JSON.parse(r.imported_names_json) } : {}),
        ...(r.target_node_id != null ? { targetNodeId: r.target_node_id } : {}),
        status: r.status as GraphReference["status"],
        ...(r.confidence != null ? { confidence: r.confidence as GraphReference["confidence"] } : {}),
        ...(r.resolver_id != null ? { resolverId: r.resolver_id } : {}),
        ...(r.resolver_version != null ? { resolverVersion: r.resolver_version } : {}),
        ...(r.message != null ? { message: r.message } : {}),
        attributes: JSON.parse(r.attributes_json!),
      }),
    );
    const diagnostics = (this.db.prepare("SELECT * FROM diagnostics WHERE scan_id = ? ORDER BY ordinal").all(scanId) as Record<string, string | null>[]).map((r) => ({
      id: r.diagnostic_id!,
      code: r.code!,
      severity: r.severity as "info" | "warning" | "error",
      message: r.message!,
      ...(r.location_json != null ? { location: JSON.parse(r.location_json) } : {}),
      ...(r.related_locations_json != null ? { relatedLocations: JSON.parse(r.related_locations_json) } : {}),
      attributes: JSON.parse(r.attributes_json!),
    }));
    return {
      schemaVersion: GRAPH_SCHEMA_VERSION,
      project: { id: project.project_id, displayName: project.display_name, rootLabel: project.display_name },
      scan: {
        id: scanRow.scan_id,
        toolVersion: scanRow.tool_version,
        startedAt: scanRow.started_at,
        completedAt: scanRow.completed_at ?? "",
        configurationHash: scanRow.configuration_hash,
        parserSetHash: scanRow.parser_set_hash,
      },
      nodes,
      edges,
      references,
      diagnostics,
      metrics: JSON.parse(scanRow.metrics_json),
    };
  }

  async getArtifacts(cacheKeys: readonly string[]): Promise<Map<string, FileExtraction>> {
    const out = new Map<string, FileExtraction>();
    const sel = this.db.prepare("SELECT artifact_json FROM artifact_cache WHERE cache_key = ?");
    const touch = this.db.prepare("UPDATE artifact_cache SET last_used_at = ? WHERE cache_key = ?");
    const ts = now();
    this.db.transaction(() => {
      for (const k of cacheKeys) {
        const r = sel.get(k) as { artifact_json: string } | undefined;
        if (!r) continue;
        out.set(k, JSON.parse(r.artifact_json) as FileExtraction);
        touch.run(ts, k);
      }
    })();
    return out;
  }

  async clearArtifactCache(options: CacheClearOptions = {}): Promise<void> {
    this.db.transaction(() => {
      this.db.prepare("DELETE FROM artifact_cache").run();
      if (options.all) this.db.prepare("DELETE FROM projects").run();
    })();
    if (options.all) this.db.exec("VACUUM");
  }

  async getCacheStats(): Promise<CacheStats> {
    const r = this.db.prepare("SELECT COUNT(*) AS n, COALESCE(SUM(byte_size), 0) AS b FROM artifact_cache").get() as { n: number; b: number };
    return { artifactCount: r.n, totalBytes: r.b };
  }

  integrityCheck(): string {
    return (this.db.pragma("integrity_check", { simple: true }) as string) ?? "unknown";
  }

  /** Keeps the newest `retainScans` completed scans per project and removes failed/cancelled ones. */
  pruneScans(projectId: string): void {
    const keep = (this.db.prepare("SELECT scan_id FROM scans WHERE project_id = ? AND status = 'completed' ORDER BY completed_at DESC, scan_id DESC LIMIT ?").all(projectId, this.retainScans) as { scan_id: string }[]).map((r) => r.scan_id);
    this.db.transaction(() => {
      const del = this.db.prepare("DELETE FROM scans WHERE scan_id = ?");
      const stale = this.db.prepare("SELECT scan_id FROM scans WHERE project_id = ? AND status IN ('completed','failed','cancelled')").all(projectId) as { scan_id: string }[];
      for (const s of stale) if (!keep.includes(s.scan_id)) del.run(s.scan_id);
    })();
  }

  pruneArtifactCache(): void {
    const { totalBytes } = this.db.prepare("SELECT COALESCE(SUM(byte_size), 0) AS totalBytes FROM artifact_cache").get() as { totalBytes: number };
    if (totalBytes <= this.cacheBudgetBytes) return;
    let excess = totalBytes - this.cacheBudgetBytes;
    const rows = this.db.prepare("SELECT cache_key, byte_size FROM artifact_cache ORDER BY last_used_at ASC, cache_key").all() as { cache_key: string; byte_size: number }[];
    const del = this.db.prepare("DELETE FROM artifact_cache WHERE cache_key = ?");
    this.db.transaction(() => {
      for (const r of rows) {
        if (excess <= 0) break;
        del.run(r.cache_key);
        excess -= r.byte_size;
      }
    })();
  }

  async close(): Promise<void> {
    if (this.db.open) this.db.close();
  }
}

class SqliteScanWriter implements ScanWriter {
  private finished = false;

  constructor(
    private readonly store: SqliteGraphStore,
    readonly scanId: string,
    private readonly projectId: string,
    private readonly failAfterRows?: number,
  ) {}

  private get db(): DB {
    return this.store.db;
  }

  private assertOpen(): void {
    if (this.finished) throw new StorageError(`scan ${this.scanId} is already finalized`);
  }

  async writeFileInventory(files: readonly FileRecord[]): Promise<void> {
    this.assertOpen();
    const ins = this.db.prepare(
      `INSERT INTO scan_files (scan_id, relative_path, content_hash, size_bytes, mtime_ms, language, adapter_id, adapter_version, parse_status, skip_reason)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    this.db.transaction(() => {
      for (const f of files) ins.run(this.scanId, f.relativePath, f.contentHash ?? null, f.sizeBytes, f.mtimeMs ?? null, f.language ?? null, f.adapterId ?? null, f.adapterVersion ?? null, f.parseStatus, f.skipReason ?? null);
    })();
  }

  async writeArtifacts(artifacts: readonly CachedArtifact[]): Promise<void> {
    this.assertOpen();
    const ins = this.db.prepare(
      `INSERT INTO artifact_cache (cache_key, content_hash, adapter_id, adapter_version, extraction_version, options_hash, artifact_json, byte_size, created_at, last_used_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(cache_key) DO UPDATE SET last_used_at = excluded.last_used_at`,
    );
    const ts = now();
    this.db.transaction(() => {
      for (const a of artifacts) {
        const body = json(a.extraction);
        ins.run(a.cacheKey, a.contentHash, a.adapterId, a.adapterVersion, a.extractionVersion, a.optionsHash, body, Buffer.byteLength(body), ts, ts);
      }
    })();
  }

  async writeGraph(graph: CodeMapGraph): Promise<void> {
    this.assertOpen();
    let rows = 0;
    const tick = () => {
      if (this.failAfterRows !== undefined && ++rows > this.failAfterRows) throw new StorageError("injected failure (test hook)");
    };
    const insNode = this.db.prepare(
      `INSERT INTO graph_nodes (scan_id, node_id, ordinal, kind, name, qualified_name, language, path, symbol_kind, location_json, attributes_json)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    const insEdge = this.db.prepare(
      `INSERT INTO graph_edges (scan_id, edge_id, ordinal, kind, source_node_id, target_node_id, confidence, resolution_method, evidence_reference_ids_json, attributes_json)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    const insRef = this.db.prepare(
      `INSERT INTO graph_references (scan_id, reference_id, ordinal, kind, source_node_id, target_node_id, status, confidence, resolver_id, resolver_version, source_location_json, raw_text, specifier, imported_names_json, message, attributes_json)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    const insDiag = this.db.prepare(
      `INSERT INTO diagnostics (scan_id, diagnostic_id, ordinal, code, severity, message, location_json, related_locations_json, attributes_json)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    const s = this.scanId;
    // Insert in primary-key order (the `ordinal` column keeps the graph's own order): hash IDs are
    // random, and ordered inserts keep the PK index appending instead of splitting pages.
    const byId = <T extends { id: string }>(rows: readonly T[]) => rows.map((row, ordinal) => ({ row, ordinal })).sort((a, b) => (a.row.id < b.row.id ? -1 : a.row.id > b.row.id ? 1 : 0));
    this.db.transaction(() => {
      for (const { row: n, ordinal } of byId(graph.nodes)) {
        tick();
        insNode.run(s, n.id, ordinal, n.kind, n.name, n.qualifiedName ?? null, n.language ?? null, n.path ?? null, n.symbolKind ?? null, n.location ? json(n.location) : null, json(n.attributes));
      }
      for (const { row: e, ordinal } of byId(graph.edges)) {
        tick();
        insEdge.run(s, e.id, ordinal, e.kind, e.sourceId, e.targetId, e.confidence, e.resolutionMethod ?? null, json(e.evidenceReferenceIds), json(e.attributes));
      }
      for (const { row: r, ordinal } of byId(graph.references)) {
        tick();
        insRef.run(s, r.id, ordinal, r.kind, r.sourceNodeId, r.targetNodeId ?? null, r.status, r.confidence ?? null, r.resolverId ?? null, r.resolverVersion ?? null, json(r.sourceLocation), r.rawText, r.specifier ?? null, r.importedNames ? json(r.importedNames) : null, r.message ?? null, json(r.attributes));
      }
      for (const { row: d, ordinal } of byId(graph.diagnostics)) {
        tick();
        insDiag.run(s, d.id, ordinal, d.code, d.severity, d.message, d.location ? json(d.location) : null, d.relatedLocations ? json(d.relatedLocations) : null, json(d.attributes ?? {}));
      }
      this.db.prepare("UPDATE scans SET metrics_json = ? WHERE scan_id = ?").run(json(graph.metrics), s);
    })();
  }

  async complete(summary: ScanSummary): Promise<void> {
    this.assertOpen();
    this.db.prepare("UPDATE scans SET status = 'completed', completed_at = ?, summary_json = ? WHERE scan_id = ? AND status = 'running'").run(now(), json(summary), this.scanId);
    this.finished = true;
    this.store.pruneScans(this.projectId);
    this.store.pruneArtifactCache();
  }

  private finalize(status: "failed" | "cancelled", error: ScanFailure): void {
    if (this.finished) return;
    this.finished = true;
    this.db.transaction(() => {
      // Partial graph rows of an unsuccessful scan are discarded; the scan row records why.
      for (const t of ["diagnostics", "graph_references", "graph_edges", "graph_nodes", "scan_files"]) this.db.prepare(`DELETE FROM ${t} WHERE scan_id = ?`).run(this.scanId);
      this.db.prepare("UPDATE scans SET status = ?, completed_at = ?, error_json = ? WHERE scan_id = ?").run(status, now(), json(error), this.scanId);
    })();
  }

  async fail(error: ScanFailure): Promise<void> {
    this.finalize("failed", error);
  }

  async cancel(reason = "cancelled by user"): Promise<void> {
    this.finalize("cancelled", { code: "CANCELLED", message: reason });
  }
}
