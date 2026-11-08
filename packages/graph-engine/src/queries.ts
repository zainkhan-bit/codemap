/** Lookup helpers used by application use cases. */
import type { CodeMapGraph, GraphEdge, GraphNode, GraphReference } from "@codemap/contracts";
import { degreeMetrics, findCycles, isolatedNodes, type DependencyCycle } from "./algorithms.js";

export interface NodeDetails {
  node: GraphNode;
  outgoing: GraphEdge[];
  incoming: GraphEdge[];
  references: GraphReference[];
}

/** Finds a node by id, exact repository path, or (for symbols) qualified name. */
export function findNode(graph: CodeMapGraph, query: string): GraphNode[] {
  const q = query.replace(/\\/g, "/").replace(/^\.\//, "");
  const byId = graph.nodes.find((n) => n.id === q);
  if (byId) return [byId];
  const byPath = graph.nodes.filter((n) => (n.kind === "file" || n.kind === "directory") && n.path === q);
  if (byPath.length) return byPath;
  return graph.nodes.filter((n) => n.kind === "symbol" && (n.qualifiedName === q || `${n.path}:${n.qualifiedName}` === q));
}

export function nodeDetails(graph: CodeMapGraph, nodeId: string): NodeDetails | undefined {
  const node = graph.nodes.find((n) => n.id === nodeId);
  if (!node) return undefined;
  return {
    node,
    outgoing: graph.edges.filter((e) => e.sourceId === nodeId),
    incoming: graph.edges.filter((e) => e.targetId === nodeId),
    references: graph.references.filter((r) => r.sourceNodeId === nodeId),
  };
}

export interface ArchitectureAnalysis {
  cycles: DependencyCycle[];
  /** Top files by fan-in/fan-out. Indicators, not defects. */
  topFanIn: { nodeId: string; fanIn: number }[];
  topFanOut: { nodeId: string; fanOut: number }[];
  isolatedFiles: string[];
}

export function analyzeArchitecture(graph: CodeMapGraph, opts: { top?: number; excludeTypeOnly?: boolean } = {}): ArchitectureAnalysis {
  const top = opts.top ?? 10;
  const degrees = degreeMetrics(graph, { excludeTypeOnly: opts.excludeTypeOnly ?? false });
  return {
    cycles: findCycles(graph, { excludeTypeOnly: opts.excludeTypeOnly ?? false }),
    topFanIn: degrees.filter((d) => d.fanIn > 0).sort((a, b) => b.fanIn - a.fanIn || (a.nodeId < b.nodeId ? -1 : 1)).slice(0, top).map(({ nodeId, fanIn }) => ({ nodeId, fanIn })),
    topFanOut: degrees.filter((d) => d.fanOut > 0).sort((a, b) => b.fanOut - a.fanOut || (a.nodeId < b.nodeId ? -1 : 1)).slice(0, top).map(({ nodeId, fanOut }) => ({ nodeId, fanOut })),
    isolatedFiles: isolatedNodes(graph),
  };
}
