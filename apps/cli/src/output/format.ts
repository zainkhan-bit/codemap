/** Human-oriented output helpers. JSON output never goes through these. */
import type { ScanSummary } from "@codemap/contracts";

const useColor = () => process.stdout.isTTY && !process.env.NO_COLOR;
const wrap = (code: string) => (s: string) => (useColor() ? `\x1b[${code}m${s}\x1b[0m` : s);
export const bold = wrap("1");
export const dim = wrap("2");
export const red = wrap("31");
export const green = wrap("32");
export const yellow = wrap("33");

export function bytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KiB`;
  return `${(n / 1024 / 1024).toFixed(1)} MiB`;
}

export function table(rows: string[][]): string {
  const widths = rows.reduce<number[]>((w, r) => r.map((c, i) => Math.max(w[i] ?? 0, c.length)), []);
  return rows.map((r) => r.map((c, i) => (i === r.length - 1 ? c : c.padEnd(widths[i]!))).join("  ")).join("\n");
}

export function scanSummaryLines(s: ScanSummary): string[] {
  const langs = Object.entries(s.languages).map(([l, n]) => `${l} ${n}`).join(", ") || "none";
  const d = s.diagnosticCounts;
  return [
    `  files      ${s.fileCount} (${langs})`,
    `  parsed     ${s.parsedCount} parsed, ${s.reusedCount} reused from cache, ${s.failedCount} failed, ${s.skippedCount} skipped`,
    `  graph      ${s.nodeCount} nodes, ${s.edgeCount} edges, ${s.referenceCount} references (${s.unresolvedCount} unresolved/ambiguous)`,
    `  cycles     ${s.cycleCount === 0 ? green("0") : red(String(s.cycleCount))} circular dependenc${s.cycleCount === 1 ? "y" : "ies"}`,
    `  issues     ${d.error ? red(`${d.error} errors`) : "0 errors"}, ${d.warning ? yellow(`${d.warning} warnings`) : "0 warnings"}, ${d.info} info`,
    `  time       ${s.durationsMs.total ?? Object.values(s.durationsMs).reduce((a, b) => a + b, 0)} ms`,
  ];
}
