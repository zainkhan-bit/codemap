/**
 * Graph algorithms over resolved dependency edges.
 *
 * Cycle detection uses an iterative Tarjan strongly-connected-components pass
 * (O(V+E), no recursion so deep graphs cannot overflow the stack). Only
 * dependency edges (default: `imports`) participate — never `contains` edges
 * and never unresolved references, which have no edges at all.
 */
import type { CodeMapGraph, Confidence, EdgeKind, GraphEdge } from "@codemap/contracts";

export interface DependencyGraphOptions {
  edgeKinds?: readonly EdgeKind[];
  /** Exclude edges below this confidence (default "medium": low-confidence edges never count). */
  minConfidence?: Confidence;
  /** Ignore import edges that are type-only (erased at runtime). Default false. */
  excludeTypeOnly?: boolean;
}

export interface Adjacency {
  nodes: string[];
  out: Map<string, string[]>;
  in: Map<string, string[]>;
}

const CONF_RANK: Record<Confidence, number> = { low: 0, medium: 1, high: 2 };

export function dependencyEdges(graph: CodeMapGraph, opts: DependencyGraphOptions = {}): GraphEdge[] {
  const kinds = new Set(opts.edgeKinds ?? ["imports"]);
  const min = CONF_RANK[opts.minConfidence ?? "medium"];
  return graph.edges.filter((e) => kinds.has(e.kind) && CONF_RANK[e.confidence] >= min && !(opts.excludeTypeOnly && e.attributes.typeOnly === true));
}

export function buildAdjacency(graph: CodeMapGraph, opts: DependencyGraphOptions = {}): Adjacency {
  const edges = dependencyEdges(graph, opts);
  const nodeSet = new Set<string>();
  const out = new Map<string, string[]>();
  const inn = new Map<string, string[]>();
  for (const e of edges) {
    nodeSet.add(e.sourceId);
    nodeSet.add(e.targetId);
    (out.get(e.sourceId) ?? out.set(e.sourceId, []).get(e.sourceId)!).push(e.targetId);
    (inn.get(e.targetId) ?? inn.set(e.targetId, []).get(e.targetId)!).push(e.sourceId);
  }
  for (const list of out.values()) list.sort();
  for (const list of inn.values()) list.sort();
  return { nodes: [...nodeSet].sort(), out, in: inn };
}

/** Iterative Tarjan SCC. Components and their members are returned in deterministic order. */
export function stronglyConnectedComponents(adj: Adjacency): string[][] {
  let index = 0;
  const idx = new Map<string, number>();
  const low = new Map<string, number>();
  const onStack = new Set<string>();
  const stack: string[] = [];
  const result: string[][] = [];

  for (const root of adj.nodes) {
    if (idx.has(root)) continue;
    const work: { node: string; next: number }[] = [{ node: root, next: 0 }];
    idx.set(root, index);
    low.set(root, index);
    index++;
    stack.push(root);
    onStack.add(root);

    while (work.length > 0) {
      const frame = work[work.length - 1]!;
      const succ = adj.out.get(frame.node) ?? [];
      if (frame.next < succ.length) {
        const w = succ[frame.next++]!;
        if (!idx.has(w)) {
          idx.set(w, index);
          low.set(w, index);
          index++;
          stack.push(w);
          onStack.add(w);
          work.push({ node: w, next: 0 });
        } else if (onStack.has(w)) {
          low.set(frame.node, Math.min(low.get(frame.node)!, idx.get(w)!));
        }
        continue;
      }
      work.pop();
      const parent = work[work.length - 1];
      if (parent) low.set(parent.node, Math.min(low.get(parent.node)!, low.get(frame.node)!));
      if (low.get(frame.node) === idx.get(frame.node)) {
        const comp: string[] = [];
        let w: string;
        do {
          w = stack.pop()!;
          onStack.delete(w);
          comp.push(w);
        } while (w !== frame.node);
        result.push(comp.sort());
      }
    }
  }
  return result.sort((a, b) => (a[0]! < b[0]! ? -1 : 1));
}

export interface DependencyCycle {
  /** All members of the strongly connected component, sorted. */
  nodeIds: string[];
  /** One concrete closed walk through the component, starting and ending at the smallest member. */
  path: string[];
  selfLoop: boolean;
}

/** Finds circular dependencies: SCCs with more than one member, plus self-imports. */
export function findCycles(graph: CodeMapGraph, opts: DependencyGraphOptions = {}): DependencyCycle[] {
  const adj = buildAdjacency(graph, opts);
  const cycles: DependencyCycle[] = [];
  for (const comp of stronglyConnectedComponents(adj)) {
    const start = comp[0]!;
    if (comp.length === 1) {
      if ((adj.out.get(start) ?? []).includes(start)) cycles.push({ nodeIds: comp, path: [start, start], selfLoop: true });
      continue;
    }
    cycles.push({ nodeIds: comp, path: shortestCycleThrough(adj, start, new Set(comp)), selfLoop: false });
  }
  return cycles;
}

