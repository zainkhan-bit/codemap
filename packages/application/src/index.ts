/**
 * @codemap/application — the composition root. The only package that wires the
 * scanner, adapters, resolvers, graph engine, storage and exporters together.
 * The CLI (and later the dashboard API) call these use cases only.
 */
import { existsSync } from "node:fs";
import { access, constants, mkdir } from "node:fs/promises";
import path from "node:path";
import {
  DEFAULT_PARSER_LIMITS,
  TOOL_VERSION,
  type CodeMapGraph,
  type GraphNode,
  type GraphStore,
  type GraphView,
  type LanguageAdapter,
  type ProjectRecord,
  type ReferenceResolver,
  type ScanRecord,
} from "@codemap/contracts";
import { createJavaScriptTypeScriptAdapter } from "@codemap/adapter-javascript-typescript";
import { createPythonAdapter } from "@codemap/adapter-python";
import { createJavaScriptTypeScriptResolver } from "@codemap/resolver-javascript-typescript";
import { createPythonResolver } from "@codemap/resolver-python";
import { validateRoot } from "@codemap/scanner";
import { DATABASE_FILE_NAME, DATABASE_SCHEMA_VERSION, SqliteGraphStore, StorageError, defaultDataDirectory } from "@codemap/storage-sqlite";
import { analyzeArchitecture, findNode, nodeDetails, projectGraph, traverseDependencies, type ProjectionFilters } from "@codemap/graph-engine";
import { ExportError, exportJson, exportMermaid, exportPng, exportSvg, type ExportFormat } from "@codemap/exporters";
import { CodeMapError } from "./errors.js";
import { ScanProjectUseCase, projectIdFor, type ScanProjectInput, type ScanProjectResult } from "./scan.js";

export * from "./errors.js";
export * from "./scan.js";
export type { ExportFormat } from "@codemap/exporters";

export interface OpenOptions {
  /** Data directory; defaults to the platform user-data directory (or CODEMAP_DATA_DIR). */
  dataDir?: string;
  /** Inject a store (tests). */
  store?: GraphStore;
}

export interface ScanSelector {
  projectId?: string;
  scanId?: string;
  /** Used to pick the project when neither id is given. */
  cwd?: string;
}

export interface CycleReport {
  index: number;
  files: string[];
  path: string[];
  selfLoop: boolean;
}

export interface ProjectSummary {
  project: { id: string; displayName: string };
  scan: ScanRecord;
  metrics: Record<string, number>;
  cycles: CycleReport[];
  topFanIn: { path: string; fanIn: number }[];
  topFanOut: { path: string; fanOut: number }[];
  isolatedFiles: string[];
  unresolved: { kind: string; count: number }[];
}

export interface DoctorCheck {
  name: string;
  ok: boolean;
  detail: string;
}

/**
 * Loads the optional PNG rasterizer. It carries a native per-platform binary, so it is an
 * optional dependency: when it cannot load, PNG export fails clearly instead of emitting a blank image.
 */
async function loadRasterizer(): Promise<typeof import("@codemap/rasterizer-png")> {
  try {
    return await import("@codemap/rasterizer-png");
  } catch (err) {
    try {
      exportPng();
    } catch (unavailable) {
      throw new CodeMapError("invalid_input", (unavailable as Error).message, [`rasterizer load error: ${(err as Error).message.split("\n")[0]}`]);
    }
    throw err;
  }
}

function label(graph: CodeMapGraph, id: string): string {
  const n = graph.nodes.find((x) => x.id === id);
  return n ? (n.path ?? n.qualifiedName ?? n.name) : id;
}

export class CodeMapApplication {
  readonly dataDir: string;
  readonly adapters: LanguageAdapter[] = [createJavaScriptTypeScriptAdapter(), createPythonAdapter()];
  readonly resolvers: ReferenceResolver[] = [createJavaScriptTypeScriptResolver(), createPythonResolver()];

