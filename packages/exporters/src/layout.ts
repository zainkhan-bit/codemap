/**
 * Deterministic layered (Sugiyama-style) layout. Pure computation, no DOM/browser.
 *
 * 1. Break cycles by reversing DFS back edges (deterministic node order).
 * 2. Assign layers by longest path from sources.
 * 3. Split edges spanning several layers with virtual waypoint nodes, so long edges are routed
 *    around real nodes instead of through them.
 * 4. Reduce crossings with barycenter sweeps (ties broken by label).
 * 5. Assign coordinates; layer widths are centered.
 */
export interface LayoutNodeInput {
  id: string;
  label: string;
}

export interface LayoutEdgeInput {
  id: string;
  source: string;
  target: string;
}

export interface LayoutNode extends LayoutNodeInput {
  x: number;
  y: number;
  width: number;
  height: number;
  layer: number;
}

export interface LayoutEdge extends LayoutEdgeInput {
  /** True when the edge points against the layer direction (it closes a cycle). */
  reversed: boolean;
  /** True for an edge from a node to itself; `points` is then empty. */
  selfLoop: boolean;
  /** Polyline from source to target, through any waypoints. */
  points: { x: number; y: number }[];
}

export interface Layout {
  width: number;
  height: number;
  nodes: LayoutNode[];
  edges: LayoutEdge[];
}

export interface LayoutOptions {
  charWidth?: number;
  nodeHeight?: number;
  hGap?: number;
  vGap?: number;
  margin?: number;
  sweeps?: number;
}

const WAYPOINT_WIDTH = 8;
/** Horizontal separation between an edge and its reverse counterpart (a 2-cycle). */
const PAIR_OFFSET = 7;
/** Extra room on the right for self-loop arcs. */
const SELF_LOOP_ROOM = 34;

