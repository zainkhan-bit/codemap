/** Shared helpers for tests: readable labels for graph assertions. */
import type { CodeMapGraph, GraphEdge, GraphReference } from "@codemap/contracts";

export function nodeLabel(g: CodeMapGraph, id: string | undefined): string {
  const n = g.nodes.find((x) => x.id === id);
  if (!n) return String(id);
  if (n.kind === "symbol") return `${n.path}:${n.qualifiedName}`;
  if (n.kind === "package") return `pkg:${n.name}`;
  return n.path ?? n.name;
}

/** "kind source -> target" strings for non-containment edges, sorted. */
export function edgeStrings(g: CodeMapGraph, kinds: GraphEdge["kind"][] = ["imports", "calls", "extends", "implements", "exports"]): string[] {
  return g.edges
    .filter((e) => kinds.includes(e.kind))
    .map((e) => `${e.kind} ${nodeLabel(g, e.sourceId)} -> ${nodeLabel(g, e.targetId)}`)
    .sort();
}

export function refStrings(g: CodeMapGraph, kind: GraphReference["kind"]): string[] {
  return g.references
    .filter((r) => r.kind === kind)
    .map((r) => `${r.status} ${r.specifier ?? r.rawText}${r.targetNodeId ? ` -> ${nodeLabel(g, r.targetNodeId)}` : ""}`)
    .sort();
}
