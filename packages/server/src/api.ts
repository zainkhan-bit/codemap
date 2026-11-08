/**
 * Read-only API v1. Every handler delegates to an application use case; the server never
 * touches SQLite, the scanner or parsers directly.
 */
import { CodeMapError, type CodeMapApplication, type ExportFormat, type ProjectionFilters } from "@codemap/application";
import { CONFIDENCES, GRAPH_VIEWS, REFERENCE_KINDS, RESOLUTION_STATUSES, TOOL_VERSION, type Confidence, type GraphView, type ReferenceKind, type ResolutionStatus } from "@codemap/contracts";

export interface ApiResponse {
  status: number;
  body: unknown;
  /** Raw payload for exports; `body` is ignored when set. */
  raw?: { contentType: string; data: string | Uint8Array; filename: string };
}

export class BadRequest extends Error {}

type Handler = (app: CodeMapApplication, params: string[], q: URLSearchParams) => Promise<ApiResponse>;

const ok = (body: unknown): ApiResponse => ({ status: 200, body });

function intParam(q: URLSearchParams, name: string, def: number, min: number, max: number): number {
  const v = q.get(name);
  if (v === null) return def;
  const n = Number(v);
  if (!Number.isInteger(n) || n < min || n > max) throw new BadRequest(`"${name}" must be an integer between ${min} and ${max}`);
  return n;
}

function boolParam(q: URLSearchParams, name: string): boolean | undefined {
  const v = q.get(name);
  if (v === null) return undefined;
  if (v !== "true" && v !== "false") throw new BadRequest(`"${name}" must be true or false`);
  return v === "true";
}

function enumList<T extends string>(q: URLSearchParams, name: string, allowed: readonly T[]): T[] | undefined {
  const v = q.get(name);
  if (v === null || v === "") return undefined;
  const items = v.split(",");
  for (const i of items) if (!(allowed as readonly string[]).includes(i)) throw new BadRequest(`unknown ${name} "${i}"`);
  return items as T[];
}

function pathParam(q: URLSearchParams): string | undefined {
  const v = q.get("path");
  if (v === null || v === "") return undefined;
  if (v.length > 1024 || v.includes("\\") || v.split("/").some((s) => s === ".." || s === ".")) throw new BadRequest('"path" must be a repository-relative POSIX path');
  return v.replace(/^\/+|\/+$/g, "");
}

function filters(q: URLSearchParams): ProjectionFilters {
  const minConfidence = enumList<Confidence>(q, "minConfidence", CONFIDENCES)?.[0];
  const includeExternal = boolParam(q, "includeExternal");
  const excludeTypeOnly = boolParam(q, "excludeTypeOnly");
  const pathPrefix = pathParam(q);
  return {
    ...(minConfidence ? { minConfidence } : {}),
    ...(includeExternal !== undefined ? { includeExternal } : {}),
    ...(excludeTypeOnly !== undefined ? { excludeTypeOnly } : {}),
    ...(pathPrefix ? { pathPrefix } : {}),
  };
}

const ID = "([A-Za-z0-9_]{1,80})";