export function layeredLayout(nodesIn: readonly LayoutNodeInput[], edgesIn: readonly LayoutEdgeInput[], opts: LayoutOptions = {}): Layout {
  const charWidth = opts.charWidth ?? 7.2;
  const nodeHeight = opts.nodeHeight ?? 30;
  const hGap = opts.hGap ?? 24;
  const vGap = opts.vGap ?? 70;
  const margin = opts.margin ?? 24;
  const sweeps = opts.sweeps ?? 6;

  const nodes = [...nodesIn].sort((a, b) => (a.label < b.label ? -1 : a.label > b.label ? 1 : a.id < b.id ? -1 : 1));
  const ids = new Set(nodes.map((n) => n.id));
  const allEdges = [...edgesIn].filter((e) => ids.has(e.source) && ids.has(e.target)).sort((a, b) => (a.id < b.id ? -1 : 1));
  const selfLoops = allEdges.filter((e) => e.source === e.target);
  const edges = allEdges.filter((e) => e.source !== e.target);
  const out = new Map<string, string[]>(nodes.map((n) => [n.id, []]));
  for (const e of edges) out.get(e.source)!.push(e.target);

  // 1. DFS back edges → reversed.
  const state = new Map<string, 1 | 2>();
  const backPairs = new Set<string>();
  for (const root of nodes) {
    if (state.get(root.id)) continue;
    const stack: { id: string; i: number }[] = [{ id: root.id, i: 0 }];
    state.set(root.id, 1);
    while (stack.length) {
      const top = stack[stack.length - 1]!;
      const succ = out.get(top.id)!;
      if (top.i < succ.length) {
        const w = succ[top.i++]!;
        const s = state.get(w);
        if (s === 1) backPairs.add(`${top.id}\u0000${w}`);
        else if (!s) {
          state.set(w, 1);
          stack.push({ id: w, i: 0 });
        }
      } else {
        state.set(top.id, 2);
        stack.pop();
      }
    }
  }
  const dag = edges.map((e) => {
    const rev = backPairs.has(`${e.source}\u0000${e.target}`);
    return { edge: e, reversed: rev, from: rev ? e.target : e.source, to: rev ? e.source : e.target };
  });

  // 2. Longest-path layering (Kahn order).
  const indeg = new Map(nodes.map((n) => [n.id, 0]));
  const dagOut = new Map<string, string[]>(nodes.map((n) => [n.id, []]));
  for (const e of dag) {
    dagOut.get(e.from)!.push(e.to);
    indeg.set(e.to, indeg.get(e.to)! + 1);
  }
  const layer = new Map(nodes.map((n) => [n.id, 0]));
  const queue = nodes.filter((n) => indeg.get(n.id) === 0).map((n) => n.id);
  for (let i = 0; i < queue.length; i++) {
    const v = queue[i]!;
    for (const w of dagOut.get(v)!) {
      layer.set(w, Math.max(layer.get(w)!, layer.get(v)! + 1));
      indeg.set(w, indeg.get(w)! - 1);
      if (indeg.get(w) === 0) queue.push(w);
    }
  }

  // 3. Waypoints: every DAG edge becomes a chain of unit-length segments.
  const label = new Map(nodes.map((n) => [n.id, n.label]));
  const width = new Map(nodes.map((n) => [n.id, Math.max(60, Math.ceil(n.label.length * charWidth) + 20)]));
  const up = new Map<string, string[]>(nodes.map((n) => [n.id, []]));
  const down = new Map<string, string[]>(nodes.map((n) => [n.id, []]));
  const chains = new Map<string, string[]>();
  for (const d of dag) {
    const chain = [d.from];
    for (let l = layer.get(d.from)! + 1; l < layer.get(d.to)!; l++) {
      const w = `\u0000wp:${d.edge.id}:${l}`;
      layer.set(w, l);
      width.set(w, WAYPOINT_WIDTH);
      label.set(w, `￿${label.get(d.from)}`); // waypoints sort after real nodes on ties
      up.set(w, []);
      down.set(w, []);
      chain.push(w);
    }
    chain.push(d.to);
    for (let i = 0; i + 1 < chain.length; i++) {
      down.get(chain[i]!)!.push(chain[i + 1]!);
      up.get(chain[i + 1]!)!.push(chain[i]!);
    }
    chains.set(d.edge.id, chain);
  }

  const layerCount = Math.max(0, ...layer.values()) + 1;
  const layers: string[][] = Array.from({ length: layerCount }, () => []);
  for (const n of nodes) layers[layer.get(n.id)!]!.push(n.id);
  for (const chain of chains.values()) for (const w of chain.slice(1, -1)) layers[layer.get(w)!]!.push(w);

  // 4. Barycenter crossing reduction.
  const order = new Map<string, number>();
  const setOrder = () => layers.forEach((l) => l.forEach((id, i) => order.set(id, i)));
  setOrder();
  for (let s = 0; s < sweeps; s++) {
    const downward = s % 2 === 0;
    const range = downward ? [...layers.keys()].slice(1) : [...layers.keys()].reverse().slice(1);
    for (const li of range) {
      const neighborsOf = (id: string) => (downward ? up.get(id)! : down.get(id)!);
      const bary = new Map(
        layers[li]!.map((id) => {
          const ns = neighborsOf(id);
          return [id, ns.length ? ns.reduce((a, n) => a + order.get(n)!, 0) / ns.length : order.get(id)!];
        }),
      );
      layers[li]!.sort((a, b) => bary.get(a)! - bary.get(b)! || (label.get(a)! < label.get(b)! ? -1 : label.get(a)! > label.get(b)! ? 1 : a < b ? -1 : 1));
      setOrder();
    }
  }

  // 5. Coordinates.
  const hasSelfLoop = new Set(selfLoops.map((e) => e.source));
  const slot = (id: string) => width.get(id)! + (hasSelfLoop.has(id) ? SELF_LOOP_ROOM : 0);
  const rowWidths = layers.map((l) => l.reduce((a, id) => a + slot(id), 0) + Math.max(0, l.length - 1) * hGap);
  const maxRow = Math.max(0, ...rowWidths);
  const pos = new Map<string, { x: number; y: number; w: number; layer: number }>();
  layers.forEach((l, li) => {
    let x = margin + (maxRow - rowWidths[li]!) / 2;
    for (const id of l) {
      pos.set(id, { x, y: margin + li * (nodeHeight + vGap), w: width.get(id)!, layer: li });
      x += slot(id) + hGap;
    }
  });

  const byId = new Map(nodes.map((n) => [n.id, n]));
  const placed: LayoutNode[] = nodes.map((n) => {
    const p = pos.get(n.id)!;
    return { ...byId.get(n.id)!, x: round(p.x), y: round(p.y), width: p.w, height: nodeHeight, layer: p.layer };
  });

  const pairs = new Set(edges.map((e) => `${e.source}\u0000${e.target}`));
  const layoutEdges: LayoutEdge[] = dag.map((d) => {
    const chain = chains.get(d.edge.id)!;
    const center = (id: string) => pos.get(id)!.x + pos.get(id)!.w / 2;
    // Points in DAG (downward) direction: bottom of `from`, waypoint centres, top of `to`.
    let pts = chain.map((id, i) => {
      const p = pos.get(id)!;
      if (i === 0) return { x: center(id), y: p.y + nodeHeight };
      if (i === chain.length - 1) return { x: center(id), y: p.y };
      return { x: center(id), y: p.y + nodeHeight / 2 };
    });
    // Separate an edge from its reverse counterpart so both arrows stay visible.
    if (pairs.has(`${d.edge.target}\u0000${d.edge.source}`)) pts = pts.map((p) => ({ x: p.x + (d.reversed ? PAIR_OFFSET : -PAIR_OFFSET), y: p.y }));
    if (d.reversed) pts.reverse();
    return { ...d.edge, reversed: d.reversed, selfLoop: false, points: pts.map((p) => ({ x: round(p.x), y: round(p.y) })) };
  });
  for (const e of selfLoops) layoutEdges.push({ ...e, reversed: false, selfLoop: true, points: [] });
  layoutEdges.sort((a, b) => (a.id < b.id ? -1 : 1));

  return {
    width: round(maxRow + margin * 2),
    height: round(margin * 2 + layerCount * nodeHeight + Math.max(0, layerCount - 1) * vGap),
    nodes: placed.sort((a, b) => a.layer - b.layer || a.x - b.x),
    edges: layoutEdges,
  };
}

function round(n: number): number {
  return Math.round(n * 10) / 10;
}
