/**
 * Static Python import resolver.
 *
 * Source roots: the repository root, every directory holding pyproject.toml or
 * setup.cfg, their `src/` directories, and roots declared in pyproject
 * (`where = [...]`, poetry `from = "..."`). The importing file's own directory
 * is a lower-confidence fallback (script execution puts it on sys.path).
 * Never imports or runs Python.
 */
import path from "node:path";
import {
  DiagnosticCodes,
  type ModuleReferenceFact,
  type ReferenceResolver,
  type ResolutionBatch,
  type ResolutionResult,
  type ResolverDiagnostic,
  type ResolverInput,
} from "@codemap/contracts";
import { DISTRIBUTION_IMPORT_ALIASES, PYTHON_STDLIB } from "./stdlib.js";

export { PYTHON_STDLIB };
export const RESOLVER_ID = "resolver-python";
export const RESOLVER_VERSION = "0.1.0";
const posix = path.posix;

function normalizeDist(name: string): string {
  return name.toLowerCase().replace(/[-_.]+/g, "-");
}

/** Extracts distribution names from a PEP 508 requirement string. */
function requirementName(req: string): string | undefined {
  const m = /^\s*([A-Za-z0-9][A-Za-z0-9._-]*)/.exec(req);
  return m ? m[1] : undefined;
}

interface PyIndex {
  files: Set<string>;
  dirs: Set<string>;
  roots: string[];
  /** Import names (top-level) of declared third-party distributions. */
  declared: Set<string>;
  diagnostics: ResolverDiagnostic[];
}

function dirOf(p: string): string {
  const d = posix.dirname(p);
  return d === "." ? "" : d;
}

function parsePyprojectRoots(text: string, baseDir: string, roots: Set<string>, declared: Set<string>): void {
  for (const m of text.matchAll(/^\s*where\s*=\s*\[([^\]]*)\]/gm)) for (const s of m[1]!.matchAll(/["']([^"']+)["']/g)) roots.add(posix.normalize(posix.join(baseDir, s[1]!)).replace(/^\.$/, ""));
  for (const m of text.matchAll(/\bfrom\s*=\s*["']([^"']+)["']/g)) roots.add(posix.normalize(posix.join(baseDir, m[1]!)).replace(/^\.$/, ""));
  for (const m of text.matchAll(/^\s*package-dir\s*=\s*\{[^}]*""\s*=\s*["']([^"']+)["']/gm)) roots.add(posix.normalize(posix.join(baseDir, m[1]!)).replace(/^\.$/, ""));
  const arrays = (body: string, keyPattern: string) => {
    for (const m of body.matchAll(new RegExp(`^\\s*(?:${keyPattern})\\s*=\\s*\\[([^\\]]*)\\]`, "gm"))) for (const s of m[1]!.matchAll(/["']([^"']+)["']/g)) addDist(requirementName(s[1]!), declared);
  };
  for (const sec of text.split(/^\s*\[(?!\[)/m)) {
    const header = /^([^\]]+)\]/.exec(sec)?.[1]?.trim();
    if (header === "project") arrays(sec, "dependencies");
    else if (header === "project.optional-dependencies" || header === "dependency-groups") arrays(sec, "[A-Za-z0-9_.-]+");
    else if (header && /^tool\.poetry\.(?:group\.[^.]+\.)?(?:dev-)?dependencies$/.test(header)) {
      // [tool.poetry.dependencies] / [tool.poetry.group.<g>.dependencies] tables.
      for (const line of sec.split("\n").slice(1)) {
        const k = /^\s*([A-Za-z0-9][A-Za-z0-9._-]*)\s*=/.exec(line);
        if (k && k[1] !== "python") addDist(k[1], declared);
      }
    }
  }
}

function addDist(name: string | undefined, declared: Set<string>): void {
  if (!name) return;
  const norm = normalizeDist(name);
  for (const alias of DISTRIBUTION_IMPORT_ALIASES[norm] ?? []) declared.add(alias);
  declared.add(norm.replace(/-/g, "_"));
  declared.add(name.replace(/-/g, "_"));
}

