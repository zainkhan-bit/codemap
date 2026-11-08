/**
 * CodeMap dashboard. Reads everything through the loopback API v1; holds no graph logic of its
 * own beyond presentation. Layout: header · sidebar (files / issues) · graph · inspector.
 */
import type {
  ApiProject,
  DependencyHit,
  EdgeWithPeer,
  GraphDiagnostic,
  GraphReference,
  GraphView,
  GraphViewResult,
  NodeDetailsView,
  NodeSummary,
  ProjectSummary,
  ReferencePage,
  ScanRecord,
} from "@codemap/contracts";
import { ApiFailure, download, get, initToken, launchParams } from "./api.js";
import { clear, fmt, h, replace, timeAgo } from "./dom.js";
import { GraphCanvas, type LayoutKind } from "./graph.js";

interface State {
  projects: ApiProject[];
  projectId?: string;
  scans: ScanRecord[];
  scanId?: string;
  summary?: ProjectSummary;
  view: GraphView;
  path?: string;
  includeExternal: boolean;
  excludeTypeOnly: boolean;
  minConfidence: "high" | "medium";
  layout: LayoutKind;
  selected?: string;
  sidebar: "files" | "issues";
  graph?: GraphViewResult;
  /** path → node summary for every file and directory (from the directory view). */
  pathIndex: Map<string, NodeSummary>;
  tree?: TreeNode;
  expanded: Set<string>;
}

interface TreeNode {
  summary: NodeSummary;
  children: TreeNode[];
  files: number;
}

const VIEWS: { id: GraphView; label: string; hint: string }[] = [
  { id: "file_dependency_view", label: "Files", hint: "Files and packages linked by resolved imports" },
  { id: "module_view", label: "Modules", hint: "Workspace packages linked by aggregated imports" },
  { id: "call_view", label: "Calls", hint: "Statically resolved calls between declarations" },
  { id: "symbol_view", label: "Symbols", hint: "Declarations, exports and inheritance" },
  { id: "directory_view", label: "Folders", hint: "Directory containment" },
];

const state: State = {
  projects: [],
  scans: [],
  view: "file_dependency_view",
  includeExternal: true,
  excludeTypeOnly: false,
  minConfidence: "medium",
  layout: "auto",
  sidebar: "files",
  pathIndex: new Map(),
  expanded: new Set([""]),
};

const root = document.getElementById("app")!;
const els = {
  header: h("header", { class: "topbar" }),
  sidebar: h("aside", { class: "sidebar", "aria-label": "Project navigation" }),
  toolbar: h("div", { class: "toolbar", role: "toolbar", "aria-label": "Graph controls" }),
  banner: h("div", { class: "banner", hidden: true, role: "status" }),
  canvas: h("div", { class: "canvas", id: "graph", "aria-label": "Dependency graph" }),
  empty: h("div", { class: "canvas-empty", hidden: true }),
  inspector: h("aside", { class: "inspector", "aria-label": "Details", "aria-live": "polite" }),
};
let canvas: GraphCanvas;
let graphRequest = 0;
let detailRequest = 0;

// ------------------------------------------------------------------ bootstrap

async function boot(): Promise<void> {
  if (!initToken()) return fatal("No access token", "Open the dashboard with the link printed by `codemap dashboard`. The token is in the part after #, which browsers never send to servers.");
  replace(
    root,
    els.header,
    h("div", { class: "body" }, els.sidebar, h("main", { class: "main" }, els.toolbar, els.banner, h("div", { class: "canvas-wrap" }, els.canvas, els.empty)), els.inspector),
  );
  canvas = new GraphCanvas(els.canvas, (id) => void select(id, false));
  window.matchMedia("(prefers-color-scheme: dark)").addEventListener("change", () => canvas.refreshStyle());
  document.addEventListener("keydown", onKey);
  try {
    state.projects = await get<ApiProject[]>("/projects");
  } catch (err) {
    return fatal("Cannot reach the CodeMap API", errMessage(err));
  }
  if (!state.projects.length) return fatal("No scanned projects yet", "Run `codemap scan <path>` and reload this page.");
  const wanted = launchParams.get("project");
  await selectProject(state.projects.find((p) => p.projectId === wanted)?.projectId ?? state.projects.find((p) => p.latestScanId)?.projectId ?? state.projects[0]!.projectId);
}

