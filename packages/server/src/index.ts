/**
 * @codemap/server — loopback-only, read-only HTTP server for the local dashboard.
 *
 * The only CodeMap package allowed to use node:http (enforced by scripts/check-boundaries.mjs).
 * It exposes application use cases as JSON and serves a fixed allowlist of dashboard assets.
 * There is no write endpoint and no file-system access beyond those prebuilt assets.
 */
import { readFileSync } from "node:fs";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { createRequire } from "node:module";
import type { Socket } from "node:net";
import path from "node:path";
import type { CodeMapApplication } from "@codemap/application";
import { handleApi } from "./api.js";
import { LOOPBACK_HOST, applySecurityHeaders, checkRequestOrigin, checkToken, generateToken } from "./security.js";

export * from "./security.js";

export interface StartServerOptions {
  app: CodeMapApplication;
  /** 0 (default) picks an ephemeral free port. */
  port?: number;
  /** Override the token (tests). Must be ≥16 URL-safe characters. */
  token?: string;
  /** Directory with the built dashboard (defaults to @codemap/dashboard's dist). */
  assetsDir?: string;
}

export interface RunningServer {
  /** Base URL without credentials, e.g. http://127.0.0.1:53311/ */
  url: string;
  /** URL to open: the token travels in the fragment, which browsers never send to servers. */
  launchUrl: string;
  token: string;
  port: number;
  close(): Promise<void>;
}

const ASSET_ROUTES: Record<string, { file: string; type: string }> = {
  "/": { file: "index.html", type: "text/html; charset=utf-8" },
  "/assets/app.js": { file: "app.js", type: "text/javascript; charset=utf-8" },
  "/assets/app.css": { file: "app.css", type: "text/css; charset=utf-8" },
  "/favicon.svg": { file: "favicon.svg", type: "image/svg+xml" },
};

function defaultAssetsDir(): string {
  return path.join(path.dirname(createRequire(import.meta.url).resolve("@codemap/dashboard/package.json")), "dist");
}

/** Loads the allowlisted assets into memory once; nothing else on disk is ever served. */
function loadAssets(dir: string): Map<string, { body: Buffer; type: string }> {
  const assets = new Map<string, { body: Buffer; type: string }>();
  for (const [route, { file, type }] of Object.entries(ASSET_ROUTES)) {
    try {
      assets.set(route, { body: readFileSync(path.join(dir, file)), type });
    } catch {
      if (file !== "favicon.svg") throw new Error(`dashboard asset ${file} is missing in ${dir}; build @codemap/dashboard first`);
    }
  }
  return assets;
}

function send(res: ServerResponse, status: number, type: string, body: string | Uint8Array, extra: Record<string, string> = {}): void {
  res.writeHead(status, { "Content-Type": type, "Content-Length": Buffer.byteLength(body), ...extra });
  res.end(body);
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  send(res, status, "application/json; charset=utf-8", JSON.stringify(body), { "Cache-Control": "no-store" });
}

export async function startServer(opts: StartServerOptions): Promise<RunningServer> {
  const token = opts.token ?? generateToken();
  if (!/^[A-Za-z0-9_-]{16,128}$/.test(token)) throw new Error("token must be 16-128 URL-safe characters");
  const assets = loadAssets(opts.assetsDir ?? defaultAssetsDir());
  let port = 0;

  const handler = async (req: IncomingMessage, res: ServerResponse) => {
    applySecurityHeaders(res);
    const rejection = checkRequestOrigin(req, port);
    if (rejection) return sendJson(res, rejection.status, { error: { kind: "forbidden", message: rejection.message } });
    if (req.method !== "GET" && req.method !== "HEAD") {
      res.setHeader("Allow", "GET, HEAD");
      return sendJson(res, 405, { error: { kind: "method_not_allowed", message: "the CodeMap API is read-only" } });
    }
    if (!req.url || req.url.length > 4096) return sendJson(res, 414, { error: { kind: "invalid_input", message: "URL too long" } });
    let url: URL;
    try {
      url = new URL(req.url, `http://${LOOPBACK_HOST}`);
    } catch {
      return sendJson(res, 400, { error: { kind: "invalid_input", message: "malformed URL" } });
    }

    if (url.pathname.startsWith("/api/")) {
      if (url.searchParams.has("token") || url.searchParams.has("access_token")) {
        return sendJson(res, 400, { error: { kind: "invalid_input", message: "tokens are only accepted in the Authorization header" } });
      }
      const denied = checkToken(req, token);
      if (denied) return sendJson(res, denied.status, { error: { kind: "unauthorized", message: denied.message } });
      const r = await handleApi(opts.app, url.pathname, url.searchParams);
      if (r.raw) {
        return send(res, r.status, r.raw.contentType, r.raw.data, { "Cache-Control": "no-store", "Content-Disposition": `attachment; filename="${r.raw.filename}"` });
      }
      return sendJson(res, r.status, r.body);
    }

    const asset = assets.get(url.pathname);
    if (!asset) return sendJson(res, 404, { error: { kind: "not_found", message: "not found" } });
    send(res, 200, asset.type, req.method === "HEAD" ? "" : asset.body, { "Cache-Control": "no-cache" });
  };

  const server: Server = createServer((req, res) => {
    handler(req, res).catch(() => {
      if (!res.headersSent) sendJson(res, 500, { error: { kind: "internal", message: "internal error" } });
      else res.destroy();
    });
  });
  server.headersTimeout = 10_000;
  server.requestTimeout = 60_000;
  const sockets = new Set<Socket>();
  server.on("connection", (s) => {
    sockets.add(s);
    s.on("close", () => sockets.delete(s));
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(opts.port ?? 0, LOOPBACK_HOST, () => resolve());
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("server did not bind a TCP port");
  port = address.port;
  const url = `http://${LOOPBACK_HOST}:${port}/`;

  return {
    url,
    launchUrl: `${url}#token=${token}`,
    token,
    port,
    close: () =>
      new Promise<void>((resolve) => {
        for (const s of sockets) s.destroy();
        server.close(() => resolve());
      }),
  };
}
