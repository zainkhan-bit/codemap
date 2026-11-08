/**
 * Security tests (blueprint §17.4): read-only scanning, no code execution,
 * no secret ingestion, no absolute-path leakage, hostile input treated as data.
 */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import Database from "better-sqlite3";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { CodeMapGraph } from "@codemap/contracts";
import { newDataDir, runCli, treeFingerprint } from "../helpers/cli.js";

let repo: string;
let outside: string;
let dataDir: string;
const MARKER = "codemap-executed-marker.txt";

beforeAll(() => {
  repo = mkdtempSync(path.join(os.tmpdir(), "codemap-sec-repo-"));
  outside = mkdtempSync(path.join(os.tmpdir(), "codemap-sec-outside-"));
  dataDir = newDataDir();
  const markerPath = JSON.stringify(path.join(outside, MARKER));
  // Would leave a marker if CodeMap ever executed project code, scripts or package managers.
  writeFileSync(path.join(repo, "package.json"), JSON.stringify({ name: "evil", scripts: { preinstall: `node -e "require('fs').writeFileSync(${markerPath},'x')"`, postinstall: "node evil.js", prepare: "node evil.js" }, dependencies: { leftpad: "1" } }));
  writeFileSync(path.join(repo, "evil.js"), `require("fs").writeFileSync(${markerPath}, "executed");\nmodule.exports = 1;\n`);
  writeFileSync(path.join(repo, "setup.py"), `open(${markerPath}, "w").write("executed")\n`);
  writeFileSync(path.join(repo, "conftest.py"), `import os\nopen(${markerPath}, "w").write("executed")\n`);
  writeFileSync(path.join(repo, ".env"), "API_TOKEN=sk-live-SUPERSECRET\n");
  writeFileSync(path.join(repo, ".env.local"), "PASSWORD=SUPERSECRET2\n");
  writeFileSync(path.join(repo, "id_rsa"), "-----BEGIN OPENSSH PRIVATE KEY----- SUPERSECRET3\n");
  writeFileSync(path.join(repo, "xss.ts"), 'export class X { "<img src=x onerror=alert(1)>"() {} }\nexport function payload() { return "</svg><script>alert(1)</script>"; }\nimport "</svg><script>alert(2)</script>";\n');
  writeFileSync(path.join(repo, "deep.ts"), `export const d = ${"(".repeat(5000)}1${")".repeat(5000)};\n`);
  writeFileSync(path.join(repo, "tsconfig.json"), "{ this is : not json ,,, ");
  writeFileSync(path.join(repo, "pyproject.toml"), "[project\nname = = broken\n");
  writeFileSync(path.join(repo, "secret_outside_link.ts"), "export const ok = 1;\n");
  writeFileSync(path.join(outside, "stolen.ts"), "export const SECRET_OUTSIDE = 'SUPERSECRET4';\n");
  try {
    symlinkSync(outside, path.join(repo, "escape"), "junction");
    symlinkSync(repo, path.join(repo, "cycle"), "junction");
  } catch {
    /* symlink creation may need privileges on Windows; the scanner rules are unit-tested separately */
  }
});

afterAll(() => {
  for (const d of [repo, outside, dataDir]) rmSync(d, { recursive: true, force: true });
});

describe("security", () => {
  it("scans without writing to the repository or executing project code", () => {
    const before = treeFingerprint(repo);
    const r = runCli(["scan", repo, "--json"], { dataDir });
    expect(r.code, r.stderr).toBeLessThanOrEqual(1);
    expect(treeFingerprint(repo)).toBe(before);
    expect(existsSync(path.join(outside, MARKER))).toBe(false);
    expect(readdirSync(repo).some((n) => n.toLowerCase().includes("codemap") && n !== "codemap.config.json")).toBe(false);
  });

  it("never follows symlinks out of the root or into loops", () => {
    const out = path.join(dataDir, "g.json");
    runCli(["export", "--format", "json", "-o", out], { dataDir, cwd: repo });
    const g = JSON.parse(readFileSync(out, "utf8")) as CodeMapGraph;
    expect(g.nodes.some((n) => n.path?.startsWith("escape/") || n.path?.startsWith("cycle/"))).toBe(false);
  });

  it("never ingests secrets or absolute paths into exports or the database", () => {
    const out = path.join(dataDir, "g2.json");
    runCli(["export", "--format", "json", "-o", out], { dataDir, cwd: repo });
    const exported = readFileSync(out, "utf8");
    for (const s of ["SUPERSECRET", "sk-live"]) expect(exported).not.toContain(s);
    expect(exported).not.toContain(repo);
    expect(exported).not.toContain(repo.replace(/\\/g, "/"));
    expect(exported).not.toContain(os.homedir());

    const db = new Database(path.join(dataDir, "codemap.db"), { readonly: true });
    try {
      const tables = ["graph_nodes", "graph_edges", "graph_references", "diagnostics", "artifact_cache", "scan_files"];
      for (const t of tables) {
        const dump = JSON.stringify(db.prepare(`SELECT * FROM ${t}`).all());
        expect(dump, t).not.toContain("SUPERSECRET");
      }
      // The canonical root is local project metadata only.
      expect(JSON.stringify(db.prepare("SELECT * FROM graph_nodes").all())).not.toContain(path.basename(path.dirname(repo)) + path.sep);
    } finally {
      db.close();
    }
  });

  it("treats HTML/JS payloads in identifiers and strings as inert data in SVG", () => {
    const out = path.join(dataDir, "x.svg");
    const r = runCli(["export", "--format", "svg", "--view", "symbol_view", "-o", out], { dataDir, cwd: repo });
    expect(r.code, r.stderr).toBe(0);
    const svg = readFileSync(out, "utf8");
    expect(svg).not.toMatch(/<script/i);
    expect(svg).not.toMatch(/<img/i);
  });

  it("survives malformed manifests and deeply nested syntax with diagnostics, not crashes", () => {
    const out = path.join(dataDir, "g3.json");
    runCli(["export", "--format", "json", "-o", out], { dataDir, cwd: repo });
    const g = JSON.parse(readFileSync(out, "utf8")) as CodeMapGraph;
    expect(g.diagnostics.some((d) => d.code === "SCAN006" && d.attributes?.path === "tsconfig.json")).toBe(true);
    expect(g.nodes.some((n) => n.path === "deep.ts")).toBe(true);
  });

  it("rejects path traversal and non-directory roots", () => {
    expect(runCli(["scan", path.join(repo, "..", "..", "definitely-not-here-codemap")], { dataDir }).code).toBe(3);
    expect(runCli(["scan", path.join(repo, "evil.js")], { dataDir }).code).toBe(3);
  });

  it("scanning an empty directory works and creates nothing inside it", () => {
    const empty = mkdtempSync(path.join(os.tmpdir(), "codemap-empty-"));
    mkdirSync(path.join(empty, "sub"));
    try {
      const r = runCli(["scan", empty, "--json"], { dataDir });
      expect(r.code).toBe(0);
      expect(readdirSync(empty)).toEqual(["sub"]);
    } finally {
      rmSync(empty, { recursive: true, force: true });
    }
  });
});
