/**
 * Exporters consume the canonical graph only; they never rescan files.
 * Outputs contain repository-relative paths only — no absolute paths, source bodies or env values.
 */
import { GRAPH_VIEWS, type CodeMapGraph, type GraphNode, type GraphView } from "@codemap/contracts";
import { findCycles, projectGraph, validateGraphInvariants, type ProjectionFilters } from "@codemap/graph-engine";
import { layeredLayout } from "./layout.js";

export { layeredLayout } from "./layout.js";
export type * from "./layout.js";

export const EXPORT_FORMATS = ["json", "svg", "mermaid", "png"] as const;
export type ExportFormat = (typeof EXPORT_FORMATS)[number];

export class ExportError extends Error {
  constructor(
    message: string,
    readonly code: "invalid_graph" | "too_large" | "unsupported_format" | "invalid_view",
  ) {
    super(message);
  }
}

export interface DiagramOptions extends ProjectionFilters {
  view?: GraphView;
  /** Refuse to draw more nodes than this unless `force` is set (default 300). */
  maxNodes?: number;
  force?: boolean;
  title?: string;
}

/** Validated, stable JSON serialization of the canonical graph. */
export function exportJson(graph: CodeMapGraph): string {
  const violations = validateGraphInvariants(graph);
  if (violations.length) throw new ExportError(`graph failed validation: ${violations.slice(0, 3).join("; ")}`, "invalid_graph");
  return `${JSON.stringify(graph, null, 2)}\n`;
}

