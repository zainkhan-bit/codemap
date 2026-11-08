import { describe, expect, it } from "vitest";
import type { CodeMapGraph, FileExtraction, SourceSpan, SymbolFact } from "@codemap/contracts";
import { Ids, IdRegistry, IdCollisionError } from "./ids.js";
import { buildGraph, moduleReferenceKey, type BuildGraphInput, type ResolvedModuleReference } from "./builder.js";
import { findCycles, degreeMetrics, traverseDependencies, weaklyConnectedComponents, isolatedNodes } from "./algorithms.js";
import { projectGraph } from "./projections.js";
import { validateGraphInvariants } from "./invariants.js";
import { edgeStrings, nodeLabel } from "../../../tests/helpers/graph.js";

const span = (line: number, startByte = line * 10): SourceSpan => ({ startByte, endByte: startByte + 5, startLine: line, startColumn: 1, endLine: line, endColumn: 6 });

function extraction(partial: Partial<FileExtraction>): FileExtraction {
  return { adapterId: "test", adapterVersion: "1", language: "typescript", syntaxStatus: "valid", imports: [], exports: [], symbols: [], calls: [], inheritance: [], diagnostics: [], extractionMetrics: { parseDurationMs: 0 }, ...partial };
}

function sym(localId: string, name: string, kind: SymbolFact["symbolKind"], line: number, parent?: string, qualified?: string): SymbolFact {
  return { localId, name, qualifiedName: qualified ?? name, symbolKind: kind, span: span(line), exported: true, modifiers: [], ...(parent ? { parentLocalId: parent } : {}) };
}

function imp(specifier: string, line: number, names: string[] = []) {
  return { specifier, form: "static_import" as const, importedNames: names.map((n) => ({ name: n })), isTypeOnly: false, isDynamicExpression: false, summary: `import ${specifier}`, span: span(line) };
}

function internal(path: string): ResolvedModuleReference {
  return { result: { referenceKey: "", status: "resolved_internal", target: { kind: "file", path }, confidence: "high", resolutionMethod: "relative_path" }, resolverId: "r", resolverVersion: "1" };
}

/** a.ts ⇄ b.ts cycle, c.ts self-import, d.ts unresolved import, e.ts isolated. */
function sampleInput(): BuildGraphInput {
  const files = [
    { path: "src/a.ts", language: "typescript", sizeBytes: 10, extraction: extraction({ imports: [imp("./b", 1, ["b"])], symbols: [sym("s0", "a", "function", 2)], calls: [{ callerLocalId: "s0", calleeSummary: "b", calleeName: "b", memberChain: ["b"], receiver: "none", callKind: "direct", span: span(3) }], exports: [{ kind: "declaration", name: "a", localName: "a", isTypeOnly: false, summary: "export a", span: span(2) }] }) },
    { path: "src/b.ts", language: "typescript", sizeBytes: 10, extraction: extraction({ imports: [imp("./a", 1, ["a"])], symbols: [sym("s0", "b", "function", 2)], exports: [{ kind: "declaration", name: "b", localName: "b", isTypeOnly: false, summary: "export b", span: span(2) }] }) },
    { path: "src/c.ts", language: "typescript", sizeBytes: 10, extraction: extraction({ imports: [imp("./c", 1)] }) },
    { path: "src/d.ts", language: "typescript", sizeBytes: 10, extraction: extraction({ imports: [imp("./missing", 1)] }) },
    { path: "lib/e.ts", language: "typescript", sizeBytes: 10, extraction: extraction({}) },
  ];
  const resolutions = new Map<string, ResolvedModuleReference>([
    [moduleReferenceKey("src/a.ts", 0), internal("src/b.ts")],
    [moduleReferenceKey("src/b.ts", 0), internal("src/a.ts")],
    [moduleReferenceKey("src/c.ts", 0), internal("src/c.ts")],
    [moduleReferenceKey("src/d.ts", 0), { result: { referenceKey: "", status: "unresolved", message: "no source file", diagnosticCode: "RESOLVE001" }, resolverId: "r", resolverVersion: "1" }],
  ]);
  return {
    project: { id: Ids.project("demo").id, displayName: "demo", rootLabel: "demo" },
    scan: { id: "scn", toolVersion: "0.1.0", startedAt: "t", completedAt: "t", configurationHash: "c", parserSetHash: "p" },
    files,
    resolutions,
  };
}

