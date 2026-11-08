/**
 * Shared adapter conformance suite (blueprint §7.6). Every LanguageAdapter must pass
 * the same scenarios; each adapter supplies equivalent snippets in its own language.
 */
import { describe, expect, it } from "vitest";
import { DEFAULT_PARSER_LIMITS, type FileExtraction, type LanguageAdapter } from "@codemap/contracts";
import { createJavaScriptTypeScriptAdapter } from "@codemap/adapter-javascript-typescript";
import { createPythonAdapter } from "@codemap/adapter-python";

interface Snippets {
  file: string;
  language: string;
  valid: string;
  recoverable: { source: string; survivingSymbol: string };
  unicodeBeforeDecl: { source: string; symbol: string };
  sameNameScopes: { source: string; qualifiedNames: string[] };
  nested: { source: string; child: string; parent: string };
  aliasImport: { source: string; specifier: string; name: string; alias: string };
  reExport: { source: string; specifier: string } | null;
  dynamicImport: string;
  commentOnly: string;
  unsupported: string;
}

const cases: { adapter: LanguageAdapter; s: Snippets }[] = [
  {
    adapter: createJavaScriptTypeScriptAdapter(),
    s: {
      file: "mod.ts",
      language: "typescript",
      valid: "import { x } from './x';\nexport class A { m(): void { x(); } }\n",
      recoverable: { source: "export function good() { return 1 }\nfunction bad( {\n", survivingSymbol: "good" },
      unicodeBeforeDecl: { source: "const s = '日本語 😀';\nexport function target() {}\n", symbol: "target" },
      sameNameScopes: { source: "class A { run() {} }\nclass B { run() {} }\n", qualifiedNames: ["A.run", "B.run"] },
      nested: { source: "function outer() { function inner() {} }\n", child: "outer.inner", parent: "outer" },
      aliasImport: { source: "import { readFile as rf } from 'node:fs';\n", specifier: "node:fs", name: "readFile", alias: "rf" },
      reExport: { source: "export { a as b } from './a';\nexport * from './c';\n", specifier: "./a" },
      dynamicImport: "export async function f(n: string) { return import(n); }\n",
      commentOnly: "// nothing here\n/* still nothing */\n",
      unsupported: "class K { ['computed' + 1]() {} }\n",
    },
  },
  {
    adapter: createPythonAdapter(),
    s: {
      file: "mod.py",
      language: "python",
      valid: "from x import y\nclass A:\n    def m(self):\n        y()\n",
      recoverable: { source: "def good():\n    return 1\n\ndef bad(:\n    pass\n", survivingSymbol: "good" },
      unicodeBeforeDecl: { source: "s = '日本語 😀'\ndef target():\n    pass\n", symbol: "target" },
      sameNameScopes: { source: "class A:\n    def run(self): pass\nclass B:\n    def run(self): pass\n", qualifiedNames: ["A.run", "B.run"] },
      nested: { source: "def outer():\n    def inner():\n        pass\n", child: "outer.inner", parent: "outer" },
      aliasImport: { source: "from os import path as p\n", specifier: "os", name: "path", alias: "p" },
      reExport: null,
      dynamicImport: "import importlib\ndef f(n):\n    return importlib.import_module(n)\n",
      commentOnly: "# nothing here\n",
      unsupported: "class K(make_base()):\n    pass\n",
    },
  },
];

const enc = (s: string) => new TextEncoder().encode(s);