function escapeXml(s: string): string {
  return s.replace(/[<>&"']/g, (c) => ({ "<": "&lt;", ">": "&gt;", "&": "&amp;", '"': "&quot;", "'": "&apos;" })[c]!);
}

function nodeLabel(n: GraphNode, view: GraphView): string {
  if (n.kind === "package" || n.kind === "module") return n.name;
  if (n.kind === "symbol") return n.qualifiedName ?? n.name;
  if (view === "directory_view") return n.name;
  return n.path ?? n.name;
}

interface DiagramModel {
  view: GraphView;
  nodes: GraphNode[];
  edges: { id: string; source: string; target: string; kind: string; confidence: string; inCycle: boolean; typeOnly: boolean }[];
}

function diagramModel(graph: CodeMapGraph, opts: DiagramOptions): DiagramModel {
  const view = opts.view ?? "file_dependency_view";
  if (!(GRAPH_VIEWS as readonly string[]).includes(view)) throw new ExportError(`unknown view "${view}"; expected one of ${GRAPH_VIEWS.join(", ")}`, "invalid_view");
  const proj = projectGraph(graph, view, opts);
  const max = opts.maxNodes ?? 300;
  if (proj.nodes.length > max && !opts.force) {
    throw new ExportError(`the ${view} has ${proj.nodes.length} nodes (limit ${max}); narrow it with --path <dir> or pass --force to render anyway`, "too_large");
  }
  const cycleMembers = new Map<string, number>();
  if (view === "file_dependency_view") findCycles(graph).forEach((c, i) => c.nodeIds.forEach((id) => cycleMembers.set(id, i)));
  return {
    view,
    nodes: proj.nodes,
    edges: proj.edges.map((e) => ({
      id: e.id,
      source: e.sourceId,
      target: e.targetId,
      kind: e.kind,
      confidence: e.confidence,
      inCycle: cycleMembers.has(e.sourceId) && cycleMembers.get(e.sourceId) === cycleMembers.get(e.targetId),
      typeOnly: e.attributes.typeOnly === true,
    })),
  };
}

const PALETTE: Record<string, { fill: string; stroke: string }> = {
  typescript: { fill: "#e8f0fe", stroke: "#3367d6" },
  javascript: { fill: "#fef7e0", stroke: "#b8860b" },
  python: { fill: "#e6f4ea", stroke: "#188038" },
  package: { fill: "#f1f3f4", stroke: "#80868b" },
  directory: { fill: "#fafafa", stroke: "#5f6368" },
  module: { fill: "#f3e8fd", stroke: "#8430ce" },
  symbol: { fill: "#fff", stroke: "#5f6368" },
  project: { fill: "#202124", stroke: "#202124" },
};

/** Deterministic SVG diagram of a graph projection, rendered without a browser. */
export function exportSvg(graph: CodeMapGraph, opts: DiagramOptions = {}): string {
  const model = diagramModel(graph, opts);
  const labels = new Map(model.nodes.map((n) => [n.id, nodeLabel(n, model.view)]));
  const layout = layeredLayout(
    model.nodes.map((n) => ({ id: n.id, label: labels.get(n.id)! })),
    model.edges.map((e) => ({ id: e.id, source: e.source, target: e.target })),
  );
  const edgeMeta = new Map(model.edges.map((e) => [e.id, e]));
  const nodeMeta = new Map(model.nodes.map((n) => [n.id, n]));
  const titleH = 28;
  const W = Math.max(layout.width, 320);
  const H = layout.height + titleH;
  const title = opts.title ?? `${graph.project.displayName} — ${model.view.replace(/_/g, " ")}`;

  const lines: string[] = [];
  lines.push(`<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" font-family="ui-monospace, SFMono-Regular, Menlo, Consolas, monospace" font-size="12">`);
  lines.push(`<title>${escapeXml(title)}</title>`);
  lines.push(
    `<defs><marker id="arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse"><path d="M0,0 L10,5 L0,10 z" fill="#5f6368"/></marker>` +
      `<marker id="arrow-cycle" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse"><path d="M0,0 L10,5 L0,10 z" fill="#d93025"/></marker></defs>`,
  );
  lines.push(`<rect width="100%" height="100%" fill="#ffffff"/>`);
  lines.push(`<text x="12" y="19" font-size="13" font-weight="bold" fill="#202124">${escapeXml(title)}</text>`);
  lines.push(`<g transform="translate(0,${titleH})">`);
  lines.push(`<g class="edges" fill="none">`);
  const placedNodes = new Map(layout.nodes.map((n) => [n.id, n]));
  for (const e of layout.edges) {
    const m = edgeMeta.get(e.id)!;
    let d: string;
    if (e.selfLoop) {
      const n = placedNodes.get(e.source)!;
      const x = n.x + n.width;
      d = `M${x},${n.y + 8} C${x + 30},${n.y - 6} ${x + 30},${n.y + n.height + 6} ${x + 1},${n.y + n.height - 8}`;
    } else {
      // Smooth curve through every waypoint with vertical tangents at each point.
      const pts = e.points;
      d = `M${pts[0]!.x},${pts[0]!.y}`;
      for (let i = 0; i + 1 < pts.length; i++) {
        const a = pts[i]!;
        const b = pts[i + 1]!;
        const dy = Math.round(((b.y - a.y) / 2) * 10) / 10;
        d += ` C${a.x},${a.y + dy} ${b.x},${b.y - dy} ${b.x},${b.y}`;
      }
    }
    const inCycle = m.inCycle || e.selfLoop;
    const stroke = inCycle ? "#d93025" : m.confidence === "medium" ? "#9aa0a6" : "#5f6368";
    const dash = m.typeOnly || m.confidence === "medium" ? ` stroke-dasharray="4 3"` : "";
    lines.push(
      `<path d="${d}" stroke="${stroke}" stroke-width="${inCycle ? 1.6 : 1}"${dash} marker-end="url(#${inCycle ? "arrow-cycle" : "arrow"})"><title>${escapeXml(`${labels.get(m.source)} → ${labels.get(m.target)} (${m.kind}, ${m.confidence}${m.typeOnly ? ", type-only" : ""}${inCycle ? ", in cycle" : ""})`)}</title></path>`,
    );
  }
  lines.push(`</g>`);
  lines.push(`<g class="nodes">`);
  for (const n of layout.nodes) {
    const meta = nodeMeta.get(n.id)!;
    const pal = PALETTE[meta.kind === "file" ? (meta.language ?? "symbol") : meta.kind] ?? PALETTE.symbol!;
    const textFill = meta.kind === "project" ? "#ffffff" : "#202124";
    lines.push(
      `<g><title>${escapeXml(`${meta.kind}: ${meta.path ?? meta.qualifiedName ?? meta.name}`)}</title><rect x="${n.x}" y="${n.y}" width="${n.width}" height="${n.height}" rx="6" fill="${pal.fill}" stroke="${pal.stroke}"/>` +
        `<text x="${n.x + n.width / 2}" y="${n.y + n.height / 2 + 4}" text-anchor="middle" fill="${textFill}">${escapeXml(n.label)}</text></g>`,
    );
  }
  lines.push(`</g></g></svg>`);
  return `${lines.join("\n")}\n`;
}

/**
 * Mermaid flowchart text. Mermaid shows fewer details than the canonical graph:
 * no evidence, locations or unresolved references — use JSON for analysis.
 */
export function exportMermaid(graph: CodeMapGraph, opts: DiagramOptions = {}): string {
  const model = diagramModel(graph, opts);
  const short = new Map(model.nodes.map((n, i) => [n.id, `n${i}`]));
  const esc = (s: string) => s.replace(/"/g, "#quot;").replace(/[<>]/g, (c) => (c === "<" ? "#lt;" : "#gt;"));
  const out = [`%% ${model.view} of ${esc(graph.project.displayName)} — generated by CodeMap; see JSON export for full detail`, "flowchart LR"];
  for (const n of model.nodes) out.push(`  ${short.get(n.id)}["${esc(nodeLabel(n, model.view))}"]`);
  model.edges.forEach((e) => out.push(`  ${short.get(e.source)} ${e.typeOnly || e.confidence === "medium" ? "-.->" : "-->"} ${short.get(e.target)}`));
  const cycleLinks = model.edges.map((e, i) => (e.inCycle ? i : -1)).filter((i) => i >= 0);
  if (cycleLinks.length) out.push(`  linkStyle ${cycleLinks.join(",")} stroke:#d93025,stroke-width:2px`);
  return `${out.join("\n")}\n`;
}

/** Raised when the optional PNG rasterizer cannot be loaded; never emit a blank image instead. */
export function exportPng(): never {
  throw new ExportError("PNG export needs the optional @codemap/rasterizer-png package, which is not installed or not supported on this platform; use --format svg (portable, renders in any browser)", "unsupported_format");
}