function fatal(title: string, detail: string): void {
  replace(root, h("div", { class: "fatal" }, h("h1", {}, title), h("p", {}, detail)));
}

function errMessage(err: unknown): string {
  return err instanceof ApiFailure || err instanceof Error ? err.message : String(err);
}

function showBanner(message: string | null, kind: "info" | "error" = "info"): void {
  els.banner.hidden = !message;
  els.banner.className = `banner ${kind}`;
  replace(els.banner, message ?? "");
}

async function selectProject(projectId: string): Promise<void> {
  state.projectId = projectId;
  state.scans = await get<ScanRecord[]>(`/projects/${projectId}/scans`);
  if (!state.scans.length) {
    renderHeader();
    return showBanner("This project has no completed scan. Run `codemap scan` on it first.", "error");
  }
  await selectScan(state.scans[0]!.scanId);
}

async function selectScan(scanId: string): Promise<void> {
  state.scanId = scanId;
  state.selected = undefined;
  state.path = undefined;
  state.expanded = new Set([""]);
  const [summary, folders] = await Promise.all([get<ProjectSummary>(`/scans/${scanId}/summary`), get<GraphViewResult>(`/scans/${scanId}/graph`, { view: "directory_view", limit: 20000, minConfidence: "low" })]);
  state.summary = summary;
  buildTree(folders);
  renderHeader();
  renderSidebar();
  renderToolbar();
  renderOverview();
  await loadGraph();
}

// ------------------------------------------------------------------ header

function renderHeader(): void {
  const s = state.summary;
  const projectSelect = h(
    "select",
    { class: "select", "aria-label": "Project", onchange: (e) => void selectProject((e.target as HTMLSelectElement).value) },
    state.projects.map((p) => h("option", { value: p.projectId, selected: p.projectId === state.projectId }, p.displayName)),
  );
  const scanSelect = h(
    "select",
    { class: "select subtle", "aria-label": "Scan", onchange: (e) => void selectScan((e.target as HTMLSelectElement).value) },
    state.scans.map((sc, i) => h("option", { value: sc.scanId, selected: sc.scanId === state.scanId }, `${i === 0 ? "Latest · " : ""}${timeAgo(sc.completedAt)} · ${sc.summary?.fileCount ?? 0} files`)),
  );
  const exportMenu = h(
    "div",
    { class: "export" },
    h("span", { class: "export-label" }, "Export"),
    (["svg", "png", "json", "mermaid"] as const).map((f) => h("button", { class: "btn small", title: f === "json" ? "Full canonical graph (all views)" : `Current view as ${f.toUpperCase()}`, onclick: () => void exportAs(f) }, f.toUpperCase())),
  );
  replace(
    els.header,
    h("div", { class: "brand" }, h("span", { class: "logo", "aria-hidden": "true" }), "CodeMap"),
    projectSelect,
    state.scans.length ? scanSelect : null,
    s ? h("div", { class: "chips" }, chip(`${fmt(s.scan.summary?.fileCount)} files`), chip(`${fmt(s.metrics["nodes.symbol"])} symbols`), s.cycles.length ? chip(`${s.cycles.length} cycles`, "danger") : chip("no cycles", "ok")) : null,
    h("div", { class: "spacer" }),
    state.scanId ? exportMenu : null,
  );
}

function chip(text: string, tone = ""): HTMLElement {
  return h("span", { class: `chip ${tone}` }, text);
}

