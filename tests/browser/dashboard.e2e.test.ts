/**
 * Dashboard end-to-end tests in a real browser (playwright-core driving the locally installed
 * Chrome or Edge — no browser download). Requires `pnpm build`. If no supported browser is
 * installed the suite is skipped with a message instead of failing.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { chromium, type Browser, type ConsoleMessage, type Page } from "playwright-core";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { CodeMapApplication } from "@codemap/application";
import { startServer, type RunningServer } from "@codemap/server";
import { FIXTURES, REPO_ROOT } from "../helpers/cli.js";

const assetsDir = path.join(REPO_ROOT, "apps", "dashboard", "dist");
let browser: Browser | undefined;
let app: CodeMapApplication;
let server: RunningServer;
let dataDir: string;
let hostile: string;

async function launch(): Promise<Browser | undefined> {
  const channels = process.env.CODEMAP_TEST_BROWSER_CHANNEL ? [process.env.CODEMAP_TEST_BROWSER_CHANNEL] : ["chrome", "msedge"];
  for (const channel of channels) {
    try {
      return await chromium.launch({ channel, headless: true });
    } catch {
      /* try the next installed browser */
    }
  }
  return undefined;
}

beforeAll(async () => {
  browser = await launch();
  dataDir = mkdtempSync(path.join(os.tmpdir(), "codemap-browser-"));
  // A project whose source contains markup in an import specifier and a symbol-bearing string.
  hostile = mkdtempSync(path.join(os.tmpdir(), "codemap-hostile-"));
  mkdirSync(path.join(hostile, "src"));
  writeFileSync(path.join(hostile, "src", "evil.ts"), 'import "<img src=x onerror=window.__xss=1>";\nexport function payload() { return "</script><script>window.__xss=2</script>"; }\n');
  app = await CodeMapApplication.open({ dataDir });
  await app.scanProject({ path: hostile });
  await app.scanProject({ path: path.join(FIXTURES, "fixture-js-esm") });
  server = await startServer({ app, assetsDir });
}, 120_000);

afterAll(async () => {
  await browser?.close();
  await server?.close();
  await app?.close();
  rmSync(dataDir, { recursive: true, force: true });
  rmSync(hostile, { recursive: true, force: true });
});

/** Opens the dashboard and records console errors, page errors and CSP violations. */
async function open(url = server.launchUrl): Promise<{ page: Page; problems: string[] }> {
  const page = await browser!.newPage({ viewport: { width: 1400, height: 900 } });
  const problems: string[] = [];
  page.on("console", (m: ConsoleMessage) => {
    if (m.type() === "error") problems.push(m.text());
  });
  page.on("pageerror", (e) => problems.push(e.message));
  await page.goto(url);
  return { page, problems };
}

async function chooseProject(page: Page, name: string): Promise<void> {
  const select = page.locator(".topbar select").first();
  const value = await select.locator("option", { hasText: name }).getAttribute("value");
  await select.selectOption(value!);
  await page.locator(".inspector-head h2", { hasText: name }).waitFor();
}

