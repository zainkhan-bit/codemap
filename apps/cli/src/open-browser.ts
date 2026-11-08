/**
 * Opens the dashboard URL in the user's browser via the OS URL handler.
 *
 * This is the only place CodeMap starts a process (allowed for this file alone by
 * scripts/check-boundaries.mjs). It runs a fixed platform command — never anything from the
 * scanned project — and only for a validated loopback URL, so no argument can be injected.
 */
import { spawn } from "node:child_process";

const SAFE_URL = /^http:\/\/127\.0\.0\.1:\d{1,5}\/#[A-Za-z0-9_=&-]+$/;

export function openBrowser(url: string): boolean {
  if (!SAFE_URL.test(url)) return false;
  const [command, args, verbatim] =
    process.platform === "win32"
      ? // `start` treats the first quoted argument as a window title. The URL is quoted (so "&" is
        // literal) and the whole command is wrapped once more because /s strips the outer quotes.
        (["cmd", ["/d", "/s", "/c", `"start "" "${url}""`], true] as const)
      : process.platform === "darwin"
        ? (["open", [url], false] as const)
        : (["xdg-open", [url], false] as const);
  try {
    const child = spawn(command, [...args], { stdio: "ignore", detached: true, windowsVerbatimArguments: verbatim, windowsHide: true });
    child.on("error", () => undefined);
    child.unref();
    return true;
  } catch {
    return false;
  }
}