const graphOf = (input = sampleInput()): CodeMapGraph => buildGraph(input);

describe("ids", () => {
  it("are deterministic, prefixed and length-safe", () => {
    expect(Ids.file("src/a.ts").id).toBe(Ids.file("src/a.ts").id);
    expect(Ids.file("src/a.ts").id).toMatch(/^fil_[0-9a-f]{32}$/);
    expect(Ids.symbol("a", "function", "x|y", "", 0).id).not.toBe(Ids.symbol("a", "function|x", "y", "", 0).id);
  });

  it("registry detects a collision with a different identity", () => {
    const reg = new IdRegistry();
    reg.register({ id: "x", identity: "one" });
    expect(reg.register({ id: "x", identity: "one" })).toBe(false);
    expect(() => reg.register({ id: "x", identity: "two" })).toThrow(IdCollisionError);
  });
});

describe("buildGraph", () => {
  it("produces a graph that satisfies all invariants", () => {
    expect(validateGraphInvariants(graphOf())).toEqual([]);
  });

  it("is deterministic across runs", () => {
    expect(JSON.stringify(graphOf())).toBe(JSON.stringify(graphOf()));
  });

  it("creates containment, import, export and call edges only for resolved references", () => {
    const g = graphOf();
    expect(edgeStrings(g)).toEqual([
      "calls src/a.ts:a -> src/b.ts:b",
      "exports src/a.ts -> src/a.ts:a",
      "exports src/b.ts -> src/b.ts:b",
      "imports src/a.ts -> src/b.ts",
      "imports src/b.ts -> src/a.ts",
      "imports src/c.ts -> src/c.ts",
    ]);
    const unresolved = g.references.find((r) => r.specifier === "./missing")!;
    expect(unresolved.status).toBe("unresolved");
    expect(unresolved.targetNodeId).toBeUndefined();
    expect(g.diagnostics.some((d) => d.code === "RESOLVE001")).toBe(true);
    const dirs = g.nodes.filter((n) => n.kind === "directory").map((n) => n.path);
    expect(dirs).toEqual(["lib", "src"]);
  });

  it("keeps symbol IDs stable when unrelated lines are inserted", () => {
    const before = graphOf();
    const shifted = sampleInput();
    const a = shifted.files[0]!.extraction!;
    a.symbols = a.symbols.map((s) => ({ ...s, span: span(s.span.startLine + 5, s.span.startByte + 100) }));
    const after = buildGraph(shifted);
    const ids = (g: CodeMapGraph) => g.nodes.filter((n) => n.kind === "symbol").map((n) => n.id).sort();
    expect(ids(after)).toEqual(ids(before));
  });

  it("changes a symbol ID when its identity changes", () => {
    const renamed = sampleInput();
    renamed.files[0]!.extraction!.symbols[0] = sym("s0", "a2", "function", 2);
    const id = (g: CodeMapGraph) => g.nodes.find((n) => n.path === "src/a.ts" && n.kind === "symbol")!.id;
    expect(id(buildGraph(renamed))).not.toBe(id(graphOf()));
  });

  it("aggregates repeated relations into one edge with multiple evidence references", () => {
    const input = sampleInput();
    input.files[0]!.extraction!.imports.push(imp("./b", 4, ["b"]));
    (input.resolutions as Map<string, ResolvedModuleReference>).set(moduleReferenceKey("src/a.ts", 1), internal("src/b.ts"));
    const g = buildGraph(input);
    const edge = g.edges.find((e) => e.kind === "imports" && nodeLabel(g, e.sourceId) === "src/a.ts")!;
    expect(edge.evidenceReferenceIds).toHaveLength(2);
  });

  it("disambiguates duplicate declarations with an ordinal and a GRAPH001 diagnostic", () => {
    const input = sampleInput();
    input.files[4]!.extraction!.symbols = [sym("s0", "dup", "function", 1), sym("s1", "dup", "function", 5)];
    const g = buildGraph(input);
    const dups = g.nodes.filter((n) => n.name === "dup");
    expect(new Set(dups.map((d) => d.id)).size).toBe(2);
    expect(g.diagnostics.some((d) => d.code === "GRAPH001")).toBe(true);
    // Same-name calls are then ambiguous, never guessed.
    input.files[4]!.extraction!.calls = [{ calleeSummary: "dup", calleeName: "dup", memberChain: ["dup"], receiver: "none", callKind: "direct", span: span(9) }];
    const g2 = buildGraph(input);
    expect(g2.references.find((r) => r.kind === "call")!.status).toBe("ambiguous");
    expect(g2.edges.some((e) => e.kind === "calls" && nodeLabel(g2, e.sourceId) === "lib/e.ts")).toBe(false);
  });

  it("downgrades a resolver result pointing at a file outside the scan", () => {
    const input = sampleInput();
    (input.resolutions as Map<string, ResolvedModuleReference>).set(moduleReferenceKey("src/d.ts", 0), internal("src/ghost.ts"));
    const g = buildGraph(input);
    expect(g.references.find((r) => r.specifier === "./missing")!.status).toBe("unresolved");
    expect(validateGraphInvariants(g)).toEqual([]);
  });

  it("resolves this.method() only within the enclosing class", () => {
    const input = sampleInput();
    input.files[4]!.extraction = extraction({
      symbols: [sym("c", "K", "class", 1), sym("m1", "run", "method", 2, "c", "K.run"), sym("m2", "step", "method", 3, "c", "K.step")],
      calls: [
        { callerLocalId: "m1", calleeSummary: "this.step", calleeName: "step", memberChain: ["this", "step"], receiver: "this", callKind: "member", span: span(4) },
        { callerLocalId: "m1", calleeSummary: "this.inherited", calleeName: "inherited", memberChain: ["this", "inherited"], receiver: "this", callKind: "member", span: span(5) },
        { callerLocalId: "m1", calleeSummary: "obj.step", calleeName: "step", receiver: "other", callKind: "member", span: span(6) },
      ],
    });
    const g = buildGraph(input);
    expect(edgeStrings(g, ["calls"])).toContain("calls lib/e.ts:K.run -> lib/e.ts:K.step");
    const statuses = g.references.filter((r) => r.kind === "call" && r.attributes.receiver !== "none").map((r) => r.status).sort();
    expect(statuses).toEqual(["resolved_internal", "unresolved", "unresolved"]);
  });
});