async function exportAs(format: "svg" | "png" | "json" | "mermaid"): Promise<void> {
  if (!state.scanId) return;
  const ext = format === "mermaid" ? "mmd" : format;
  try {
    await download(`/scans/${state.scanId}/export`, { format, view: format === "json" ? undefined : state.view, path: state.path, includeExternal: state.includeExternal, excludeTypeOnly: state.excludeTypeOnly || undefined, force: true }, `codemap-${state.view.replace("_view", "")}.${ext}`);
  } catch (err) {
    showBanner(`Export failed: ${errMessage(err)}`, "error");
  }
}

// ------------------------------------------------------------------ sidebar: file tree + issues

function buildTree(folders: GraphViewResult): void {
  state.pathIndex.clear();
  const byId = new Map(folders.nodes.map((n) => [n.id, n]));
  const nodes = new Map<string, TreeNode>();
  for (const n of folders.nodes) {
    const summary: NodeSummary = { id: n.id, kind: n.kind, name: n.name, label: n.path ?? n.name, ...(n.path !== undefined ? { path: n.path } : {}), ...(n.language ? { language: n.language } : {}) };
    nodes.set(n.id, { summary, children: [], files: 0 });
    if (n.kind !== "project") state.pathIndex.set(n.path ?? "", summary);
  }
  let rootNode: TreeNode | undefined;
  for (const e of folders.edges) nodes.get(e.sourceId)?.children.push(nodes.get(e.targetId)!);
  for (const [id, t] of nodes) if (byId.get(id)!.kind === "project") rootNode = t;
  const count = (t: TreeNode): number => (t.files = t.summary.kind === "file" ? 1 : t.children.reduce((a, c) => a + count(c), 0));
  const sort = (t: TreeNode) => {
    t.children.sort((a, b) => (a.summary.kind === b.summary.kind ? a.summary.name.localeCompare(b.summary.name, "en") : a.summary.kind === "directory" ? -1 : 1));
    t.children.forEach(sort);
  };
  if (rootNode) {
    count(rootNode);
    sort(rootNode);
  }
  state.tree = rootNode;
}

function renderSidebar(): void {
  const tabs = h(
    "div",
    { class: "tabs", role: "tablist" },
    (["files", "issues"] as const).map((t) =>
      h("button", { class: `tab ${state.sidebar === t ? "active" : ""}`, role: "tab", "aria-selected": state.sidebar === t ? "true" : "false", onclick: () => ((state.sidebar = t), renderSidebar()) }, t === "files" ? "Files" : `Issues${issueCount() ? ` · ${issueCount()}` : ""}`),
    ),
  );
  const body = h("div", { class: "sidebar-body" });
  replace(els.sidebar, tabs, body);
  if (state.sidebar === "files") renderTree(body);
  else void renderIssues(body);
}

/** Unresolved imports/exports/inheritance. Unresolved calls are expected (builtins, dynamic dispatch) and listed per symbol. */
function actionableUnresolved(): number {
  return (state.summary?.unresolved ?? []).filter((u) => u.kind !== "call").reduce((a, u) => a + u.count, 0);
}

function issueCount(): number {
  return state.summary ? state.summary.cycles.length + actionableUnresolved() : 0;
}

