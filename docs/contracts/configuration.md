# `codemap.config.json`

Optional; defaults apply when absent. Validated by `parseCodeMapConfig` in `@codemap/contracts`.

| Key | Type | Default | Meaning |
|---|---|---|---|
| `version` | `1` | `1` | Config format version. Other values are rejected. |
| `include` | glob[] | `[]` | When non-empty, only matching files are scanned (Node `path.matchesGlob`). |
| `exclude` | gitignore pattern[] | `[]` | Always excluded. |
| `maxFileSizeBytes` | int > 0 | 2 000 000 | Larger files are skipped (`SCAN002`). CLI `--max-file-size` overrides. |
| `maxFiles` | int > 0 | 50 000 | Discovery stops beyond this (`SCAN005`). |
| `concurrency` | `"auto"` \| 1–16 | `"auto"` | `auto` = min(8, cores − 1). |
| `languages` | subset of `javascript`, `typescript`, `python` | all | Languages to scan. |
| `resolution.typescript` / `.python` | bool | true | Run the resolver for that language. |
| `resolution.resolveExternalPackages` | bool | true | When false, bare package imports are `ignored`. |
| `analysis.calls` / `.inheritance` / `.cycles` | bool | true | Extract calls / inheritance; compute cycles. |

Unknown keys produce warnings (shown after the scan and stored as `SCAN006` diagnostics). Invalid
values stop the scan with exit code 2. Never put secrets in this file. Changing it changes the
`configurationHash` of the next scan; changing `analysis.calls/inheritance` invalidates parse
artifacts (they are part of the cache key).
