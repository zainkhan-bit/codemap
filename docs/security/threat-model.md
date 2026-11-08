# Threat model (v0.1.0)

**Asset**: the user's machine and the scanned repository's confidentiality and integrity.
**Adversary**: the author of a repository the user scans (untrusted code, crafted files).

| Threat | Mitigation | Verified by |
|---|---|---|
| Code execution via package scripts, build tools, `setup.py`, `conftest.py` | No subprocess/vm/network modules in any package (lint); parsing is syntax-only | `check-boundaries.mjs`, security test marker file |
| Writes into the scanned repo | Data dir outside the project; scanner only opens files for reading | tree fingerprint before/after test |
| Path traversal / symlink escape / symlink loops | Root validated once; `lstat`-based walk never follows links | security + scanner tests |
| Secret disclosure | Hard exclusion of secret-like files; config allowlist; config text never persisted | grep of exports and every DB table |
| Absolute path disclosure in exports | Relative paths only; redaction of absolute paths in source facts; invariant check | invariants + security tests |
| Malicious content rendered in SVG/Mermaid | All text XML-escaped; Mermaid labels escaped | exporter + security tests |
| Denial of service (huge files, deep nesting, many files) | Size/count limits, parse time budget, depth guard, iterative algorithms | conformance + scanner tests |
| Malformed manifests | Parsed defensively; diagnostics (`SCAN006`), never crashes | security test |
| Tampered/newer database | Migration checksums; refuse newer schema | storage tests |

## Local dashboard server

**Additional adversaries**: a malicious website open in the user's browser; another user or process
on the same machine.

| Threat | Mitigation | Verified by |
|---|---|---|
| Remote network access | Bound to 127.0.0.1 only | server test (URL/bind) |
| Website reading the API (CSRF/XHR) | Bearer token required; no cookies; no CORS headers; Origin and Sec-Fetch-Site checks | server tests |
| DNS rebinding | Host header must be 127.0.0.1/localhost with our port (421 otherwise) | server test |
| Token leakage | Token only in URL fragment → sessionStorage; stripped from address bar; never in query, logs or Referer (`no-referrer`) | server + browser tests |
| Local process guessing the token | 256-bit random token, constant-time comparison | server test |
| Path traversal / arbitrary file read | Static allowlist of four in-memory assets; no file-system access per request | server test |
| XSS from repository content | Text-only DOM insertion; strict CSP without `unsafe-inline`/eval | browser test with hostile specifiers |
| Clickjacking | `frame-ancestors 'none'`, `X-Frame-Options: DENY` | server test |
| Mutation via API | GET/HEAD only; no write use cases exposed | server test |

Residual risk: any local process running as the same user can read the scan database directly; the
token protects the HTTP surface, not the data directory.
