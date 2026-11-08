# ADR-0008: Local-first security and no project-code execution

- Status: accepted · Date: 2026-11-08

## Decision
Scanning is a read-only static operation: no subprocesses, no network modules (enforced by the
boundary checker), no evaluation of project files, no writes inside the scanned root. Symlinks are
never followed. Secret-like files are never read; only allowlisted configs are read and their text
is never persisted. Exports contain repository-relative paths only; absolute paths found in source
facts are redacted to `<absolute-path>`, and the invariant check rejects any that slip through.
Syntax summaries are bounded and never echo string literals from computed call receivers. SVG
output escapes all data.

## Consequences
Verified by `tests/security`: a marker-file test for script execution, a tree fingerprint before
and after scanning, symlink escape and loop, `.env`/private-key content absent from exports and
from every database table, HTML payloads inert in SVG, and malformed manifests plus 5000-level
nesting handled with diagnostics.

The security test found a real leak during development: Python `open("C:\\…").write()` put an
absolute path into a call summary. It was fixed at the source (summaries no longer echo receiver
expressions) and by central redaction.
