/**
 * Graph invariants checked before persistence and export (blueprint §9.5).
 * Returns human-readable violations; an empty array means the graph is valid.
 */
import { validateGraphSchema, type CodeMapGraph } from "@codemap/contracts";

/** Patterns that indicate an absolute machine path leaked into graph data. */
const ABSOLUTE_PATH = /(^|[\s"'(=])(?:[A-Za-z]:[\\/]|\\\\[^\\]|\/(?:home|Users|root|var|tmp|private|mnt|opt|etc)\/)/;

export function validateGraphInvariants(graph: CodeMapGraph, opts: { maxViolations?: number } = {}): string[] {
  const max = opts.maxViolations ?? 50;
  const schema = validateGraphSchema(graph);
  const violations = [...schema.errors];
  const push = (msg: string) => {
    if (violations.length < max) violations.push(msg);
  };
  if (!schema.ok) return violations.slice(0, max);

  const nodeIds = new Set<string>();
  for (const n of graph.nodes) {
    if (nodeIds.has(n.id)) push(`duplicate node id ${n.id}`);
    nodeIds.add(n.id);
    if (n.location && n.path !== undefined && n.location.path !== n.path) push(`node ${n.id}: location.path differs from node path`);
  }
  if (!nodeIds.has(graph.project.id)) push(`project node ${graph.project.id} is missing`);

  const edgeIds = new Set<string>();
  for (const e of graph.edges) {
    if (edgeIds.has(e.id)) push(`duplicate edge id ${e.id}`);
    edgeIds.add(e.id);
    if (!nodeIds.has(e.sourceId)) push(`edge ${e.id}: source ${e.sourceId} does not exist`);
    if (!nodeIds.has(e.targetId)) push(`edge ${e.id}: target ${e.targetId} does not exist`);
    if (e.kind !== "contains" && e.evidenceReferenceIds.length === 0) push(`edge ${e.id}: ${e.kind} edge has no evidence`);
  }

  const refIds = new Set<string>();
  for (const r of graph.references) {
    if (refIds.has(r.id)) push(`duplicate reference id ${r.id}`);
    refIds.add(r.id);
    if (!nodeIds.has(r.sourceNodeId)) push(`reference ${r.id}: source node ${r.sourceNodeId} does not exist`);
    const resolved = r.status === "resolved_internal" || r.status === "resolved_external";
    if (resolved && (!r.targetNodeId || !nodeIds.has(r.targetNodeId))) push(`reference ${r.id}: resolved reference has no existing target`);
    if (!resolved && r.targetNodeId) push(`reference ${r.id}: ${r.status} reference must not have a target`);
    if (ABSOLUTE_PATH.test(r.rawText) || (r.specifier && /^[A-Za-z]:[\\/]/.test(r.specifier))) push(`reference ${r.id}: contains an absolute path`);
  }
  for (const e of graph.edges) for (const ev of e.evidenceReferenceIds) if (!refIds.has(ev)) push(`edge ${e.id}: evidence ${ev} does not exist`);

  const diagIds = new Set<string>();
  for (const d of graph.diagnostics) {
    if (diagIds.has(d.id)) push(`duplicate diagnostic id ${d.id}`);
    diagIds.add(d.id);
  }

  for (const label of [graph.project.rootLabel, graph.project.displayName]) if (ABSOLUTE_PATH.test(label) || /^[A-Za-z]:[\\/]/.test(label)) push(`project label "${label}" looks like an absolute path`);
  return violations.slice(0, max);
}

export class GraphInvariantError extends Error {
  constructor(readonly violations: string[]) {
    super(`graph invariant violation: ${violations.slice(0, 5).join("; ")}${violations.length > 5 ? ` (+${violations.length - 5} more)` : ""}`);
  }
}

export function assertGraphInvariants(graph: CodeMapGraph): void {
  const v = validateGraphInvariants(graph);
  if (v.length) throw new GraphInvariantError(v);
}
