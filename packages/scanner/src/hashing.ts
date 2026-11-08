import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { DiagnosticCodes } from "@codemap/contracts";

export type ReadOutcome =
  | { ok: true; bytes: Uint8Array; contentHash: string }
  | { ok: false; skipReason: string; message: string };

const BINARY_SNIFF_BYTES = 8000;

export function contentHash(bytes: Uint8Array): string {
  return `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
}

/** A NUL byte in the first 8000 bytes marks the file as binary (same heuristic as Git). */
export function looksBinary(bytes: Uint8Array): boolean {
  const n = Math.min(bytes.length, BINARY_SNIFF_BYTES);
  for (let i = 0; i < n; i++) if (bytes[i] === 0) return true;
  return false;
}

/** Reads a file once, enforcing the size limit on the actual bytes read, and hashes it. */
export async function readAndHash(absolutePath: string, maxBytes: number): Promise<ReadOutcome> {
  let bytes: Uint8Array;
  try {
    bytes = await readFile(absolutePath);
  } catch (err) {
    return { ok: false, skipReason: DiagnosticCodes.ACCESS_ERROR, message: `cannot read file (${(err as NodeJS.ErrnoException).code ?? "error"})` };
  }
  if (bytes.length > maxBytes) return { ok: false, skipReason: DiagnosticCodes.FILE_TOO_LARGE, message: `file exceeds ${maxBytes} bytes` };
  if (looksBinary(bytes)) return { ok: false, skipReason: DiagnosticCodes.BINARY_FILE, message: "binary file skipped" };
  return { ok: true, bytes, contentHash: contentHash(bytes) };
}

/** Runs `fn` over `items` with at most `limit` in flight, preserving result order. */
export async function mapLimit<T, R>(items: readonly T[], limit: number, fn: (item: T, index: number) => Promise<R>, signal?: AbortSignal): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      if (signal?.aborted) throw signal.reason ?? new Error("aborted");
      const i = next++;
      results[i] = await fn(items[i]!, i);
    }
  };
  await Promise.all(Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, worker));
  return results;
}
