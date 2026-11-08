import { describe, expect, it } from "vitest";
import type { ConfigSnapshot, ModuleReferenceFact, ResolutionResult } from "@codemap/contracts";
import { createJavaScriptTypeScriptResolver, parseJsonc } from "./index.js";

const files = [
  "src/index.ts",
  "src/util.ts",
  "src/legacy.js",
  "src/components/index.tsx",
  "src/esm.ts",
  "src/dup.ts",
  "src/dup.tsx",
  "lib/helpers.ts",
  "packages/core/src/index.ts",
  "packages/core/src/feature.ts",
  "packages/plain/index.js",
  "internal/thing.ts",
];

const configs: ConfigSnapshot[] = [
  { path: "package.json", kind: "package_json", text: JSON.stringify({ name: "root", dependencies: { react: "1" }, devDependencies: { "@types/node": "1" }, imports: { "#internal/*": "./internal/*.ts" } }) },
  { path: "packages/core/package.json", kind: "package_json", text: JSON.stringify({ name: "@acme/core", exports: { ".": { types: "./dist/index.d.ts", import: "./dist/index.js" }, "./feature": "./dist/feature.js" } }) },
  { path: "packages/plain/package.json", kind: "package_json", text: JSON.stringify({ name: "plain", main: "index.js" }) },
  { path: "tsconfig.json", kind: "tsconfig", text: `{ // comment\n "compilerOptions": { "baseUrl": ".", "paths": { "@lib/*": ["lib/*"], "~/*": ["src/*"], }, }, }` },
];

async function resolve(specifier: string | undefined, opts: Partial<ModuleReferenceFact> = {}): Promise<ResolutionResult> {
  const ref: ModuleReferenceFact = { referenceKey: "k", fromPath: "src/index.ts", language: "typescript", form: "static_import", isDynamicExpression: specifier === undefined, isTypeOnly: false, importedNames: [], ...(specifier !== undefined ? { specifier } : {}), ...opts };
  const batch = await createJavaScriptTypeScriptResolver().resolve({ fileInventory: [], references: [ref], projectContext: { sourceFiles: files, directories: [], configs }, resolutionOptions: { resolveExternalPackages: true } });
  return batch.results[0]!;
}

const target = (r: ResolutionResult) => (r.target?.kind === "file" ? r.target.path : r.target ? `${r.target.ecosystem}:${r.target.name}` : undefined);

describe("JS/TS resolver", () => {
  it.each([
    ["./util", "src/util.ts", "relative_path"],
    ["./util.ts", "src/util.ts", "relative_path"],
    ["./esm.js", "src/esm.ts", "relative_path"],
    ["./legacy", "src/legacy.js", "relative_path"],
    ["./components", "src/components/index.tsx", "relative_path"],
    ["@lib/helpers", "lib/helpers.ts", "tsconfig_paths"],
    ["~/util", "src/util.ts", "tsconfig_paths"],
    ["lib/helpers", "lib/helpers.ts", "tsconfig_base_url"],
    ["#internal/thing", "internal/thing.ts", "package_imports"],
    ["@acme/core", "packages/core/src/index.ts", "package_exports"],
    ["@acme/core/feature", "packages/core/src/feature.ts", "package_exports"],
    ["plain", "packages/plain/index.js", "package_main"],
  ])("resolves %s → %s via %s", async (spec, expected, method) => {
    const r = await resolve(spec);
    expect(r.status).toBe("resolved_internal");
    expect(target(r)).toBe(expected);
    expect(r.resolutionMethod).toBe(method);
  });

  it("marks build-output → source mapping as medium confidence", async () => {
    expect((await resolve("@acme/core")).confidence).toBe("medium");
    expect((await resolve("./util")).confidence).toBe("high");
  });

  it("identifies node builtins and declared external packages", async () => {
    expect(target(await resolve("node:fs"))).toBe("node_builtin:node:fs");
    expect(target(await resolve("path"))).toBe("node_builtin:node:path");
    const react = await resolve("react/jsx-runtime");
    expect(react.status).toBe("resolved_external");
    expect(target(react)).toBe("npm:react");
  });

  it("does not invent undeclared packages", async () => {
    const r = await resolve("left-pad");
    expect(r.status).toBe("unresolved");
    expect(r.diagnosticCode).toBe("RESOLVE001");
  });

  it("reports ambiguity instead of choosing", async () => {
    const r = await resolve("./dup");
    expect(r.status).toBe("ambiguous");
    expect(r.candidateTargets?.map((c) => (c.kind === "file" ? c.path : ""))).toEqual(["src/dup.ts", "src/dup.tsx"]);
  });

  it("leaves dynamic, missing, escaping and asset imports unresolved or ignored", async () => {
    expect((await resolve(undefined, { form: "dynamic_import" })).status).toBe("unresolved");
    expect((await resolve("./nope")).status).toBe("unresolved");
    expect((await resolve("../../outside")).message).toMatch(/outside the scanned project/);
    expect((await resolve("./styles.css")).status).toBe("ignored");
    expect((await resolve("https://cdn.example.com/x.js")).status).toBe("unresolved");
  });

  it("respects resolveExternalPackages=false", async () => {
    const ref: ModuleReferenceFact = { referenceKey: "k", fromPath: "src/index.ts", language: "typescript", form: "static_import", isDynamicExpression: false, isTypeOnly: false, importedNames: [], specifier: "react" };
    const batch = await createJavaScriptTypeScriptResolver().resolve({ fileInventory: [], references: [ref], projectContext: { sourceFiles: files, directories: [], configs }, resolutionOptions: { resolveExternalPackages: false } });
    expect(batch.results[0]!.status).toBe("ignored");
  });

  it("reports malformed configuration instead of crashing", async () => {
    const batch = await createJavaScriptTypeScriptResolver().resolve({
      fileInventory: [],
      references: [],
      projectContext: { sourceFiles: files, directories: [], configs: [{ path: "package.json", kind: "package_json", text: "{ nope" }, { path: "tsconfig.json", kind: "tsconfig", text: '{ "extends": "@tsconfig/strictest" }' }] },
      resolutionOptions: { resolveExternalPackages: true },
    });
    expect(batch.diagnostics.map((d) => d.code).sort()).toEqual(["RESOLVE003", "SCAN006"]);
  });
});

describe("parseJsonc", () => {
  it("strips comments and trailing commas but keeps string contents", () => {
    expect(parseJsonc('{ "a": "http://x//y", /* c */ "b": [1, 2,], }')).toEqual({ a: "http://x//y", b: [1, 2] });
  });
});
