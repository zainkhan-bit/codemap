/** `codemap dashboard`: serves the local dashboard on 127.0.0.1 until interrupted. */
import { CodeMapApplication, CodeMapError, ExitCodes } from "@codemap/application";
import { startServer } from "@codemap/server";
import { openBrowser } from "../open-browser.js";
import { bold, dim, yellow } from "../output/format.js";

export async function dashboardCommand(app: CodeMapApplication, values: Record<string, unknown>, signal: AbortSignal): Promise<number> {
  let port = 0;
  if (values.port !== undefined) {
    port = Number(values.port);
    if (!Number.isInteger(port) || port < 1024 || port > 65535) throw new CodeMapError("invalid_input", "--port must be an integer between 1024 and 65535");
  }
  if ((await app.listProjects()).length === 0) throw new CodeMapError("not_found", 'no scanned projects yet; run "codemap scan <path>" first');
  if (typeof values.project === "string" && !(await app.store.getProject(values.project))) throw new CodeMapError("not_found", `project ${values.project} not found`);

  let server;
  try {
    server = await startServer({ app, port });
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    throw new CodeMapError(code === "EADDRINUSE" ? "invalid_input" : "internal", code === "EADDRINUSE" ? `port ${port} is already in use` : `cannot start the dashboard server: ${(err as Error).message}`);
  }
  const launchUrl = typeof values.project === "string" ? `${server.launchUrl}&project=${values.project}` : server.launchUrl;
  const opened = values["no-open"] !== true && openBrowser(launchUrl);

  process.stdout.write(`${bold("CodeMap dashboard")} on ${server.url} ${dim("(127.0.0.1 only, read-only)")}\n`);
  if (opened) process.stdout.write(dim("Opened in your browser. If it did not open, run again with --no-open to print the private link.\n"));
  else {
    process.stdout.write(`Open this private link (it contains a one-time access token):\n  ${launchUrl}\n`);
    process.stdout.write(yellow("Do not share it; anyone on this machine with the link can read the scan results.\n"));
  }
  process.stdout.write(dim("Press Ctrl+C to stop.\n"));

  await new Promise<void>((resolve) => {
    if (signal.aborted) return resolve();
    signal.addEventListener("abort", () => resolve(), { once: true });
    process.once("SIGTERM", () => resolve());
  });
  await server.close();
  process.stdout.write(dim("Dashboard stopped.\n"));
  return ExitCodes.OK;
}
