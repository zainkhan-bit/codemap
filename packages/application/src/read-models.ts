/**
 * Read models for the local API and dashboard. Pure functions over an immutable snapshot:
 * they shape the canonical graph for display, they never re-derive or alter it.
 */
import type { CodeMapGraph, Confidence, DependencyHit, GraphNode, GraphView, GraphViewResult, NodeDetailsView, NodeSummary, ReferenceKind, ReferencePage, ResolutionStatus } from "@codemap/contracts";
import { findCycles, projectGraph, traverseDependencies, type ProjectionFilters } from "@codemap/graph-engine";

export function nodeLabel(n: GraphNode): string {
  if (n.kind === "symbol") return n.qualifiedName ?? n.name;
  if (n.kind === "package" || n.kind === "module" || n.kind === "project") return n.name;
  return n.path ?? n.name;
}

export function summarizeNode(n: GraphNode): NodeSummary {
  return {
    id: n.id,
    kind: n.kind,
    name: n.name,
    label: nodeLabel(n),
    ...(n.path !== undefined ? { path: n.path } : {}),
    ...(n.language !== undefined ? { language: n.language } : {}),
    ...(n.symbolKind !== undefined ? { symbolKind: n.symbolKind } : {}),
  };
}

/** A projection bounded to `limit` nodes; truncation is explicit, never silent. */
export function graphView(graph: CodeMapGraph, view: GraphView, filters: ProjectionFilters, limit: number): GraphViewResult {
  const p = projectGraph(graph, view, filters);
  const truncated = p.nodes.length > limit;
  const nodes = truncated ? p.nodes.slice(0, limit) : p.nodes;
  const keep = new Set(nodes.map((n) => n.id));
  const edges = p.edges.filter((e) => keep.has(e.sourceId) && keep.has(e.targetId));
  const cycleOf = new Map<string, number>();
  if (view === "file_dependency_view") findCycles(graph, { excludeTypeOnly: filters.excludeTypeOnly ?? false }).forEach((c, i) => c.nodeIds.forEach((id) => cycleOf.set(id, i)));
  const cycleNodeIds = [...cycleOf.keys()].filter((id) => keep.has(id)).sort();
  const cycleEdgeIds = edges.filter((e) => cycleOf.has(e.sourceId) && cycleOf.get(e.sourceId) === cycleOf.get(e.targetId)).map((e) => e.id);
  return { view, nodes, edges, cycleNodeIds, cycleEdgeIds, totalNodes: p.nodes.length, truncated };
}

export function nodeDetailsView(graph: CodeMapGraph, nodeId: string): NodeDetailsView | undefined {
  const byId = new Map(graph.nodes.map((n) => [n.id, n]));
  const node = byId.get(nodeId);
  if (!node) return undefined;
  const peer = (id: string) => summarizeNode(byId.get(id)!);
  const contains = graph.edges.filter((e) => e.kind === "contains");
  const parentEdge = contains.find((e) => e.targetId === nodeId);
  const children = contains.filter((e) => e.sourceId === nodeId).map((e) => peer(e.targetId));
  const owned = new Set([nodeId]);
  if (node.kind === "file") for (const n of graph.nodes) if (n.kind === "symbol" && n.path === node.path) owned.add(n.id);
  return {
    node,
    ...(parentEdge ? { parent: peer(parentEdge.sourceId) } : {}),
    children: children.sort((a, b) => a.label.localeCompare(b.label, "en")),
    outgoing: graph.edges.filter((e) => e.kind !== "contains" && e.sourceId === nodeId).map((edge) => ({ edge, peer: peer(edge.targetId) })),
    incoming: graph.edges.filter((e) => e.kind !== "contains" && e.targetId === nodeId).map((edge) => ({ edge, peer: peer(edge.sourceId) })),
    references: graph.references.filter((r) => owned.has(r.sourceNodeId)),
    diagnostics: node.path !== undefined ? graph.diagnostics.filter((d) => d.location?.path === node.path || d.attributes?.path === node.path) : [],
  };
}

export function dependenciesView(graph: CodeMapGraph, nodeId: string, opts: { direction: "outgoing" | "incoming"; maxDepth: number; minConfidence?: Confidence }): DependencyHit[] {
  const byId = new Map(graph.nodes.map((n) => [n.id, n]));
  return traverseDependencies(graph, nodeId, { direction: opts.direction, maxDepth: opts.maxDepth, minConfidence: opts.minConfidence ?? "medium", limit: 5000 })
    .filter((h) => byId.has(h.nodeId))
    .map((h) => ({ node: summarizeNode(byId.get(h.nodeId)!), depth: h.depth, via: h.via }));
}

export interface ReferenceQuery {
  status?: ResolutionStatus[];
  kind?: ReferenceKind[];
  pathPrefix?: string;
  limit: number;
  offset: number;
}

export function referencesView(graph: CodeMapGraph, q: ReferenceQuery): ReferencePage {
  const byId = new Map(graph.nodes.map((n) => [n.id, n]));
  const prefix = q.pathPrefix?.replace(/\/$/, "");
  const all = graph.references.filter(
    (r) =>
      (!q.status?.length || q.status.includes(r.status)) &&
      (!q.kind?.length || q.kind.includes(r.kind)) &&
      (!prefix || r.sourceLocation.path === prefix || r.sourceLocation.path.startsWith(`${prefix}/`)),
  );
  return {
    total: all.length,
    offset: q.offset,
    items: all.slice(q.offset, q.offset + q.limit).map((r) => ({
      reference: r,
      source: summarizeNode(byId.get(r.sourceNodeId)!),
      ...(r.targetNodeId && byId.has(r.targetNodeId) ? { target: summarizeNode(byId.get(r.targetNodeId)!) } : {}),
    })),
  };
}
