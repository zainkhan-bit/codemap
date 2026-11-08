import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { CodeMapGraph, FileExtraction, ScanSummary } from "@codemap/contracts";
import { SqliteGraphStore, StorageError, migrate, openDatabase } from "./store.js";
import { MIGRATIONS } from "./migrations.js";
import { defaultDataDirectory } from "./data-dir.js";

let dir: string;
let file: string;

beforeEach(async () => {
  dir = await mkdtemp(path.join(os.tmpdir(), "codemap-store-"));
  file = path.join(dir, "codemap.db");
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

const loc = { path: "a.ts", startByte: 0, endByte: 3, startLine: 1, startColumn: 1, endLine: 1, endColumn: 4 };
function graph(scanId: string): CodeMapGraph {
  return {
    schemaVersion: "1.0",
    project: { id: "prj_1", displayName: "demo", rootLabel: "demo" },
    scan: { id: scanId, toolVersion: "0.1.0", startedAt: "t", completedAt: "t", configurationHash: "c", parserSetHash: "p" },
    nodes: [
      { id: "prj_1", kind: "project", name: "demo", attributes: {} },
      { id: "fil_a", kind: "file", name: "a.ts", path: "a.ts", language: "typescript", attributes: { sizeBytes: 3 } },
      { id: "fil_b", kind: "file", name: "b.ts", path: "b.ts", language: "typescript", attributes: {} },
      { id: "sym_f", kind: "symbol", name: "f", qualifiedName: "f", symbolKind: "function", path: "a.ts", location: loc, attributes: { exported: true } },
    ],
    edges: [
      { id: "edg_1", kind: "contains", sourceId: "prj_1", targetId: "fil_a", confidence: "high", evidenceReferenceIds: [], attributes: {} },
      { id: "edg_2", kind: "imports", sourceId: "fil_a", targetId: "fil_b", confidence: "high", resolutionMethod: "relative_path", evidenceReferenceIds: ["ref_1"], attributes: { typeOnly: false } },
    ],
    references: [
      { id: "ref_1", kind: "import", sourceNodeId: "fil_a", sourceLocation: loc, rawText: "import './b'", specifier: "./b", targetNodeId: "fil_b", status: "resolved_internal", confidence: "high", attributes: {} },
      { id: "ref_2", kind: "import", sourceNodeId: "fil_a", sourceLocation: { ...loc, startByte: 5, endByte: 8 }, rawText: "import 'x'", specifier: "x", status: "unresolved", message: "nope", attributes: {} },
    ],
    diagnostics: [{ id: "dgn_1", code: "RESOLVE001", severity: "warning", message: "x: nope", location: loc, attributes: {} }],
    metrics: { "nodes.total": 4 },
  };
}
const summary: ScanSummary = { fileCount: 2, parsedCount: 2, reusedCount: 0, skippedCount: 0, failedCount: 0, nodeCount: 4, edgeCount: 2, referenceCount: 2, unresolvedCount: 1, cycleCount: 0, diagnosticCounts: { info: 0, warning: 1, error: 0 }, durationsMs: {}, languages: { typescript: 2 } };
const begin = (store: SqliteGraphStore, scanId: string) =>
  store.beginScan({ scanId, projectId: "prj_1", startedAt: new Date().toISOString(), toolVersion: "0.1.0", graphSchemaVersion: "1.0", configurationHash: "c", parserSetHash: "p" });

async function completedScan(store: SqliteGraphStore, scanId: string) {
  const w = await begin(store, scanId);
  await w.writeFileInventory([{ relativePath: "a.ts", sizeBytes: 3, parseStatus: "parsed", contentHash: "sha256:x", language: "typescript" }]);
  await w.writeGraph(graph(scanId));
  await w.complete(summary);
}

describe("SqliteGraphStore", () => {
  it("migrates a fresh database and enables WAL + foreign keys", async () => {
    const store = new SqliteGraphStore({ filename: file });
    expect(store.db.pragma("journal_mode", { simple: true })).toBe("wal");
    expect(store.db.pragma("foreign_keys", { simple: true })).toBe(1);
    expect((store.db.prepare("SELECT COUNT(*) n FROM schema_migrations").get() as { n: number }).n).toBe(MIGRATIONS.length);
    await store.close();
  });

  it("writes and reloads an identical graph snapshot", async () => {
    const store = new SqliteGraphStore({ filename: file });
    await store.createProject({ projectId: "prj_1", canonicalRoot: "/tmp/demo", displayName: "demo" });
    await completedScan(store, "scn_1");
    const loaded = await store.loadGraph("scn_1");
    const expected = graph("scn_1");
    expect(loaded.nodes).toEqual(expected.nodes);
    expect(loaded.edges).toEqual(expected.edges);
    expect(loaded.references).toEqual(expected.references);
    expect(loaded.diagnostics).toEqual(expected.diagnostics);
    expect(loaded.metrics).toEqual(expected.metrics);
    expect((await store.getScanFiles("scn_1"))[0]!.contentHash).toBe("sha256:x");
    expect((await store.loadGraph("scn_1", { nodeKinds: ["file"] })).edges.map((e) => e.id)).toEqual(["edg_2"]);
    await store.close();
  });

  it("enforces foreign keys and cascades snapshot deletion", async () => {
    const store = new SqliteGraphStore({ filename: file });
    await store.createProject({ projectId: "prj_1", canonicalRoot: "/tmp/demo", displayName: "demo" });
    expect(() => store.db.prepare("INSERT INTO graph_nodes (scan_id, node_id, ordinal, kind, name, attributes_json) VALUES ('scn_ghost', 'n', 0, 'file', 'x', '{}')").run()).toThrow(/FOREIGN KEY/);
    expect(() => store.db.prepare("INSERT INTO scans (scan_id, project_id, status, started_at, tool_version, graph_schema_version, configuration_hash, parser_set_hash, summary_json) VALUES ('s', 'prj_ghost', 'running', 't', 'v', '1', 'c', 'p', '{}')").run()).toThrow(/FOREIGN KEY/);
    expect(() => store.db.prepare("INSERT INTO graph_edges (scan_id, edge_id, ordinal, kind, source_node_id, target_node_id, confidence, evidence_reference_ids_json, attributes_json) VALUES ('scn_ghost', 'e', 0, 'teleports', 'a', 'b', 'high', '[]', '{}')").run()).toThrow(/CHECK|FOREIGN KEY/);
    await completedScan(store, "scn_1");
    store.db.prepare("DELETE FROM projects WHERE project_id = 'prj_1'").run();
    for (const t of ["scans", "graph_nodes", "graph_edges", "graph_references", "diagnostics", "scan_files"]) expect((store.db.prepare(`SELECT COUNT(*) n FROM ${t}`).get() as { n: number }).n, t).toBe(0);
    await store.close();
  });

  it("rolls back the whole graph write on failure and keeps the previous completed scan as latest", async () => {
    const store = new SqliteGraphStore({ filename: file, failAfterRows: 5 });
    await store.createProject({ projectId: "prj_1", canonicalRoot: "/tmp/demo", displayName: "demo" });
    const good = new SqliteGraphStore({ filename: file });
    await completedScan(good, "scn_good");
    const w = await begin(store, "scn_bad");
    await expect(w.writeGraph(graph("scn_bad"))).rejects.toThrow(/injected failure/);
    expect((store.db.prepare("SELECT COUNT(*) n FROM graph_nodes WHERE scan_id = 'scn_bad'").get() as { n: number }).n).toBe(0);
    await w.fail({ code: "STORE001", message: "boom" });
    expect((await store.getScan("scn_bad"))!.status).toBe("failed");
    expect((await store.getLatestCompletedScan("prj_1"))!.scanId).toBe("scn_good");
    await expect(store.loadGraph("scn_bad")).rejects.toBeInstanceOf(StorageError);
    await good.close();
    await store.close();
  });

  it("an interrupted (running) or cancelled scan never becomes latest", async () => {
    const store = new SqliteGraphStore({ filename: file });
    await store.createProject({ projectId: "prj_1", canonicalRoot: "/tmp/demo", displayName: "demo" });
    await completedScan(store, "scn_1");
    const running = await begin(store, "scn_running");
    await running.writeGraph(graph("scn_running"));
    const cancelled = await begin(store, "scn_cancel");
    await cancelled.cancel();
    expect((await store.getLatestCompletedScan("prj_1"))!.scanId).toBe("scn_1");
    await store.close();
  });

  it("caches artifacts by key and clears them", async () => {
    const store = new SqliteGraphStore({ filename: file });
    await store.createProject({ projectId: "prj_1", canonicalRoot: "/tmp/demo", displayName: "demo" });
    const w = await begin(store, "scn_c");
    const extraction: FileExtraction = { adapterId: "a", adapterVersion: "1", language: "typescript", syntaxStatus: "valid", imports: [], exports: [], symbols: [], calls: [], inheritance: [], diagnostics: [], extractionMetrics: { parseDurationMs: 1 } };
    await w.writeArtifacts([{ cacheKey: "k1", contentHash: "h", adapterId: "a", adapterVersion: "1", extractionVersion: "1", optionsHash: "o", extraction }]);
    expect((await store.getArtifacts(["k1", "k2"])).size).toBe(1);
    expect((await store.getCacheStats()).artifactCount).toBe(1);
    await store.clearArtifactCache();
    expect((await store.getArtifacts(["k1"])).size).toBe(0);
    await store.close();
  });

  it("prunes old scans beyond the retention limit", async () => {
    const store = new SqliteGraphStore({ filename: file, retainScans: 2 });
    await store.createProject({ projectId: "prj_1", canonicalRoot: "/tmp/demo", displayName: "demo" });
    for (const id of ["scn_1", "scn_2", "scn_3"]) await completedScan(store, id);
    expect((await store.listScans("prj_1")).map((s) => s.scanId).sort()).toEqual(["scn_2", "scn_3"]);
    await store.close();
  });

  it("reopens cleanly, passes integrity_check and detects tampered migrations", async () => {
    const store = new SqliteGraphStore({ filename: file });
    await store.close();
    const reopened = new SqliteGraphStore({ filename: file });
    expect(reopened.integrityCheck()).toBe("ok");
    reopened.db.prepare("UPDATE schema_migrations SET checksum = 'tampered' WHERE version = 1").run();
    await reopened.close();
    expect(() => new SqliteGraphStore({ filename: file })).toThrow(/checksum mismatch/);
  });

  it("refuses a database from a newer CodeMap", async () => {
    const db = openDatabase(file);
    migrate(db);
    db.prepare("INSERT INTO schema_migrations VALUES (999, 'future', 'x', 'now')").run();
    db.close();
    expect(() => new SqliteGraphStore({ filename: file })).toThrow(/newer CodeMap/);
  });

  it("keeps data outside the project in a platform data directory", () => {
    expect(defaultDataDirectory({ LOCALAPPDATA: "C:\\Users\\u\\AppData\\Local" }, "win32")).toBe(path.join("C:\\Users\\u\\AppData\\Local", "CodeMap"));
    expect(defaultDataDirectory({ XDG_DATA_HOME: "/x" }, "linux")).toBe(path.join("/x", "codemap"));
    expect(defaultDataDirectory({ CODEMAP_DATA_DIR: dir }, "linux")).toBe(path.resolve(dir));
    void Database;
  });
});