function renderTree(body: HTMLElement): void {
  if (!state.tree) return replace(body, h("p", { class: "muted pad" }, "No files."));
  const list = h("ul", { class: "tree", role: "tree" });
  const add = (t: TreeNode, depth: number, parent: HTMLElement) => {
    const isDir = t.summary.kind !== "file";
    const key = t.summary.path ?? "";
    const open = state.expanded.has(key);
    const focused = state.path !== undefined && state.path === key;
    const row = h(
      "li",
      { role: "treeitem", "aria-expanded": isDir ? String(open) : undefined },
      h(
        "div",
        {
          class: `tree-row ${state.selected === t.summary.id ? "selected" : ""} ${focused ? "focused" : ""}`,
          style: `--depth:${depth}`,
          title: key || t.summary.name,
          onclick: () => {
            if (isDir) {
              if (open) state.expanded.delete(key);
              else state.expanded.add(key);
              renderSidebar();
            } else void select(t.summary.id, true);
          },
        },
        h("span", { class: `caret ${isDir ? (open ? "open" : "") : "none"}`, "aria-hidden": "true" }),
        h("span", { class: `icon ${isDir ? "dir" : `file ${t.summary.language ?? ""}`}`, "aria-hidden": "true" }),
        h("span", { class: "name" }, t.summary.kind === "project" ? (state.summary?.project.displayName ?? t.summary.name) : t.summary.name),
        isDir ? h("span", { class: "count" }, fmt(t.files)) : null,
        isDir && t.summary.kind !== "project"
          ? h("button", { class: "focus-btn", title: `Show only ${key} in the graph`, "aria-label": `Focus graph on ${key}`, onclick: (e) => (e.stopPropagation(), void setPath(focused ? undefined : key)) }, focused ? "Unfocus" : "Focus")
          : null,
      ),
    );
    parent.append(row);
    if (isDir && open && t.children.length) {
      const ul = h("ul", { role: "group" });
      row.append(ul);
      for (const c of t.children) add(c, depth + 1, ul);
    }
  };
  add(state.tree, 0, list);
  replace(body, list);
}

async function renderIssues(body: HTMLElement): Promise<void> {
  const s = state.summary;
  if (!s || !state.scanId) return;
  const scanId = state.scanId;
  const cycles = h(
    "section",
    { class: "issue-group" },
    h("h3", {}, `Circular dependencies`, h("span", { class: "count" }, String(s.cycles.length))),
    s.cycles.length
      ? h(
          "ol",
          { class: "issue-list" },
          s.cycles.map((c) =>
            h(
              "li",
              {},
              h(
                "button",
                { class: "link cycle", onclick: () => void selectPath(c.files[0]!) },
                c.selfLoop ? `${c.files[0]} imports itself` : c.path.join(" → "),
              ),
            ),
          ),
        )
      : h("p", { class: "muted" }, "None in resolved import edges."),
  );
  const unresolved = h("section", { class: "issue-group" }, h("h3", {}, "Unresolved imports & inheritance", h("span", { class: "count" }, String(actionableUnresolved()))), h("p", { class: "muted" }, "Loading…"));
  const diags = h("section", { class: "issue-group" }, h("h3", {}, "Diagnostics"), h("p", { class: "muted" }, "Loading…"));
  replace(body, cycles, unresolved, diags);

  const [refs, diagnostics] = await Promise.all([
    get<ReferencePage>(`/scans/${scanId}/references`, { status: "unresolved,ambiguous", kind: "import,extends,implements,export", limit: 300 }),
    get<GraphDiagnostic[]>(`/scans/${scanId}/diagnostics`, { severity: "error,warning" }),
  ]);
  if (state.scanId !== scanId) return;
  unresolved.lastElementChild!.replaceWith(
    refs.items.length
      ? h(
          "ul",
          { class: "issue-list" },
          refs.items.map((i) => h("li", {}, h("button", { class: "link", onclick: () => void select(fileIdOf(i.reference) ?? i.source.id, true) }, h("span", { class: `status ${i.reference.status}` }, i.reference.status === "ambiguous" ? "ambiguous" : i.reference.kind), " ", h("code", {}, i.reference.specifier ?? i.reference.rawText), h("span", { class: "where" }, `${i.reference.sourceLocation.path}:${i.reference.sourceLocation.startLine}`)), i.reference.message ? h("div", { class: "reason" }, i.reference.message) : null)),
          refs.total > refs.items.length ? h("li", { class: "muted" }, `…and ${fmt(refs.total - refs.items.length)} more (see JSON export)`) : null,
          h("li", { class: "muted small" }, "Unresolved calls are listed per symbol in the inspector."),
        )
      : h("p", { class: "muted" }, "No unresolved import or inheritance references."),
  );
  diags.lastElementChild!.replaceWith(
    diagnostics.length
      ? h(
          "ul",
          { class: "issue-list" },
          diagnostics.slice(0, 300).map((d) => {
            const p = d.location?.path ?? (d.attributes?.path as string | undefined);
            return h("li", {}, h("button", { class: "link", disabled: !p, onclick: () => p && void selectPath(p) }, h("span", { class: `sev ${d.severity}` }, d.code), " ", d.message, p ? h("span", { class: "where" }, `${p}${d.location ? `:${d.location.startLine}` : ""}`) : null));
          }),
        )
      : h("p", { class: "muted" }, "No warnings or errors."),
  );
}

