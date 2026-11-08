/**
 * Runtime validation at process boundaries (JSON import/export, storage reads,
 * configuration). Structural checks only; cross-entity invariants live in
 * @codemap/graph-engine.
 */
import {
  CONFIDENCES,
  DIAGNOSTIC_SEVERITIES,
  EDGE_KINDS,
  GRAPH_SCHEMA_VERSION,
  NODE_KINDS,
  REFERENCE_KINDS,
  RESOLUTION_STATUSES,
  SYMBOL_KINDS,
  type CodeMapGraph,
  type SourceLocation,
} from "./graph.js";
import { DEFAULT_CONFIG, MAX_CONCURRENCY, SUPPORTED_LANGUAGES, type CodeMapConfig } from "./project.js";

export interface ValidationResult<T> {
  ok: boolean;
  value?: T;
  errors: string[];
  warnings: string[];
}

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const isString = (v: unknown): v is string => typeof v === "string";
const isNonNegInt = (v: unknown): v is number => Number.isInteger(v) && (v as number) >= 0;
const isPosInt = (v: unknown): v is number => Number.isInteger(v) && (v as number) >= 1;
const oneOf = <T extends string>(values: readonly T[], v: unknown): v is T => isString(v) && (values as readonly string[]).includes(v);

/**
 * True when `p` is a normalized repository-relative POSIX path:
 * no leading slash, no drive letter, no backslash, no "." or ".." segments.
 * The empty string denotes the repository root.
 */
export function isNormalizedRelativePath(p: string): boolean {
  if (p === "") return true;
  if (p.startsWith("/") || p.includes("\\") || /^[A-Za-z]:/.test(p) || p.endsWith("/")) return false;
  return p.split("/").every((seg) => seg !== "" && seg !== "." && seg !== "..");
}

export function validateSourceLocation(loc: unknown, where: string, errors: string[]): loc is SourceLocation {
  if (!isObject(loc)) {
    errors.push(`${where}: location must be an object`);
    return false;
  }
  const before = errors.length;
  if (!isString(loc.path) || !isNormalizedRelativePath(loc.path)) errors.push(`${where}: location.path must be a normalized relative POSIX path`);
  for (const k of ["startByte", "endByte"] as const) if (!isNonNegInt(loc[k])) errors.push(`${where}: location.${k} must be a non-negative integer`);
  for (const k of ["startLine", "startColumn", "endLine", "endColumn"] as const) if (!isPosInt(loc[k])) errors.push(`${where}: location.${k} must be a positive integer`);
  if (errors.length === before) {
    const l = loc as unknown as SourceLocation;
    if (l.endByte < l.startByte) errors.push(`${where}: location.endByte < startByte`);
    if (l.endLine < l.startLine || (l.endLine === l.startLine && l.endColumn < l.startColumn)) errors.push(`${where}: location end precedes start`);
  }
  return errors.length === before;
}

function validateAttributes(v: unknown, where: string, errors: string[]): void {
  if (!isObject(v)) errors.push(`${where}: attributes must be an object`);
}

