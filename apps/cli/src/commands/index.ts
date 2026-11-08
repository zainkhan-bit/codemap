/** Command implementations. Each returns an exit code; they call application use cases only. */
import { writeFile } from "node:fs/promises";
import path from "node:path";
import { CodeMapApplication, CodeMapError, ExitCodes, type ExportFormat, type ScanProgress, type ScanSelector } from "@codemap/application";
import { GRAPH_VIEWS, type GraphView } from "@codemap/contracts";
import { bold, bytes, dim, green, red, scanSummaryLines, table, yellow } from "../output/format.js";

export interface GlobalOptions {
  json: boolean;
  verbose: boolean;
}

const out = (s = "") => process.stdout.write(`${s}\n`);
const err = (s = "") => process.stderr.write(`${s}\n`);
const printJson = (v: unknown) => out(JSON.stringify(v, null, 2));

function selector(values: Record<string, unknown>): ScanSelector {
  return {
    cwd: process.cwd(),
    ...(typeof values.project === "string" ? { projectId: values.project } : {}),
    ...(typeof values.scan === "string" ? { scanId: values.scan } : {}),
  };
}

function progressReporter(enabled: boolean): ((p: ScanProgress) => void) | undefined {
  if (!enabled || !process.stderr.isTTY) return undefined;
  let last = "";
  return (p) => {
    const line = p.total !== undefined ? `${p.phase} ${p.completed ?? 0}/${p.total}` : `${p.phase}…`;
    if (line === last) return;
    last = line;
    process.stderr.write(`\r\x1b[2K${dim(line)}`);
    if (p.phase === "persist") process.stderr.write("\r\x1b[2K");
  };
}

export async function scanCommand(app: CodeMapApplication, args: string[], values: Record<string, unknown>, g: GlobalOptions, signal: AbortSignal): Promise<number> {
  if (args.length > 1) throw new CodeMapError("invalid_input", "scan accepts a single path");
  const target = args[0] ?? ".";
  let maxFileSize: number | undefined;
  if (values["max-file-size"] !== undefined) {
    maxFileSize = Number(values["max-file-size"]);
    if (!Number.isInteger(maxFileSize) || maxFileSize <= 0) throw new CodeMapError("invalid_input", "--max-file-size must be a positive integer (bytes)");
  }
  const onProgress = progressReporter(true);
  const result = await app.scanProject({ path: target, ...(maxFileSize !== undefined ? { maxFileSizeBytes: maxFileSize } : {}), signal, ...(onProgress ? { onProgress } : {}) });
  if (g.json) {
    printJson({ projectId: result.projectId, scanId: result.scan.scanId, status: result.scan.status, partial: result.partial, summary: result.summary, configWarnings: result.configWarnings });
  } else {
    out(`${bold("CodeMap")} scanned ${bold(result.scan.scanId)} ${dim(`(project ${result.projectId})`)}`);
    for (const l of scanSummaryLines(result.summary)) out(l);
    for (const w of result.configWarnings) out(yellow(`  warning: codemap.config.json: ${w}`));
    out();
    out(dim("Next steps:"));
    out(dim("  codemap summary                     overview, hotspots and cycles"));
    out(dim("  codemap analyze --cycles            list circular dependencies"));
    out(dim("  codemap export --format svg -o map.svg"));
    out(dim("  (The interactive dashboard is not part of this release.)"));
  }
  return result.partial ? ExitCodes.PARTIAL : ExitCodes.OK;
}

