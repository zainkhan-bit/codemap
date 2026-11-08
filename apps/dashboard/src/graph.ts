/** Cytoscape-based graph explorer. Renders an API projection; never derives relations itself. */
import cytoscape, { type Core, type ElementDefinition, type LayoutOptions } from "cytoscape";
import type { GraphViewResult } from "@codemap/contracts";

export type LayoutKind = "auto" | "layered" | "force";

/** Above this many nodes a layered layout becomes a few unreadably wide rows. */
const AUTO_LAYERED_MAX = 60;

// Overlapping nodes during layout produce noisy console warnings that are not actionable.
cytoscape.warnings(false);

const css = (name: string) => getComputedStyle(document.documentElement).getPropertyValue(name).trim();

/** Compact two-line labels: the name, then (for files) the last two directory segments. */
function label(n: GraphViewResult["nodes"][number], view: GraphViewResult["view"]): string {
  if (n.kind === "symbol") return n.qualifiedName ?? n.name;
  if (n.kind !== "file" || view === "directory_view" || !n.path) return n.name;
  const dirs = n.path.split("/").slice(0, -1);
  if (!dirs.length) return n.name;
  return `${n.name}\n${dirs.length > 2 ? "…/" : ""}${dirs.slice(-2).join("/")}`;
}

function style(): cytoscape.StylesheetJson {
  return [
    {
      selector: "node",
      style: {
        shape: "round-rectangle",
        "background-color": css("--node-bg"),
        "border-width": 1,
        "border-color": css("--node-border"),
        label: "data(label)",
        color: css("--fg"),
        "font-family": css("--mono"),
        "font-size": 11,
        "text-valign": "center",
        "text-halign": "center",
        "text-wrap": "wrap",
        "line-height": 1.25,
        width: "data(w)",
        height: "data(hgt)",
        padding: "0",
      },
    },
    { selector: 'node[lang = "typescript"]', style: { "background-color": css("--ts-bg"), "border-color": css("--ts") } },
    { selector: 'node[lang = "javascript"]', style: { "background-color": css("--js-bg"), "border-color": css("--js") } },
    { selector: 'node[lang = "python"]', style: { "background-color": css("--py-bg"), "border-color": css("--py") } },
    { selector: 'node[kind = "package"]', style: { "background-color": css("--pkg-bg"), "border-color": css("--muted"), "border-style": "dashed", color: css("--muted") } },
    { selector: 'node[kind = "module"]', style: { "background-color": css("--mod-bg"), "border-color": css("--mod") } },
    { selector: 'node[kind = "directory"], node[kind = "project"]', style: { shape: "tag", "background-color": css("--panel"), "border-color": css("--muted") } },
    { selector: "node[?inCycle]", style: { "border-color": css("--danger"), "border-width": 2 } },
    {
      selector: "edge",
      style: {
        width: 1.2,
        "line-color": css("--edge"),
        "target-arrow-color": css("--edge"),
        "target-arrow-shape": "triangle",
        "arrow-scale": 0.9,
        "curve-style": "bezier",
      },
    },
    { selector: 'edge[conf = "medium"], edge[?typeOnly]', style: { "line-style": "dashed" } },
    { selector: 'edge[kind = "calls"]', style: { "line-color": css("--call"), "target-arrow-color": css("--call") } },
    { selector: 'edge[kind = "extends"], edge[kind = "implements"]', style: { "target-arrow-shape": "triangle-backcurve", "line-color": css("--mod"), "target-arrow-color": css("--mod") } },
    { selector: 'edge[kind = "contains"]', style: { "target-arrow-shape": "none", "line-color": css("--node-border"), width: 1 } },
    { selector: "edge[?inCycle]", style: { "line-color": css("--danger"), "target-arrow-color": css("--danger"), width: 2 } },
    { selector: ".faded", style: { opacity: 0.15 } },
    { selector: "node.match", style: { "border-color": css("--accent"), "border-width": 2 } },
    { selector: "node:selected", style: { "border-color": css("--accent"), "border-width": 3, "background-color": css("--accent-bg") } },
    { selector: "edge.focus", style: { width: 2.2, "z-index": 10 } },
  ];
}