function fileIdOf(r: GraphReference): string | undefined {
  return state.pathIndex.get(r.sourceLocation.path)?.id;
}

async function selectPath(p: string): Promise<void> {
  const n = state.pathIndex.get(p);
  if (n) await select(n.id, true);
}

// ------------------------------------------------------------------ toolbar + graph

function renderToolbar(): void {
  const viewTabs = h(
    "div",
    { class: "segmented", role: "radiogroup", "aria-label": "View" },
    VIEWS.map((v) => h("button", { class: state.view === v.id ? "active" : "", role: "radio", "aria-checked": String(state.view === v.id), title: v.hint, onclick: () => ((state.view = v.id), renderToolbar(), void loadGraph()) }, v.label)),
  );
  const toggle = (label: string, checked: boolean, on: (v: boolean) => void, title: string) =>
    h("label", { class: "toggle", title }, h("input", { type: "checkbox", checked, onchange: (e) => on((e.target as HTMLInputElement).checked) }), label);
  const search = h("input", { class: "search", type: "search", placeholder: "Find node  ( / )", "aria-label": "Find node in graph" }) as HTMLInputElement;
  const searchInfo = h("span", { class: "search-info muted" });
  search.addEventListener("input", () => replace(searchInfo, search.value ? `${canvas.search(search.value).count} match` : ""));
  search.addEventListener("keydown", (e) => {
    if (e.key === "Enter") {
      const r = canvas.search(search.value);
      replace(searchInfo, `${r.count} match${r.count === 1 ? "" : "es"}`);
      if (r.next) void select(r.next, true);
    }
    if (e.key === "Escape") {
      search.value = "";
      canvas.search("");
      replace(searchInfo, "");
    }
  });
  replace(
    els.toolbar,
    viewTabs,
    state.path !== undefined ? h("span", { class: "chip focus" }, `in ${state.path}/`, h("button", { class: "chip-x", "aria-label": "Clear folder focus", onclick: () => void setPath(undefined) }, "×")) : null,
    h("div", { class: "spacer" }),
    toggle("External", state.includeExternal, (v) => ((state.includeExternal = v), void loadGraph()), "Show external packages and the standard library"),
    toggle("Type-only", !state.excludeTypeOnly, (v) => ((state.excludeTypeOnly = !v), void loadGraph()), "Show imports that are erased at runtime (import type)"),
    toggle("Inferred", state.minConfidence === "medium", (v) => ((state.minConfidence = v ? "medium" : "high"), void loadGraph()), "Include medium-confidence edges (resolved by convention); low confidence is never shown"),
    h(
      "select",
      { class: "select subtle", "aria-label": "Layout", onchange: (e) => ((state.layout = (e.target as HTMLSelectElement).value as LayoutKind), canvas.relayout(state.layout)) },
      h("option", { value: "auto", selected: state.layout === "auto" }, "Auto layout"),
      h("option", { value: "layered", selected: state.layout === "layered" }, "Layered"),
      h("option", { value: "force", selected: state.layout === "force" }, "Force"),
    ),
    h("button", { class: "btn small", title: "Fit graph to screen", onclick: () => canvas.fit() }, "Fit"),
    search,
    searchInfo,
  );
}

async function setPath(p: string | undefined): Promise<void> {
  state.path = p;
  if (p) for (let d = p; ; d = d.includes("/") ? d.slice(0, d.lastIndexOf("/")) : "") {
    state.expanded.add(d);
    if (!d) break;
  }
  renderToolbar();
  renderSidebar();
  await loadGraph();
}

