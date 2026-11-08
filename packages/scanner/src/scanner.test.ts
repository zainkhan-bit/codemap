import { mkdtemp, mkdir, readdir, rm, stat, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { DEFAULT_CONFIG, type CodeMapConfig } from "@codemap/contracts";
import { discoverFiles } from "./discover.js";
import { looksBinary, readAndHash } from "./hashing.js";
import { ConfigError, loadProjectConfig } from "./config.js";
import { ScanPathError, toPosixRelative, validateRoot } from "./paths.js";

let root: string;
const classify = (p: string) => (/\.(ts|js|py)$/.test(p) ? (p.endsWith(".py") ? "python" : "typescript") : undefined);

async function put(rel: string, content: string | Uint8Array = "export const x = 1;\n"): Promise<void> {
  const abs = path.join(root, ...rel.split("/"));
  await mkdir(path.dirname(abs), { recursive: true });
  await writeFile(abs, content);
}

async function discover(config: Partial<CodeMapConfig> = {}) {
  return discoverFiles({ root, config: { ...DEFAULT_CONFIG, ...config }, classify });
}

async function snapshot(dir: string): Promise<string[]> {
  const out: string[] = [];
  const walk = async (d: string) => {
    for (const e of await readdir(d, { withFileTypes: true })) {
      const p = path.join(d, e.name);
      const st = await stat(p).catch(() => undefined);
      out.push(`${path.relative(root, p)}|${st?.size}|${st?.mtimeMs}`);
      if (e.isDirectory()) await walk(p);
    }
  };
  await walk(dir);
  return out.sort();
}

beforeAll(async () => {
  root = await mkdtemp(path.join(os.tmpdir(), "codemap-scanner-"));
  await put("src/a.ts");
  await put("src/b.js");
  await put("src/nested/deep/c.py", "x = 1\n");
  await put("src/generated/gen.ts");
  await put("src/keep.generated.ts");
  await put("src/app.min.js");
  await put("node_modules/pkg/index.js");
  await put("dist/out.js");
  await put(".git/config.js");
  await put("venv-custom/pyvenv.cfg", "home = /usr\n");
  await put("venv-custom/lib/site.py", "x = 1\n");
  await put(".env", "SECRET=hunter2\n");
  await put(".env.production.js", "SECRET=hunter2\n");
  await put("keys/server.pem", "-----BEGIN-----\n");
  await put("big.ts", "x".repeat(5000));
  await put("bin.ts", new Uint8Array([0x65, 0x00, 0x66]));
  await put("ignored-by-git.ts");
  await put("docs/readme.md", "# hi\n");
  await put("módulo.py", "x = 1\n");
  await put("package.json", '{ "name": "demo" }');
  await put("src/tsconfig.json", "{}");
  await put("requirements.txt", "requests\n");
  await put(".gitignore", "ignored-by-git.ts\nsrc/generated/\nsrc/*.generated.ts\n");
  await put(".codemapignore", "!src/keep.generated.ts\n");
  await put("src/nested/.gitignore", "deep/\n");
});

afterAll(async () => {
  await rm(root, { recursive: true, force: true });
});

describe("discoverFiles", () => {
  it("applies built-in, VCS, venv, secret, .gitignore and .codemapignore rules", async () => {
    const r = await discover();
    expect(r.files.map((f) => f.relativePath)).toEqual(["big.ts", "bin.ts", "módulo.py", "src/a.ts", "src/b.js", "src/keep.generated.ts"]);
  });

  it("reads only allowlisted configuration files", async () => {
    const r = await discover();
    expect(r.configs.map((c) => [c.path, c.kind])).toEqual([
      ["package.json", "package_json"],
      ["requirements.txt", "requirements_txt"],
      ["src/tsconfig.json", "tsconfig"],
    ]);
    expect(JSON.stringify(r)).not.toContain("hunter2");
  });

  it("enforces max file size and max file count with diagnostics", async () => {
    const r = await discover({ maxFileSizeBytes: 1000, maxFiles: 3 });
    expect(r.skipped.map((s) => [s.relativePath, s.skipReason])).toEqual(
      expect.arrayContaining([
        ["big.ts", "SCAN002"],
        ["src/b.js", "SCAN005"],
      ]),
    );
    expect(r.files).toHaveLength(3);
    expect(r.diagnostics.filter((d) => d.code === "SCAN005")).toHaveLength(1);
  });

  it("supports config include/exclude", async () => {
    const r = await discover({ include: ["src/**"], exclude: ["**/*.js"] });
    expect(r.files.map((f) => f.relativePath)).toEqual(["src/a.ts", "src/keep.generated.ts"]);
  });

  it("skips symbolic links (including loops) with SCAN003", async () => {
    try {
      await symlink(root, path.join(root, "loop"), "junction");
      await symlink(path.join(root, "src", "a.ts"), path.join(root, "link.ts"), "file");
    } catch {
      return; // Creating symlinks requires privileges on some Windows setups.
    }
    const r = await discover();
    expect(r.diagnostics.filter((d) => d.code === "SCAN003").map((d) => d.path)).toEqual(expect.arrayContaining(["loop"]));
    expect(r.files.some((f) => f.relativePath.startsWith("loop/") || f.relativePath === "link.ts")).toBe(false);
    await rm(path.join(root, "loop"), { force: true, recursive: false }).catch(() => undefined);
    await rm(path.join(root, "link.ts"), { force: true }).catch(() => undefined);
  });

  it("never writes inside the scanned directory", async () => {
    const before = await snapshot(root);
    await discover();
    expect(await snapshot(root)).toEqual(before);
  });
});

describe("hashing", () => {
  it("detects binary content and hashes text deterministically", async () => {
    expect(looksBinary(new Uint8Array([1, 0, 2]))).toBe(true);
    const bin = await readAndHash(path.join(root, "bin.ts"), 1e6);
    expect(bin.ok ? "" : bin.skipReason).toBe("SCAN001");
    const a = await readAndHash(path.join(root, "src", "a.ts"), 1e6);
    const b = await readAndHash(path.join(root, "src", "a.ts"), 1e6);
    expect(a.ok && b.ok && a.contentHash === b.contentHash && a.contentHash.startsWith("sha256:")).toBe(true);
  });
});

describe("paths and config", () => {
  it("normalizes OS separators to POSIX and NFC", () => {
    expect(toPosixRelative(["a", "b", "c.ts"].join(path.sep))).toBe("a/b/c.ts");
    expect(toPosixRelative("módulo.py")).toBe("módulo.py");
  });

  it("validates the root path", async () => {
    await expect(validateRoot(path.join(root, "missing"))).rejects.toBeInstanceOf(ScanPathError);
    await expect(validateRoot(path.join(root, "src", "a.ts"))).rejects.toMatchObject({ reason: "not_directory" });
    expect((await validateRoot(root)).displayName).toBe(path.basename(root));
  });

  it("loads codemap.config.json with defaults and rejects invalid files", async () => {
    expect((await loadProjectConfig(root)).fromFile).toBe(false);
    const dir = await mkdtemp(path.join(os.tmpdir(), "codemap-cfg-"));
    await writeFile(path.join(dir, "codemap.config.json"), '{ "version": 1, "maxFiles": 10, "extra": 1 }');
    const ok = await loadProjectConfig(dir, { maxFileSizeBytes: 5 });
    expect([ok.config.maxFiles, ok.config.maxFileSizeBytes, ok.warnings.length]).toEqual([10, 5, 1]);
    await writeFile(path.join(dir, "codemap.config.json"), '{ "maxFiles": "lots" }');
    await expect(loadProjectConfig(dir)).rejects.toBeInstanceOf(ConfigError);
    await rm(dir, { recursive: true, force: true });
  });
});
