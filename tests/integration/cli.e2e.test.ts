/**
 * End-to-end tests against the built CLI and the fixture repositories (blueprint §17.2–17.3).
 * Run `pnpm build` first (`pnpm test` does this).
 */
import { cpSync, existsSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { validateGraphSchema, type CodeMapGraph } from "@codemap/contracts";
import { validateGraphInvariants } from "@codemap/graph-engine";
import { edgeStrings, refStrings } from "../helpers/graph.js";
import { CLI, FIXTURES, newDataDir, runCli } from "../helpers/cli.js";

let dataDir: string;
let work: string;

beforeAll(() => {
  if (!existsSync(CLI)) throw new Error("CLI is not built; run `pnpm build` first");
  dataDir = newDataDir();
  work = mkdtempSync(path.join(os.tmpdir(), "codemap-e2e-work-"));
});
afterAll(() => {
  rmSync(dataDir, { recursive: true, force: true });
  rmSync(work, { recursive: true, force: true });
});

function scanAndExport(fixture: string): CodeMapGraph {
  const dir = path.join(FIXTURES, fixture);
  const scan = runCli(["scan", dir, "--json"], { dataDir });
  expect(scan.code, scan.stderr).toBe(0);
  const out = path.join(work, `${fixture}.json`);
  const exp = runCli(["export", "--format", "json", "--output", out, "--scan", scan.json<{ scanId: string }>().scanId], { dataDir });
  expect(exp.code, exp.stderr).toBe(0);
  const graph = JSON.parse(readFileSync(out, "utf8")) as CodeMapGraph;
  expect(validateGraphSchema(graph).errors).toEqual([]);
  expect(validateGraphInvariants(graph)).toEqual([]);
  return graph;
}

describe("fixtures produce the expected graphs", () => {
  it("fixture-js-esm: ESM imports, re-exports, inheritance, calls and cycles", () => {
    const g = scanAndExport("fixture-js-esm");
    expect(edgeStrings(g, ["imports"])).toEqual([
      "imports src/a.js -> src/b.js",
      "imports src/b.js -> src/a.js",
      "imports src/index.js -> pkg:lodash",
      "imports src/index.js -> pkg:node:fs",
      "imports src/index.js -> src/a.js",
      "imports src/index.js -> src/b.js",
      "imports src/index.js -> src/models/user.js",
      "imports src/index.js -> src/self.js",
      "imports src/models/user.js -> src/models/base.js",
      "imports src/self.js -> src/self.js",
    ]);
    expect(edgeStrings(g, ["calls", "extends"])).toEqual([
      "calls src/a.js:a -> src/b.js:b",
      "calls src/b.js:helper -> src/a.js:a",
      "calls src/index.js:main -> src/a.js:a",
      "calls src/models/base.js:Base.save -> src/models/base.js:Base.validate",
      "calls src/models/user.js:createUser -> src/models/user.js:User",
      "extends src/models/user.js:User -> src/models/base.js:Base",
    ]);
    expect(edgeStrings(g, ["exports"])).toContain("exports src/index.js -> src/models/user.js:User");
    expect(refStrings(g, "call")).toContain("unresolved save");
    expect(g.metrics["analysis.cycles"]).toBe(2);
  });

  it("fixture-ts-paths: tsconfig paths, type-only imports, .js→.ts and implements", () => {
    const g = scanAndExport("fixture-ts-paths");
    expect(edgeStrings(g, ["imports", "implements"])).toEqual([
      "implements src/services/service.ts:Service -> src/services/service.ts:Runner",
      "imports src/main.ts -> src/services/service.ts",
      "imports src/main.ts -> src/types.ts",
      "imports src/main.ts -> src/util.ts",
      "imports src/services/service.ts -> src/types.ts",
      "imports src/services/service.ts -> src/util.ts",
    ]);
    const typeOnly = g.edges.find((e) => e.kind === "imports" && e.resolutionMethod === "tsconfig_paths" && e.attributes.typeOnly === true);
    expect(typeOnly).toBeDefined();
  });

  it("fixture-python: src layout, relative imports, submodules, stdlib and declared deps", () => {
    const g = scanAndExport("fixture-python");
    expect(edgeStrings(g, ["imports"])).toEqual(
      expect.arrayContaining([
        "imports src/pyfix/__init__.py -> src/pyfix/core.py",
        "imports src/pyfix/cli.py -> pkg:importlib",
        "imports src/pyfix/core.py -> pkg:os",
        "imports src/pyfix/core.py -> pkg:requests",
        "imports src/pyfix/core.py -> pkg:yaml",
        "imports src/pyfix/core.py -> src/pyfix/util.py",
        "imports tests/test_core.py -> src/pyfix/core.py",
      ]),
    );
    expect(edgeStrings(g, ["calls", "extends"])).toEqual(
      expect.arrayContaining(["calls src/pyfix/core.py:Engine.run -> src/pyfix/core.py:Engine.step", "calls src/pyfix/core.py:Engine.run -> src/pyfix/util.py:helper", "extends src/pyfix/core.py:Engine -> src/pyfix/base.py:Base"]),
    );
    expect(refStrings(g, "import")).toContain("unresolved pyfix.missing");
    expect(g.nodes.find((n) => n.kind === "module")?.name).toBe("pyfix");
  });

  it("fixture-monorepo: workspace packages via exports, external packages kept external", () => {
    const g = scanAndExport("fixture-monorepo");
    expect(edgeStrings(g, ["imports"])).toEqual(["imports packages/app/src/index.tsx -> packages/core/src/index.ts", "imports packages/app/src/index.tsx -> packages/core/src/math.ts", "imports packages/app/src/index.tsx -> pkg:react"]);
    expect(g.nodes.filter((n) => n.kind === "module").map((n) => n.name).sort()).toEqual(["@mono/app", "@mono/core", "mono-root"]);
    const out = path.join(work, "modules.svg");
    expect(runCli(["export", "--format", "svg", "--view", "module_view", "-o", out, "--project", g.project.id], { dataDir }).code).toBe(0);
    expect(readFileSync(out, "utf8")).toContain("@mono/app");
  });

  it("fixture-unresolved: missing, undeclared, ambiguous, dynamic and asset references stay distinguishable", () => {
    const g = scanAndExport("fixture-unresolved");
    expect(refStrings(g, "import")).toEqual(["ambiguous ./dup", "ignored ./styles.css", "unresolved ./missing", "unresolved import(name)", "unresolved not-declared", "unresolved require(name)"]);
    expect(g.edges.filter((e) => e.kind === "imports")).toEqual([]);
    expect(g.diagnostics.map((d) => d.code).sort()).toEqual(["RESOLVE001", "RESOLVE001", "RESOLVE001", "RESOLVE001", "RESOLVE002"]);
  });

  it("fixture-invalid-syntax: recovers declarations and reports PARSE001", () => {
    const g = scanAndExport("fixture-invalid-syntax");
    expect(g.nodes.filter((n) => n.kind === "symbol").map((n) => `${n.path}:${n.qualifiedName}`)).toEqual(expect.arrayContaining(["broken.ts:ok", "broken.py:fine", "broken.py:AfterError.method"]));
    expect(g.diagnostics.filter((d) => d.code === "PARSE001").map((d) => d.location?.path).sort()).toEqual(["broken.py", "broken.ts"]);
    expect(g.nodes.filter((n) => n.kind === "file").every((n) => n.attributes.syntaxStatus === "recovered")).toBe(true);
  });

  it("fixture-unicode: exact byte/column positions after non-ASCII text and Unicode file names", () => {
    const g = scanAndExport("fixture-unicode");
    const naive = g.nodes.find((n) => n.name === "naïve")!;
    const bytes = readFileSync(path.join(FIXTURES, "fixture-unicode", "unicode.ts"));
    expect(bytes.subarray(naive.location!.startByte, naive.location!.endByte).toString("utf8")).toMatch(/^function naïve\(\)/);
    expect([naive.location!.startLine, naive.location!.startColumn]).toEqual([3, 8]);
    expect(g.nodes.some((n) => n.path === "módulo.py")).toBe(true);
  });

  it("graph IDs are identical across independent scans and data directories", () => {
    const a = scanAndExport("fixture-js-esm");
    const other = newDataDir();
    try {
      const scan = runCli(["scan", path.join(FIXTURES, "fixture-js-esm"), "--json"], { dataDir: other });
      const out = path.join(work, "again.json");
      runCli(["export", "--format", "json", "-o", out, "--scan", scan.json<{ scanId: string }>().scanId], { dataDir: other });
      const b = JSON.parse(readFileSync(out, "utf8")) as CodeMapGraph;
      expect(b.nodes.map((n) => n.id)).toEqual(a.nodes.map((n) => n.id));
      expect(b.edges.map((e) => e.id)).toEqual(a.edges.map((e) => e.id));
      expect(b.references.map((r) => r.id)).toEqual(a.references.map((r) => r.id));
    } finally {
      rmSync(other, { recursive: true, force: true });
    }
  });
});

describe("CLI behaviour", () => {
  it("analyze --cycles, summary, deps and projects work from the project directory", () => {
    const dir = path.join(FIXTURES, "fixture-js-esm");
    runCli(["scan", dir], { dataDir });
    const cycles = runCli(["analyze", "--cycles", "--json"], { dataDir, cwd: dir }).json<{ cycles: { files: string[]; selfLoop: boolean }[] }>();
    expect(cycles.cycles.map((c) => c.files)).toEqual([["src/a.js", "src/b.js"], ["src/self.js"]]);
    const human = runCli(["analyze", "--cycles"], { dataDir, cwd: dir });
    expect(human.stdout).toContain("src/b.js → src/a.js → src/b.js");
    const summary = runCli(["summary", "--json"], { dataDir, cwd: path.join(dir, "src") }).json<{ topFanIn: { path: string; fanIn: number }[] }>();
    expect(summary.topFanIn[0]!.fanIn).toBe(2);
    expect(["src/a.js", "src/b.js"]).toContain(summary.topFanIn[0]!.path);
    const deps = runCli(["deps", "src/index.js", "--json"], { dataDir, cwd: dir }).json<{ dependencies: { path: string }[] }>();
    expect(deps.dependencies.map((d) => d.path)).toContain("src/models/user.js");
    expect(runCli(["projects", "--json"], { dataDir }).json<unknown[]>().length).toBeGreaterThan(0);
  });

  it("reuses parse artifacts, reparses only changed files and drops stale edges", () => {
    const copy = path.join(work, "copy");
    cpSync(path.join(FIXTURES, "fixture-js-esm"), copy, { recursive: true });
    const fresh = newDataDir();
    try {
      const first = runCli(["scan", copy, "--json"], { dataDir: fresh }).json<{ summary: { parsedCount: number; reusedCount: number } }>();
      expect([first.summary.parsedCount, first.summary.reusedCount]).toEqual([6, 0]);
      const second = runCli(["scan", copy, "--json"], { dataDir: fresh }).json<{ summary: { parsedCount: number; reusedCount: number } }>();
      expect([second.summary.parsedCount, second.summary.reusedCount]).toEqual([0, 6]);
      writeFileSync(path.join(copy, "src", "a.js"), `${readFileSync(path.join(copy, "src", "a.js"), "utf8")}\n// edited\n`);
      renameSync(path.join(copy, "src", "b.js"), path.join(copy, "src", "renamed.js"));
      const third = runCli(["scan", copy, "--json"], { dataDir: fresh }).json<{ scanId: string; summary: { parsedCount: number; reusedCount: number; cycleCount: number } }>();
      expect([third.summary.parsedCount, third.summary.reusedCount, third.summary.cycleCount]).toEqual([1, 5, 1]);
      const out = path.join(work, "copy.json");
      runCli(["export", "--format", "json", "-o", out, "--scan", third.scanId], { dataDir: fresh });
      const g = JSON.parse(readFileSync(out, "utf8")) as CodeMapGraph;
      expect(edgeStrings(g, ["imports"]).some((e) => e.includes("src/b.js"))).toBe(false);
      expect(refStrings(g, "import")).toContain("unresolved ./b.js");
    } finally {
      rmSync(fresh, { recursive: true, force: true });
    }
  });

  it("uses stable exit codes", () => {
    expect(runCli(["--version"], { dataDir }).stdout.trim()).toBe("0.1.0");
    expect(runCli(["--help"], { dataDir }).code).toBe(0);
    expect(runCli(["scan", path.join(work, "does-not-exist")], { dataDir }).code).toBe(3);
    expect(runCli(["frobnicate"], { dataDir }).code).toBe(2);
    expect(runCli(["scan", "--bogus-flag"], { dataDir }).code).toBe(2);
    expect(runCli(["export", "--format", "png", "--project", "x"], { dataDir }).code).toBe(2);
    expect(runCli(["summary", "--project", "prj_nope"], { dataDir }).code).toBe(2);
    const badCfg = path.join(work, "badcfg");
    cpSync(path.join(FIXTURES, "fixture-ts-paths"), badCfg, { recursive: true });
    writeFileSync(path.join(badCfg, "codemap.config.json"), '{ "maxFiles": "many" }');
    expect(runCli(["scan", badCfg], { dataDir }).code).toBe(2);
  });

  it("exports PNG through the optional rasterizer", () => {
    const dir = path.join(FIXTURES, "fixture-ts-paths");
    runCli(["scan", dir], { dataDir });
    const out = path.join(work, "map.png");
    const r = runCli(["export", "--format", "png", "-o", out], { dataDir, cwd: dir });
    expect(r.code, r.stderr).toBe(0);
    expect([...readFileSync(out).subarray(0, 4)]).toEqual([0x89, 0x50, 0x4e, 0x47]);
    expect(runCli(["export", "--format", "png"], { dataDir, cwd: dir }).stderr).toMatch(/--output/);
  });

  it("emits machine-readable JSON with progress kept off stdout", () => {
    const r = runCli(["scan", path.join(FIXTURES, "fixture-unicode"), "--json"], { dataDir });
    expect(() => r.json()).not.toThrow();
    expect(r.json<{ status: string }>().status).toBe("completed");
  });

  it("doctor reports every check healthy", () => {
    const r = runCli(["doctor", "--json"], { dataDir });
    const body = r.json<{ ok: boolean; checks: { name: string; ok: boolean }[] }>();
    expect(body.checks.filter((c) => !c.ok)).toEqual([]);
    expect(r.code).toBe(0);
  });

  it("cache clear and data location", () => {
    expect(runCli(["data", "location", "--json"], { dataDir }).json<{ dataDir: string }>().dataDir).toBe(path.resolve(dataDir));
    const cleared = runCli(["cache", "clear", "--json"], { dataDir }).json<{ removedArtifacts: number }>();
    expect(cleared.removedArtifacts).toBeGreaterThan(0);
  });
});
