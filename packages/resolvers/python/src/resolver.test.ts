import { describe, expect, it } from "vitest";
import type { ConfigSnapshot, ModuleReferenceFact, ResolutionResult } from "@codemap/contracts";
import { createPythonResolver } from "./index.js";

const files = [
  "src/app/__init__.py",
  "src/app/core.py",
  "src/app/util.py",
  "src/app/sub/__init__.py",
  "src/app/sub/deep.py",
  "src/nsp/mod.py",
  "scripts/tool.py",
  "scripts/sibling.py",
  "logging.py",
];
const configs: ConfigSnapshot[] = [
  { path: "pyproject.toml", kind: "pyproject", text: '[project]\nname = "app"\ndependencies = [\n  "requests>=2",\n  "PyYAML",\n]\nclassifiers = ["Framework :: Django"]\n\n[tool.setuptools.packages.find]\nwhere = ["src"]\n' },
  { path: "requirements-dev.txt", kind: "requirements_txt", text: "# dev\n--index-url https://user:token@example.com/simple\npytest==8\n" },
];

async function resolve(specifier: string | undefined, opts: Partial<ModuleReferenceFact> = {}): Promise<ResolutionResult> {
  const ref: ModuleReferenceFact = { referenceKey: "k", fromPath: "src/app/core.py", language: "python", form: "static_import", isDynamicExpression: specifier === undefined, isTypeOnly: false, importedNames: [], ...(specifier !== undefined ? { specifier } : {}), ...opts };
  const batch = await createPythonResolver().resolve({ fileInventory: [], references: [ref], projectContext: { sourceFiles: files, directories: [], configs }, resolutionOptions: { resolveExternalPackages: true } });
  return batch.results[0]!;
}
const target = (r: ResolutionResult) => (r.target?.kind === "file" ? r.target.path : r.target ? `${r.target.ecosystem}:${r.target.name}` : undefined);

describe("Python resolver", () => {
  it("resolves absolute imports through the src/ source root", async () => {
    expect(target(await resolve("app.core"))).toBe("src/app/core.py");
    expect(target(await resolve("app"))).toBe("src/app/__init__.py");
    expect(target(await resolve("app.sub.deep"))).toBe("src/app/sub/deep.py");
  });

  it("resolves relative imports by level", async () => {
    expect(target(await resolve("util", { relativeLevel: 1 }))).toBe("src/app/util.py");
    expect(target(await resolve("app.util", { relativeLevel: 2 }))).toBe("src/app/util.py");
    expect((await resolve("x", { relativeLevel: 5 })).status).toBe("unresolved");
  });

  it("links `from . import submodule` to the submodule file", async () => {
    const r = await resolve("", { relativeLevel: 1, importedNames: [{ name: "util" }, { name: "not_a_module" }] });
    expect(target(r)).toBe("src/app/__init__.py");
    expect(r.nameTargets).toEqual({ util: { kind: "file", path: "src/app/util.py" } });
  });

  it("treats namespace packages honestly", async () => {
    const r = await resolve("nsp");
    expect(r.status).toBe("unresolved");
    expect(r.diagnosticCode).toBe("RESOLVE003");
    const viaName = await resolve("nsp", { importedNames: [{ name: "mod" }] });
    expect(target(viaName)).toBe("src/nsp/mod.py");
  });

  it("recognises the standard library and flags local shadowing as ambiguous", async () => {
    expect(target(await resolve("os.path"))).toBe("stdlib:os");
    expect((await resolve("logging")).status).toBe("ambiguous");
  });

  it("maps declared distributions to import names, including aliases", async () => {
    expect(target(await resolve("requests"))).toBe("pypi:requests");
    expect(target(await resolve("yaml"))).toBe("pypi:yaml");
    expect(target(await resolve("pytest"))).toBe("pypi:pytest");
    expect((await resolve("django")).status).toBe("unresolved");
  });

  it("falls back to the script directory with medium confidence", async () => {
    const r = await resolve("sibling", { fromPath: "scripts/tool.py" });
    expect(target(r)).toBe("scripts/sibling.py");
    expect(r.confidence).toBe("medium");
  });

  it("never resolves computed module names", async () => {
    expect((await resolve(undefined, { form: "dynamic_import" })).status).toBe("unresolved");
  });
});