function layoutFor(requested: LayoutKind, n: number): LayoutOptions {
  const kind = requested === "auto" ? (n <= AUTO_LAYERED_MAX ? "layered" : "force") : requested;
  if (kind === "force") return { name: "cose", animate: false, randomize: false, nodeRepulsion: () => 9000, idealEdgeLength: () => 90, numIter: n > 800 ? 400 : 1000, fit: true, padding: 30 } as LayoutOptions;
  return { name: "breadthfirst", directed: true, spacingFactor: 1.15, avoidOverlap: true, fit: true, padding: 30 } as LayoutOptions;
}

export class GraphCanvas {
  private cy: Core;
  private matches: string[] = [];
  private matchIndex = -1;

  constructor(
    container: HTMLElement,
    private readonly onSelect: (nodeId: string | null) => void,
  ) {
    this.cy = cytoscape({ container, style: style(), minZoom: 0.05, maxZoom: 3, boxSelectionEnabled: false, selectionType: "single" });
    this.cy.on("tap", "node", (ev) => this.onSelect(ev.target.id()));
    this.cy.on("tap", (ev) => {
      if (ev.target === this.cy) this.onSelect(null);
    });
  }

  render(data: GraphViewResult, layout: LayoutKind): void {
    const cycleNodes = new Set(data.cycleNodeIds);
    const cycleEdges = new Set(data.cycleEdgeIds);
    const elements: ElementDefinition[] = [
      ...data.nodes.map((n) => {
        const text = label(n, data.view);
        const lines = text.split("\n");
        const longest = Math.max(...lines.map((l) => l.length));
        return { group: "nodes" as const, data: { id: n.id, label: text, w: Math.min(320, Math.max(48, longest * 6.8 + 22)), hgt: lines.length > 1 ? 38 : 26, kind: n.kind, lang: n.kind === "file" || n.kind === "symbol" ? n.language : undefined, inCycle: cycleNodes.has(n.id) } };
      }),
      ...data.edges.map((e) => ({
        group: "edges" as const,
        data: { id: e.id, source: e.sourceId, target: e.targetId, kind: e.kind, conf: e.confidence, typeOnly: e.attributes.typeOnly === true, inCycle: cycleEdges.has(e.id) },
      })),
    ];
    this.cy.batch(() => {
      this.cy.elements().remove();
      this.cy.add(elements);
    });
    this.cy.layout(layoutFor(layout, data.nodes.length)).run();
    this.matches = [];
  }

  relayout(layout: LayoutKind): void {
    this.cy.layout(layoutFor(layout, this.cy.nodes().length)).run();
  }

  has(id: string): boolean {
    return this.cy.getElementById(id).nonempty();
  }

  /** Selects a node and dims everything outside its direct neighbourhood. */
  select(id: string | null, center = false): void {
    this.cy.batch(() => {
      this.cy.elements().removeClass("faded focus").unselect();
      if (!id) return;
      const node = this.cy.getElementById(id);
      if (node.empty()) return;
      node.select();
      const hood = node.closedNeighborhood();
      this.cy.elements().not(hood).addClass("faded");
      node.connectedEdges().addClass("focus");
    });
    if (id && center) {
      const node = this.cy.getElementById(id);
      // Frame the node together with its direct neighbours, without zooming in further than 1.4x.
      if (node.nonempty()) {
        const hood = node.closedNeighborhood();
        this.cy.animate({ fit: { eles: hood, padding: 60 } }, { duration: 250, complete: () => this.cy.zoom() > 1.4 && this.cy.zoom({ level: 1.4, renderedPosition: this.cy.getElementById(id).renderedPosition() }) });
      }
    }
  }

  /** Highlights label matches; returns the next match to select (cycles on repeated calls). */
  search(term: string): { next?: string; count: number } {
    const t = term.trim().toLowerCase();
    this.cy.nodes().removeClass("match");
    if (!t) {
      this.matches = [];
      return { count: 0 };
    }
    const found = this.cy.nodes().filter((n) => String(n.data("label")).toLowerCase().includes(t));
    found.addClass("match");
    const ids = found.map((n) => n.id());
    if (ids.join() !== this.matches.join()) {
      this.matches = ids;
      this.matchIndex = -1;
    }
    if (!ids.length) return { count: 0 };
    this.matchIndex = (this.matchIndex + 1) % ids.length;
    return { next: ids[this.matchIndex], count: ids.length };
  }

  fit(): void {
    this.cy.animate({ fit: { eles: this.cy.elements(), padding: 30 } }, { duration: 200 });
  }

  get nodeCount(): number {
    return this.cy.nodes().length;
  }

  refreshStyle(): void {
    this.cy.style(style());
  }
}
