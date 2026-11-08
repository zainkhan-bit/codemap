import { describe, expect, it } from "vitest";
import { isNormalizedRelativePath, parseCodeMapConfig, validateGraphSchema } from "./validation.js";
import type { CodeMapGraph } from "./graph.js";

const loc = { path: "src/a.ts", startByte: 0, endByte: 10, startLine: 1, startColumn: 1, endLine: 1, endColumn: 11 };

function graph(): CodeMapGraph {
  return {
    schemaVersion: "1.0",
    project: { id: "prj_1", displayName: "demo", rootLabel: "demo" },
    scan: { id: "scn_1", toolVersion: "0.1.0", startedAt: "t", completedAt: "t", configurationHash: "c", parserSetHash: "p" },
    nodes: [
      { id: "prj_1", kind: "project", name: "demo", attributes: {} },
      { id: "fil_1", kind: "file", name: "a.ts", path: "src/a.ts", attributes: {} },
      { id: "sym_1", kind: "symbol", name: "f", symbolKind: "function", path: "src/a.ts", location: loc, attributes: {} },
    ],
    edges: [{ id: "edg_1", kind: "contains", sourceId: "fil_1", targetId: "sym_1", confidence: "high", evidenceReferenceIds: [], attributes: {} }],
    references: [{ id: "ref_1", kind: "import", sourceNodeId: "fil_1", sourceLocation: loc, rawText: "import x", status: "unresolved", attributes: {} }],
    diagnostics: [],
    metrics: { "nodes.total": 3 },
  };
}

describe("validateGraphSchema", () => {
  it("accepts a valid graph and survives a JSON round-trip", () => {
    const g = graph();
    expect(validateGraphSchema(g).ok).toBe(true);
    const round = JSON.parse(JSON.stringify(g));
    expect(validateGraphSchema(round).ok).toBe(true);
    expect(round).toEqual(g);
  });

  it("rejects unknown node, edge and reference kinds", () => {
    const g = graph() as unknown as { nodes: { kind: string }[]; edges: { kind: string }[]; references: { kind: string }[] };
    g.nodes[1]!.kind = "widget";
    g.edges[0]!.kind = "depends_on";
    g.references[0]!.kind = "magic";
    const r = validateGraphSchema(g);
    expect(r.ok).toBe(false);
    expect(r.errors.join("\n")).toMatch(/unknown node kind "widget"/);
    expect(r.errors.join("\n")).toMatch(/unknown edge kind "depends_on"/);
    expect(r.errors.join("\n")).toMatch(/unknown reference kind "magic"/);
  });

  it("rejects an unsupported schema version", () => {
    expect(validateGraphSchema({ ...graph(), schemaVersion: "2.0" }).errors[0]).toMatch(/unsupported schemaVersion/);
  });

  it("rejects absolute and non-normalized paths and inverted spans", () => {
    const g = graph();
    g.nodes[1]!.path = "C:\\repo\\src\\a.ts";
    g.nodes[2]!.location = { ...loc, startByte: 10, endByte: 2 };
    const r = validateGraphSchema(g);
    expect(r.ok).toBe(false);
    expect(r.errors.some((e) => e.includes("normalized relative POSIX path"))).toBe(true);
    expect(r.errors.some((e) => e.includes("endByte < startByte"))).toBe(true);
  });

  it("requires symbolKind on symbol nodes", () => {
    const g = graph();
    delete g.nodes[2]!.symbolKind;
    expect(validateGraphSchema(g).errors.join()).toMatch(/symbol nodes require symbolKind/);
  });
});

describe("isNormalizedRelativePath", () => {
  it.each([
    ["src/a.ts", true],
    ["", true],
    ["módulo.py", true],
    ["/etc/passwd", false],
    ["../x", false],
    ["a/./b", false],
    ["a\\b", false],
    ["C:/x", false],
    ["a//b", false],
    ["dir/", false],
  ])("%s → %s", (p, expected) => expect(isNormalizedRelativePath(p)).toBe(expected));
});

describe("parseCodeMapConfig", () => {
  it("fills defaults for an empty object", () => {
    const r = parseCodeMapConfig({});
    expect(r.ok).toBe(true);
    expect(r.value!.maxFiles).toBe(50_000);
    expect(r.value!.languages).toEqual(["javascript", "typescript", "python"]);
  });

  it("warns about unknown keys instead of silently accepting them", () => {
    const r = parseCodeMapConfig({ version: 1, colour: "blue", analysis: { cycles: false, magic: true } });
    expect(r.ok).toBe(true);
    expect(r.warnings).toEqual(['unknown configuration key "colour" ignored', 'unknown configuration key "analysis.magic" ignored']);
    expect(r.value!.analysis.cycles).toBe(false);
  });

  it("rejects invalid values", () => {
    const r = parseCodeMapConfig({ version: 2, maxFiles: -1, languages: ["cobol"], concurrency: 999, include: "src" });
    expect(r.ok).toBe(false);
    expect(r.errors).toHaveLength(5);
  });
});