  private constructor(
    readonly store: GraphStore,
    dataDir: string,
  ) {
    this.dataDir = dataDir;
  }

  static databasePath(dataDir: string = defaultDataDirectory()): string {
    return path.join(dataDir, DATABASE_FILE_NAME);
  }

  static async open(opts: OpenOptions = {}): Promise<CodeMapApplication> {
    const dataDir = opts.dataDir ?? defaultDataDirectory();
    if (opts.store) return new CodeMapApplication(opts.store, dataDir);
    try {
      await mkdir(dataDir, { recursive: true });
      return new CodeMapApplication(new SqliteGraphStore({ filename: CodeMapApplication.databasePath(dataDir) }), dataDir);
    } catch (err) {
      throw new CodeMapError(
        "storage",
        err instanceof StorageError ? err.message : `cannot open CodeMap data directory ${dataDir}: ${(err as Error).message}`,
        [`The database only holds derived data. To reset it, delete ${CodeMapApplication.databasePath(dataDir)} (and its -wal/-shm files) and scan again.`],
        err,
      );
    }
  }

  /** Data location without opening the database (works even when the database is unusable). */
  static dataLocation(dataDir: string = defaultDataDirectory()): { dataDir: string; database: string; databaseSchemaVersion: number } {
    return { dataDir, database: CodeMapApplication.databasePath(dataDir), databaseSchemaVersion: DATABASE_SCHEMA_VERSION };
  }

  async close(): Promise<void> {
    await this.store.close();
  }

  // ------------------------------------------------------------ ScanProjectUseCase

  scanProject(input: ScanProjectInput): Promise<ScanProjectResult> {
    return new ScanProjectUseCase(this.store, this.adapters, this.resolvers).execute(input);
  }

  // ------------------------------------------------------------ selection helpers

  /** Resolves which completed scan a read command refers to. */
  async selectScan(sel: ScanSelector): Promise<{ project: ProjectRecord; scan: ScanRecord }> {
    if (sel.scanId) {
      const scan = await this.store.getScan(sel.scanId);
      if (!scan) throw new CodeMapError("not_found", `scan ${sel.scanId} not found`);
      if (scan.status !== "completed") throw new CodeMapError("not_found", `scan ${sel.scanId} is ${scan.status}; only completed scans can be read`);
      return { project: (await this.store.getProject(scan.projectId))!, scan };
    }
    let project: ProjectRecord | null = null;
    if (sel.projectId) {
      project = await this.store.getProject(sel.projectId);
      if (!project) throw new CodeMapError("not_found", `project ${sel.projectId} not found; run "codemap projects" to list known projects`);
    } else if (sel.cwd) {
      // Pick the project whose root is the cwd or its nearest ancestor.
      const projects = await this.store.listProjects();
      let canonical: string | undefined;
      try {
        canonical = (await validateRoot(sel.cwd)).canonicalRoot;
      } catch {
        canonical = undefined;
      }
      if (canonical) {
        const id = projectIdFor(canonical);
        project = projects.find((p) => p.projectId === id) ?? null;
        if (!project) {
          const norm = (p: string) => (process.platform === "win32" ? p.toLowerCase() : p);
          project = projects.filter((p) => norm(canonical!).startsWith(norm(p.canonicalRoot) + path.sep)).sort((a, b) => b.canonicalRoot.length - a.canonicalRoot.length)[0] ?? null;
        }
      }
      if (!project && projects.length === 1) project = projects[0]!;
    }
    if (!project) throw new CodeMapError("not_found", 'no scanned project found here; run "codemap scan <path>" first or pass --project <id>');
    const scan = await this.store.getLatestCompletedScan(project.projectId);
    if (!scan) throw new CodeMapError("not_found", `project ${project.displayName} has no completed scan; run "codemap scan" first`);
    return { project, scan };
  }

