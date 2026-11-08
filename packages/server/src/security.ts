/**
 * Security controls for the local server (blueprint §13).
 *
 * - Bound to 127.0.0.1 only; never 0.0.0.0.
 * - A high-entropy token per process. The browser receives it in the URL fragment (never sent
 *   to servers or written to history/referrers) and returns it as `Authorization: Bearer`.
 *   Tokens in query strings are never accepted.
 * - Host header must name this loopback origin (defeats DNS rebinding).
 * - Origin, when present, must be this exact origin; cross-site fetch metadata is refused.
 *   No CORS headers are ever sent.
 * - Strict CSP and hardening headers on every response.
 */
import { randomBytes, timingSafeEqual } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";

export const LOOPBACK_HOST = "127.0.0.1";

/** 256 bits, base64url (no characters that need escaping in a URL fragment). */
export function generateToken(): string {
  return randomBytes(32).toString("base64url");
}

export function tokensEqual(expected: string, presented: string): boolean {
  const a = Buffer.from(expected);
  const b = Buffer.from(presented);
  return a.length === b.length && timingSafeEqual(a, b);
}

export const CONTENT_SECURITY_POLICY = [
  "default-src 'none'",
  "script-src 'self'",
  "style-src 'self'",
  "img-src 'self' data: blob:",
  "connect-src 'self'",
  "font-src 'self'",
  "base-uri 'none'",
  "form-action 'none'",
  "frame-ancestors 'none'",
].join("; ");

export function applySecurityHeaders(res: ServerResponse): void {
  res.setHeader("Content-Security-Policy", CONTENT_SECURITY_POLICY);
  res.setHeader("Referrer-Policy", "no-referrer");
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("X-Frame-Options", "DENY");
  res.setHeader("Cross-Origin-Opener-Policy", "same-origin");
  res.setHeader("Cross-Origin-Resource-Policy", "same-origin");
  res.setHeader("Permissions-Policy", "camera=(), microphone=(), geolocation=(), interest-cohort=()");
}

export type Rejection = { status: number; message: string } | undefined;

/** Host/Origin/fetch-metadata checks applied to every request (static and API). */
export function checkRequestOrigin(req: IncomingMessage, port: number): Rejection {
  const allowedHosts = new Set([`${LOOPBACK_HOST}:${port}`, `localhost:${port}`]);
  const host = req.headers.host;
  if (!host || !allowedHosts.has(host.toLowerCase())) return { status: 421, message: "misdirected request: unexpected Host header" };
  const origin = req.headers.origin;
  if (origin !== undefined && !allowedHosts.has(origin.toLowerCase().replace(/^http:\/\//, "")) ) return { status: 403, message: "cross-origin requests are not allowed" };
  if (origin !== undefined && !origin.toLowerCase().startsWith("http://")) return { status: 403, message: "cross-origin requests are not allowed" };
  const site = req.headers["sec-fetch-site"];
  if (site === "cross-site" || site === "same-site") return { status: 403, message: "cross-site requests are not allowed" };
  return undefined;
}

/** Bearer-token check for API routes. */
export function checkToken(req: IncomingMessage, token: string): Rejection {
  const auth = req.headers.authorization;
  const m = auth ? /^Bearer ([A-Za-z0-9_-]{16,128})$/.exec(auth) : null;
  if (!m || !tokensEqual(token, m[1]!)) return { status: 401, message: "missing or invalid access token; open the dashboard from the URL printed by `codemap dashboard`" };
  return undefined;
}
