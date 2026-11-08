/** Runs the built CLI (apps/cli/dist) as a subprocess with an isolated data directory. */
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { lstatSync, mkdtempSync, readFileSync, readdirSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const REPO_ROOT = fileURLToPath(new URL("../../", import.meta.url));
export const CLI = path.join(REPO_ROOT, "apps", "cli", "dist", "index.js");
export const FIXTURES = path.join(REPO_ROOT, "tests", "fixtures");

export interface CliResult {
  code: number;
  stdout: string;
  stderr: string;
  json<T = Record<string, unknown>>(): T;
}

export function newDataDir(): string {
  return mkdtempSync(path.join(os.tmpdir(), "codemap-e2e-data-"));
}

export function runCli(args: string[], opts: { cwd?: string; dataDir: string; env?: Record<string, string> }): CliResult {
  const r = spawnSync(process.execPath, [CLI, ...args], {
    cwd: opts.cwd ?? REPO_ROOT,
    env: { ...process.env, CODEMAP_DATA_DIR: opts.dataDir, NO_COLOR: "1", ...opts.env },
    encoding: "utf8",
    timeout: 120_000,
  });
  return {
    code: r.status ?? -1,
    stdout: r.stdout,
    stderr: r.stderr,
    json<T>() {
      return JSON.parse(r.stdout) as T;
    },
  };
}

/** Hash of every file path, size and content under `dir` — proves a scan wrote nothing. */
export function treeFingerprint(dir: string): string {
  const h = createHash("sha256");
  const walk = (d: string) => {
    for (const name of readdirSync(d).sort()) {
      const p = path.join(d, name);
      const st = lstatSync(p);
      h.update(`${path.relative(dir, p)}|${st.size}|${st.mtimeMs}\n`);
      if (st.isSymbolicLink()) continue;
      if (st.isDirectory()) walk(p);
      else h.update(readFileSync(p));
    }
  };
  walk(dir);
  return h.digest("hex");
}
