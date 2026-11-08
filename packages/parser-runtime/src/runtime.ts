/**
 * Tree-sitter runtime lifecycle. The only package (besides adapters) that touches
 * web-tree-sitter. Grammars are loaded from packaged .wasm files on local disk;
 * nothing is ever downloaded at scan time.
 */
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { Language, Parser, type Node, type Tree } from "web-tree-sitter";

export type { Node as SyntaxNode, Tree as SyntaxTree, Language as GrammarLanguage };

export const RUNTIME_ID = "web-tree-sitter";
export const RUNTIME_VERSION = "0.25.10";

export interface GrammarSpec {
  /** Stable grammar id, e.g. "tree-sitter-javascript". */
  id: string;
  /** Exact grammar package version (recorded in cache keys and the license audit). */
  version: string;
  /** Absolute path to the .wasm grammar. */
  wasmPath: string;
}

let initPromise: Promise<void> | undefined;
const languageCache = new Map<string, Promise<Language>>();

/** Initialises the WebAssembly runtime once per process. */
export function initRuntime(): Promise<void> {
  initPromise ??= Parser.init();
  return initPromise;
}

export async function loadGrammar(spec: GrammarSpec): Promise<Language> {
  await initRuntime();
  let p = languageCache.get(spec.wasmPath);
  if (!p) {
    p = readFile(spec.wasmPath).then((bytes) => Language.load(new Uint8Array(bytes)));
    languageCache.set(spec.wasmPath, p);
    p.catch(() => languageCache.delete(spec.wasmPath));
  }
  return p;
}

/** Resolves a .wasm file shipped inside an npm package, relative to the caller module. */
export function resolvePackagedWasm(fromModuleUrl: string, specifier: string): string {
  return createRequire(fromModuleUrl).resolve(specifier);
}

export type ParseOutcome = { tree: Tree; timedOut: false } | { tree: null; timedOut: boolean };

/**
 * Parses text with a wall-clock budget. Tree-sitter calls the progress callback
 * periodically; returning true cancels the parse.
 */
export function parseWithBudget(parser: Parser, text: string, timeoutMs: number): ParseOutcome {
  const deadline = performance.now() + timeoutMs;
  let timedOut = false;
  const tree = parser.parse(text, null, {
    progressCallback: (() => {
      if (performance.now() > deadline) timedOut = true;
      return timedOut;
    }) as unknown as () => void,
  });
  if (!tree) return { tree: null, timedOut };
  return { tree, timedOut: false };
}

/** A worker-scoped parser bound to one grammar. Not shared across concurrent parses. */
export async function createParser(spec: GrammarSpec): Promise<Parser> {
  const lang = await loadGrammar(spec);
  const parser = new Parser();
  parser.setLanguage(lang);
  return parser;
}

export type { Parser };