/** Structural validation of a CodeMap IR v1 graph. */
export function validateGraphSchema(input: unknown): ValidationResult<CodeMapGraph> {
  const errors: string[] = [];
  const warnings: string[] = [];
  if (!isObject(input)) return { ok: false, errors: ["graph must be an object"], warnings };
  if (input.schemaVersion !== GRAPH_SCHEMA_VERSION) errors.push(`unsupported schemaVersion ${JSON.stringify(input.schemaVersion)}; expected "${GRAPH_SCHEMA_VERSION}"`);

  const project = input.project;
  if (!isObject(project) || !isString(project.id) || !isString(project.displayName) || !isString(project.rootLabel)) errors.push("project must have string id, displayName and rootLabel");
  const scan = input.scan;
  if (!isObject(scan)) errors.push("scan must be an object");
  else for (const k of ["id", "toolVersion", "startedAt", "completedAt", "configurationHash", "parserSetHash"]) if (!isString(scan[k])) errors.push(`scan.${k} must be a string`);

  for (const k of ["nodes", "edges", "references", "diagnostics"]) if (!Array.isArray(input[k])) errors.push(`${k} must be an array`);
  if (!isObject(input.metrics) || !Object.values(input.metrics).every((v) => typeof v === "number" && Number.isFinite(v))) errors.push("metrics must be an object of finite numbers");
  if (errors.length > 0) return { ok: false, errors, warnings };

  (input.nodes as unknown[]).forEach((n, i) => {
    const w = `nodes[${i}]`;
    if (!isObject(n)) return void errors.push(`${w}: must be an object`);
    if (!isString(n.id) || n.id === "") errors.push(`${w}: id must be a non-empty string`);
    if (!oneOf(NODE_KINDS, n.kind)) errors.push(`${w}: unknown node kind ${JSON.stringify(n.kind)}`);
    if (!isString(n.name)) errors.push(`${w}: name must be a string`);
    if (n.path !== undefined && (!isString(n.path) || !isNormalizedRelativePath(n.path))) errors.push(`${w}: path must be a normalized relative POSIX path`);
    if (n.symbolKind !== undefined && !oneOf(SYMBOL_KINDS, n.symbolKind)) errors.push(`${w}: unknown symbolKind ${JSON.stringify(n.symbolKind)}`);
    if (n.kind === "symbol" && n.symbolKind === undefined) errors.push(`${w}: symbol nodes require symbolKind`);
    if (n.location !== undefined) validateSourceLocation(n.location, w, errors);
    validateAttributes(n.attributes, w, errors);
  });

  (input.edges as unknown[]).forEach((e, i) => {
    const w = `edges[${i}]`;
    if (!isObject(e)) return void errors.push(`${w}: must be an object`);
    if (!isString(e.id) || e.id === "") errors.push(`${w}: id must be a non-empty string`);
    if (!oneOf(EDGE_KINDS, e.kind)) errors.push(`${w}: unknown edge kind ${JSON.stringify(e.kind)}`);
    if (!isString(e.sourceId) || !isString(e.targetId)) errors.push(`${w}: sourceId/targetId must be strings`);
    if (!oneOf(CONFIDENCES, e.confidence)) errors.push(`${w}: invalid confidence`);
    if (!Array.isArray(e.evidenceReferenceIds) || !e.evidenceReferenceIds.every(isString)) errors.push(`${w}: evidenceReferenceIds must be a string array`);
    validateAttributes(e.attributes, w, errors);
  });

  (input.references as unknown[]).forEach((r, i) => {
    const w = `references[${i}]`;
    if (!isObject(r)) return void errors.push(`${w}: must be an object`);
    if (!isString(r.id) || r.id === "") errors.push(`${w}: id must be a non-empty string`);
    if (!oneOf(REFERENCE_KINDS, r.kind)) errors.push(`${w}: unknown reference kind ${JSON.stringify(r.kind)}`);
    if (!isString(r.sourceNodeId)) errors.push(`${w}: sourceNodeId must be a string`);
    validateSourceLocation(r.sourceLocation, w, errors);
    if (!isString(r.rawText)) errors.push(`${w}: rawText must be a string`);
    if (!oneOf(RESOLUTION_STATUSES, r.status)) errors.push(`${w}: invalid status`);
    if (r.confidence !== undefined && !oneOf(CONFIDENCES, r.confidence)) errors.push(`${w}: invalid confidence`);
    validateAttributes(r.attributes, w, errors);
  });

  (input.diagnostics as unknown[]).forEach((d, i) => {
    const w = `diagnostics[${i}]`;
    if (!isObject(d)) return void errors.push(`${w}: must be an object`);
    if (!isString(d.id) || !isString(d.code) || !isString(d.message)) errors.push(`${w}: id, code and message must be strings`);
    if (!oneOf(DIAGNOSTIC_SEVERITIES, d.severity)) errors.push(`${w}: invalid severity`);
    if (d.location !== undefined) validateSourceLocation(d.location, w, errors);
  });

  return errors.length === 0 ? { ok: true, value: input as unknown as CodeMapGraph, errors, warnings } : { ok: false, errors, warnings };
}