describe("dashboard in a real browser", () => {
  it("has a supported browser available", () => {
    if (!browser) console.warn("No Chrome or Edge found; set CODEMAP_TEST_BROWSER_CHANNEL. Browser tests skipped.");
    expect(true).toBe(true);
  });

  it("loads with the fragment token, removes it from the address bar and stays CSP-clean", async () => {
    if (!browser) return;
    const { page, problems } = await open();
    await page.locator(".tile-value").first().waitFor();
    expect(page.url()).toBe(server.url);
    expect(page.url()).not.toContain(server.token);
    await page.waitForTimeout(500);
    expect(problems).toEqual([]);
    await page.close();
  });

  it("shows the project overview with real numbers", async () => {
    if (!browser) return;
    const { page } = await open();
    await chooseProject(page, "fixture-js-esm");
    const tiles = await page.locator(".tile").allInnerTexts();
    expect(tiles.map((t) => t.replace(/\s+/g, " ").trim())).toEqual(expect.arrayContaining(["6 files", "2 cycles", "10 import edges"]));
    await expect.poll(() => page.locator(".canvas-empty").isHidden()).toBe(true);
    expect(await page.locator("#graph canvas").count()).toBeGreaterThan(0);
    await page.close();
  });

  it("navigates the file tree and inspects a file", async () => {
    if (!browser) return;
    const { page } = await open();
    await chooseProject(page, "fixture-js-esm");
    await page.locator(".tree-row", { hasText: "src" }).first().click();
    await page.locator(".tree-row", { hasText: "index.js" }).click();
    await page.locator(".inspector-head h2", { hasText: "index.js" }).waitFor();
    const imports = await page.locator(".section", { hasText: "Imports" }).locator(".node-link").allInnerTexts();
    expect(imports.sort()).toEqual(["lodash", "node:fs", "src/a.js", "src/b.js", "src/models/user.js", "src/self.js"]);
    // Following a relationship selects the peer.
    await page.locator(".node-link", { hasText: "src/models/user.js" }).click();
    await page.locator(".inspector-head h2", { hasText: "user.js" }).waitFor();
    expect(await page.locator(".section", { hasText: "Imported by" }).locator(".node-link").allInnerTexts()).toEqual(["src/index.js"]);
    await page.close();
  });

  it("lists cycles in the issues tab and jumps to them", async () => {
    if (!browser) return;
    const { page } = await open();
    await chooseProject(page, "fixture-js-esm");
    await page.locator(".tab", { hasText: "Issues" }).click();
    const cycles = await page.locator(".link.cycle").allInnerTexts();
    expect(cycles).toEqual(["src/b.js → src/a.js → src/b.js", "src/self.js imports itself"]);
    await page.locator(".link.cycle").first().click();
    await page.locator(".inspector-head h2", { hasText: "a.js" }).waitFor();
    await page.close();
  });

  it("switches views and focuses folders", async () => {
    if (!browser) return;
    const { page, problems } = await open();
    await chooseProject(page, "fixture-js-esm");
    for (const view of ["Modules", "Calls", "Symbols", "Folders", "Files"]) {
      await page.locator(".segmented button", { hasText: view }).click();
      await expect.poll(() => page.locator(".segmented button.active").innerText()).toBe(view);
    }
    await page.locator(".tree-row", { hasText: "src" }).first().click();
    await page.locator(".tree-row", { hasText: "models" }).hover();
    await page.locator(".tree-row", { hasText: "models" }).locator(".focus-btn").click();
    await page.locator(".chip.focus", { hasText: "src/models/" }).waitFor();
    expect(problems).toEqual([]);
    await page.close();
  });

  it("renders hostile repository text as inert text", async () => {
    if (!browser) return;
    const { page, problems } = await open();
    await chooseProject(page, path.basename(hostile));
    await page.locator(".tab", { hasText: "Issues" }).click();
    await page.locator("code", { hasText: "<img src=x onerror=window.__xss=1>" }).waitFor();
    await page.locator(".tab", { hasText: "Files" }).click();
    await page.locator(".tree-row", { hasText: "src" }).first().click();
    await page.locator(".tree-row", { hasText: "evil.ts" }).click();
    await page.locator(".inspector-head h2", { hasText: "evil.ts" }).waitFor();
    expect(await page.evaluate(() => (window as unknown as { __xss?: number }).__xss)).toBeUndefined();
    expect(await page.locator("img[src=x]").count()).toBe(0);
    expect(problems).toEqual([]);
    await page.close();
  });

  it("explains a missing token instead of showing data", async () => {
    if (!browser) return;
    const context = await browser.newContext();
    const page = await context.newPage();
    await page.goto(server.url);
    await page.locator(".fatal h1", { hasText: "No access token" }).waitFor();
    await context.close();
  });

  it("rejects a forged token", async () => {
    if (!browser) return;
    const context = await browser.newContext();
    const page = await context.newPage();
    await page.goto(`${server.url}#token=${"x".repeat(43)}`);
    await page.locator(".fatal h1", { hasText: "Cannot reach the CodeMap API" }).waitFor();
    await context.close();
  });
});