  async loadGraph(sel: ScanSelector): Promise<{ project: ProjectRecord; scan: ScanRecord; graph: CodeMapGraph }> {
    const { project, scan } = await this.selectScan(sel);
    return { project, scan, graph: await this.store.loadGraph(scan.scanId) };
  }

  // ------------------------------------------------------------ GetProjectSummaryUseCase

  async getProjectSummary(sel: ScanSelector, opts: { top?: number; excludeTypeOnly?: boolean } = {}): Promise<ProjectSummary> {
    const { project, scan, graph } = await this.loadGraph(sel);
    const analysis = analyzeArchitecture(graph, opts);
    const unresolved = new Map<string, number>();
    for (const r of graph.references) if (r.status === "unresolved" || r.status === "ambiguous") unresolved.set(r.kind, (unresolved.get(r.kind) ?? 0) + 1);
    return {
      project: { id: project.projectId, displayName: project.displayName },
      scan,
      metrics: graph.metrics,
      cycles: analysis.cycles.map((c, i) => ({ index: i + 1, files: c.nodeIds.map((id) => label(graph, id)).sort(), path: c.path.map((id) => label(graph, id)), selfLoop: c.selfLoop })),
      topFanIn: analysis.topFanIn.map((d) => ({ path: label(graph, d.nodeId), fanIn: d.fanIn })),
      topFanOut: analysis.topFanOut.map((d) => ({ path: label(graph, d.nodeId), fanOut: d.fanOut })),
      isolatedFiles: analysis.isolatedFiles.map((id) => label(graph, id)),
      unresolved: [...unresolved.entries()].sort().map(([kind, count]) => ({ kind, count })),
    };
  }

  // ------------------------------------------------------------ AnalyzeCycles (analyze --cycles)

  async analyzeCycles(sel: ScanSelector, opts: { excludeTypeOnly?: boolean } = {}): Promise<{ scanId: string; cycles: CycleReport[] }> {
    const summary = await this.getProjectSummary(sel, opts);
    return { scanId: summary.scan.scanId, cycles: summary.cycles };
  }

  // ------------------------------------------------------------ GetGraphProjectionUseCase

  async getGraphProjection(sel: ScanSelector, view: GraphView, filters: ProjectionFilters = {}) {
    const { graph } = await this.loadGraph(sel);
    return projectGraph(graph, view, filters);
  }

  // ------------------------------------------------------------ GetNodeDetailsUseCase / GetNodeDependenciesUseCase

  async getNodeDetails(sel: ScanSelector, query: string) {
    const { graph } = await this.loadGraph(sel);
    const matches = findNode(graph, query);
    if (matches.length === 0) throw new CodeMapError("not_found", `no node matches "${query}"`);
    if (matches.length > 1) throw new CodeMapError("invalid_input", `"${query}" matches ${matches.length} nodes; use a node id`, matches.slice(0, 10).map((m) => `${m.id}  ${m.path ?? ""} ${m.qualifiedName ?? m.name}`));
    return nodeDetails(graph, matches[0]!.id)!;
  }

  async getNodeDependencies(sel: ScanSelector, query: string, opts: { direction?: "outgoing" | "incoming"; maxDepth?: number } = {}): Promise<{ node: GraphNode; dependencies: { path: string; depth: number }[] }> {
    const { graph } = await this.loadGraph(sel);
    const matches = findNode(graph, query);
    if (matches.length !== 1) throw new CodeMapError("not_found", matches.length ? `"${query}" is ambiguous` : `no node matches "${query}"`);
    const hits = traverseDependencies(graph, matches[0]!.id, opts);
    return { node: matches[0]!, dependencies: hits.map((h) => ({ path: label(graph, h.nodeId), depth: h.depth })) };
  }

  // ------------------------------------------------------------ ExportGraphUseCase