async function loadGraph(): Promise<void> {
  if (!state.scanId) return;
  const req = ++graphRequest;
  showBanner(null);
  try {
    const data = await get<GraphViewResult>(`/scans/${state.scanId}/graph`, {
      view: state.view,
      path: state.path,
      includeExternal: state.includeExternal,
      excludeTypeOnly: state.excludeTypeOnly,
      minConfidence: state.minConfidence,
      limit: 1500,
    });
    if (req !== graphRequest) return;
    state.graph = data;
    els.empty.hidden = data.nodes.length > 0;
    if (!data.nodes.length) replace(els.empty, h("p", {}, "Nothing to show in this view.", h("br"), h("span", { class: "muted" }, state.view === "call_view" ? "No statically resolved calls here." : "Try another view or clear the folder focus.")));
    canvas.render(data, state.layout);
    if (data.truncated) showBanner(`Showing ${fmt(data.nodes.length)} of ${fmt(data.totalNodes)} nodes. Focus a folder in the file tree to see the rest.`, "info");
    if (state.selected) canvas.select(state.selected);
  } catch (err) {
    if (req === graphRequest) showBanner(`Could not load graph: ${errMessage(err)}`, "error");
  }
}

// ------------------------------------------------------------------ selection + inspector

async function select(id: string | null, center: boolean): Promise<void> {
  state.selected = id ?? undefined;
  canvas.select(id, center);
  if (state.sidebar === "files") {
    if (id) {
      const n = [...state.pathIndex.values()].find((x) => x.id === id);
      if (n?.path) for (let d = n.path; d.includes("/"); ) state.expanded.add((d = d.slice(0, d.lastIndexOf("/"))));
    }
    renderSidebar();
    els.sidebar.querySelector(".tree-row.selected")?.scrollIntoView({ block: "nearest" });
  }
  if (!id) return renderOverview();
  const req = ++detailRequest;
  replace(els.inspector, h("p", { class: "muted pad" }, "Loading…"));
  try {
    const d = await get<NodeDetailsView>(`/scans/${state.scanId}/nodes/${id}`);
    if (req === detailRequest) renderDetails(d);
  } catch (err) {
    if (req === detailRequest) replace(els.inspector, h("p", { class: "error pad" }, errMessage(err)));
  }
}

function onKey(e: KeyboardEvent): void {
  const typing = (e.target as HTMLElement)?.matches?.("input, select, textarea");
  if (e.key === "/" && !typing) {
    e.preventDefault();
    els.toolbar.querySelector<HTMLInputElement>(".search")?.focus();
  } else if (e.key === "Escape" && !typing && state.selected) void select(null, false);
}

