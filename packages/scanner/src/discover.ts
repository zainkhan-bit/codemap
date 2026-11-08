/**
 * Safe, read-only file discovery.
 *
 * - Never follows symbolic links (SCAN003).
 * - Never enters VCS internals; never reads secret-like files.
 * - Honours built-in exclusions, nested .gitignore/.codemapignore and config include/exclude.
 * - Reads only allowlisted configuration files, size-bounded.
 * - Emits sorted, NFC-normalized, repository-relative POSIX paths.
 */
import { opendir, readFile, stat } from "node:fs/promises";
import path from "node:path";
import ignore, { type Ignore } from "ignore";
import { DiagnosticCodes, type CodeMapConfig, type ConfigSnapshot, type FileRecord } from "@codemap/contracts";
import {
  HARD_EXCLUDED_DIRS,
  MAX_CONFIG_BYTES,
  VENV_MARKERS,
  configKindFor,
  isBuiltinExcludedDir,
  isBuiltinExcludedFile,
  isHardExcludedFile,
} from "./rules.js";
import { toPosixRelative } from "./paths.js";

export interface ScanDiagnostic {
  code: string;
  severity: "info" | "warning" | "error";
  message: string;
  path?: string;
}

export interface DiscoveredFile {
  relativePath: string;
  /** Local absolute path; never placed in graph data. */
  absolutePath: string;
  sizeBytes: number;
  mtimeMs: number;
  language: string;
}

export interface DiscoveryResult {
  files: DiscoveredFile[];
  /** Files that were seen but not scanned (too large, limit reached, …). */
  skipped: FileRecord[];
  configs: ConfigSnapshot[];
  diagnostics: ScanDiagnostic[];
  /** Directories visited, for metrics. */
  directoryCount: number;
}

export interface DiscoveryOptions {
  root: string;
  config: CodeMapConfig;
  /** Maps a relative path to a supported language, or undefined. Provided by the composition root. */
  classify: (relativePath: string) => string | undefined;
  signal?: AbortSignal;
}

interface IgnoreLayer {
  /** Directory the ignore file lives in ("" for root). */
  base: string;
  git?: Ignore;
  codemap?: Ignore;
}

async function readIgnoreFile(abs: string): Promise<Ignore | undefined> {
  try {
    const text = await readFile(abs, "utf8");
    return ignore({ allowRelativePaths: true }).add(text);
  } catch {
    return undefined;
  }
}

function relativeTo(base: string, p: string): string {
  return base === "" ? p : p.slice(base.length + 1);
}

/** Evaluates .gitignore then .codemapignore layers; a later match wins, .codemapignore negation re-includes. */
function ignoredByLayers(layers: readonly IgnoreLayer[], rel: string, isDir: boolean): boolean {
  let ignored = false;
  for (const kind of ["git", "codemap"] as const) {
    for (const layer of layers) {
      const ig = layer[kind];
      if (!ig) continue;
      const sub = relativeTo(layer.base, rel) + (isDir ? "/" : "");
      const r = ig.test(sub);
      if (r.ignored) ignored = true;
      else if (r.unignored) ignored = false;
    }
  }
  return ignored;
}

