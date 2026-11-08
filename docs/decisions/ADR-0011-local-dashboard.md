# ADR-0011: Loopback read API and local dashboard (Stage 6)

- Status: accepted · Date: 2026-11-08

## Context
Stage 6 adds an interactive dashboard on top of the stable engine. The blueprint (§13) fixes the
security requirements: loopback binding, an ephemeral token passed via the URL fragment and sent as
a Bearer token, Host/Origin validation, no permissive CORS, a restrictive CSP, no path traversal, no
write endpoints, and a UI that reads only the canonical API.

## Decision
- **`@codemap/server`** serves `/api/v1/*` (see [local-api.md](../architecture/local-api.md)) by
  calling `@codemap/application` use cases, plus four prebuilt dashboard assets held in memory.
  It is the only package that may import `node:http` (one file, enforced by the boundary checker).
- **API response types live in `@codemap/contracts`** (`api.ts`), so the dashboard depends on
  contracts only — never on application, storage or parser code.
- **The dashboard is plain TypeScript + Cytoscape.js**, bundled by esbuild into same-origin files.
  No React: the UI is small, a framework would add a runtime and build surface without changing the
  architecture, and plain DOM with text-only insertion keeps the XSS story simple. Cytoscape's
  injected `<style>` (blocked by the CSP) is pre-empted with its marker element; styles that must be
  dynamic are set through the CSSOM, which the CSP allows.
- **Opening the browser** uses the OS URL handler from a single CLI file
  (`apps/cli/src/open-browser.ts`), the only sanctioned subprocess in CodeMap. It runs a fixed
  command and only accepts a URL matching `http://127.0.0.1:<port>/#<safe chars>`.
- **`codemap scan` does not start the dashboard.** The blueprint allows launching by default, but a
  long-running server after a scan would break scripts and CI. `codemap dashboard` starts it; `scan`
  still accepts `--no-open` for forward compatibility.
- **Browser tests use `playwright-core` with the installed Chrome or Edge** (no browser download),
  under the same Vitest runner as every other suite.

## Alternatives
- Serving the dashboard from `file://`: no same-origin API, and tokens would need another channel.
- Cookie-based auth: exposes the API to CSRF from other local pages; bearer headers do not.
- React + Vite: heavier toolchain; can be adopted later behind the same API contract.

## Consequences
- Two reviewed exceptions to "no network or subprocess modules" (server listen socket; browser
  launch). Both are listed in `scripts/check-boundaries.mjs` `EXEMPT` and fail CI if they spread.
- The application caches up to three completed snapshots in memory for the server's lifetime.
- `@codemap/dashboard` ships prebuilt assets; `pnpm build` runs `tsc -b` and then the dashboard bundle.