const CONFIG_KEYS = new Set(["$schema", "version", "include", "exclude", "maxFileSizeBytes", "maxFiles", "concurrency", "languages", "resolution", "analysis"]);

/** Validate a parsed codemap.config.json, filling defaults. Unknown keys are warnings. */
export function parseCodeMapConfig(raw: unknown): ValidationResult<CodeMapConfig> {
  const errors: string[] = [];
  const warnings: string[] = [];
  if (!isObject(raw)) return { ok: false, errors: ["configuration must be a JSON object"], warnings };
  for (const k of Object.keys(raw)) if (!CONFIG_KEYS.has(k)) warnings.push(`unknown configuration key "${k}" ignored`);
  if (raw.version !== undefined && raw.version !== 1) errors.push(`unsupported configuration version ${JSON.stringify(raw.version)}; expected 1`);

  const strArray = (key: "include" | "exclude" | "languages"): string[] | undefined => {
    const v = raw[key];
    if (v === undefined) return undefined;
    if (!Array.isArray(v) || !v.every(isString)) {
      errors.push(`"${key}" must be an array of strings`);
      return undefined;
    }
    return v;
  };
  const posInt = (key: "maxFileSizeBytes" | "maxFiles"): number | undefined => {
    const v = raw[key];
    if (v === undefined) return undefined;
    if (!isPosInt(v)) {
      errors.push(`"${key}" must be a positive integer`);
      return undefined;
    }
    return v;
  };
  const bools = <K extends "resolution" | "analysis">(key: K): Partial<CodeMapConfig[K]> => {
    const v = raw[key];
    if (v === undefined) return {};
    if (!isObject(v)) {
      errors.push(`"${key}" must be an object`);
      return {};
    }
    const allowed = Object.keys(DEFAULT_CONFIG[key]);
    const out: Record<string, boolean> = {};
    for (const [k, val] of Object.entries(v)) {
      if (!allowed.includes(k)) warnings.push(`unknown configuration key "${key}.${k}" ignored`);
      else if (typeof val !== "boolean") errors.push(`"${key}.${k}" must be a boolean`);
      else out[k] = val;
    }
    return out as Partial<CodeMapConfig[K]>;
  };

  const languages = strArray("languages");
  if (languages) for (const l of languages) if (!(SUPPORTED_LANGUAGES as readonly string[]).includes(l)) errors.push(`unsupported language "${l}"; supported: ${SUPPORTED_LANGUAGES.join(", ")}`);
  let concurrency: CodeMapConfig["concurrency"] = DEFAULT_CONFIG.concurrency;
  if (raw.concurrency !== undefined) {
    if (raw.concurrency === "auto") concurrency = "auto";
    else if (isPosInt(raw.concurrency) && raw.concurrency <= MAX_CONCURRENCY) concurrency = raw.concurrency;
    else errors.push(`"concurrency" must be "auto" or an integer between 1 and ${MAX_CONCURRENCY}`);
  }

  const config: CodeMapConfig = {
    version: 1,
    include: strArray("include") ?? [...DEFAULT_CONFIG.include],
    exclude: strArray("exclude") ?? [...DEFAULT_CONFIG.exclude],
    maxFileSizeBytes: posInt("maxFileSizeBytes") ?? DEFAULT_CONFIG.maxFileSizeBytes,
    maxFiles: posInt("maxFiles") ?? DEFAULT_CONFIG.maxFiles,
    concurrency,
    languages: languages ?? [...DEFAULT_CONFIG.languages],
    resolution: { ...DEFAULT_CONFIG.resolution, ...bools("resolution") },
    analysis: { ...DEFAULT_CONFIG.analysis, ...bools("analysis") },
  };
  return errors.length === 0 ? { ok: true, value: config, errors, warnings } : { ok: false, errors, warnings };
}
