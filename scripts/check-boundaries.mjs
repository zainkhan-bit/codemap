#!/usr/bin/env node
/**
 * Enforces the package dependency rules from the blueprint (§5.2):
 * allowed @codemap/* imports per package, forbidden third-party/builtin modules,
 * no network or subprocess modules anywhere in shipped code, no circular package deps,
 * and package.json dependencies that match actual imports.
 */
import { readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

/** package dir → { allowed CodeMap deps, forbidden module patterns } */
const RULES = {
  "packages/contracts": { allow: [], forbid: [/^node:(fs|child_process|http|https|net)/] },
  "packages/graph-engine": { allow: ["contracts"], forbid: [/^node:(fs|path|os|http|https|net)/, /^better-sqlite3$/, /^web-tree-sitter$/, /^tree-sitter/] },
  "packages/scanner": { allow: ["contracts"], forbid: [/^web-tree-sitter$/, /^better-sqlite3$/] },
  "packages/parser-runtime": { allow: ["contracts"], forbid: [/^better-sqlite3$/] },
  "packages/adapters/javascript-typescript": { allow: ["contracts", "parser-runtime"], forbid: [/^better-sqlite3$/, /^node:fs/] },
  "packages/adapters/python": { allow: ["contracts", "parser-runtime"], forbid: [/^better-sqlite3$/, /^node:fs/] },
  "packages/resolvers/javascript-typescript": { allow: ["contracts"], forbid: [/^node:fs/, /^web-tree-sitter$/, /^better-sqlite3$/, /^typescript$/] },
  "packages/resolvers/python": { allow: ["contracts"], forbid: [/^node:fs/, /^web-tree-sitter$/, /^better-sqlite3$/] },
  "packages/storage-sqlite": { allow: ["contracts"], forbid: [/^web-tree-sitter$/] },
  "packages/exporters": { allow: ["contracts", "graph-engine"], forbid: [/^node:fs/, /^better-sqlite3$/, /^web-tree-sitter$/] },
  "packages/rasterizer-png": { allow: [], forbid: [/^node:fs/, /^better-sqlite3$/, /^web-tree-sitter$/] },
  "packages/application": { allow: ["rasterizer-png", "contracts", "scanner", "adapter-javascript-typescript", "adapter-python", "resolver-javascript-typescript", "resolver-python", "graph-engine", "storage-sqlite", "exporters"], forbid: [] },
  "apps/cli": { allow: ["contracts", "application"], forbid: [/^better-sqlite3$/, /^web-tree-sitter$/] },
};
/** Never allowed in shipped code: CodeMap makes no network calls and executes nothing. */
const GLOBAL_FORBID = [/^(node:)?(child_process|http|https|http2|net|dgram|tls|worker_threads|vm)$/];

const errors = [];
const graph = new Map();

function sources(dir) {
  const out = [];
  for (const name of readdirSync(dir)) {
    const p = path.join(dir, name);
    if (statSync(p).isDirectory()) out.push(...sources(p));
    else if (/\.ts$/.test(name) && !/\.test\.ts$/.test(name)) out.push(p);
  }
  return out;
}

for (const [dir, rule] of Object.entries(RULES)) {
  const pkg = JSON.parse(readFileSync(path.join(root, dir, "package.json"), "utf8"));
  const declared = new Set([...Object.keys(pkg.dependencies ?? {}), ...Object.keys(pkg.optionalDependencies ?? {})]);
  const used = new Set();
  const allowed = new Set(rule.allow.map((a) => `@codemap/${a}`));
  for (const file of sources(path.join(root, dir, "src"))) {
    // Strip comments so prose such as `require("x")` in docs is not mistaken for an import.
    const text = readFileSync(file, "utf8")
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/(^|[^:"'\\])\/\/[^\n]*/g, "$1");
    for (const m of text.matchAll(/(?:^|\n)\s*(?:import|export)[^"';]*?from\s+["']([^"']+)["']|import\(\s*["']([^"']+)["']\s*\)|require\(\s*["']([^"']+)["']\s*\)/g)) {
      const spec = m[1] ?? m[2] ?? m[3];
      if (spec.startsWith(".")) continue;
      const rel = path.relative(root, file);
      const bare = spec.startsWith("@") ? spec.split("/").slice(0, 2).join("/") : spec.split("/")[0];
      if (bare.startsWith("@codemap/")) {
        used.add(bare);
        if (!allowed.has(bare)) errors.push(`${rel}: ${pkg.name} must not import ${bare}`);
      }
      for (const f of [...rule.forbid, ...GLOBAL_FORBID]) if (f.test(spec)) errors.push(`${rel}: ${pkg.name} must not import "${spec}"`);
      if (!spec.startsWith("node:") && !bare.startsWith("@codemap/") && !declared.has(bare)) errors.push(`${rel}: imports "${bare}" which is not declared in ${dir}/package.json`);
    }
  }
  for (const d of declared) if (d.startsWith("@codemap/") && !used.has(d)) errors.push(`${dir}/package.json declares unused dependency ${d}`);
  graph.set(pkg.name, [...declared].filter((d) => d.startsWith("@codemap/")));
}

// Cycle detection over declared package dependencies.
const state = new Map();
const visit = (n, trail) => {
  if (state.get(n) === 2) return;
  if (state.get(n) === 1) return void errors.push(`circular package dependency: ${[...trail, n].join(" → ")}`);
  state.set(n, 1);
  for (const d of graph.get(n) ?? []) visit(d, [...trail, n]);
  state.set(n, 2);
};
for (const n of graph.keys()) visit(n, []);

if (errors.length) {
  console.error(`Package boundary check failed (${errors.length}):`);
  for (const e of errors) console.error(`  - ${e}`);
  process.exit(1);
}
console.log(`Package boundaries OK (${Object.keys(RULES).length} packages, no cycles, no network/subprocess modules).`);
