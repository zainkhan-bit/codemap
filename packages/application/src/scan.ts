/**
 * ScanProjectUseCase — the scan pipeline (blueprint §9.1):
 *
 *  1 validate path → 2 load config → 3–5 discover/classify → 6 read + hash →
 *  7 reuse or parse → 8 project context → 9 resolve → 10 build graph →
 *  11 algorithms → 12 invariants → 13 persist + promote → 14 summary.
 *
 * Never writes into the scanned repository, never executes project code.
 */
import { createHash, randomBytes } from "node:crypto";
import { availableParallelism } from "node:os";
import {
  DEFAULT_PARSER_LIMITS,
  DiagnosticCodes,
  EXTRACTION_SCHEMA_VERSION,
  GRAPH_SCHEMA_VERSION,
  MAX_CONCURRENCY,
  TOOL_VERSION,
  type CachedArtifact,
  type CodeMapConfig,
  type FileExtraction,
  type FileRecord,
  type GraphStore,
  type LanguageAdapter,
  type ModuleReferenceFact,
  type ParserLimits,
  type ProjectContext,
  type ReferenceResolver,
  type ScanRecord,
  type ScanSummary,
  type ScanWriter,
} from "@codemap/contracts";
import { ConfigError, ScanPathError, discoverFiles, loadProjectConfig, mapLimit, readAndHash, validateRoot, type DiscoveredFile } from "@codemap/scanner";
import {
  Ids,
  buildGraph,
  findCycles,
  moduleReferenceKey,
  validateGraphInvariants,
  type BuildDiagnosticInput,
  type BuildFileInput,
  type ModuleDefinition,
  type ResolvedModuleReference,
} from "@codemap/graph-engine";
import { CodeMapError } from "./errors.js";

export type ScanPhase = "discover" | "hash" | "parse" | "resolve" | "build" | "analyze" | "persist";

export interface ScanProgress {
  phase: ScanPhase;
  completed?: number;
  total?: number;
}

export interface ScanProjectInput {
  path: string;
  maxFileSizeBytes?: number;
  signal?: AbortSignal;
  onProgress?: (p: ScanProgress) => void;
  parserLimits?: Partial<ParserLimits>;
}

export interface ScanProjectResult {
  projectId: string;
  scan: ScanRecord;
  summary: ScanSummary;
  /** True when some files failed to parse or error diagnostics were produced. */
  partial: boolean;
  configWarnings: string[];
}

export function sha256(s: string): string {
  return createHash("sha256").update(s).digest("hex");
}

/** Stable project identity derived from the canonical root (case-folded on case-insensitive platforms). */
export function projectIdFor(canonicalRoot: string, platform: NodeJS.Platform = process.platform): string {
  const norm = platform === "win32" || platform === "darwin" ? canonicalRoot.toLowerCase() : canonicalRoot;
  return Ids.project(norm.replace(/\\/g, "/")).id;
}

export function resolveConcurrency(c: CodeMapConfig["concurrency"]): number {
  if (c !== "auto") return Math.min(MAX_CONCURRENCY, Math.max(1, c));
  return Math.min(8, Math.max(1, availableParallelism() - 1));
}