  async exportGraph(sel: ScanSelector, format: ExportFormat, opts: ProjectionFilters & { view?: GraphView; force?: boolean; maxNodes?: number } = {}): Promise<{ content: string | Uint8Array; scanId: string }> {
    const { scan, graph } = await this.loadGraph(sel);
    try {
      switch (format) {
        case "json":
          return { content: exportJson(graph), scanId: scan.scanId };
        case "svg":
          return { content: exportSvg(graph, opts), scanId: scan.scanId };
        case "mermaid":
          return { content: exportMermaid(graph, opts), scanId: scan.scanId };
        case "png": {
          const svg = exportSvg(graph, opts);
          const rasterizer = await loadRasterizer();
          try {
            return { content: rasterizer.rasterizeSvg(svg), scanId: scan.scanId };
          } catch (err) {
            throw new CodeMapError("invalid_input", `PNG export failed: ${(err as Error).message}`);
          }
        }
      }
    } catch (err) {
      if (err instanceof ExportError) throw new CodeMapError(err.code === "invalid_graph" ? "internal" : "invalid_input", err.message);
      throw err;
    }
  }

  // ------------------------------------------------------------ projects / cache / data location

  async listProjects(): Promise<{ project: ProjectRecord; latest: ScanRecord | null }[]> {
    const projects = await this.store.listProjects();
    return Promise.all(projects.map(async (p) => ({ project: p, latest: await this.store.getLatestCompletedScan(p.projectId) })));
  }

  async clearCache(opts: { all?: boolean } = {}): Promise<{ removedArtifacts: number; removedBytes: number }> {
    const before = await this.store.getCacheStats();
    await this.store.clearArtifactCache(opts);
    return { removedArtifacts: before.artifactCount, removedBytes: before.totalBytes };
  }

  dataLocation(): { dataDir: string; database: string; databaseSchemaVersion: number } {
    return CodeMapApplication.dataLocation(this.dataDir);
  }

  // ------------------------------------------------------------ DoctorUseCase

  async doctor(): Promise<DoctorCheck[]> {
    const checks: DoctorCheck[] = [];
    const major = Number(process.versions.node.split(".")[0]);
    checks.push({ name: "node", ok: major >= 24, detail: `Node.js ${process.versions.node} (requires >= 24)` });
    try {
      await access(this.dataDir, constants.W_OK);
      checks.push({ name: "data-directory", ok: true, detail: `${this.dataDir} is writable` });
    } catch {
      checks.push({ name: "data-directory", ok: false, detail: `${this.dataDir} is not writable` });
    }
    if (this.store instanceof SqliteGraphStore) {
      const integrity = this.store.integrityCheck();
      checks.push({ name: "sqlite", ok: integrity === "ok", detail: `database schema v${DATABASE_SCHEMA_VERSION}, integrity_check=${integrity}, JSON functions available` });
    }
    const samples: Record<string, [string, string]> = { "javascript-typescript": ["probe.tsx", "export const a = (p: number) => <b/>;"], python: ["probe.py", "def f():\n    return 1\n"] };
    for (const a of this.adapters) {
      const [file, code] = samples[a.id] ?? ["probe.txt", ""];
      try {
        const ex = await a.parseFile({ relativePath: file, language: a.languages[0]!, source: new TextEncoder().encode(code), contentHash: "probe", projectConfiguration: { calls: true, inheritance: true }, limits: DEFAULT_PARSER_LIMITS });
        checks.push({ name: `adapter:${a.id}`, ok: ex.syntaxStatus === "valid" && ex.symbols.length > 0, detail: `${a.id}@${a.version} (${a.grammarFingerprint})` });
      } catch (err) {
        checks.push({ name: `adapter:${a.id}`, ok: false, detail: `grammar failed to load: ${(err as Error).message}` });
      }
    }
    checks.push({ name: "codemap", ok: true, detail: `CodeMap ${TOOL_VERSION}; database ${existsSync(CodeMapApplication.databasePath(this.dataDir)) ? "present" : "not yet created"}` });
    return checks;
  }
}
