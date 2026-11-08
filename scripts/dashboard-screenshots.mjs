#!/usr/bin/env node
// Dev tool: serves the dashboard for the scans in $CODEMAP_DATA_DIR and screenshots it with the
// locally installed Chrome. Usage: node scripts/dashboard-screenshots.mjs <out-prefix> [light|dark]
import { chromium } from "playwright-core";
import { CodeMapApplication } from "../packages/application/dist/index.js";
import { startServer } from "../packages/server/dist/index.js";
const out = process.argv[2];
const app = await CodeMapApplication.open();
const server = await startServer({ app });
const browser = await chromium.launch({ channel: "chrome", headless: true });
const page = await browser.newPage({ viewport: { width: 1440, height: 900 }, colorScheme: process.argv[3] ?? "light" });
const problems = [];
page.on("console", (m) => { if (m.type() === "error" || m.type() === "warning") problems.push(`${m.type()}: ${m.text()}`); });
page.on("pageerror", (e) => problems.push(`pageerror: ${e.message}`));
await page.goto(server.launchUrl);
await page.waitForSelector(".tile-value");
await page.waitForTimeout(1500);
await page.screenshot({ path: `${out}-overview.png` });
// Select a file from the tree and show its details.
await page.locator(".tree-row", { hasText: "packages" }).first().click();
await page.locator(".tree-row", { hasText: "graph-engine" }).first().click();
await page.locator(".tree-row", { hasText: "src" }).nth(0).click();
await page.waitForTimeout(300);
await page.locator(".tree-row", { hasText: "builder.ts" }).first().click();
await page.waitForSelector(".inspector-head h2");
await page.waitForTimeout(800);
await page.screenshot({ path: `${out}-file.png` });
await page.locator(".tab", { hasText: "Issues" }).click();
await page.waitForTimeout(800);
await page.screenshot({ path: `${out}-issues.png` });
console.log("url-after-token-removal:", page.url());
console.log(problems.length ? problems.join("\n") : "no console errors");
await browser.close();
await server.close();
await app.close();
