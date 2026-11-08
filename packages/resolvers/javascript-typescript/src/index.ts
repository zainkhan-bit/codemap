/**
 * Static JavaScript/TypeScript module resolver.
 *
 * Works purely from the discovered file inventory and allowlisted config
 * snapshots (package.json, tsconfig.json, jsconfig.json). It never touches
 * disk, node_modules, or the TypeScript compiler. See
 * docs/architecture/resolution-strategy.md for the supported matrix.
 */
import { builtinModules } from "node:module";
import path from "node:path";
import {
  DiagnosticCodes,
  type ConfigSnapshot,
  type ModuleReferenceFact,
  type ReferenceResolver,
  type ResolutionBatch,
  type ResolutionResult,
  type ResolvedTarget,
  type ResolverDiagnostic,
  type ResolverInput,
} from "@codemap/contracts";
import { parseJsonc } from "./jsonc.js";

export { parseJsonc };

export const RESOLVER_ID = "resolver-javascript-typescript";
export const RESOLVER_VERSION = "0.1.0";

const posix = path.posix;
const NODE_BUILTINS = new Set(builtinModules.filter((m) => !m.startsWith("_")));
const TS_EXT = [".ts", ".tsx", ".mts", ".cts"];
const DTS_EXT = [".d.ts", ".d.mts", ".d.cts"];
const JS_EXT = [".js", ".jsx", ".mjs", ".cjs"];
const PROBE_EXT = [...TS_EXT, ...DTS_EXT, ...JS_EXT];
const JS_TO_TS: Record<string, string[]> = { ".js": [".ts", ".tsx", ".d.ts"], ".jsx": [".tsx"], ".mjs": [".mts", ".d.mts"], ".cjs": [".cts", ".d.cts"] };
const ASSET_EXT = /\.(css|scss|sass|less|styl|svg|png|jpe?g|gif|webp|avif|ico|bmp|json|json5|md|mdx|html?|wasm|txt|ya?ml|toml|graphql|gql|vue|svelte|astro|woff2?|ttf|otf|eot|mp3|mp4|webm|wav|csv|xml)$/i;
const EXPORT_CONDITIONS = ["types", "import", "module", "require", "node", "default"];

interface PackageInfo {
  dir: string;
  name?: string;
  exports?: unknown;
  imports?: Record<string, unknown>;
  entryFields: string[];
  dependencies: Set<string>;
}

interface TsConfigInfo {
  dir: string;
  baseUrl?: string;
  paths?: { pattern: string; targets: string[] }[];
  /** Directory `paths` targets are relative to (baseUrl or the defining config's dir). */
  pathsBase?: string;
}

function extFamily(p: string): "ts" | "dts" | "js" {
  if (DTS_EXT.some((e) => p.endsWith(e))) return "dts";
  if (TS_EXT.some((e) => p.endsWith(e))) return "ts";
  return "js";
}