describe("algorithms", () => {
  it("finds the multi-node cycle and the self-cycle, nothing else", () => {
    const g = graphOf();
    const cycles = findCycles(g).map((c) => ({ files: c.nodeIds.map((id) => nodeLabel(g, id)).sort(), self: c.selfLoop }));
    expect(cycles).toEqual(
      expect.arrayContaining([
        { files: ["src/a.ts", "src/b.ts"], self: false },
        { files: ["src/c.ts"], self: true },
      ]),
    );
    expect(cycles).toHaveLength(2);
  });

  it("returns a concrete closed path for each cycle", () => {
    const g = graphOf();
    const multi = findCycles(g).find((c) => !c.selfLoop)!;
    expect(multi.path[0]).toBe(multi.path[multi.path.length - 1]);
    expect(multi.path).toHaveLength(3);
  });

  it("does not report cycles from containment or unresolved references", () => {
    const input = sampleInput();
    (input.resolutions as Map<string, ResolvedModuleReference>).delete(moduleReferenceKey("src/b.ts", 0));
    (input.resolutions as Map<string, ResolvedModuleReference>).delete(moduleReferenceKey("src/c.ts", 0));
    expect(findCycles(buildGraph(input))).toEqual([]);
  });

  it("handles a long chain without recursion limits", () => {
    const n = 20_000;
    const nodes = Array.from({ length: n }, (_, i) => ({ id: `f${i}`, kind: "file" as const, name: `f${i}`, path: `f${i}.ts`, attributes: {} }));
    const edges = nodes.slice(1).map((nd, i) => ({ id: `e${i}`, kind: "imports" as const, sourceId: nodes[i]!.id, targetId: nd.id, confidence: "high" as const, evidenceReferenceIds: ["r"], attributes: {} }));
    edges.push({ id: "back", kind: "imports", sourceId: `f${n - 1}`, targetId: "f0", confidence: "high", evidenceReferenceIds: ["r"], attributes: {} });
    const g = { ...graphOf(), nodes, edges };
    const cycles = findCycles(g);
    expect(cycles).toHaveLength(1);
    expect(cycles[0]!.nodeIds).toHaveLength(n);
  });

  it("computes fan-in/fan-out, traversal, components and isolated files", () => {
    const g = graphOf();
    const byLabel = Object.fromEntries(degreeMetrics(g).map((d) => [nodeLabel(g, d.nodeId), [d.fanIn, d.fanOut]]));
    expect(byLabel["src/a.ts"]).toEqual([1, 1]);
    expect(byLabel["src/c.ts"]).toEqual([0, 0]); // self-import only
    const a = g.nodes.find((x) => x.path === "src/a.ts")!.id;
    expect(traverseDependencies(g, a, { maxDepth: 5 }).map((h) => nodeLabel(g, h.nodeId))).toEqual(["src/b.ts"]);
    expect(isolatedNodes(g).map((id) => nodeLabel(g, id))).toEqual(expect.arrayContaining(["lib/e.ts", "src/d.ts"]));
    expect(weaklyConnectedComponents(g)[0]).toHaveLength(2);
  });
});