function moduleDefinitions(ctx: ProjectContext): ModuleDefinition[] {
  const mods: ModuleDefinition[] = [];
  for (const c of ctx.configs) {
    const dir = c.path.includes("/") ? c.path.slice(0, c.path.lastIndexOf("/")) : "";
    if (c.kind === "package_json") {
      try {
        const j = JSON.parse(c.text) as { name?: unknown };
        if (typeof j.name === "string" && j.name) mods.push({ path: dir, name: j.name, ecosystem: "npm" });
      } catch {
        /* reported by the resolver */
      }
    } else if (c.kind === "pyproject") {
      const m = /^\s*\[(?:project|tool\.poetry)\][^[]*?^\s*name\s*=\s*["']([^"']+)["']/ms.exec(c.text);
      if (m) mods.push({ path: dir, name: m[1]!, ecosystem: "pypi" });
    }
  }
  const seen = new Set<string>();
  return mods.filter((m) => (seen.has(`${m.path}|${m.name}`) ? false : (seen.add(`${m.path}|${m.name}`), true)));
}

export class ScanProjectUseCase {
  constructor(
    private readonly store: GraphStore,
    private readonly adapters: readonly LanguageAdapter[],
    private readonly resolvers: readonly ReferenceResolver[],
  ) {}

  parserSetHash(): string {
    return sha256(
      JSON.stringify({
        adapters: this.adapters.map((a) => `${a.id}@${a.version};${a.grammarFingerprint}`),
        resolvers: this.resolvers.map((r) => `${r.id}@${r.version}`),
        extraction: EXTRACTION_SCHEMA_VERSION,
      }),
    );
  }

  private classify(config: CodeMapConfig) {
    return (rel: string): string | undefined => {
      for (const a of this.adapters) {
        const d = a.detect({ relativePath: rel });
        if (d.supported && d.language && config.languages.includes(d.language)) return d.language;
      }
      return undefined;
    };
  }

  private adapterFor(rel: string): LanguageAdapter | undefined {
    return this.adapters.find((a) => a.detect({ relativePath: rel }).supported);
  }

  async execute(input: ScanProjectInput): Promise<ScanProjectResult> {
    const timings: Record<string, number> = {};
    const t0 = performance.now();
    let mark = t0;
    const lap = (name: string) => {
      const n = performance.now();
      timings[name] = Math.round(n - mark);
      mark = n;
    };
    const { signal } = input;
    const checkAbort = () => {
      if (signal?.aborted) throw new CodeMapError("cancelled", "scan cancelled");
    };
    const progress = (p: ScanProgress) => input.onProgress?.(p);

    // 1. Validate path.
    let root;
    try {
      root = await validateRoot(input.path);
    } catch (err) {
      if (err instanceof ScanPathError) throw new CodeMapError("path", err.message);
      throw err;
    }
    // 2. Config.
    let loaded;
    try {
      loaded = await loadProjectConfig(root.canonicalRoot, input.maxFileSizeBytes !== undefined ? { maxFileSizeBytes: input.maxFileSizeBytes } : {});
    } catch (err) {
      if (err instanceof ConfigError) throw new CodeMapError("invalid_input", err.message, err.details);
      throw err;
    }
    const config = loaded.config;
    const concurrency = resolveConcurrency(config.concurrency);
    const limits: ParserLimits = { ...DEFAULT_PARSER_LIMITS, ...input.parserLimits, maxFileSizeBytes: config.maxFileSizeBytes };

    // 3–5. Discovery.
    progress({ phase: "discover" });
    const discovery = await discoverFiles({ root: root.canonicalRoot, config, classify: this.classify(config), ...(signal ? { signal } : {}) }).catch((err) => {
      if (signal?.aborted) throw new CodeMapError("cancelled", "scan cancelled");
      throw err;
    });
    lap("discover");
    checkAbort();

    // 6. Read + hash.
    progress({ phase: "hash", completed: 0, total: discovery.files.length });
    const records: FileRecord[] = [...discovery.skipped];
    const readable: { file: DiscoveredFile; bytes: Uint8Array; contentHash: string; adapter: LanguageAdapter }[] = [];
    const extraDiagnostics: BuildDiagnosticInput[] = discovery.diagnostics.map((d) => ({ code: d.code, severity: d.severity, message: d.message, ...(d.path !== undefined ? { path: d.path } : {}) }));
    const reads = await mapLimit(discovery.files, concurrency * 2, (f) => readAndHash(f.absolutePath, config.maxFileSizeBytes), signal).catch((err) => {
      if (signal?.aborted) throw new CodeMapError("cancelled", "scan cancelled");
      throw err;
    });
    discovery.files.forEach((f, i) => {
      const r = reads[i]!;
      const adapter = this.adapterFor(f.relativePath);
      if (!r.ok || !adapter) {
        const reason = r.ok ? DiagnosticCodes.PARSE_UNSUPPORTED : r.skipReason;
        records.push({ relativePath: f.relativePath, sizeBytes: f.sizeBytes, mtimeMs: f.mtimeMs, language: f.language, parseStatus: "skipped", skipReason: reason });
        extraDiagnostics.push({ code: reason, severity: "info", message: r.ok ? "no adapter for file" : r.message, path: f.relativePath });
        return;
      }
      readable.push({ file: f, bytes: r.bytes, contentHash: r.contentHash, adapter });
    });
    lap("hash");
    checkAbort();

    // 7. Parse with artifact cache.
    const languageConfig = { calls: config.analysis.calls, inheritance: config.analysis.inheritance };
    const optionsHash = sha256(JSON.stringify({ languageConfig, limits }));
    const keyOf = (r: (typeof readable)[number]) =>
      sha256([r.contentHash, r.adapter.id, r.adapter.version, r.adapter.grammarFingerprint, EXTRACTION_SCHEMA_VERSION, optionsHash].join("|"));
    const keys = readable.map(keyOf);
    let cached: Map<string, FileExtraction>;
    try {
      cached = await this.store.getArtifacts(keys);
    } catch (err) {
      throw new CodeMapError("storage", `cannot read artifact cache: ${(err as Error).message}`, [], err);
    }
    const newArtifacts: CachedArtifact[] = [];
    const extractions = new Map<string, FileExtraction | undefined>();
    let parsedCount = 0;
    let reusedCount = 0;
    let failedCount = 0;
    let done = 0;
    progress({ phase: "parse", completed: 0, total: readable.length });
    await mapLimit(
      readable,
      concurrency,
      async (r, i) => {
        const key = keys[i]!;
        const hit = cached.get(key);
        let extraction: FileExtraction | undefined;
        let status: FileRecord["parseStatus"];
        if (hit) {
          extraction = hit;
          status = "reused";
          reusedCount++;
        } else {
          try {
            extraction = await r.adapter.parseFile({ relativePath: r.file.relativePath, language: r.file.language, source: r.bytes, contentHash: r.contentHash, projectConfiguration: languageConfig, limits });
          } catch (err) {
            extraction = undefined;
            extraDiagnostics.push({ code: DiagnosticCodes.PARSE_FAILED, severity: "error", message: `parser crashed: ${(err as Error).message.slice(0, 200)}`, path: r.file.relativePath });
          }
          if (extraction && extraction.syntaxStatus !== "failed") {
            status = "parsed";
            parsedCount++;
            newArtifacts.push({ cacheKey: key, contentHash: r.contentHash, adapterId: r.adapter.id, adapterVersion: r.adapter.version, extractionVersion: EXTRACTION_SCHEMA_VERSION, optionsHash, extraction });
          } else {
            status = "failed";
            failedCount++;
          }
        }
        extractions.set(r.file.relativePath, extraction);
        records.push({
          relativePath: r.file.relativePath,
          sizeBytes: r.file.sizeBytes,
          mtimeMs: r.file.mtimeMs,
          contentHash: r.contentHash,
          language: extraction?.language ?? r.file.language,
          adapterId: r.adapter.id,
          adapterVersion: r.adapter.version,
          parseStatus: status,
          ...(status === "failed" ? { skipReason: DiagnosticCodes.PARSE_FAILED } : {}),
        });
        progress({ phase: "parse", completed: ++done, total: readable.length });
      },
      signal,
    ).catch((err) => {
      if (signal?.aborted) throw new CodeMapError("cancelled", "scan cancelled");
      throw err;
    });
    // Source buffers are no longer needed.
    readable.forEach((r) => ((r as { bytes?: Uint8Array }).bytes = undefined));
    records.sort((a, b) => (a.relativePath < b.relativePath ? -1 : 1));
    lap("parse");
    checkAbort();

    // 8. Project context.
    const sourceFiles = readable.map((r) => r.file.relativePath).sort();
    const dirs = new Set<string>();
    for (const f of sourceFiles) for (let d = f; d.includes("/"); ) dirs.add((d = d.slice(0, d.lastIndexOf("/"))));
    const context: ProjectContext = { sourceFiles, directories: [...dirs].sort(), configs: discovery.configs };

    // 9. Resolve.
    progress({ phase: "resolve" });
    const refsByLanguage = new Map<string, ModuleReferenceFact[]>();
    for (const path of sourceFiles) {
      const ex = extractions.get(path);
      ex?.imports.forEach((imp, i) => {
        const list = refsByLanguage.get(ex.language) ?? [];
        list.push({
          referenceKey: moduleReferenceKey(path, i),
          fromPath: path,
          language: ex.language,
          ...(imp.specifier !== undefined ? { specifier: imp.specifier } : {}),
          form: imp.form,
          isDynamicExpression: imp.isDynamicExpression,
          isTypeOnly: imp.isTypeOnly,
          ...(imp.relativeLevel ? { relativeLevel: imp.relativeLevel } : {}),
          importedNames: imp.importedNames,
        });
        refsByLanguage.set(ex.language, list);
      });
    }
    const resolutions = new Map<string, ResolvedModuleReference>();
    for (const resolver of this.resolvers) {
      const enabled = resolver.languages.some((l) => (l === "python" ? config.resolution.python : config.resolution.typescript));
      if (!enabled) continue;
      const references = resolver.languages.flatMap((l) => refsByLanguage.get(l) ?? []);
      if (!references.length) continue;
      const batch = await resolver.resolve({ fileInventory: records, references, projectContext: context, resolutionOptions: { resolveExternalPackages: config.resolution.resolveExternalPackages } });
      for (const r of batch.results) resolutions.set(r.referenceKey, { result: r, resolverId: batch.resolverId, resolverVersion: batch.resolverVersion });
      for (const d of batch.diagnostics) extraDiagnostics.push({ code: d.code, severity: d.severity, message: d.message, ...(d.path !== undefined ? { path: d.path } : {}) });
    }
    lap("resolve");
    checkAbort();

    // 10. Build graph.
    progress({ phase: "build" });
    const projectId = projectIdFor(root.canonicalRoot);
    const scanId = `scn_${Date.now().toString(36)}_${randomBytes(4).toString("hex")}`;
    const startedAt = new Date(Date.now() - Math.round(performance.now() - t0)).toISOString();
    const configurationHash = sha256(JSON.stringify(config));
    const parserSetHash = this.parserSetHash();
    for (const w of loaded.warnings) extraDiagnostics.push({ code: DiagnosticCodes.CONFIG_INVALID, severity: "warning", message: `codemap.config.json: ${w}`, path: "codemap.config.json" });
    const files: BuildFileInput[] = readable.map((r) => {
      const ex = extractions.get(r.file.relativePath);
      return { path: r.file.relativePath, language: ex?.language ?? r.file.language, contentHash: r.contentHash, sizeBytes: r.file.sizeBytes, ...(ex ? { extraction: ex } : {}) };
    });
    const graph = buildGraph({
      project: { id: projectId, displayName: root.displayName, rootLabel: root.displayName },
      scan: { id: scanId, toolVersion: TOOL_VERSION, startedAt, completedAt: startedAt, configurationHash, parserSetHash },
      files,
      resolutions,
      modules: moduleDefinitions(context),
      diagnostics: extraDiagnostics,
      options: languageConfig,
    });
    lap("build");

    // 11. Algorithms.
    progress({ phase: "analyze" });
    const cycles = config.analysis.cycles ? findCycles(graph) : [];
    graph.metrics["analysis.cycles"] = cycles.length;
    graph.metrics["files.parsed"] = parsedCount;
    graph.metrics["files.reused"] = reusedCount;
    graph.metrics["files.failed"] = failedCount;
    graph.metrics["files.skipped"] = discovery.skipped.length + (discovery.files.length - readable.length);
    graph.metrics = Object.fromEntries(Object.entries(graph.metrics).sort(([a], [b]) => (a < b ? -1 : 1)));

    // 12. Invariants.
    const violations = validateGraphInvariants(graph);
    if (violations.length) throw new CodeMapError("internal", `${DiagnosticCodes.GRAPH_INVARIANT}: graph invariant violation`, violations);
    lap("analyze");
    checkAbort();

    // 13. Persist.
    progress({ phase: "persist" });
    graph.scan.completedAt = new Date().toISOString();
    const diagCounts = { info: 0, warning: 0, error: 0 };
    for (const d of graph.diagnostics) diagCounts[d.severity]++;
    const languages: Record<string, number> = {};
    for (const f of files) languages[f.language] = (languages[f.language] ?? 0) + 1;
    const summary: ScanSummary = {
      fileCount: readable.length,
      parsedCount,
      reusedCount,
      skippedCount: records.filter((r) => r.parseStatus === "skipped").length,
      failedCount,
      nodeCount: graph.nodes.length,
      edgeCount: graph.edges.length,
      referenceCount: graph.references.length,
      unresolvedCount: graph.references.filter((r) => r.status === "unresolved" || r.status === "ambiguous").length,
      cycleCount: cycles.length,
      diagnosticCounts: diagCounts,
      durationsMs: timings,
      languages: Object.fromEntries(Object.entries(languages).sort()),
    };

    let writer: ScanWriter | undefined;
    try {
      await this.store.createProject({ projectId, canonicalRoot: root.canonicalRoot, displayName: root.displayName });
      writer = await this.store.beginScan({ scanId, projectId, startedAt, toolVersion: TOOL_VERSION, graphSchemaVersion: GRAPH_SCHEMA_VERSION, configurationHash, parserSetHash });
      await writer.writeFileInventory(records);
      await writer.writeArtifacts(newArtifacts);
      await writer.writeGraph(graph);
      if (signal?.aborted) {
        await writer.cancel("cancelled by user before completion");
        throw new CodeMapError("cancelled", "scan cancelled");
      }
      lap("persist");
      summary.durationsMs = { ...timings, total: Math.round(performance.now() - t0) };
      await writer.complete(summary);
    } catch (err) {
      if (err instanceof CodeMapError) throw err;
      await writer?.fail({ code: DiagnosticCodes.STORE_FAILED, message: (err as Error).message }).catch(() => undefined);
      throw new CodeMapError("storage", `${DiagnosticCodes.STORE_FAILED}: scan persistence failed: ${(err as Error).message}`, [], err);
    }
    const scan = (await this.store.getScan(scanId))!;
    return { projectId, scan, summary, partial: failedCount > 0 || diagCounts.error > 0, configWarnings: loaded.warnings };
  }
}
