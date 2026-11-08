import {
  DiagnosticCodes,
  type DetectionInput,
  type DetectionResult,
  type FileExtraction,
  type LanguageAdapter,
  type ParseFileInput,
} from "@codemap/contracts";
import {
  RUNTIME_ID,
  RUNTIME_VERSION,
  SourceText,
  collectSyntaxErrors,
  createParser,
  parseWithBudget,
  resolvePackagedWasm,
  type GrammarSpec,
  type Parser,
} from "@codemap/parser-runtime";
import { JsExtractor } from "./extract.js";

export const ADAPTER_ID = "javascript-typescript";
export const ADAPTER_VERSION = "0.1.0";

type Dialect = "javascript" | "typescript" | "tsx";

const GRAMMARS: Record<Dialect, Omit<GrammarSpec, "wasmPath"> & { file: string }> = {
  javascript: { id: "tree-sitter-javascript", version: "0.25.0", file: "tree-sitter-javascript/tree-sitter-javascript.wasm" },
  typescript: { id: "tree-sitter-typescript", version: "0.23.2", file: "tree-sitter-typescript/tree-sitter-typescript.wasm" },
  tsx: { id: "tree-sitter-typescript/tsx", version: "0.23.2", file: "tree-sitter-typescript/tree-sitter-tsx.wasm" },
};

const EXTENSIONS: Record<string, Dialect> = {
  ".js": "javascript",
  ".mjs": "javascript",
  ".cjs": "javascript",
  ".jsx": "javascript",
  ".ts": "typescript",
  ".mts": "typescript",
  ".cts": "typescript",
  ".tsx": "tsx",
};

function dialectFor(path: string): Dialect | undefined {
  const dot = path.lastIndexOf(".");
  return dot < 0 ? undefined : EXTENSIONS[path.slice(dot).toLowerCase()];
}

export class JavaScriptTypeScriptAdapter implements LanguageAdapter {
  readonly id = ADAPTER_ID;
  readonly version = ADAPTER_VERSION;
  readonly languages = ["javascript", "typescript"] as const;
  readonly extensions = Object.keys(EXTENSIONS);
  readonly grammarFingerprint = `${RUNTIME_ID}@${RUNTIME_VERSION};${Object.values(GRAMMARS).map((g) => `${g.id}@${g.version}`).join(",")}`;
  /** One parser per dialect, scoped to this adapter instance (one instance per worker). */
  private readonly parsers = new Map<Dialect, Promise<Parser>>();

  detect(input: DetectionInput): DetectionResult {
    const d = dialectFor(input.relativePath);
    return d ? { supported: true, language: d === "javascript" ? "javascript" : "typescript" } : { supported: false };
  }

  private parser(d: Dialect): Promise<Parser> {
    let p = this.parsers.get(d);
    if (!p) {
      const g = GRAMMARS[d];
      p = createParser({ id: g.id, version: g.version, wasmPath: resolvePackagedWasm(import.meta.url, g.file) });
      this.parsers.set(d, p);
    }
    return p;
  }

  async parseFile(input: ParseFileInput): Promise<FileExtraction> {
    const started = performance.now();
    const dialect = dialectFor(input.relativePath) ?? (input.language === "typescript" ? "typescript" : "javascript");
    const base: FileExtraction = {
      adapterId: this.id,
      adapterVersion: this.version,
      language: dialect === "javascript" ? "javascript" : "typescript",
      syntaxStatus: "failed",
      imports: [],
      exports: [],
      symbols: [],
      calls: [],
      inheritance: [],
      diagnostics: [],
      extractionMetrics: { parseDurationMs: 0 },
    };
    if (input.source.length > input.limits.maxFileSizeBytes) {
      base.diagnostics.push({ code: DiagnosticCodes.FILE_TOO_LARGE, severity: "warning", message: `file exceeds parser limit of ${input.limits.maxFileSizeBytes} bytes` });
      return base;
    }
    const src = new SourceText(input.source);
    const parser = await this.parser(dialect);
    const outcome = parseWithBudget(parser, src.text, input.limits.parseTimeoutMs);
    if (!outcome.tree) {
      base.diagnostics.push(
        outcome.timedOut
          ? { code: DiagnosticCodes.PARSE_TIMEOUT, severity: "error", message: `parser exceeded ${input.limits.parseTimeoutMs} ms budget` }
          : { code: DiagnosticCodes.PARSE_FAILED, severity: "error", message: "parser failed to produce a syntax tree" },
      );
      parser.reset();
      base.extractionMetrics.parseDurationMs = Math.round(performance.now() - started);
      return base;
    }
    const tree = outcome.tree;
    try {
      const root = tree.rootNode;
      const facts = new JsExtractor(src, input.limits.maxTreeDepth, input.projectConfiguration).run(root);
      const syntaxErrors = collectSyntaxErrors(root, src);
      if (!src.exact) facts.diagnostics.push({ code: DiagnosticCodes.PARSE_UNSUPPORTED, severity: "warning", message: "file is not valid UTF-8; byte offsets are approximate" });
      return {
        ...base,
        syntaxStatus: root.hasError ? "recovered" : "valid",
        ...facts,
        diagnostics: [...syntaxErrors, ...facts.diagnostics],
        extractionMetrics: { parseDurationMs: Math.round(performance.now() - started), nodeCount: root.descendantCount },
      };
    } finally {
      tree.delete();
    }
  }
}

export function createJavaScriptTypeScriptAdapter(): JavaScriptTypeScriptAdapter {
  return new JavaScriptTypeScriptAdapter();
}