describe("projections", () => {
  it("file_dependency_view contains only files/packages and import edges", () => {
    const p = projectGraph(graphOf(), "file_dependency_view");
    expect(new Set(p.nodes.map((n) => n.kind))).toEqual(new Set(["file"]));
    expect(p.edges.every((e) => e.kind === "imports")).toBe(true);
  });

  it("directory_view filters by path prefix", () => {
    const p = projectGraph(graphOf(), "directory_view", { pathPrefix: "lib" });
    expect(p.nodes.filter((n) => n.kind !== "project").map((n) => n.path)).toEqual(["lib", "lib/e.ts"]);
  });

  it("module_view aggregates file imports into derived module edges", () => {
    const input = sampleInput();
    input.modules = [
      { path: "src", name: "app", ecosystem: "npm" },
      { path: "lib", name: "lib", ecosystem: "npm" },
    ];
    input.files[0]!.extraction!.imports.push(imp("../lib/e", 5));
    (input.resolutions as Map<string, ResolvedModuleReference>).set(moduleReferenceKey("src/a.ts", 1), internal("lib/e.ts"));
    const g = buildGraph(input);
    const p = projectGraph(g, "module_view");
    expect(p.edges.map((e) => `${nodeLabel(g, e.sourceId)}->${nodeLabel(g, e.targetId)}`)).toEqual(["src->lib"]);
    expect(p.edges[0]!.attributes.derived).toBe(true);
  });

  it("call_view keeps only call endpoints", () => {
    const g = graphOf();
    const p = projectGraph(g, "call_view");
    expect(p.nodes.map((n) => nodeLabel(g, n.id)).sort()).toEqual(["src/a.ts:a", "src/b.ts:b"]);
  });
});

describe("invariants", () => {
  it("detect dangling endpoints, evidence and leaked absolute paths", () => {
    const g = graphOf();
    g.edges.push({ id: "edg_x", kind: "imports", sourceId: "nope", targetId: g.nodes[1]!.id, confidence: "high", evidenceReferenceIds: ["ref_missing"], attributes: {} });
    g.references[0]!.rawText = 'import x from "C:\\Users\\me\\secret.ts"';
    const v = validateGraphInvariants(g).join("\n");
    expect(v).toMatch(/source nope does not exist/);
    expect(v).toMatch(/evidence ref_missing does not exist/);
    expect(v).toMatch(/absolute path/);
  });

  it("detect a resolved reference without a target", () => {
    const g = graphOf();
    const r = g.references.find((x) => x.status === "resolved_internal")!;
    delete r.targetNodeId;
    expect(validateGraphInvariants(g).join()).toMatch(/resolved reference has no existing target/);
  });
});

describe("redaction", () => {
  it("never lets absolute paths from source facts reach the graph", async () => {
    const { redactAbsolutePaths } = await import("./builder.js");
    expect(redactAbsolutePaths('import x from "C:\\Users\\me\\x.ts"')).toBe('import x from "<absolute-path>"');
    expect(redactAbsolutePaths("require('/home/me/secret.js')")).toBe("require('<absolute-path>')");
    expect(redactAbsolutePaths("./relative/path.js")).toBe("./relative/path.js");
    const input = sampleInput();
    input.files[3]!.extraction!.imports[0] = imp("/home/me/abs.js", 1);
    const g = buildGraph(input);
    expect(validateGraphInvariants(g)).toEqual([]);
    expect(JSON.stringify(g)).not.toContain("/home/me");
  });
});
