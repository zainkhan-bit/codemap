# Security policy

CodeMap scans untrusted repositories, so its security model is part of its design: scanning is
read-only and offline, never executes project code or package scripts, never follows symbolic
links, never reads secret-like files (`.env*`, private keys, `.npmrc`…) and keeps absolute machine
paths out of exported data. See [ADR-0008](docs/decisions/ADR-0008-local-first-security.md) and the
tests in `tests/security/`.

## Supported versions

Only the latest release receives security fixes while the project is pre-1.0.

## Reporting a vulnerability

Please **do not open a public issue**. Use the hosting platform's private vulnerability reporting
(for GitHub: *Security → Report a vulnerability* on the repository). Include the CodeMap version,
platform, a minimal repository or file that reproduces the problem, and the impact you observed.

Examples of in-scope issues: any code path that executes scanned code or spawns processes, writes
inside the scanned directory, follows symlinks outside the root, leaks file contents, secrets or
absolute paths into exports or logs, or lets crafted input crash/hang the scanner beyond its limits.