/** BFS from `start` back to `start` restricted to the component. */
function shortestCycleThrough(adj: Adjacency, start: string, members: Set<string>): string[] {
  const prev = new Map<string, string>();
  const queue: string[] = [];
  for (const w of adj.out.get(start) ?? []) {
    if (!members.has(w) || prev.has(w)) continue;
    prev.set(w, start);
    queue.push(w);
  }
  for (let i = 0; i < queue.length; i++) {
    const v = queue[i]!;
    for (const w of adj.out.get(v) ?? []) {
      if (w === start) {
        const path = [start];
        for (let cur: string | undefined = v; cur && cur !== start; cur = prev.get(cur)) path.splice(1, 0, cur);
        path.push(start);
        return path;
      }
      if (members.has(w) && !prev.has(w)) {
        prev.set(w, v);
        queue.push(w);
      }
    }
  }
  return [start, start];
}

export interface TraversalOptions extends DependencyGraphOptions {
  direction?: "outgoing" | "incoming";
  /** Maximum hops; default 1 (direct). Use Infinity for transitive closure. */
  maxDepth?: number;
  /** Stop after this many results to bound work on huge graphs. */
  limit?: number;
}

export interface TraversalHit {
  nodeId: string;
  depth: number;
  via: string;
}

/** BFS reachability with depth and result limits. */
export function traverseDependencies(graph: CodeMapGraph, startId: string, opts: TraversalOptions = {}): TraversalHit[] {
  const adj = buildAdjacency(graph, opts);
  const next = opts.direction === "incoming" ? adj.in : adj.out;
  const maxDepth = opts.maxDepth ?? 1;
  const limit = opts.limit ?? 10_000;
  const seen = new Set([startId]);
  const hits: TraversalHit[] = [];
  let frontier = [startId];
  for (let depth = 1; depth <= maxDepth && frontier.length > 0 && hits.length < limit; depth++) {
    const nextFrontier: string[] = [];
    for (const v of frontier) {
      for (const w of next.get(v) ?? []) {
        if (seen.has(w)) continue;
        seen.add(w);
        hits.push({ nodeId: w, depth, via: v });
        nextFrontier.push(w);
        if (hits.length >= limit) break;
      }
    }
    frontier = nextFrontier;
  }
  return hits;
}

export interface DegreeMetric {
  nodeId: string;
  /** Number of distinct nodes that depend on this node (incoming dependency edges). */
  fanIn: number;
  /** Number of distinct nodes this node depends on (outgoing dependency edges). */
  fanOut: number;
}

/** Fan-in / fan-out over dependency edges for every node of the given kinds (default: files). */
export function degreeMetrics(graph: CodeMapGraph, opts: DependencyGraphOptions & { nodeKinds?: string[] } = {}): DegreeMetric[] {
  const adj = buildAdjacency(graph, opts);
  const kinds = new Set(opts.nodeKinds ?? ["file"]);
  return graph.nodes
    .filter((n) => kinds.has(n.kind))
    // Self-imports are cycles, not dependencies on other files, so they do not count toward degree.
    .map((n) => ({ nodeId: n.id, fanIn: new Set(adj.in.get(n.id)?.filter((s) => s !== n.id)).size, fanOut: new Set(adj.out.get(n.id)?.filter((t) => t !== n.id)).size }));
}

/** Weakly connected components over dependency edges among nodes of the given kinds; isolated nodes are singleton components. */
export function weaklyConnectedComponents(graph: CodeMapGraph, opts: DependencyGraphOptions & { nodeKinds?: string[] } = {}): string[][] {
  const kinds = new Set(opts.nodeKinds ?? ["file"]);
  const ids = graph.nodes.filter((n) => kinds.has(n.kind)).map((n) => n.id).sort();
  const parent = new Map(ids.map((id) => [id, id]));
  const find = (x: string): string => {
    let r = x;
    while (parent.get(r) !== r) r = parent.get(r)!;
    while (parent.get(x) !== r) {
      const n = parent.get(x)!;
      parent.set(x, r);
      x = n;
    }
    return r;
  };
  for (const e of dependencyEdges(graph, opts)) {
    if (!parent.has(e.sourceId) || !parent.has(e.targetId)) continue;
    const a = find(e.sourceId);
    const b = find(e.targetId);
    if (a !== b) parent.set(a < b ? b : a, a < b ? a : b);
  }
  const groups = new Map<string, string[]>();
  for (const id of ids) (groups.get(find(id)) ?? groups.set(find(id), []).get(find(id))!).push(id);
  return [...groups.values()].sort((a, b) => b.length - a.length || (a[0]! < b[0]! ? -1 : 1));
}

/** Nodes of the given kinds with no dependency edges in either direction. */
export function isolatedNodes(graph: CodeMapGraph, opts: DependencyGraphOptions & { nodeKinds?: string[] } = {}): string[] {
  const adj = buildAdjacency(graph, opts);
  const kinds = new Set(opts.nodeKinds ?? ["file"]);
  return graph.nodes
    .filter((n) => kinds.has(n.kind) && !adj.out.has(n.id) && !adj.in.has(n.id))
    .map((n) => n.id)
    .sort();
}