describe.each(cases)("$adapter.id adapter conformance", ({ adapter, s }) => {
  const parse = (source: string | Uint8Array, limits = DEFAULT_PARSER_LIMITS): Promise<FileExtraction> =>
    adapter.parseFile({ relativePath: s.file, language: s.language, source: typeof source === "string" ? enc(source) : source, contentHash: "test", projectConfiguration: { calls: true, inheritance: true }, limits });

  it("detects its own files and declines others", () => {
    expect(adapter.detect({ relativePath: s.file }).supported).toBe(true);
    expect(adapter.detect({ relativePath: "README.md" }).supported).toBe(false);
  });

  it("extracts imports, symbols and calls from valid syntax", async () => {
    const ex = await parse(s.valid);
    expect(ex.syntaxStatus).toBe("valid");
    expect(ex.imports).toHaveLength(1);
    expect(ex.symbols.map((x) => x.qualifiedName)).toEqual(["A", "A.m"]);
    expect(ex.calls.length).toBeGreaterThanOrEqual(1);
    expect(ex.calls[0]!.callerLocalId).toBe(ex.symbols[1]!.localId);
    expect(ex.diagnostics).toEqual([]);
  });

  it("recovers declarations from a file with syntax errors and reports PARSE001", async () => {
    const ex = await parse(s.recoverable.source);
    expect(ex.syntaxStatus).toBe("recovered");
    expect(ex.symbols.map((x) => x.name)).toContain(s.recoverable.survivingSymbol);
    expect(ex.diagnostics.some((d) => d.code === "PARSE001")).toBe(true);
  });

  it("maps UTF-8 byte offsets and UTF-16 columns exactly after non-ASCII text", async () => {
    const bytes = enc(s.unicodeBeforeDecl.source);
    const ex = await parse(bytes);
    const sym = ex.symbols.find((x) => x.name === s.unicodeBeforeDecl.symbol)!;
    const text = new TextDecoder().decode(bytes.subarray(sym.span.startByte, sym.span.endByte));
    expect(text).toMatch(new RegExp(`^(export )?(function|def) ${s.unicodeBeforeDecl.symbol}`));
    expect(sym.span.startLine).toBe(2);
    const line2 = s.unicodeBeforeDecl.source.split("\n")[1]!;
    expect(sym.span.startColumn).toBe(line2.search(/function|def/) + 1);
  });

  it("distinguishes same simple names in different scopes", async () => {
    const ex = await parse(s.sameNameScopes.source);
    const runs = ex.symbols.filter((x) => x.name === "run");
    expect(runs.map((r) => r.qualifiedName).sort()).toEqual(s.sameNameScopes.qualifiedNames);
    expect(new Set(runs.map((r) => r.parentLocalId)).size).toBe(2);
  });

  it("records nested declarations with their parent", async () => {
    const ex = await parse(s.nested.source);
    const child = ex.symbols.find((x) => x.qualifiedName === s.nested.child)!;
    const parent = ex.symbols.find((x) => x.qualifiedName === s.nested.parent)!;
    expect(child.parentLocalId).toBe(parent.localId);
  });

  it("captures import aliases", async () => {
    const ex = await parse(s.aliasImport.source);
    expect(ex.imports[0]!.specifier).toBe(s.aliasImport.specifier);
    expect(ex.imports[0]!.importedNames).toEqual([{ name: s.aliasImport.name, alias: s.aliasImport.alias }]);
  });

  it.runIf(s.reExport !== null)("captures re-exports as both a module dependency and an export", async () => {
    const ex = await parse(s.reExport!.source);
    expect(ex.imports.map((i) => i.form)).toEqual(["re_export", "re_export"]);
    expect(ex.exports.map((e) => [e.kind, e.name, e.localName ?? null])).toEqual([
      ["re_export", "b", "a"],
      ["re_export_all", "*", null],
    ]);
    expect(ex.exports[0]!.importIndex).toBe(0);
  });

  it("records non-literal dynamic imports as dynamic, without a specifier", async () => {
    const ex = await parse(s.dynamicImport);
    const dyn = ex.imports.find((i) => i.form === "dynamic_import")!;
    expect(dyn.isDynamicExpression).toBe(true);
    expect(dyn.specifier).toBeUndefined();
  });

  it("handles empty and comment-only files", async () => {
    for (const src of ["", s.commentOnly]) {
      const ex = await parse(src);
      expect(ex.syntaxStatus).toBe("valid");
      expect([ex.imports, ex.symbols, ex.calls, ex.diagnostics].every((l) => l.length === 0)).toBe(true);
    }
  });

  it("enforces the file size limit", async () => {
    const ex = await parse(s.valid, { ...DEFAULT_PARSER_LIMITS, maxFileSizeBytes: 10 });
    expect(ex.syntaxStatus).toBe("failed");
    expect(ex.diagnostics[0]!.code).toBe("SCAN002");
  });

  it("enforces the parse time budget", async () => {
    const big = Array.from({ length: 20_000 }, (_, i) => (s.language === "python" ? `def f${i}():\n    return ${i}\n` : `function f${i}() { return ${i}; }\n`)).join("");
    const ex = await parse(big, { ...DEFAULT_PARSER_LIMITS, maxFileSizeBytes: 10_000_000, parseTimeoutMs: 0 });
    expect(ex.syntaxStatus).toBe("failed");
    expect(ex.diagnostics[0]!.code).toBe("PARSE003");
    // The adapter stays usable after a cancelled parse.
    expect((await parse(s.valid)).syntaxStatus).toBe("valid");
  });

  it("guards against pathologically deep nesting", async () => {
    const deep = s.language === "python" ? `x = ${"[".repeat(3000)}${"]".repeat(3000)}\n` : `const x = ${"[".repeat(3000)}${"]".repeat(3000)};\n`;
    const ex = await parse(deep, { ...DEFAULT_PARSER_LIMITS, maxTreeDepth: 200 });
    expect(ex.diagnostics.some((d) => d.code === "PARSE004" && /nesting deeper/.test(d.message))).toBe(true);
  });

  it("reports unsupported constructs instead of silently dropping them", async () => {
    const ex = await parse(s.unsupported);
    expect(ex.diagnostics.some((d) => d.code === "PARSE004")).toBe(true);
  });

  it("produces deterministic output across repeated runs", async () => {
    const strip = (e: FileExtraction) => ({ ...e, extractionMetrics: undefined });
    const a = await parse(s.valid + s.sameNameScopes.source);
    const b = await parse(s.valid + s.sameNameScopes.source);
    expect(strip(a)).toEqual(strip(b));
  });

  it("never stores source bodies in summaries", async () => {
    const body = s.language === "python" ? `def f():\n${"    x = 1\n".repeat(200)}` : `function f() {\n${"  x = 1;\n".repeat(200)}}\n`;
    const ex = await parse(`${body}${s.language === "python" ? "f()\n" : "f();\n"}`);
    for (const c of ex.calls) expect(c.calleeSummary.length).toBeLessThanOrEqual(80);
    expect(JSON.stringify(ex).length).toBeLessThan(5_000);
  });
});