function buildIndex(input: ResolverInput): PyIndex {
  const files = new Set(input.projectContext.sourceFiles);
  const dirs = new Set<string>(input.projectContext.directories);
  for (const f of files) for (let d = dirOf(f); ; d = dirOf(d)) {
    dirs.add(d);
    if (d === "") break;
  }
  const roots = new Set<string>([""]);
  const declared = new Set<string>();
  const diagnostics: ResolverDiagnostic[] = [];
  for (const c of input.projectContext.configs) {
    const base = dirOf(c.path);
    if (c.kind === "pyproject" || c.kind === "setup_cfg") {
      roots.add(base);
      if (dirs.has(posix.join(base, "src").replace(/^\.\//, ""))) roots.add(base === "" ? "src" : `${base}/src`);
      if (c.kind === "pyproject") parsePyprojectRoots(c.text, base, roots, declared);
      if (c.kind === "setup_cfg") {
        const req = /install_requires\s*=\s*\n((?:[ \t]+.*\n?)*)/.exec(c.text);
        if (req) for (const line of req[1]!.split("\n")) addDist(requirementName(line), declared);
      }
    }
    if (c.kind === "requirements_txt") {
      for (const line of c.text.split("\n")) {
        const t = line.trim();
        if (t && !t.startsWith("#") && !t.startsWith("-")) addDist(requirementName(t), declared);
      }
    }
  }
  if (dirs.has("src") && ![...files].some((f) => /^[^/]+\.py$/.test(f) && f !== "setup.py" && f !== "conftest.py")) roots.add("src");
  return { files, dirs, roots: [...roots].sort((a, b) => b.length - a.length || (a < b ? -1 : 1)), declared, diagnostics };
}

type Lookup = { kind: "file"; path: string } | { kind: "namespace"; dir: string } | { kind: "none" };

function lookupModule(ix: PyIndex, baseDir: string, segments: readonly string[]): Lookup {
  const rel = posix.join(baseDir, ...segments).replace(/^\.\/?/, "");
  for (const ext of [".py", ".pyi"]) if (rel && ix.files.has(rel + ext)) return { kind: "file", path: rel + ext };
  for (const ext of [".py", ".pyi"]) {
    const init = rel ? `${rel}/__init__${ext}` : `__init__${ext}`;
    if (ix.files.has(init)) return { kind: "file", path: init };
  }
  if (rel && ix.dirs.has(rel)) return { kind: "namespace", dir: rel };
  return { kind: "none" };
}

export class PythonResolver implements ReferenceResolver {
  readonly id = RESOLVER_ID;
  readonly version = RESOLVER_VERSION;
  readonly languages = ["python"] as const;

  async resolve(input: ResolverInput): Promise<ResolutionBatch> {
    const ix = buildIndex(input);
    const results = input.references.filter((r) => r.language === "python").map((r) => this.resolveOne(ix, r, input.resolutionOptions.resolveExternalPackages));
    return { resolverId: this.id, resolverVersion: this.version, results, diagnostics: ix.diagnostics };
  }

  private withSubmodules(ix: PyIndex, res: ResolutionResult, pkgDir: string, ref: ModuleReferenceFact): ResolutionResult {
    const nameTargets: Record<string, { kind: "file"; path: string }> = {};
    for (const n of ref.importedNames) {
      if (n.name === "*") continue;
      const sub = lookupModule(ix, pkgDir, [n.name]);
      if (sub.kind === "file") nameTargets[n.name] = { kind: "file", path: sub.path };
    }
    return Object.keys(nameTargets).length ? { ...res, nameTargets } : res;
  }

  private resolveOne(ix: PyIndex, ref: ModuleReferenceFact, resolveExternal: boolean): ResolutionResult {
    const base = { referenceKey: ref.referenceKey };
    if (ref.isDynamicExpression || ref.specifier === undefined) {
      return { ...base, status: "unresolved", message: "module name is computed at runtime; not statically resolvable", diagnosticCode: DiagnosticCodes.RESOLVE_UNRESOLVED };
    }
    const segments = ref.specifier ? ref.specifier.split(".") : [];

    if (ref.relativeLevel) {
      let dir = dirOf(ref.fromPath);
      for (let i = 1; i < ref.relativeLevel; i++) {
        if (dir === "") return { ...base, status: "unresolved", message: "relative import climbs above the project root", diagnosticCode: DiagnosticCodes.RESOLVE_UNRESOLVED };
        dir = dirOf(dir);
      }
      const hit = lookupModule(ix, dir, segments);
      const pkgDir = posix.join(dir, ...segments).replace(/^\.\/?/, "");
      if (hit.kind === "file") return this.withSubmodules(ix, { ...base, status: "resolved_internal", target: hit, confidence: "high", resolutionMethod: "relative_path" }, hit.path.includes("/__init__.") || hit.path.startsWith("__init__.") ? pkgDir : "\0", ref);
      if (hit.kind === "namespace" || (segments.length === 0 && ix.dirs.has(dir))) {
        const r = this.withSubmodules(ix, { ...base, status: "unresolved", message: "namespace package (no __init__.py) has no file node", diagnosticCode: DiagnosticCodes.RESOLVE_PARTIAL_SUPPORT }, pkgDir, ref);
        return r.nameTargets ? { ...r, status: "resolved_internal", target: Object.values(r.nameTargets)[0]!, confidence: "high", resolutionMethod: "relative_path", message: "imported names are submodules of a namespace package" } : r;
      }
      return { ...base, status: "unresolved", message: `relative module "${".".repeat(ref.relativeLevel)}${ref.specifier}" not found`, diagnosticCode: DiagnosticCodes.RESOLVE_UNRESOLVED };
    }

    const top = segments[0]!;
    const found: { root: string; hit: Lookup }[] = [];
    for (const root of ix.roots) {
      const hit = lookupModule(ix, root, segments);
      if (hit.kind !== "none") found.push({ root, hit });
    }
    const files = found.filter((f) => f.hit.kind === "file");
    const uniquePaths = [...new Set(files.map((f) => (f.hit as { path: string }).path))];

    if (PYTHON_STDLIB.has(top)) {
      if (uniquePaths.length === 0) return { ...base, status: "resolved_external", target: { kind: "package", name: top, ecosystem: "stdlib" }, confidence: "high", resolutionMethod: "stdlib" };
      return {
        ...base,
        status: "ambiguous",
        candidateTargets: [{ kind: "package", name: top, ecosystem: "stdlib" }, ...uniquePaths.map((p) => ({ kind: "file" as const, path: p }))],
        message: `"${ref.specifier}" shadows a standard-library module`,
        diagnosticCode: DiagnosticCodes.RESOLVE_AMBIGUOUS,
      };
    }
    if (uniquePaths.length === 1) {
      const p = uniquePaths[0]!;
      const isPkg = /(^|\/)__init__\.pyi?$/.test(p);
      return this.withSubmodules(ix, { ...base, status: "resolved_internal", target: { kind: "file", path: p }, confidence: "high", resolutionMethod: files[0]!.root === "" ? "python_package_path" : "python_source_root" }, isPkg ? dirOf(p) : "\0", ref);
    }
    if (uniquePaths.length > 1) {
      return { ...base, status: "ambiguous", candidateTargets: uniquePaths.map((p) => ({ kind: "file", path: p })), message: `"${ref.specifier}" exists under several source roots`, diagnosticCode: DiagnosticCodes.RESOLVE_AMBIGUOUS };
    }
    const ns = found.find((f) => f.hit.kind === "namespace");
    if (ns) {
      const r = this.withSubmodules(ix, { ...base, status: "unresolved", message: "namespace package (no __init__.py) has no file node", diagnosticCode: DiagnosticCodes.RESOLVE_PARTIAL_SUPPORT }, (ns.hit as { dir: string }).dir, ref);
      return r.nameTargets ? { ...r, status: "resolved_internal", target: Object.values(r.nameTargets)[0]!, confidence: "high", resolutionMethod: "python_package_path", message: "imported names are submodules of a namespace package" } : r;
    }
    // Script-directory fallback: running a file puts its own directory on sys.path.
    const local = lookupModule(ix, dirOf(ref.fromPath), segments);
    if (local.kind === "file") return { ...base, status: "resolved_internal", target: local, confidence: "medium", resolutionMethod: "python_source_root", message: "resolved relative to the importing file's directory (script-style import)" };

    if (!resolveExternal) return { ...base, status: "ignored", message: "external package resolution disabled by configuration" };
    if (ix.declared.has(top) || ix.declared.has(top.toLowerCase())) return { ...base, status: "resolved_external", target: { kind: "package", name: top, ecosystem: "pypi" }, confidence: "high", resolutionMethod: "manifest_dependency" };
    return { ...base, status: "unresolved", message: `module "${ref.specifier}" not found in the project and not declared as a dependency`, diagnosticCode: DiagnosticCodes.RESOLVE_UNRESOLVED };
  }
}

export function createPythonResolver(): PythonResolver {
  return new PythonResolver();
}