function renderOverview(): void {
  const s = state.summary;
  if (!s) return clear(els.inspector);
  const m = s.metrics;
  const tile = (label: string, value: number | undefined, tone = "") => h("div", { class: `tile ${tone}` }, h("div", { class: "tile-value" }, fmt(value)), h("div", { class: "tile-label" }, label));
  const langs = Object.entries(s.scan.summary?.languages ?? {});
  const total = langs.reduce((a, [, n]) => a + n, 0) || 1;
  const pathLink = (p: string, n: number) => h("li", {}, h("button", { class: "link", onclick: () => void selectPath(p), disabled: !state.pathIndex.has(p) }, h("span", { class: "num" }, String(n)), p));
  replace(
    els.inspector,
    h("div", { class: "inspector-head" }, h("div", { class: "eyebrow" }, "Project overview"), h("h2", {}, s.project.displayName), h("p", { class: "muted small" }, `Scan ${s.scan.scanId} · ${timeAgo(s.scan.completedAt)}`)),
    h(
      "div",
      { class: "tiles" },
      tile("files", s.scan.summary?.fileCount),
      tile("symbols", m["nodes.symbol"]),
      tile("import edges", m["edges.imports"]),
      tile("call edges", m["edges.calls"]),
      tile("cycles", s.cycles.length, s.cycles.length ? "danger" : "ok"),
      tile("unresolved imports", actionableUnresolved(), actionableUnresolved() ? "warn" : "ok"),
    ),
    langs.length
      ? h(
          "section",
          { class: "section" },
          h("h3", {}, "Languages"),
          h("div", { class: "langbar", role: "img", "aria-label": langs.map(([l, n]) => `${l} ${n}`).join(", ") }, langs.map(([l, n]) => h("span", { class: `seg ${l}`, style: `flex:${n}`, title: `${l}: ${n} files (${Math.round((n / total) * 100)}%)` }))),
          h("div", { class: "legend" }, langs.map(([l, n]) => h("span", {}, h("i", { class: `dot ${l}` }), `${l} ${n}`))),
        )
      : null,
    h("section", { class: "section" }, h("h3", {}, "Most depended-on"), s.topFanIn.length ? h("ol", { class: "rank" }, s.topFanIn.slice(0, 8).map((d) => pathLink(d.path, d.fanIn))) : h("p", { class: "muted" }, "No import edges.")),
    h("section", { class: "section" }, h("h3", {}, "Most dependencies"), s.topFanOut.length ? h("ol", { class: "rank" }, s.topFanOut.slice(0, 8).map((d) => pathLink(d.path, d.fanOut))) : h("p", { class: "muted" }, "No import edges.")),
    h("p", { class: "muted small pad-x" }, "Fan-in and fan-out count distinct files linked by resolved imports. They point at hotspots; they are not defects by themselves."),
    h("p", { class: "muted small pad-x" }, `${fmt(s.unresolved.find((u) => u.kind === "call")?.count ?? 0)} calls could not be linked statically (builtins, external APIs, dynamic dispatch). Select a symbol to see its unresolved calls.`),
    s.isolatedFiles.length ? h("p", { class: "muted small pad-x" }, `${fmt(s.isolatedFiles.length)} files have no resolved import edges.`) : null,
  );
}

const EDGE_TITLES: Record<string, [string, string]> = {
  imports: ["Imports", "Imported by"],
  calls: ["Calls", "Called by"],
  exports: ["Exports", "Exported by"],
  extends: ["Extends", "Extended by"],
  implements: ["Implements", "Implemented by"],
};

function renderDetails(d: NodeDetailsView): void {
  const n = d.node;
  const loc = n.location ? `${n.location.path}:${n.location.startLine}` : n.path;
  const unresolved = d.references.filter((r) => r.status === "unresolved" || r.status === "ambiguous");
  const groups: HTMLElement[] = [];
  for (const kind of Object.keys(EDGE_TITLES)) {
    const out = d.outgoing.filter((e) => e.edge.kind === kind);
    const inc = d.incoming.filter((e) => e.edge.kind === kind);
    if (out.length) groups.push(edgeSection(EDGE_TITLES[kind]![0], out));
    if (inc.length) groups.push(edgeSection(EDGE_TITLES[kind]![1], inc));
  }
  const symbols = d.children.filter((c) => c.kind === "symbol");
  const attrs = n.attributes;
  replace(
    els.inspector,
    h(
      "div",
      { class: "inspector-head" },
      h("div", { class: "eyebrow" }, n.kind === "symbol" ? (n.symbolKind ?? "symbol") : n.kind, n.language ? ` · ${n.language}` : "", attrs.exported === true ? " · exported" : ""),
      h("h2", { class: "mono break" }, n.kind === "symbol" ? (n.qualifiedName ?? n.name) : n.name),
      loc ? h("p", { class: "mono small muted break" }, loc) : null,
      h("div", { class: "head-actions" }, h("button", { class: "btn small", onclick: () => void select(null, false) }, "← Overview"), n.kind === "file" || n.kind === "package" || n.kind === "module" ? h("button", { class: "btn small", onclick: () => void transitive(n.id) }, "Transitive dependencies") : null),
    ),
    d.parent && d.parent.kind === "symbol" ? h("p", { class: "pad-x small" }, "Inside ", nodeLink(d.parent)) : null,
    groups.length ? groups : n.kind !== "directory" && n.kind !== "project" ? h("p", { class: "muted pad" }, "No resolved relationships.") : null,
    symbols.length ? h("section", { class: "section" }, h("h3", {}, "Declarations", h("span", { class: "count" }, String(symbols.length))), h("ul", { class: "rel" }, symbols.map((c) => h("li", {}, nodeLink(c), h("span", { class: "kind" }, c.symbolKind ?? ""))))) : null,
    n.kind === "directory" || n.kind === "project" ? h("section", { class: "section" }, h("h3", {}, "Contents"), h("ul", { class: "rel" }, d.children.map((c) => h("li", {}, nodeLink(c))))) : null,
    unresolved.length
      ? h(
          "section",
          { class: "section" },
          h("h3", {}, "Unresolved references", h("span", { class: "count warn" }, String(unresolved.length))),
          h("ul", { class: "rel" }, unresolved.slice(0, 200).map((r) => h("li", { title: r.message ?? "" }, h("span", { class: `status ${r.status}` }, r.status === "ambiguous" ? "ambiguous" : r.kind), " ", h("code", {}, r.rawText), h("div", { class: "reason" }, `line ${r.sourceLocation.startLine}${r.message ? ` · ${r.message}` : ""}`)))),
        )
      : null,
    d.diagnostics.length ? h("section", { class: "section" }, h("h3", {}, "Diagnostics"), h("ul", { class: "rel" }, d.diagnostics.map((g) => h("li", {}, h("span", { class: `sev ${g.severity}` }, g.code), " ", g.message, g.location ? h("span", { class: "where" }, `line ${g.location.startLine}`) : null)))) : null,
    h("div", { id: "transitive" }),
  );
}