function packageNameOf(spec: string): { name: string; subpath: string } | undefined {
  const parts = spec.split("/");
  if (spec.startsWith("@")) {
    if (parts.length < 2 || !parts[1]) return undefined;
    return { name: `${parts[0]}/${parts[1]}`, subpath: parts.slice(2).join("/") };
  }
  return { name: parts[0]!, subpath: parts.slice(1).join("/") };
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

class ProjectIndex {
  readonly files: Set<string>;
  readonly packages = new Map<string, PackageInfo>(); // by dir
  readonly workspace = new Map<string, PackageInfo>(); // by package name
  readonly tsconfigs = new Map<string, TsConfigInfo>(); // by dir (tsconfig.json / jsconfig.json only)
  readonly diagnostics: ResolverDiagnostic[] = [];

  constructor(files: readonly string[], configs: readonly ConfigSnapshot[]) {
    this.files = new Set(files);
    const byPath = new Map(configs.map((c) => [c.path, c]));
    for (const c of configs) if (c.kind === "package_json") this.addPackage(c);
    for (const c of configs) {
      const base = posix.basename(c.path);
      if ((c.kind === "tsconfig" && base === "tsconfig.json") || c.kind === "jsconfig") {
        const dir = posix.dirname(c.path) === "." ? "" : posix.dirname(c.path);
        if (c.kind === "jsconfig" && this.tsconfigs.has(dir)) continue;
        const info = this.loadTsconfig(c.path, byPath, new Set());
        if (info) this.tsconfigs.set(dir, info);
      }
    }
  }

  private addPackage(c: ConfigSnapshot): void {
    let json: unknown;
    try {
      json = JSON.parse(c.text.replace(/^﻿/, ""));
    } catch {
      this.diagnostics.push({ code: DiagnosticCodes.CONFIG_INVALID, severity: "warning", message: "package.json is not valid JSON; ignored for resolution", path: c.path });
      return;
    }
    if (!isRecord(json)) return;
    const dir = posix.dirname(c.path) === "." ? "" : posix.dirname(c.path);
    const deps = new Set<string>();
    for (const field of ["dependencies", "devDependencies", "peerDependencies", "optionalDependencies"]) {
      const d = json[field];
      if (isRecord(d)) for (const k of Object.keys(d)) deps.add(k);
    }
    const info: PackageInfo = {
      dir,
      ...(typeof json.name === "string" ? { name: json.name } : {}),
      ...(json.exports !== undefined ? { exports: json.exports } : {}),
      ...(isRecord(json.imports) ? { imports: json.imports } : {}),
      entryFields: ["source", "types", "typings", "module", "main"].map((f) => json[f]).filter((v): v is string => typeof v === "string"),
      dependencies: deps,
    };
    this.packages.set(dir, info);
    if (info.name && !this.workspace.has(info.name)) this.workspace.set(info.name, info);
  }

  private loadTsconfig(cfgPath: string, byPath: Map<string, ConfigSnapshot>, seen: Set<string>): TsConfigInfo | undefined {
    if (seen.has(cfgPath)) return undefined;
    seen.add(cfgPath);
    const snap = byPath.get(cfgPath);
    if (!snap) return undefined;
    let json: unknown;
    try {
      json = parseJsonc(snap.text);
    } catch {
      this.diagnostics.push({ code: DiagnosticCodes.CONFIG_INVALID, severity: "warning", message: "tsconfig is not valid JSON(C); ignored for resolution", path: cfgPath });
      return undefined;
    }
    if (!isRecord(json)) return undefined;
    const dir = posix.dirname(cfgPath) === "." ? "" : posix.dirname(cfgPath);
    let info: TsConfigInfo = { dir };
    const ext = typeof json.extends === "string" ? [json.extends] : Array.isArray(json.extends) ? json.extends.filter((e): e is string => typeof e === "string") : [];
    for (const e of ext) {
      if (e.startsWith(".")) {
        let target = posix.normalize(posix.join(dir, e));
        if (!target.endsWith(".json")) target += ".json";
        const parent = this.loadTsconfig(target, byPath, seen);
        if (parent) info = { ...parent, dir };
        else this.diagnostics.push({ code: DiagnosticCodes.RESOLVE_PARTIAL_SUPPORT, severity: "info", message: `extended config "${e}" was not found in the scanned project`, path: cfgPath });
      } else {
        this.diagnostics.push({ code: DiagnosticCodes.RESOLVE_PARTIAL_SUPPORT, severity: "info", message: `extending package config "${e}" is not supported; its compilerOptions are ignored`, path: cfgPath });
      }
    }
    const co = isRecord(json.compilerOptions) ? json.compilerOptions : {};
    if (typeof co.baseUrl === "string") info.baseUrl = posix.normalize(posix.join(dir, co.baseUrl)).replace(/^\.$/, "").replace(/\/$/, "");
    if (isRecord(co.paths)) {
      info.paths = Object.entries(co.paths)
        .filter((e): e is [string, string[]] => Array.isArray(e[1]))
        .map(([pattern, targets]) => ({ pattern, targets: targets.filter((t) => typeof t === "string") }));
      info.pathsBase = info.baseUrl ?? dir;
    } else if (info.paths && typeof co.baseUrl === "string") info.pathsBase = info.baseUrl;
    for (const opt of ["rootDirs"]) if (co[opt] !== undefined) this.diagnostics.push({ code: DiagnosticCodes.RESOLVE_PARTIAL_SUPPORT, severity: "info", message: `compilerOptions.${opt} is not supported by the static resolver`, path: cfgPath });
    return info;
  }

  nearest<T>(map: Map<string, T>, fromDir: string): T | undefined {
    let d = fromDir;
    for (;;) {
      const v = map.get(d);
      if (v) return v;
      if (d === "") return undefined;
      d = d.includes("/") ? d.slice(0, d.lastIndexOf("/")) : "";
    }
  }

  dependencyDeclared(name: string, fromDir: string): boolean {
    let d: string | undefined = fromDir;
    while (d !== undefined) {
      if (this.packages.get(d)?.dependencies.has(name)) return true;
      d = d === "" ? undefined : d.includes("/") ? d.slice(0, d.lastIndexOf("/")) : "";
    }
    return false;
  }
}

type Probe = { kind: "found"; path: string } | { kind: "ambiguous"; candidates: string[] } | { kind: "none" };

export class JavaScriptTypeScriptResolver implements ReferenceResolver {
  readonly id = RESOLVER_ID;
  readonly version = RESOLVER_VERSION;
  readonly languages = ["javascript", "typescript"] as const;

  async resolve(input: ResolverInput): Promise<ResolutionBatch> {
    const index = new ProjectIndex(input.projectContext.sourceFiles, input.projectContext.configs);
    const results = input.references.filter((r) => this.languages.includes(r.language as "javascript")).map((r) => this.resolveOne(index, r, input.resolutionOptions.resolveExternalPackages));
    return { resolverId: this.id, resolverVersion: this.version, results, diagnostics: index.diagnostics };
  }

  private resolveOne(ix: ProjectIndex, ref: ModuleReferenceFact, resolveExternal: boolean): ResolutionResult {
    const base = { referenceKey: ref.referenceKey };
    const spec = ref.specifier;
    if (ref.isDynamicExpression || spec === undefined) return { ...base, status: "unresolved", message: "module specifier is computed at runtime; not statically resolvable", diagnosticCode: DiagnosticCodes.RESOLVE_UNRESOLVED };
    const fromDir = posix.dirname(ref.fromPath) === "." ? "" : posix.dirname(ref.fromPath);
    const preferTs = extFamily(ref.fromPath) !== "js";

    if (spec.startsWith("node:") || NODE_BUILTINS.has(spec) || NODE_BUILTINS.has(spec.split("/")[0]!)) {
      const name = spec.startsWith("node:") ? spec : `node:${spec}`;
      return { ...base, status: "resolved_external", target: { kind: "package", name: name.split("/")[0]!, ecosystem: "node_builtin" }, confidence: "high", resolutionMethod: "stdlib" };
    }

    if (spec.startsWith("./") || spec.startsWith("../") || spec === "." || spec === "..") {
      const joined = posix.normalize(posix.join(fromDir, spec));
      if (joined === ".." || joined.startsWith("../")) return { ...base, status: "unresolved", message: "relative import points outside the scanned project", diagnosticCode: DiagnosticCodes.RESOLVE_UNRESOLVED };
      if (ASSET_EXT.test(spec)) return { ...base, status: "ignored", message: "non-code asset import" };
      return this.fromProbe(base, this.probe(ix, joined === "." ? "" : joined, preferTs), "relative_path", "high", spec);
    }
    if (spec.startsWith("/") || /^[A-Za-z]:/.test(spec) || /^[a-z][a-z0-9+.-]*:/i.test(spec)) {
      return { ...base, status: "unresolved", message: "absolute paths and URL specifiers are not resolved", diagnosticCode: DiagnosticCodes.RESOLVE_UNRESOLVED };
    }

    if (spec.startsWith("#")) {
      const pkg = ix.nearest(ix.packages, fromDir);
      const mapped = pkg?.imports ? this.matchExportsMap(pkg.imports, spec) : undefined;
      for (const t of mapped ?? []) {
        const r = this.probeTarget(ix, pkg!.dir, t, preferTs);
        if (r) return { ...base, status: "resolved_internal", target: { kind: "file", path: r.path }, confidence: r.confidence, resolutionMethod: "package_imports" };
      }
      return { ...base, status: "unresolved", message: `subpath import "${spec}" not found in package.json "imports"`, diagnosticCode: DiagnosticCodes.RESOLVE_UNRESOLVED };
    }

    const ts = ix.nearest(ix.tsconfigs, fromDir);
    if (ts?.paths && ts.pathsBase !== undefined) {
      const hit = this.matchTsPaths(ix, ts, spec, preferTs);
      if (hit) return { ...base, ...hit };
    }
    if (ts?.baseUrl !== undefined) {
      const p = this.probe(ix, posix.join(ts.baseUrl, spec).replace(/^\.\//, ""), preferTs);
      if (p.kind !== "none") return this.fromProbe(base, p, "tsconfig_base_url", "high", spec);
    }

    const pkgName = packageNameOf(spec);
    if (!pkgName) return { ...base, status: "unresolved", message: "malformed package specifier", diagnosticCode: DiagnosticCodes.RESOLVE_UNRESOLVED };
    const ws = ix.workspace.get(pkgName.name);
    if (ws) {
      const r = this.resolveWorkspacePackage(ix, ws, pkgName.subpath, preferTs);
      if (r) return { ...base, status: "resolved_internal", target: { kind: "file", path: r.path }, confidence: r.confidence, resolutionMethod: r.method };
      return { ...base, status: "unresolved", message: `workspace package "${pkgName.name}" has no resolvable entry for "${spec}"`, diagnosticCode: DiagnosticCodes.RESOLVE_UNRESOLVED };
    }
    if (!resolveExternal) return { ...base, status: "ignored", message: "external package resolution disabled by configuration" };
    if (ix.dependencyDeclared(pkgName.name, fromDir) || (ref.isTypeOnly && ix.dependencyDeclared(`@types/${pkgName.name.replace(/^@/, "").replace("/", "__")}`, fromDir))) {
      return { ...base, status: "resolved_external", target: { kind: "package", name: pkgName.name, ecosystem: "npm" }, confidence: "high", resolutionMethod: "manifest_dependency" };
    }
    return { ...base, status: "unresolved", message: `package "${pkgName.name}" is not declared in any package.json`, diagnosticCode: DiagnosticCodes.RESOLVE_UNRESOLVED };
  }

  private fromProbe(base: { referenceKey: string }, p: Probe, method: string, confidence: "high" | "medium", spec: string): ResolutionResult {
    if (p.kind === "found") return { ...base, status: "resolved_internal", target: { kind: "file", path: p.path }, confidence, resolutionMethod: method };
    if (p.kind === "ambiguous") {
      const candidateTargets: ResolvedTarget[] = p.candidates.map((c) => ({ kind: "file", path: c }));
      return { ...base, status: "ambiguous", candidateTargets, message: `"${spec}" matches ${p.candidates.length} files equally: ${p.candidates.join(", ")}`, diagnosticCode: DiagnosticCodes.RESOLVE_AMBIGUOUS };
    }
    return { ...base, status: "unresolved", message: `no source file found for "${spec}"`, diagnosticCode: DiagnosticCodes.RESOLVE_UNRESOLVED };
  }

  /**
   * Node/TypeScript-style probing in tiers: exact file, extension (incl. TS's .js→.ts mapping),
   * then directory index. Within a tier the importer's language family is preferred; remaining
   * ties are reported as ambiguous rather than silently picking one.
   */
  probe(ix: ProjectIndex, target: string, preferTs: boolean): Probe {
    const famRank = (p: string) => {
      const f = extFamily(p);
      return preferTs ? { ts: 0, dts: 1, js: 2 }[f] : { js: 0, ts: 1, dts: 2 }[f];
    };
    const pick = (cands: string[]): Probe => {
      const present = [...new Set(cands)].filter((c) => ix.files.has(c));
      if (present.length === 0) return { kind: "none" };
      const best = Math.min(...present.map(famRank));
      const top = present.filter((c) => famRank(c) === best);
      if (top.length === 1) return { kind: "found", path: top[0]! };
      return { kind: "ambiguous", candidates: top.sort() };
    };
    if (target !== "" && ix.files.has(target)) return { kind: "found", path: target };
    const ext = posix.extname(target);
    const tier2: string[] = [];
    if (JS_TO_TS[ext]) for (const e of JS_TO_TS[ext]!) tier2.push(target.slice(0, -ext.length) + e);
    if (target !== "") for (const e of PROBE_EXT) tier2.push(target + e);
    const t2 = pick(tier2);
    if (t2.kind !== "none") return t2;
    const dir = target;
    const pkg = ix.packages.get(dir);
    if (pkg && dir !== "") {
      for (const field of pkg.entryFields) {
        const r = this.probeTarget(ix, dir, field, preferTs);
        if (r) return { kind: "found", path: r.path };
      }
    }
    return pick(PROBE_EXT.map((e) => (dir === "" ? `index${e}` : `${dir}/index${e}`)));
  }

  /** Resolves a package-relative target (e.g. "./dist/index.js"), mapping build output to source by convention. */
  private probeTarget(ix: ProjectIndex, pkgDir: string, target: string, preferTs: boolean): { path: string; confidence: "high" | "medium" } | undefined {
    const rel = posix.normalize(posix.join(pkgDir, target)).replace(/^\.\/?/, "");
    if (rel.startsWith("../")) return undefined;
    const direct = this.probe(ix, rel, preferTs);
    if (direct.kind === "found") return { path: direct.path, confidence: "high" };
    // Build output (dist/, lib/, build/, out/) is excluded from scanning; map it back to src/ by convention.
    const inner = posix.normalize(target).replace(/^\.\//, "");
    const m = /^(dist|lib|build|out|esm|cjs)\/(.*)$/.exec(inner);
    if (m) {
      const stripped = m[2]!.replace(/\.d\.(m|c)?ts$/, "").replace(/\.(m|c)?js$/, "");
      const srcPath = posix.join(pkgDir, "src", stripped);
      const p = this.probe(ix, srcPath, preferTs);
      if (p.kind === "found") return { path: p.path, confidence: "medium" };
    }
    return undefined;
  }

  private resolveWorkspacePackage(ix: ProjectIndex, pkg: PackageInfo, subpath: string, preferTs: boolean): { path: string; confidence: "high" | "medium"; method: string } | undefined {
    const key = subpath ? `./${subpath}` : ".";
    if (pkg.exports !== undefined) {
      const exportsMap: Record<string, unknown> = isRecord(pkg.exports) && Object.keys(pkg.exports).some((k) => k.startsWith(".")) ? pkg.exports : { ".": pkg.exports };
      const targets = this.matchExportsMap(exportsMap, key);
      if (targets) {
        for (const t of targets) {
          const r = this.probeTarget(ix, pkg.dir, t, preferTs);
          if (r) return { ...r, method: "package_exports" };
        }
        return undefined;
      }
    }
    if (subpath) {
      const r = this.probeTarget(ix, pkg.dir, `./${subpath}`, preferTs);
      return r ? { ...r, method: "workspace_package" } : undefined;
    }
    for (const field of pkg.entryFields) {
      const r = this.probeTarget(ix, pkg.dir, field, preferTs);
      if (r) return { ...r, method: "package_main" };
    }
    const idx = this.probe(ix, pkg.dir === "" ? "index" : `${pkg.dir}/index`, preferTs);
    if (idx.kind === "found") return { path: idx.path, confidence: "high", method: "package_main" };
    const src = this.probe(ix, posix.join(pkg.dir, "src/index"), preferTs);
    return src.kind === "found" ? { path: src.path, confidence: "medium", method: "workspace_package" } : undefined;
  }

  /** Matches a package.json exports/imports map key (exact or single "*" pattern); returns candidate targets in condition order. */
  private matchExportsMap(map: Record<string, unknown>, key: string): string[] | undefined {
    let value: unknown;
    let star: string | undefined;
    if (key in map) value = map[key];
    else {
      let bestLen = -1;
      for (const [k, v] of Object.entries(map)) {
        const i = k.indexOf("*");
        if (i < 0) continue;
        const pre = k.slice(0, i);
        const post = k.slice(i + 1);
        if (key.startsWith(pre) && key.endsWith(post) && key.length >= pre.length + post.length && pre.length > bestLen) {
          bestLen = pre.length;
          value = v;
          star = key.slice(pre.length, key.length - post.length);
        }
      }
    }
    if (value === undefined) return undefined;
    const out: string[] = [];
    const collect = (v: unknown) => {
      if (typeof v === "string") out.push(star !== undefined ? v.replaceAll("*", star) : v);
      else if (Array.isArray(v)) v.forEach(collect);
      else if (isRecord(v)) {
        for (const c of EXPORT_CONDITIONS) if (c in v) collect(v[c]);
        for (const [c, sub] of Object.entries(v)) if (!EXPORT_CONDITIONS.includes(c)) collect(sub);
      }
    };
    collect(value);
    return out;
  }

  private matchTsPaths(ix: ProjectIndex, ts: TsConfigInfo, spec: string, preferTs: boolean): Omit<ResolutionResult, "referenceKey"> | undefined {
    let best: { targets: string[]; star: string; prefixLen: number } | undefined;
    for (const { pattern, targets } of ts.paths ?? []) {
      const i = pattern.indexOf("*");
      if (i < 0) {
        if (pattern === spec) {
          best = { targets, star: "", prefixLen: Infinity };
          break;
        }
        continue;
      }
      const pre = pattern.slice(0, i);
      const post = pattern.slice(i + 1);
      if (spec.startsWith(pre) && spec.endsWith(post) && spec.length >= pre.length + post.length && (!best || pre.length > best.prefixLen)) {
        best = { targets, star: spec.slice(pre.length, spec.length - post.length), prefixLen: pre.length };
      }
    }
    if (!best) return undefined;
    for (const t of best.targets) {
      const p = this.probe(ix, posix.normalize(posix.join(ts.pathsBase!, t.replaceAll("*", best.star))).replace(/^\.\/?/, ""), preferTs);
      if (p.kind === "found") return { status: "resolved_internal", target: { kind: "file", path: p.path }, confidence: "high", resolutionMethod: "tsconfig_paths" };
      if (p.kind === "ambiguous") return { status: "ambiguous", candidateTargets: p.candidates.map((c) => ({ kind: "file" as const, path: c })), message: `"${spec}" matches ${p.candidates.length} files equally via tsconfig paths`, diagnosticCode: DiagnosticCodes.RESOLVE_AMBIGUOUS };
    }
    return undefined;
  }
}

export function createJavaScriptTypeScriptResolver(): JavaScriptTypeScriptResolver {
  return new JavaScriptTypeScriptResolver();
}
