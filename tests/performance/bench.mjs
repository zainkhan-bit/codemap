#!/usr/bin/env node
/**
 * Reproducible scan benchmark (blueprint §17.5).
 *
 *   node tests/performance/bench.mjs [fileCount ...]     (default: 1000 10000)
 *
 * Generates a deterministic synthetic TS/Python repository per size in the OS temp dir,
 * runs a cold scan (empty data dir) and a warm scan (parse cache populated) in-process,
 * and prints per-phase durations, cache hit rate and peak RSS as JSON. Requires `pnpm build`.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { CodeMapApplication } from "../../packages/application/dist/index.js";

const sizes = process.argv.slice(2).map(Number).filter((n) => n > 0);
if (sizes.length === 0) sizes.push(1000, 10000);

/** Deterministic PRNG so every run generates the same repository. */
function rng(seed) {
  let s = seed >>> 0;
  return () => ((s = (Math.imul(s ^ (s >>> 15), 2246822507) + 0x9e3779b9) >>> 0) / 2 ** 32);
}

function generate(root, count) {
  const rand = rng(count);
  const pyShare = 0.25;
  const files = [];
  for (let i = 0; i < count; i++) {
    const dir = `pkg${i % 40}/mod${Math.floor(i / 40) % 25}`;
    files.push({ i, dir, py: rand() < pyShare });
  }
  writeFileSync(path.join(root, "package.json"), JSON.stringify({ name: "bench", dependencies: { lodash: "4" } }));
  writeFileSync(path.join(root, "pyproject.toml"), '[project]\nname = "bench"\ndependencies = ["requests"]\n');
  for (const f of files) {
    const abs = path.join(root, f.dir);
    mkdirSync(abs, { recursive: true });
    const deps = [1, 2, 3].map(() => files[Math.floor(rand() * count)]).filter((d) => d.py === f.py && d.i !== f.i);
    if (f.py) {
      for (const d of deps) mkdirSync(path.join(root, d.dir), { recursive: true });
      const body = [
        ...deps.map((d) => `from ${d.dir.replace(/\//g, ".")}.f${d.i} import C${d.i}`),
        "import os",
        "import requests",
        "",
        `class C${f.i}:`,
        "    def __init__(self):",
        "        self.ready = True",
        "",
        "    def run(self):",
        ...deps.map((d) => `        C${d.i}().run()`),
        "        return self.helper()",
        "",
        "    def helper(self):",
        "        return os.getcwd()",
        "",
        `def make${f.i}():`,
        `    return C${f.i}()`,
        "",
      ].join("\n");
      writeFileSync(path.join(abs, `f${f.i}.py`), body);
    } else {
      const rel = (d) => {
        const r = path.posix.relative(f.dir, d.dir) || ".";
        return `${r.startsWith(".") ? r : `./${r}`}/f${d.i}`;
      };
      const body = [
        ...deps.map((d) => `import { C${d.i}, make${d.i} } from "${rel(d)}";`),
        'import _ from "lodash";',
        "",
        `export interface I${f.i} { run(): number }`,
        `export class C${f.i} implements I${f.i} {`,
        "  private value = 1;",
        "  run(): number {",
        ...deps.map((d) => `    make${d.i}().run();`),
        "    return this.helper();",
        "  }",
        "  private helper(): number {",
        "    return _.identity(this.value);",
        "  }",
        "}",
        "",
        `export function make${f.i}(): C${f.i} {`,
        `  return new C${f.i}();`,
        "}",
        "",
      ].join("\n");
      writeFileSync(path.join(abs, `f${f.i}.ts`), body);
    }
  }
  for (const d of new Set(files.filter((f) => f.py).flatMap((f) => [f.dir, f.dir.split("/")[0]]))) writeFileSync(path.join(root, d, "__init__.py"), "");
}

async function timedScan(dataDir, root) {
  const app = await CodeMapApplication.open({ dataDir });
  let peak = process.memoryUsage().rss;
  const timer = setInterval(() => (peak = Math.max(peak, process.memoryUsage().rss)), 25);
  const t0 = performance.now();
  try {
    const r = await app.scanProject({ path: root });
    return { wallMs: Math.round(performance.now() - t0), peakRssMiB: Math.round(Math.max(peak, process.memoryUsage().rss) / 1048576), summary: r.summary };
  } finally {
    clearInterval(timer);
    await app.close();
  }
}

const results = [];
for (const n of sizes) {
  const root = mkdtempSync(path.join(os.tmpdir(), `codemap-bench-${n}-`));
  const dataDir = mkdtempSync(path.join(os.tmpdir(), `codemap-bench-data-${n}-`));
  try {
    const g0 = performance.now();
    generate(root, n);
    const genMs = Math.round(performance.now() - g0);
    const cold = await timedScan(dataDir, root);
    const warm = await timedScan(dataDir, root);
    const s = cold.summary;
    results.push({
      files: s.fileCount,
      generationMs: genMs,
      cold: { wallMs: cold.wallMs, phasesMs: s.durationsMs, peakRssMiB: cold.peakRssMiB },
      warm: { wallMs: warm.wallMs, phasesMs: warm.summary.durationsMs, cacheHitRate: +(warm.summary.reusedCount / warm.summary.fileCount).toFixed(3) },
      graph: { nodes: s.nodeCount, edges: s.edgeCount, references: s.referenceCount, cycles: s.cycleCount },
    });
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(dataDir, { recursive: true, force: true });
  }
}

console.log(
  JSON.stringify(
    {
      machine: { platform: `${os.platform()} ${os.release()}`, arch: os.arch(), cpu: os.cpus()[0]?.model, cores: os.availableParallelism(), memoryGiB: Math.round(os.totalmem() / 2 ** 30), node: process.version },
      results,
    },
    null,
    2,
  ),
);
