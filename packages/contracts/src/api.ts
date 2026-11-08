/**
 * Local read API v1 response contracts (`/api/v1/...`). Shared by the server that produces them
 * and the dashboard that consumes them; the dashboard depends on these types only.
 */
import type { GraphDiagnostic, GraphEdge, GraphNode, GraphReference, GraphView } from "./graph.js";
import type { ScanRecord } from "./store.js";

export const API_VERSION = "v1";

export interface ApiError {
  error: { kind: string; message: string };
}

export interface ApiHealth {
  status: "ok";
  version: string;
  readOnly: true;
}

export interface ApiProject {
  projectId: string;
  displayName: string;
  lastSeenAt: string;
  latestScanId: string | null;
  latestCompletedAt: string | null;
}

export interface NodeSummary {
  id: string;
  kind: GraphNode["kind"];
  name: string;
  label: string;
  path?: string;
  language?: string;
  symbolKind?: string;
}

export interface GraphViewResult {
  view: GraphView;
  nodes: GraphNode[];
  edges: GraphEdge[];
  /** Node IDs that belong to a dependency cycle (file_dependency_view only). */
  cycleNodeIds: string[];
  /** Edges whose endpoints lie in the same dependency cycle. */
  cycleEdgeIds: string[];
  totalNodes: number;
  truncated: boolean;
}

export interface EdgeWithPeer {
  edge: GraphEdge;
  peer: NodeSummary;
}

export interface NodeDetailsView {
  node: GraphNode;
  parent?: NodeSummary;
  children: NodeSummary[];
  outgoing: EdgeWithPeer[];
  incoming: EdgeWithPeer[];
  /** References made from this node (and, for files, from symbols declared in it). */
  references: GraphReference[];
  diagnostics: GraphDiagnostic[];
}

export interface DependencyHit {
  node: NodeSummary;
  depth: number;
  via: string;
}

export interface ReferenceItem {
  reference: GraphReference;
  source: NodeSummary;
  target?: NodeSummary;
}

export interface ReferencePage {
  total: number;
  offset: number;
  items: ReferenceItem[];
}

export interface CycleReport {
  index: number;
  files: string[];
  path: string[];
  selfLoop: boolean;
}

export interface ProjectSummary {
  project: { id: string; displayName: string };
  scan: ScanRecord;
  metrics: Record<string, number>;
  cycles: CycleReport[];
  topFanIn: { path: string; fanIn: number }[];
  topFanOut: { path: string; fanOut: number }[];
  isolatedFiles: string[];
  unresolved: { kind: string; count: number }[];
}
