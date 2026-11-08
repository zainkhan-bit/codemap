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

Out of scope for v0.1.0: the local HTTP server (not implemented). Its requirements (loopback
binding, ephemeral token, Host/Origin checks, CSP) are specified in the blueprint §13 and must be
tested before the dashboard ships.
