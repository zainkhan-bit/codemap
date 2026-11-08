# Local read API v1 and dashboard

Implemented by `@codemap/server` (HTTP), backed by use cases in `@codemap/application`, consumed by
`apps/dashboard`. Response types are the versioned contract in
[`packages/contracts/src/api.ts`](../../packages/contracts/src/api.ts).

```bash
codemap dashboard                 # serve and open the browser
codemap dashboard --no-open       # print the private link instead
codemap dashboard --project <id> --port 47000
```

The server runs until Ctrl+C. Scans are still started from the CLI; the API is read-only.

## Security model

| Control | Implementation |
|---|---|
| Loopback only | Binds `127.0.0.1`, never `0.0.0.0`; ephemeral port by default. |
| Per-process token | 256-bit random, base64url. Delivered in the URL **fragment** (`#token=…`), which browsers never send to servers or in `Referer`. The page moves it to tab-scoped `sessionStorage` and strips it from the address bar. Sent back only as `Authorization: Bearer`; tokens in query strings are rejected (400). Compared in constant time. |
| DNS rebinding | `Host` must be `127.0.0.1:<port>` or `localhost:<port>`, else **421**. |
| Cross-origin | `Origin`, when present, must be this exact origin; `Sec-Fetch-Site: cross-site/same-site` is refused (**403**). No CORS headers are ever sent. |
| Content Security Policy | `default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self' data: blob:; connect-src 'self'; font-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'` — no inline script or style, no eval, no remote origins. |
| Other headers | `Referrer-Policy: no-referrer`, `X-Content-Type-Options: nosniff`, `X-Frame-Options: DENY`, COOP/CORP `same-origin`, restrictive `Permissions-Policy`; API responses `Cache-Control: no-store`. |
| Read-only | Only `GET`/`HEAD`; anything else is **405**. No endpoint writes files or starts scans. |
| No file serving | Four prebuilt assets are loaded into memory at start and served by exact path. Every other path is 404, so traversal is impossible by construction. |
| Errors | JSON `{ error: { kind, message } }`; internal errors never include stacks or paths. |
| Logs | The server logs nothing. The CLI prints the tokenised link only with `--no-open` (or when the browser could not be launched) and warns not to share it. |
| XSS | The dashboard inserts repository data only as text nodes (`textContent`), never as HTML. |

All of the above are covered by `packages/server/src/server.test.ts` and
`tests/browser/dashboard.e2e.test.ts`.

## Endpoints

All under `/api/v1`, all `GET`, all require the bearer token.

| Endpoint | Returns | Query parameters |
|---|---|---|
| `/health` | `ApiHealth` | — |
| `/projects` | `ApiProject[]` (no local paths) | — |
| `/projects/:projectId/scans` | completed `ScanRecord[]`, newest first | — |
| `/scans/:scanId/summary` | `ProjectSummary` | — |
| `/scans/:scanId/graph` | `GraphViewResult` (IR nodes/edges of a projection, cycle membership, explicit `truncated`) | `view` (`file_dependency_view` default, `module_view`, `directory_view`, `symbol_view`, `call_view`), `path`, `minConfidence` (`high`/`medium`/`low`), `includeExternal`, `excludeTypeOnly`, `limit` (1–20000, default 2000) |
| `/scans/:scanId/nodes/:nodeId` | `NodeDetailsView`: node, parent, children, incoming/outgoing edges with peers, references, diagnostics | — |
| `/scans/:scanId/nodes/:nodeId/dependencies` | `DependencyHit[]` (BFS) | `direction` (`outgoing`/`incoming`), `depth` (1–50) |
| `/scans/:scanId/references` | `ReferencePage` | `status`, `kind` (comma-separated), `path`, `limit` (≤5000), `offset` |
| `/scans/:scanId/diagnostics` | `GraphDiagnostic[]` | `severity` (comma-separated) |
| `/scans/:scanId/export` | attachment (`json`, `svg`, `mermaid`, `png`) | `format`, plus the graph parameters and `force` |

Invalid parameters → 400; unknown scan/node/route → 404. Completed snapshots are immutable, so the
application caches the three most recently used graphs in memory by scan ID.

## Dashboard

Plain TypeScript and [Cytoscape.js](https://js.cytoscape.org/) bundled with esbuild into four
same-origin files (`index.html`, `app.js`, `app.css`, `favicon.svg`); no framework, no CDN.

- **Overview**: files, symbols, import and call edges, cycles, unresolved imports, language mix,
  most depended-on and most dependent files.
- **Files**: the directory tree; selecting a file inspects it, **Focus** limits the graph to a folder.
- **Issues**: cycles (click to jump), unresolved and ambiguous imports/inheritance with reasons,
  warnings and errors. Unresolved *calls* are expected (builtins, dynamic dispatch) and are shown
  per symbol rather than as issues.
- **Graph**: Files, Modules, Calls, Symbols and Folders views; toggles for external packages,
  type-only imports and medium-confidence (“inferred”) edges; auto/layered/force layout; search
  (`/`); cycle edges in red; selecting a node dims everything outside its neighbourhood.
- **Inspector**: relationships grouped by kind (imports / imported by, calls / called by, exports,
  extends, implements), declarations, unresolved references with reasons, diagnostics, and
  transitive dependencies on demand.
- **Export**: SVG, PNG, JSON, Mermaid of the current view and folder focus.
- Light and dark themes follow the operating system.
