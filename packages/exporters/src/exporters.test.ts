import { describe, expect, it } from "vitest";
import type { CodeMapGraph, GraphNode } from "@codemap/contracts";
import { ExportError, exportJson, exportMermaid, exportPng, exportSvg, layeredLayout } from "./index.js";

function file(id: string, p: string): GraphNode {
  return { id, kind: "file", name: p, path: p, language: "typescript", attributes: {} };
}

function graph(): CodeMapGraph {
  const loc = { path: "a.ts", startByte: 0, endByte: 1, startLine: 1, startColumn: 1, endLine: 1, endColumn: 2 };
  return {
    schemaVersion: "1.0",
    project: { id: "prj", displayName: "demo<&>", rootLabel: "demo" },
    scan: { id: "s", toolVersion: "0.1.0", startedAt: "t", completedAt: "t", configurationHash: "c", parserSetHash: "p" },
    nodes: [{ id: "prj", kind: "project", name: "demo", attributes: {} }, file("a", "a.ts"), file("b", "<script>alert(1)</script>.ts"), file("c", "c.ts")],
    edges: [
      { id: "e1", kind: "imports", sourceId: "a", targetId: "b", confidence: "high", evidenceReferenceIds: ["r"], attributes: {} },
      { id: "e2", kind: "imports", sourceId: "b", targetId: "a", confidence: "high", evidenceReferenceIds: ["r"], attributes: {} },
      { id: "e3", kind: "imports", sourceId: "a", targetId: "c", confidence: "medium", evidenceReferenceIds: ["r"], attributes: { typeOnly: true } },
    ],
    references: [{ id: "r", kind: "import", sourceNodeId: "a", sourceLocation: loc, rawText: "import", status: "resolved_internal", targetNodeId: "b", confidence: "high", attributes: {} }],
    diagnostics: [],
    metrics: {},
  };
}

describe("exporters", () => {
  it("JSON export validates and is stable", () => {
    expect(exportJson(graph())).toBe(exportJson(graph()));
    const bad = graph();
    bad.edges[0]!.targetId = "missing";
    expect(() => exportJson(bad)).toThrow(ExportError);
  });

  it("SVG export is deterministic, escapes data and marks cycle edges", () => {
    const svg = exportSvg(graph());
    expect(svg).toBe(exportSvg(graph()));
    expect(svg.startsWith("<svg")).toBe(true);
    expect(svg).not.toContain("<script>");
    expect(svg).toContain("&lt;script&gt;");
    expect(svg).toContain("demo&lt;&amp;&gt;");
    expect((svg.match(/arrow-cycle\)/g) ?? []).length).toBe(2);
    expect(svg).toContain('stroke-dasharray="4 3"');
    // Balanced tags (a cheap well-formedness check without an XML dependency).
    const opens = (svg.match(/<g[ >]/g) ?? []).length;
    expect((svg.match(/<\/g>/g) ?? []).length).toBe(opens);
  });

  it("refuses oversized diagrams unless forced", () => {
    expect(() => exportSvg(graph(), { maxNodes: 1 })).toThrow(/narrow it/);
    expect(exportSvg(graph(), { maxNodes: 1, force: true })).toContain("<svg");
  });

  it("Mermaid export emits nodes, dotted medium/type-only edges and cycle styling", () => {
    const m = exportMermaid(graph());
    expect(m).toContain("flowchart LR");
    expect(m).toContain("-.->");
    expect(m).toMatch(/linkStyle \d+,\d+ stroke:#d93025/);
    expect(m).not.toContain("<script>");
  });

  it("PNG fails clearly instead of emitting a blank image", () => {
    expect(() => exportPng()).toThrow(/rasterizer-png.*use --format svg/);
  });

  it("layered layout breaks cycles and places every node", () => {
    const l = layeredLayout(
      [
        { id: "a", label: "a" },
        { id: "b", label: "b" },
        { id: "c", label: "c" },
      ],
      [
        { id: "1", source: "a", target: "b" },
        { id: "2", source: "b", target: "c" },
        { id: "3", source: "c", target: "a" },
      ],
    );
    expect(l.nodes).toHaveLength(3);
    expect(l.edges.filter((e) => e.reversed)).toHaveLength(1);
    expect(new Set(l.nodes.map((n) => n.layer)).size).toBe(3);
  });
});

describe("layout routing", () => {
  it("routes long edges through waypoints instead of through intermediate nodes", () => {
    // a → b → c and a → c: the a→c edge spans two layers and must bend around b.
    const l = layeredLayout(
      [
        { id: "a", label: "a" },
        { id: "b", label: "b" },
        { id: "c", label: "c" },
      ],
      [
        { id: "1", source: "a", target: "b" },
        { id: "2", source: "b", target: "c" },
        { id: "3", source: "a", target: "c" },
      ],
    );
    const long = l.edges.find((e) => e.id === "3")!;
    expect(long.points).toHaveLength(3);
    const b = l.nodes.find((n) => n.id === "b")!;
    const mid = long.points[1]!;
    expect(mid.x < b.x || mid.x > b.x + b.width).toBe(true);
  });

  it("draws self-loops and separates 2-cycle edges", () => {
    const l = layeredLayout(
      [
        { id: "a", label: "a" },
        { id: "b", label: "b" },
      ],
      [
        { id: "1", source: "a", target: "b" },
        { id: "2", source: "b", target: "a" },
        { id: "3", source: "a", target: "a" },
      ],
    );
    expect(l.edges.find((e) => e.id === "3")!.selfLoop).toBe(true);
    const [e1, e2] = [l.edges.find((e) => e.id === "1")!, l.edges.find((e) => e.id === "2")!];
    expect(e1.points[0]!.x).not.toBe(e2.points[e2.points.length - 1]!.x);
  });
});
