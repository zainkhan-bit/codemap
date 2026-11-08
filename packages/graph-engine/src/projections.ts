/**
 * Graph projections: read-only views computed from the canonical graph.
 * Projections never mutate the canonical snapshot. Derived (aggregated) edges
 * are marked with `attributes.derived = true` and get IDs from the same
 * deterministic scheme.
 */
import type { CodeMapGraph, Confidence, EdgeKind, GraphEdge, GraphNode, GraphView, NodeKind } from "@codemap/contracts";
import { Ids } from "./ids.js";

export interface ProjectionFilters {
  /** Minimum edge confidence (default "medium"). */
  minConfidence?: Confidence;
  /** Include external package nodes in dependency views (default true). */
  includeExternal?: boolean;
  /** Only keep nodes whose path starts with this prefix (directory or file). */
  pathPrefix?: string;
  /** Hide type-only import edges (default false). */
  excludeTypeOnly?: boolean;
}

export interface GraphProjection {
  view: GraphView;
  nodes: GraphNode[];
  edges: GraphEdge[];
}

const RANK: Record<Confidence, number> = { low: 0, medium: 1, high: 2 };

function underPrefix(path: string | undefined, prefix: string | undefined): boolean {
  if (!prefix) return true;
  if (path === undefined) return false;
  return path === prefix || path.startsWith(prefix.endsWith("/") ? prefix : `${prefix}/`);
}

function select(graph: CodeMapGraph, nodeKinds: readonly NodeKind[], edgeKinds: readonly EdgeKind[], f: ProjectionFilters): { nodes: GraphNode[]; edges: GraphEdge[] } {
  const kinds = new Set(nodeKinds);
  const min = RANK[f.minConfidence ?? "medium"];
  const nodes = graph.nodes.filter(
    (n) => kinds.has(n.kind) && (n.kind === "project" || n.kind === "package" || underPrefix(n.path, f.pathPrefix)) && !(n.kind === "package" && f.includeExternal === false),
  );
  const ids = new Set(nodes.map((n) => n.id));
  const eKinds = new Set(edgeKinds);
  const edges = graph.edges.filter(
    (e) => eKinds.has(e.kind) && RANK[e.confidence] >= min && ids.has(e.sourceId) && ids.has(e.targetId) && !(f.excludeTypeOnly && e.attributes.typeOnly === true),
  );
  return { nodes, edges };
}

/** Drops package nodes that no remaining edge touches. */
function pruneUnreferencedPackages(nodes: GraphNode[], edges: GraphEdge[]): GraphNode[] {
  const used = new Set(edges.flatMap((e) => [e.sourceId, e.targetId]));
  return nodes.filter((n) => n.kind !== "package" || used.has(n.id));
}

function moduleView(graph: CodeMapGraph, f: ProjectionFilters): GraphProjection {
  const modules = graph.nodes.filter((n) => n.kind === "module").sort((a, b) => (b.path ?? "").length - (a.path ?? "").length);
  const owner = (path: string | undefined): GraphNode | undefined => modules.find((m) => underPrefix(path, m.path) || !m.path);
  const fileOwner = new Map<string, GraphNode>();
  for (const n of graph.nodes) {
    if (n.kind !== "file") continue;
    const m = owner(n.path);
    if (m) fileOwner.set(n.id, m);
  }
  const packages = new Map(graph.nodes.filter((n) => n.kind === "package").map((n) => [n.id, n]));
  const min = RANK[f.minConfidence ?? "medium"];
  const agg = new Map<string, GraphEdge>();
  for (const e of graph.edges) {
    if (e.kind !== "imports" || RANK[e.confidence] < min || (f.excludeTypeOnly && e.attributes.typeOnly === true)) continue;
    const src = fileOwner.get(e.sourceId);
    const dst = fileOwner.get(e.targetId) ?? (f.includeExternal === false ? undefined : packages.get(e.targetId));
    if (!src || !dst || src.id === dst.id) continue;
    const ident = Ids.edge("imports", src.id, dst.id);
    const existing = agg.get(ident.id);
    if (existing) {
      existing.evidenceReferenceIds.push(...e.evidenceReferenceIds);
      existing.attributes.fileEdgeCount = (existing.attributes.fileEdgeCount as number) + 1;
      if (RANK[e.confidence] < RANK[existing.confidence]) existing.confidence = e.confidence;
    } else {
      agg.set(ident.id, { id: ident.id, kind: "imports", sourceId: src.id, targetId: dst.id, confidence: e.confidence, evidenceReferenceIds: [...e.evidenceReferenceIds], attributes: { derived: true, fileEdgeCount: 1 } });
    }
  }
  const edges = [...agg.values()].sort((a, b) => (a.id < b.id ? -1 : 1));
  for (const e of edges) e.evidenceReferenceIds = [...new Set(e.evidenceReferenceIds)].sort();
  const nodes = [...modules, ...packages.values()].filter((n) => n.kind === "module" || edges.some((e) => e.targetId === n.id));
  return { view: "module_view", nodes: nodes.sort((a, b) => (a.id < b.id ? -1 : 1)), edges };
}

export function projectGraph(graph: CodeMapGraph, view: GraphView, filters: ProjectionFilters = {}): GraphProjection {
  switch (view) {
    case "directory_view": {
      const { nodes, edges } = select(graph, ["project", "directory", "file"], ["contains"], filters);
      return { view, nodes, edges };
    }
    case "file_dependency_view": {
      const { nodes, edges } = select(graph, ["file", "package"], ["imports"], filters);
      return { view, nodes: pruneUnreferencedPackages(nodes, edges), edges };
    }
    case "module_view":
      return moduleView(graph, filters);
    case "symbol_view": {
      const { nodes, edges } = select(graph, ["file", "symbol"], ["contains", "exports", "extends", "implements"], filters);
      return { view, nodes, edges };
    }
    case "call_view": {
      const sel = select(graph, ["file", "symbol"], ["calls"], filters);
      const used = new Set(sel.edges.flatMap((e) => [e.sourceId, e.targetId]));
      return { view, nodes: sel.nodes.filter((n) => used.has(n.id)), edges: sel.edges };
    }
  }
}