export async function summaryCommand(app: CodeMapApplication, values: Record<string, unknown>, g: GlobalOptions): Promise<number> {
  const s = await app.getProjectSummary(selector(values), { excludeTypeOnly: values["exclude-type-only"] === true });
  if (g.json) {
    printJson(s);
    return ExitCodes.OK;
  }
  out(`${bold(s.project.displayName)} ${dim(`project ${s.project.id}`)}`);
  out(dim(`scan ${s.scan.scanId} completed ${s.scan.completedAt ?? "?"}`));
  if (s.scan.summary) for (const l of scanSummaryLines(s.scan.summary)) out(l);
  out();
  out(bold("Most depended-on files (fan-in)"));
  out(s.topFanIn.length ? table(s.topFanIn.map((d) => [`  ${d.fanIn}`, d.path])) : dim("  none"));
  out(bold("Files with most dependencies (fan-out)"));
  out(s.topFanOut.length ? table(s.topFanOut.map((d) => [`  ${d.fanOut}`, d.path])) : dim("  none"));
  out(dim("  fan-in/fan-out = distinct files linked by resolved import edges; indicators, not defects."));
  out(bold(`Circular dependencies: ${s.cycles.length}`));
  for (const c of s.cycles.slice(0, 10)) out(`  ${red(`#${c.index}`)} ${c.path.join(" → ")}`);
  if (s.cycles.length > 10) out(dim(`  … ${s.cycles.length - 10} more (codemap analyze --cycles)`));
  if (s.unresolved.length) out(`${bold("Unresolved references:")} ${s.unresolved.map((u) => `${u.kind} ${u.count}`).join(", ")}`);
  if (s.isolatedFiles.length) out(dim(`${s.isolatedFiles.length} files have no resolved import edges.`));
  return ExitCodes.OK;
}

export async function analyzeCommand(app: CodeMapApplication, values: Record<string, unknown>, g: GlobalOptions): Promise<number> {
  if (values.cycles !== true) throw new CodeMapError("invalid_input", "analyze requires an analysis flag; supported: --cycles");
  const r = await app.analyzeCycles(selector(values), { excludeTypeOnly: values["exclude-type-only"] === true });
  if (g.json) {
    printJson(r);
    return ExitCodes.OK;
  }
  if (r.cycles.length === 0) {
    out(green("No circular dependencies found in resolved import edges."));
    return ExitCodes.OK;
  }
  out(bold(`${r.cycles.length} circular dependenc${r.cycles.length === 1 ? "y" : "ies"} (strongly connected components of resolved imports)`));
  for (const c of r.cycles) {
    out(`${red(`#${c.index}`)} ${c.selfLoop ? "self-import" : `${c.files.length} files`}`);
    out(`   ${c.path.join(" → ")}`);
    if (c.files.length > c.path.length - 1) out(dim(`   members: ${c.files.join(", ")}`));
  }
  return ExitCodes.OK;
}

export async function exportCommand(app: CodeMapApplication, values: Record<string, unknown>, g: GlobalOptions): Promise<number> {
  const format = String(values.format ?? "json") as ExportFormat;
  if (!["json", "svg", "mermaid", "png"].includes(format)) throw new CodeMapError("invalid_input", `unsupported format "${format}"; use json, svg, mermaid or png`);
  if (format === "png" && typeof values.output !== "string") throw new CodeMapError("invalid_input", "PNG export is binary; pass --output <file.png>");
  const view = (values.view as GraphView | undefined) ?? undefined;
  if (view && !(GRAPH_VIEWS as readonly string[]).includes(view)) throw new CodeMapError("invalid_input", `unknown view "${view}"; expected one of ${GRAPH_VIEWS.join(", ")}`);
  const { content, scanId } = await app.exportGraph(selector(values), format, {
    ...(view ? { view } : {}),
    ...(typeof values.path === "string" ? { pathPrefix: values.path.replace(/\\/g, "/").replace(/^\.\//, "").replace(/\/$/, "") } : {}),
    ...(values.force === true ? { force: true } : {}),
    ...(values["exclude-type-only"] === true ? { excludeTypeOnly: true } : {}),
  });
  if (typeof values.output === "string") {
    const target = path.resolve(values.output);
    await writeFile(target, content, "utf8");
    if (g.json) printJson({ scanId, format, output: target, bytes: Buffer.byteLength(content) });
    else out(`${green("wrote")} ${target} ${dim(`(${format}, ${bytes(Buffer.byteLength(content))}, scan ${scanId})`)}`);
  } else process.stdout.write(content);
  return ExitCodes.OK;
}

export async function depsCommand(app: CodeMapApplication, args: string[], values: Record<string, unknown>, g: GlobalOptions): Promise<number> {
  const q = args[0];
  if (!q) throw new CodeMapError("invalid_input", "deps requires a file path, symbol name or node id");
  const depth = values.depth !== undefined ? Number(values.depth) : 1;
  if (!Number.isInteger(depth) || depth < 1) throw new CodeMapError("invalid_input", "--depth must be a positive integer");
  const r = await app.getNodeDependencies(selector(values), q, { direction: values.reverse === true ? "incoming" : "outgoing", maxDepth: depth });
  if (g.json) {
    printJson({ node: r.node, dependencies: r.dependencies });
    return ExitCodes.OK;
  }
  out(bold(`${values.reverse === true ? "Dependents of" : "Dependencies of"} ${r.node.path ?? r.node.name}`));
  out(r.dependencies.length ? table(r.dependencies.map((d) => [`  ${d.depth}`, d.path])) : dim("  none"));
  return ExitCodes.OK;
}

export async function projectsCommand(app: CodeMapApplication, g: GlobalOptions): Promise<number> {
  const list = await app.listProjects();
  if (g.json) {
    printJson(list.map(({ project, latest }) => ({ projectId: project.projectId, displayName: project.displayName, root: project.canonicalRoot, lastSeenAt: project.lastSeenAt, latestScanId: latest?.scanId ?? null, latestCompletedAt: latest?.completedAt ?? null })));
    return ExitCodes.OK;
  }
  if (!list.length) {
    out(dim('No projects scanned yet. Run "codemap scan <path>".'));
    return ExitCodes.OK;
  }
  out(table([["PROJECT", "NAME", "LATEST SCAN", "ROOT"], ...list.map(({ project, latest }) => [project.projectId, project.displayName, latest?.scanId ?? "-", project.canonicalRoot])]));
  return ExitCodes.OK;
}

export async function cacheCommand(app: CodeMapApplication, args: string[], values: Record<string, unknown>, g: GlobalOptions): Promise<number> {
  if (args[0] !== "clear") throw new CodeMapError("invalid_input", 'unknown cache command; use "codemap cache clear [--all]"');
  const r = await app.clearCache({ all: values.all === true });
  if (g.json) printJson({ ...r, all: values.all === true });
  else out(`${green("cleared")} ${r.removedArtifacts} cached parse artifacts (${bytes(r.removedBytes)})${values.all === true ? " and all projects/scans" : ""}`);
  return ExitCodes.OK;
}

export async function dataCommand(args: string[], g: GlobalOptions): Promise<number> {
  if (args[0] !== "location") throw new CodeMapError("invalid_input", 'unknown data command; use "codemap data location"');
  const loc = CodeMapApplication.dataLocation();
  if (g.json) printJson(loc);
  else {
    out(loc.dataDir);
    out(dim(`database: ${loc.database} (schema v${loc.databaseSchemaVersion}); derived data, safe to delete`));
  }
  return ExitCodes.OK;
}

export async function doctorCommand(app: CodeMapApplication, g: GlobalOptions): Promise<number> {
  const checks = await app.doctor();
  const ok = checks.every((c) => c.ok);
  if (g.json) printJson({ ok, checks });
  else for (const c of checks) out(`${c.ok ? green("✓") : red("✗")} ${c.name.padEnd(30)} ${c.detail}`);
  return ok ? ExitCodes.OK : ExitCodes.INTERNAL;
}

export { err };