function edgeSection(title: string, edges: EdgeWithPeer[]): HTMLElement {
  const sorted = [...edges].sort((a, b) => a.peer.label.localeCompare(b.peer.label, "en"));
  return h(
    "section",
    { class: "section" },
    h("h3", {}, title, h("span", { class: "count" }, String(edges.length))),
    h(
      "ul",
      { class: "rel" },
      sorted.map((e) =>
        h(
          "li",
          { title: `${e.edge.resolutionMethod ?? ""} · ${e.edge.evidenceReferenceIds.length} evidence reference(s)` },
          nodeLink(e.peer),
          e.edge.confidence !== "high" ? h("span", { class: "conf" }, e.edge.confidence) : null,
          e.edge.attributes.typeOnly === true ? h("span", { class: "conf" }, "type") : null,
        ),
      ),
    ),
  );
}

function nodeLink(n: NodeSummary): HTMLElement {
  const isExternal = n.kind === "package";
  return h("button", { class: `link node-link ${isExternal ? "external" : ""}`, onclick: () => void select(n.id, true), title: n.path ?? n.label }, n.kind === "symbol" ? n.label : (n.path ?? n.label));
}

async function transitive(id: string): Promise<void> {
  const target = els.inspector.querySelector("#transitive");
  if (!target || !state.scanId) return;
  replace(target, h("p", { class: "muted pad" }, "Loading…"));
  const [out, inc] = await Promise.all([
    get<DependencyHit[]>(`/scans/${state.scanId}/nodes/${id}/dependencies`, { direction: "outgoing", depth: 50 }),
    get<DependencyHit[]>(`/scans/${state.scanId}/nodes/${id}/dependencies`, { direction: "incoming", depth: 50 }),
  ]);
  const list = (title: string, hits: DependencyHit[]) =>
    h("section", { class: "section" }, h("h3", {}, title, h("span", { class: "count" }, String(hits.length))), hits.length ? h("ul", { class: "rel" }, hits.slice(0, 300).map((x) => h("li", {}, nodeLink(x.node), h("span", { class: "kind" }, `depth ${x.depth}`)))) : h("p", { class: "muted" }, "None."));
  replace(target, list("Depends on (transitively)", out), list("Depended on by (transitively)", inc));
}

void boot();
