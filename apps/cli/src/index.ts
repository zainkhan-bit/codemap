#!/usr/bin/env node
/**
 * codemap — CLI entry point. Parses arguments, opens the application, dispatches
 * to a command and maps errors to stable exit codes:
 *   0 success · 1 completed with partial analysis · 2 invalid arguments/config ·
 *   3 path access · 4 storage · 5 internal · 130 cancelled (SIGINT)
 */
import { parseArgs } from "node:util";
import { CodeMapApplication, CodeMapError, ExitCodes } from "@codemap/application";
import { TOOL_VERSION } from "@codemap/contracts";
import { analyzeCommand, cacheCommand, dataCommand, depsCommand, doctorCommand, err, exportCommand, projectsCommand, scanCommand, summaryCommand, type GlobalOptions } from "./commands/index.js";

const HELP = `codemap ${TOOL_VERSION} — local-first codebase architecture analysis (read-only, offline)

Usage:
  codemap scan [path] [--json] [--max-file-size <bytes>] [--no-open]
  codemap summary [--project <id>] [--scan <id>] [--json]
  codemap analyze --cycles [--project <id>] [--scan <id>] [--exclude-type-only] [--json]
  codemap export --format json|svg|mermaid|png [--output <file>] [--scan <id>] [--project <id>]
                 [--view <view>] [--path <dir>] [--force]
  codemap deps <file|symbol|node-id> [--reverse] [--depth <n>] [--json]
  codemap projects [--json]
  codemap cache clear [--all]
  codemap data location
  codemap doctor
  codemap --version | --help

Views: file_dependency_view (default), module_view, directory_view, symbol_view, call_view

Scanning never modifies the repository, never runs project code and makes no network calls.
Data is stored outside the project (see "codemap data location").
Exit codes: 0 ok, 1 partial analysis, 2 invalid input, 3 path error, 4 storage error, 5 internal, 130 cancelled.`;

const OPTIONS = {
  json: { type: "boolean" },
  verbose: { type: "boolean", short: "v" },
  help: { type: "boolean", short: "h" },
  version: { type: "boolean", short: "V" },
  "no-open": { type: "boolean" },
  "max-file-size": { type: "string" },
  project: { type: "string" },
  scan: { type: "string" },
  cycles: { type: "boolean" },
  "exclude-type-only": { type: "boolean" },
  format: { type: "string", short: "f" },
  output: { type: "string", short: "o" },
  view: { type: "string" },
  path: { type: "string" },
  force: { type: "boolean" },
  all: { type: "boolean" },
  reverse: { type: "boolean" },
  depth: { type: "string" },
} as const;

async function main(argv: string[]): Promise<number> {
  let parsed;
  try {
    parsed = parseArgs({ args: argv, options: OPTIONS, allowPositionals: true, strict: true });
  } catch (e) {
    err(`codemap: ${(e as Error).message}`);
    err('Run "codemap --help" for usage.');
    return ExitCodes.INVALID_INPUT;
  }
  const { values, positionals } = parsed;
  if (values.version) {
    process.stdout.write(`${TOOL_VERSION}\n`);
    return ExitCodes.OK;
  }
  const [command, ...args] = positionals;
  if (values.help || !command || command === "help") {
    process.stdout.write(`${HELP}\n`);
    return command || values.help ? ExitCodes.OK : ExitCodes.INVALID_INPUT;
  }
  const g: GlobalOptions = { json: values.json === true, verbose: values.verbose === true };

  const controller = new AbortController();
  let interrupts = 0;
  const onSigint = () => {
    interrupts++;
    if (interrupts > 1) process.exit(ExitCodes.CANCELLED);
    err("\ncancelling… (press Ctrl+C again to force)");
    controller.abort(new CodeMapError("cancelled", "scan cancelled"));
  };
  process.on("SIGINT", onSigint);

  let app: CodeMapApplication | undefined;
  try {
    // `data location` must work even when the database cannot be opened.
    if (command === "data") return await dataCommand(args, g);
    app = await CodeMapApplication.open();
    const v = values as Record<string, unknown>;
    switch (command) {
      case "scan":
        return await scanCommand(app, args, v, g, controller.signal);
      case "summary":
        return await summaryCommand(app, v, g);
      case "analyze":
        return await analyzeCommand(app, v, g);
      case "export":
        return await exportCommand(app, v, g);
      case "deps":
        return await depsCommand(app, args, v, g);
      case "projects":
        return await projectsCommand(app, g);
      case "cache":
        return await cacheCommand(app, args, v, g);
      case "data":
        return await dataCommand(args, g);
      case "doctor":
        return await doctorCommand(app, g);
      default:
        err(`codemap: unknown command "${command}"`);
        err('Run "codemap --help" for usage.');
        return ExitCodes.INVALID_INPUT;
    }
  } catch (e) {
    if (e instanceof CodeMapError) {
      if (g.json) process.stdout.write(`${JSON.stringify({ error: { kind: e.kind, message: e.message, details: e.details } }, null, 2)}\n`);
      err(`codemap: ${e.message}`);
      for (const d of e.details.slice(0, g.verbose ? 100 : 5)) err(`  ${d}`);
      if (g.verbose && e.cause instanceof Error && e.cause.stack) err(e.cause.stack);
      return e.exitCode;
    }
    err(`codemap: unexpected internal error: ${(e as Error).message}`);
    if (g.verbose && e instanceof Error && e.stack) err(e.stack);
    else err("Re-run with --verbose for details.");
    return ExitCodes.INTERNAL;
  } finally {
    process.off("SIGINT", onSigint);
    await app?.close().catch(() => undefined);
  }
}

main(process.argv.slice(2)).then(
  (code) => {
    process.exitCode = code;
  },
  (e) => {
    process.stderr.write(`codemap: fatal: ${(e as Error).message}\n`);
    process.exitCode = ExitCodes.INTERNAL;
  },
);
