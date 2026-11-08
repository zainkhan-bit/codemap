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
  type Parser,
} from "@codemap/parser-runtime";
import { PyExtractor } from "./extract.js";

export const ADAPTER_ID = "python";
export const ADAPTER_VERSION = "0.1.0";
const GRAMMAR = { id: "tree-sitter-python", version: "0.25.0", file: "tree-sitter-python/tree-sitter-python.wasm" };

export class PythonAdapter implements LanguageAdapter {
  readonly id = ADAPTER_ID;
  readonly version = ADAPTER_VERSION;
  readonly languages = ["python"] as const;
  readonly extensions = [".py", ".pyi"];
  readonly grammarFingerprint = `${RUNTIME_ID}@${RUNTIME_VERSION};${GRAMMAR.id}@${GRAMMAR.version}`;
  private parserPromise: Promise<Parser> | undefined;

  detect(input: DetectionInput): DetectionResult {
    const lower = input.relativePath.toLowerCase();
    return lower.endsWith(".py") || lower.endsWith(".pyi") ? { supported: true, language: "python" } : { supported: false };
  }

  private parser(): Promise<Parser> {
    this.parserPromise ??= createParser({ id: GRAMMAR.id, version: GRAMMAR.version, wasmPath: resolvePackagedWasm(import.meta.url, GRAMMAR.file) });
    return this.parserPromise;
  }

  async parseFile(input: ParseFileInput): Promise<FileExtraction> {
    const started = performance.now();
    const base: FileExtraction = {
      adapterId: this.id,
      adapterVersion: this.version,
      language: "python",
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
    const parser = await this.parser();
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
      const facts = new PyExtractor(src, input.limits.maxTreeDepth, input.projectConfiguration).run(root);
      if (!src.exact) facts.diagnostics.push({ code: DiagnosticCodes.PARSE_UNSUPPORTED, severity: "warning", message: "file is not valid UTF-8; byte offsets are approximate" });
      return {
        ...base,
        syntaxStatus: root.hasError ? "recovered" : "valid",
        ...facts,
        diagnostics: [...collectSyntaxErrors(root, src), ...facts.diagnostics],
        extractionMetrics: { parseDurationMs: Math.round(performance.now() - started), nodeCount: root.descendantCount },
      };
    } finally {
      tree.delete();
    }
  }
}

export function createPythonAdapter(): PythonAdapter {
  return new PythonAdapter();
}
