/**
 * Local server tests: API behaviour against a real fixture scan, and the security controls from
 * blueprint §13 (loopback binding, bearer token, Host/Origin checks, headers, read-only, static
 * allowlist, no token leakage).
 */
import { request } from "node:http";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { CodeMapApplication } from "@codemap/application";
import type { GraphViewResult, NodeDetailsView, ProjectSummary, ReferencePage } from "@codemap/contracts";
import { CONTENT_SECURITY_POLICY, startServer, type RunningServer } from "./index.js";

const repo = fileURLToPath(new URL("../../../", import.meta.url));
const assetsDir = path.join(repo, "apps", "dashboard", "dist");
let dataDir: string;
let app: CodeMapApplication;
let server: RunningServer;
let scanId: string;

interface Res {
  status: number;
  headers: Record<string, string | string[] | undefined>;
  body: string;
}

/** Raw HTTP so tests can forge Host/Origin headers that fetch() would refuse to set. */
function raw(pathname: string, opts: { method?: string; headers?: Record<string, string>; auth?: boolean } = {}): Promise<Res> {
  const headers: Record<string, string> = { Host: `127.0.0.1:${server.port}`, ...(opts.auth === false ? {} : { Authorization: `Bearer ${server.token}` }), ...opts.headers };
  return new Promise((resolve, reject) => {
    const req = request({ host: "127.0.0.1", port: server.port, path: pathname, method: opts.method ?? "GET", headers }, (res) => {
      let body = "";
      res.setEncoding("utf8");
      res.on("data", (c) => (body += c));
      res.on("end", () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body }));
    });
    req.on("error", reject);
    req.end();
  });
}

async function api<T>(pathname: string): Promise<T> {
  const r = await raw(`/api/v1${pathname}`);
  expect(r.status, r.body).toBe(200);
  return JSON.parse(r.body) as T;
}

beforeAll(async () => {
  dataDir = mkdtempSync(path.join(os.tmpdir(), "codemap-server-"));
  app = await CodeMapApplication.open({ dataDir });
  scanId = (await app.scanProject({ path: path.join(repo, "tests", "fixtures", "fixture-js-esm") })).scan.scanId;
  server = await startServer({ app, assetsDir });
});

afterAll(async () => {
  await server?.close();
  await app?.close();
  rmSync(dataDir, { recursive: true, force: true });
});

describe("binding and launch URL", () => {
  it("listens on 127.0.0.1 with an ephemeral port and puts the token only in the fragment", () => {
    expect(server.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/$/);
    expect(server.port).toBeGreaterThan(0);
    expect(server.launchUrl).toBe(`${server.url}#token=${server.token}`);
    expect(server.token).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(server.url).not.toContain(server.token);
  });

  it("generates a different token per server", async () => {
    const other = await startServer({ app, assetsDir });
    expect(other.token).not.toBe(server.token);
    await other.close();
  });
});

describe("authentication", () => {
  it("rejects API calls without or with a wrong bearer token", async () => {
    expect((await raw("/api/v1/health", { auth: false })).status).toBe(401);
    expect((await raw("/api/v1/health", { auth: false, headers: { Authorization: "Bearer wrong-token-wrong-token" } })).status).toBe(401);
    expect((await raw("/api/v1/health", { auth: false, headers: { Authorization: `Basic ${server.token}` } })).status).toBe(401);
    expect((await raw("/api/v1/health")).status).toBe(200);
  });

  it("never accepts the token in the query string", async () => {
    const r = await raw(`/api/v1/health?token=${server.token}`, { auth: false });
    expect(r.status).toBe(400);
  });

  it("serves the static shell without a token (it contains no project data)", async () => {
    const r = await raw("/", { auth: false });
    expect(r.status).toBe(200);
    expect(r.headers["content-type"]).toMatch(/text\/html/);
    expect(r.body).not.toContain("fixture-js-esm");
  });
});

