/**
 * Built-in exclusion rules. See docs/architecture/scanning-pipeline.md for precedence.
 *
 * 1. Hard safety exclusions (cannot be overridden): VCS internals, secret-like files.
 * 2. Built-in generated/dependency exclusions.
 * 3. .gitignore rules (nested files honoured).
 * 4. .codemapignore rules (may re-include with "!pattern" what .gitignore excluded).
 * 5. codemap.config.json "exclude" (always excludes) and "include" (allowlist when non-empty).
 */
import type { ConfigSnapshotKind } from "@codemap/contracts";

/** Directories never entered. */
export const HARD_EXCLUDED_DIRS: ReadonlySet<string> = new Set([".git", ".hg", ".svn", ".bzr", "_darcs", ".jj", "CVS"]);

/** Secret-like files never read, whatever their extension. */
export function isHardExcludedFile(name: string): boolean {
  const lower = name.toLowerCase();
  return (
    /^\.env(\..*)?$/.test(lower) ||
    /\.(pem|key|p12|pfx|keystore|jks|crt|cer)$/.test(lower) ||
    /^id_(rsa|dsa|ecdsa|ed25519)/.test(lower) ||
    lower === ".npmrc" ||
    lower === ".pypirc" ||
    lower === ".netrc"
  );
}

/** Dependency, build-output, cache and virtual-environment directories. */
export const BUILTIN_EXCLUDED_DIRS: ReadonlySet<string> = new Set([
  "node_modules",
  "bower_components",
  "jspm_packages",
  ".pnpm-store",
  ".yarn",
  "dist",
  "build",
  "out",
  "coverage",
  ".nyc_output",
  ".next",
  ".nuxt",
  ".svelte-kit",
  ".turbo",
  ".cache",
  ".parcel-cache",
  ".vercel",
  ".venv",
  "venv",
  "__pycache__",
  ".mypy_cache",
  ".pytest_cache",
  ".ruff_cache",
  ".tox",
  ".nox",
  ".eggs",
  "site-packages",
  ".gradle",
  ".idea",
  ".dart_tool",
]);

export function isBuiltinExcludedDir(name: string): boolean {
  return BUILTIN_EXCLUDED_DIRS.has(name) || name.endsWith(".egg-info");
}

/** Marker files that identify a virtual environment regardless of its directory name. */
export const VENV_MARKERS: readonly string[] = ["pyvenv.cfg"];

export function isBuiltinExcludedFile(name: string): boolean {
  return /\.min\.(js|mjs|cjs)$/.test(name) || /\.bundle\.js$/.test(name) || /\.map$/.test(name);
}

/** Allowlisted configuration files read as static snapshots. Nothing else is ever read as config. */
export function configKindFor(name: string): ConfigSnapshotKind | undefined {
  if (name === "package.json") return "package_json";
  if (name === "tsconfig.json" || /^tsconfig\.[\w.-]+\.json$/.test(name)) return "tsconfig";
  if (name === "jsconfig.json") return "jsconfig";
  if (name === "pyproject.toml") return "pyproject";
  if (name === "pnpm-workspace.yaml") return "pnpm_workspace";
  if (name === "setup.cfg") return "setup_cfg";
  // Only package names are extracted; index URLs or credentials in the file are never retained.
  if (/^requirements[\w.-]*\.txt$/.test(name)) return "requirements_txt";
  return undefined;
}

export const MAX_CONFIG_BYTES = 1_000_000;
