#!/usr/bin/env node
// Removes build output and TypeScript build info from every package.
import { readdirSync, rmSync, existsSync } from "node:fs";
import path from "node:path";

const roots = ["apps", "packages", "packages/adapters", "packages/resolvers"];
for (const r of roots) {
  if (!existsSync(r)) continue;
  for (const name of readdirSync(r)) {
    const dir = path.join(r, name);
    rmSync(path.join(dir, "dist"), { recursive: true, force: true });
    rmSync(path.join(dir, "tsconfig.tsbuildinfo"), { force: true });
  }
}
console.log("cleaned");