const ROUTES: [RegExp, Handler][] = [
  [/^\/api\/v1\/health$/, async () => ok({ status: "ok", version: TOOL_VERSION, readOnly: true })],
  [
    /^\/api\/v1\/projects$/,
    async (app) => ok((await app.listProjects()).map(({ project, latest }) => ({ projectId: project.projectId, displayName: project.displayName, lastSeenAt: project.lastSeenAt, latestScanId: latest?.scanId ?? null, latestCompletedAt: latest?.completedAt ?? null }))),
  ],
  [new RegExp(`^/api/v1/projects/${ID}/scans$`), async (app, [projectId]) => ok(await app.listScans(projectId!))],
  [new RegExp(`^/api/v1/scans/${ID}/summary$`), async (app, [scanId]) => ok(await app.getProjectSummary({ scanId: scanId! }))],
  [
    new RegExp(`^/api/v1/scans/${ID}/graph$`),
    async (app, [scanId], q) => {
      const view = (q.get("view") ?? "file_dependency_view") as GraphView;
      if (!(GRAPH_VIEWS as readonly string[]).includes(view)) throw new BadRequest(`unknown view "${view}"`);
      return ok(await app.getGraphView(scanId!, view, filters(q), intParam(q, "limit", 2000, 1, 20000)));
    },
  ],
  [new RegExp(`^/api/v1/scans/${ID}/nodes/${ID}$`), async (app, [scanId, nodeId]) => ok(await app.getNodeDetailsById(scanId!, nodeId!))],
  [
    new RegExp(`^/api/v1/scans/${ID}/nodes/${ID}/dependencies$`),
    async (app, [scanId, nodeId], q) => {
      const direction = q.get("direction") ?? "outgoing";
      if (direction !== "outgoing" && direction !== "incoming") throw new BadRequest('"direction" must be outgoing or incoming');
      return ok(await app.getNodeDependenciesById(scanId!, nodeId!, { direction, maxDepth: intParam(q, "depth", 1, 1, 50) }));
    },
  ],
  [
    new RegExp(`^/api/v1/scans/${ID}/references$`),
    async (app, [scanId], q) => {
      const status = enumList<ResolutionStatus>(q, "status", RESOLUTION_STATUSES);
      const kind = enumList<ReferenceKind>(q, "kind", REFERENCE_KINDS);
      const pathPrefix = pathParam(q);
      return ok(await app.listReferences(scanId!, { ...(status ? { status } : {}), ...(kind ? { kind } : {}), ...(pathPrefix ? { pathPrefix } : {}), limit: intParam(q, "limit", 200, 1, 5000), offset: intParam(q, "offset", 0, 0, 10_000_000) }));
    },
  ],
  [new RegExp(`^/api/v1/scans/${ID}/diagnostics$`), async (app, [scanId], q) => ok(await app.listDiagnostics(scanId!, enumList(q, "severity", ["info", "warning", "error"] as const)))],
  [
    new RegExp(`^/api/v1/scans/${ID}/export$`),
    async (app, [scanId], q) => {
      const format = (q.get("format") ?? "svg") as ExportFormat;
      const types: Record<string, string> = { json: "application/json; charset=utf-8", svg: "image/svg+xml", mermaid: "text/plain; charset=utf-8", png: "image/png" };
      if (!types[format]) throw new BadRequest(`unsupported format "${format}"`);
      const view = q.get("view") as GraphView | null;
      if (view && !(GRAPH_VIEWS as readonly string[]).includes(view)) throw new BadRequest(`unknown view "${view}"`);
      const force = boolParam(q, "force");
      const { content } = await app.exportGraph({ scanId: scanId! }, format, { ...filters(q), ...(view ? { view } : {}), ...(force ? { force } : {}) });
      const ext = format === "mermaid" ? "mmd" : format;
      return { status: 200, body: null, raw: { contentType: types[format]!, data: content, filename: `codemap-${scanId}.${ext}` } };
    },
  ],
];

export async function handleApi(app: CodeMapApplication, pathname: string, q: URLSearchParams): Promise<ApiResponse> {
  for (const [re, handler] of ROUTES) {
    const m = re.exec(pathname);
    if (!m) continue;
    try {
      return await handler(app, m.slice(1), q);
    } catch (err) {
      if (err instanceof BadRequest) return { status: 400, body: { error: { kind: "invalid_input", message: err.message } } };
      if (err instanceof CodeMapError) {
        const status = err.kind === "not_found" ? 404 : err.kind === "invalid_input" ? 400 : 500;
        return { status, body: { error: { kind: err.kind, message: status === 500 ? "internal error" : err.message } } };
      }
      return { status: 500, body: { error: { kind: "internal", message: "internal error" } } };
    }
  }
  return { status: 404, body: { error: { kind: "not_found", message: "unknown API route" } } };
}