export async function discoverFiles(opts: DiscoveryOptions): Promise<DiscoveryResult> {
  const { root, config, classify, signal } = opts;
  const result: DiscoveryResult = { files: [], skipped: [], configs: [], diagnostics: [], directoryCount: 0 };
  const exclude = ignore({ allowRelativePaths: true }).add(config.exclude);
  const includes = config.include;
  const included = (rel: string) => includes.length === 0 || includes.some((g) => path.posix.matchesGlob(rel, g));
  let limitReached = false;

  const walk = async (absDir: string, relDir: string, parentLayers: readonly IgnoreLayer[]): Promise<void> => {
    if (signal?.aborted) throw signal.reason ?? new Error("aborted");
    let dir;
    try {
      dir = await opendir(absDir);
    } catch (err) {
      result.diagnostics.push({ code: DiagnosticCodes.ACCESS_ERROR, severity: "warning", message: `cannot read directory (${(err as NodeJS.ErrnoException).code ?? "error"})`, path: relDir || "." });
      return;
    }
    const entries: { name: string; isDir: boolean; isFile: boolean; isLink: boolean }[] = [];
    try {
      for await (const d of dir) entries.push({ name: d.name, isDir: d.isDirectory(), isFile: d.isFile(), isLink: d.isSymbolicLink() });
    } catch (err) {
      result.diagnostics.push({ code: DiagnosticCodes.ACCESS_ERROR, severity: "warning", message: `error while listing directory (${(err as NodeJS.ErrnoException).code ?? "error"})`, path: relDir || "." });
    }
    entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    result.directoryCount++;

    if (relDir !== "" && entries.some((e) => e.isFile && VENV_MARKERS.includes(e.name))) return;

    const layer: IgnoreLayer = { base: relDir };
    if (entries.some((e) => e.isFile && e.name === ".gitignore")) layer.git = await readIgnoreFile(path.join(absDir, ".gitignore"));
    if (entries.some((e) => e.isFile && e.name === ".codemapignore")) layer.codemap = await readIgnoreFile(path.join(absDir, ".codemapignore"));
    const layers = layer.git || layer.codemap ? [...parentLayers, layer] : parentLayers;

    const subdirs: { abs: string; rel: string }[] = [];
    for (const e of entries) {
      const rel = toPosixRelative(relDir === "" ? e.name : `${relDir}/${e.name}`);
      const abs = path.join(absDir, e.name);
      if (e.isLink) {
        result.diagnostics.push({ code: DiagnosticCodes.SYMLINK_SKIPPED, severity: "info", message: "symbolic link skipped by policy", path: rel });
        continue;
      }
      if (e.isDir) {
        if (HARD_EXCLUDED_DIRS.has(e.name) || isBuiltinExcludedDir(e.name)) continue;
        if (ignoredByLayers(layers, rel, true) || exclude.ignores(`${rel}/`)) continue;
        subdirs.push({ abs, rel });
        continue;
      }
      if (!e.isFile || isHardExcludedFile(e.name)) continue;

      const configKind = configKindFor(e.name);
      if (configKind) {
        try {
          const st = await stat(abs);
          if (st.size <= MAX_CONFIG_BYTES) result.configs.push({ path: rel, kind: configKind, text: await readFile(abs, "utf8") });
          else result.diagnostics.push({ code: DiagnosticCodes.FILE_TOO_LARGE, severity: "warning", message: `configuration file exceeds ${MAX_CONFIG_BYTES} bytes; ignored`, path: rel });
        } catch (err) {
          result.diagnostics.push({ code: DiagnosticCodes.ACCESS_ERROR, severity: "warning", message: `cannot read configuration file (${(err as NodeJS.ErrnoException).code ?? "error"})`, path: rel });
        }
        continue;
      }

      const language = classify(rel);
      if (!language || isBuiltinExcludedFile(e.name)) continue;
      if (ignoredByLayers(layers, rel, false) || exclude.ignores(rel) || !included(rel)) continue;

      let st;
      try {
        st = await stat(abs);
      } catch (err) {
        result.diagnostics.push({ code: DiagnosticCodes.ACCESS_ERROR, severity: "warning", message: `cannot stat file (${(err as NodeJS.ErrnoException).code ?? "error"})`, path: rel });
        result.skipped.push({ relativePath: rel, sizeBytes: 0, language, parseStatus: "skipped", skipReason: DiagnosticCodes.ACCESS_ERROR });
        continue;
      }
      if (result.files.length >= config.maxFiles) {
        if (!limitReached) {
          limitReached = true;
          result.diagnostics.push({ code: DiagnosticCodes.FILE_LIMIT_REACHED, severity: "warning", message: `maximum file count (${config.maxFiles}) reached; remaining files were not scanned` });
        }
        result.skipped.push({ relativePath: rel, sizeBytes: st.size, mtimeMs: Math.trunc(st.mtimeMs), language, parseStatus: "skipped", skipReason: DiagnosticCodes.FILE_LIMIT_REACHED });
        continue;
      }
      if (st.size > config.maxFileSizeBytes) {
        result.diagnostics.push({ code: DiagnosticCodes.FILE_TOO_LARGE, severity: "info", message: `file exceeds ${config.maxFileSizeBytes} bytes; skipped`, path: rel });
        result.skipped.push({ relativePath: rel, sizeBytes: st.size, mtimeMs: Math.trunc(st.mtimeMs), language, parseStatus: "skipped", skipReason: DiagnosticCodes.FILE_TOO_LARGE });
        continue;
      }
      result.files.push({ relativePath: rel, absolutePath: abs, sizeBytes: st.size, mtimeMs: Math.trunc(st.mtimeMs), language });
    }
    for (const d of subdirs) await walk(d.abs, d.rel, layers);
  };

  await walk(root, "", []);
  result.configs.sort((a, b) => (a.path < b.path ? -1 : 1));
  return result;
}