describe("request origin checks", () => {
  it("rejects foreign Host headers (DNS rebinding)", async () => {
    expect((await raw("/api/v1/health", { headers: { Host: "evil.example" } })).status).toBe(421);
    expect((await raw("/", { headers: { Host: `evil.example:${server.port}` } })).status).toBe(421);
    expect((await raw("/api/v1/health", { headers: { Host: `localhost:${server.port}` } })).status).toBe(200);
  });

  it("rejects cross-origin and cross-site requests", async () => {
    expect((await raw("/api/v1/health", { headers: { Origin: "http://evil.example" } })).status).toBe(403);
    expect((await raw("/api/v1/health", { headers: { Origin: `https://127.0.0.1:${server.port}` } })).status).toBe(403);
    expect((await raw("/api/v1/health", { headers: { "Sec-Fetch-Site": "cross-site" } })).status).toBe(403);
    expect((await raw("/api/v1/health", { headers: { Origin: `http://127.0.0.1:${server.port}`, "Sec-Fetch-Site": "same-origin" } })).status).toBe(200);
  });
});

describe("response hardening", () => {
  it("sends a strict CSP and hardening headers, and never CORS headers", async () => {
    for (const p of ["/", "/assets/app.js", "/api/v1/health", "/api/v1/nope", "/missing"]) {
      const r = await raw(p, { headers: { Origin: `http://127.0.0.1:${server.port}` } });
      expect(r.headers["content-security-policy"], p).toBe(CONTENT_SECURITY_POLICY);
      expect(r.headers["referrer-policy"]).toBe("no-referrer");
      expect(r.headers["x-content-type-options"]).toBe("nosniff");
      expect(r.headers["x-frame-options"]).toBe("DENY");
      expect(Object.keys(r.headers).some((h) => h.startsWith("access-control-"))).toBe(false);
    }
    expect(CONTENT_SECURITY_POLICY).not.toMatch(/unsafe-inline|unsafe-eval|\*/);
    expect((await raw("/api/v1/health")).headers["cache-control"]).toBe("no-store");
  });

  it("is read-only", async () => {
    for (const method of ["POST", "PUT", "PATCH", "DELETE"]) {
      const r = await raw("/api/v1/projects", { method });
      expect(r.status, method).toBe(405);
      expect(r.headers.allow).toBe("GET, HEAD");
    }
  });

  it("serves only the allowlisted assets (no traversal, no directory access)", async () => {
    expect((await raw("/assets/app.js", { auth: false })).status).toBe(200);
    for (const p of ["/index.html", "/../package.json", "/%2e%2e/%2e%2e/package.json", "/assets/../../package.json", "/assets/app.js.map", "/assets/", "/dist/app.js", "/..%5c..%5cpackage.json", "/C:/Windows/win.ini"]) {
      expect((await raw(p, { auth: false })).status, p).toBe(404);
    }
  });

  it("returns errors without stack traces or internals", async () => {
    const r = await raw("/api/v1/scans/scn_does_not_exist/summary");
    expect(r.status).toBe(404);
    expect(r.body).not.toMatch(/at \w+ \(|node_modules|\\|\.ts:/);
    expect(JSON.parse(r.body).error.kind).toBe("not_found");
  });

  it("validates parameters", async () => {
    for (const p of [`/scans/${scanId}/graph?view=everything`, `/scans/${scanId}/graph?limit=0`, `/scans/${scanId}/graph?path=../etc`, `/scans/${scanId}/references?status=maybe`, `/scans/${scanId}/export?format=exe`, `/scans/${scanId}/graph?includeExternal=yes`]) {
      expect((await raw(`/api/v1${p}`)).status, p).toBe(400);
    }
    expect((await raw("/api/v1/scans/has-dash/summary")).status).toBe(404);
  });

  it("never writes the token to stdout or stderr", async () => {
    const seen: string[] = [];
    const out = process.stdout.write.bind(process.stdout);
    const err = process.stderr.write.bind(process.stderr);
    process.stdout.write = ((c: string) => (seen.push(String(c)), true)) as typeof process.stdout.write;
    process.stderr.write = ((c: string) => (seen.push(String(c)), true)) as typeof process.stderr.write;
    try {
      await raw("/api/v1/health");
      await raw("/api/v1/health", { auth: false });
      await raw(`/api/v1/scans/${scanId}/export?format=svg`);
    } finally {
      process.stdout.write = out;
      process.stderr.write = err;
    }
    expect(seen.join("")).not.toContain(server.token);
  });
});

describe("API v1", () => {
  it("lists projects and completed scans", async () => {
    const projects = await api<{ projectId: string; displayName: string; latestScanId: string }[]>("/projects");
    expect(projects).toHaveLength(1);
    expect(projects[0]!.displayName).toBe("fixture-js-esm");
    expect(projects[0]!.latestScanId).toBe(scanId);
    const scans = await api<{ scanId: string; status: string }[]>(`/projects/${projects[0]!.projectId}/scans`);
    expect(scans.map((s) => [s.scanId, s.status])).toEqual([[scanId, "completed"]]);
    expect(JSON.stringify(projects)).not.toContain(repo.replace(/\\/g, "\\\\"));
  });

  it("returns the project summary", async () => {
    const s = await api<ProjectSummary>(`/scans/${scanId}/summary`);
    expect(s.cycles.map((c) => c.files)).toEqual([["src/a.js", "src/b.js"], ["src/self.js"]]);
    expect(s.scan.summary?.fileCount).toBe(6);
  });

  it("returns graph projections with cycle membership and explicit truncation", async () => {
    const g = await api<GraphViewResult>(`/scans/${scanId}/graph?view=file_dependency_view`);
    const label = (id: string) => g.nodes.find((n) => n.id === id)!.path ?? g.nodes.find((n) => n.id === id)!.name;
    expect(g.edges.map((e) => `${label(e.sourceId)}->${label(e.targetId)}`)).toContain("src/a.js->src/b.js");
    expect(g.cycleNodeIds.map(label).sort()).toEqual(["src/a.js", "src/b.js", "src/self.js"]);
    expect(g.cycleEdgeIds.map((id) => g.edges.find((e) => e.id === id)!).map((e) => `${label(e.sourceId)}->${label(e.targetId)}`).sort()).toEqual(["src/a.js->src/b.js", "src/b.js->src/a.js", "src/self.js->src/self.js"]);
    expect(g.truncated).toBe(false);
    const small = await api<GraphViewResult>(`/scans/${scanId}/graph?limit=2`);
    expect([small.nodes.length, small.truncated, small.totalNodes]).toEqual([2, true, g.totalNodes]);
    const noExternal = await api<GraphViewResult>(`/scans/${scanId}/graph?includeExternal=false`);
    expect(noExternal.nodes.some((n) => n.kind === "package")).toBe(false);
    const focused = await api<GraphViewResult>(`/scans/${scanId}/graph?path=src/models`);
    expect(focused.nodes.filter((n) => n.kind === "file").map((n) => n.path).sort()).toEqual(["src/models/base.js", "src/models/user.js"]);
  });

  it("returns node details, dependencies and references", async () => {
    const g = await api<GraphViewResult>(`/scans/${scanId}/graph`);
    const index = g.nodes.find((n) => n.path === "src/index.js")!;
    const d = await api<NodeDetailsView>(`/scans/${scanId}/nodes/${index.id}`);
    expect(d.node.path).toBe("src/index.js");
    expect(d.outgoing.filter((e) => e.edge.kind === "imports").map((e) => e.peer.label).sort()).toEqual(["lodash", "node:fs", "src/a.js", "src/b.js", "src/models/user.js", "src/self.js"]);
    expect(d.children.map((c) => c.name)).toEqual(["main"]);
    const deps = await api<{ node: { label: string }; depth: number }[]>(`/scans/${scanId}/nodes/${index.id}/dependencies?depth=5`);
    expect(deps.map((x) => x.node.label)).toContain("src/models/base.js");
    const refs = await api<ReferencePage>(`/scans/${scanId}/references?status=unresolved&kind=call`);
    expect(refs.items.map((i) => i.reference.specifier).sort()).toEqual(["save", "super"]);
    expect((await raw(`/api/v1/scans/${scanId}/nodes/sym_00000000000000000000000000000000`)).status).toBe(404);
  });

  it("exports SVG and PNG as attachments", async () => {
    const svg = await raw(`/api/v1/scans/${scanId}/export?format=svg`);
    expect(svg.headers["content-type"]).toBe("image/svg+xml");
    expect(svg.headers["content-disposition"]).toMatch(/^attachment; filename="codemap-scn_[a-z0-9_]+\.svg"$/);
    expect(svg.body.startsWith("<svg")).toBe(true);
    const png = await raw(`/api/v1/scans/${scanId}/export?format=png`);
    expect([png.status, png.headers["content-type"]]).toEqual([200, "image/png"]);
  });
});
