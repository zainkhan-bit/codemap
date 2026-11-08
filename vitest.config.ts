import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

const src = (p: string) => fileURLToPath(new URL(`./${p}/src/index.ts`, import.meta.url));

// Unit tests run against TypeScript sources; end-to-end tests run the built CLI (pnpm build first).
export default defineConfig({
  resolve: {
    alias: {
      "@codemap/contracts": src("packages/contracts"),
      "@codemap/graph-engine": src("packages/graph-engine"),
      "@codemap/scanner": src("packages/scanner"),
      "@codemap/parser-runtime": src("packages/parser-runtime"),
      "@codemap/adapter-javascript-typescript": src("packages/adapters/javascript-typescript"),
      "@codemap/adapter-python": src("packages/adapters/python"),
      "@codemap/resolver-javascript-typescript": src("packages/resolvers/javascript-typescript"),
      "@codemap/resolver-python": src("packages/resolvers/python"),
      "@codemap/storage-sqlite": src("packages/storage-sqlite"),
      "@codemap/exporters": src("packages/exporters"),
      "@codemap/rasterizer-png": src("packages/rasterizer-png"),
      "@codemap/application": src("packages/application"),
    },
  },
  test: {
    include: ["packages/**/src/**/*.test.ts", "apps/**/src/**/*.test.ts", "tests/**/*.test.ts"],
    exclude: ["**/node_modules/**", "**/dist/**", "tests/fixtures/**"],
    testTimeout: 60_000,
    hookTimeout: 60_000,
  },
});
