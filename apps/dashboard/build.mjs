// Bundles the dashboard into dist/ as same-origin static files (no CDN, no inline scripts or
// styles, so it runs under the server's strict Content-Security-Policy).
import { copyFileSync, mkdirSync, rmSync } from "node:fs";
import { build } from "esbuild";

rmSync("dist", { recursive: true, force: true });
mkdirSync("dist");
await build({
  entryPoints: { app: "src/main.ts" },
  bundle: true,
  format: "esm",
  target: "es2022",
  minify: true,
  sourcemap: false,
  legalComments: "eof",
  outdir: "dist",
  logLevel: "warning",
});
// "/favicon.svg" is served by the local server, not bundled.
await build({ entryPoints: { app: "src/app.css" }, bundle: true, minify: true, outdir: "dist", external: ["/favicon.svg"], logLevel: "warning" });
copyFileSync("src/index.html", "dist/index.html");
copyFileSync("src/favicon.svg", "dist/favicon.svg");
console.log("dashboard built → dist/");
