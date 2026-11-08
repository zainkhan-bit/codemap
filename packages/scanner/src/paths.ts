import { realpath, stat } from "node:fs/promises";
import path from "node:path";

export class ScanPathError extends Error {
  constructor(
    message: string,
    readonly reason: "not_found" | "not_directory" | "access_denied",
  ) {
    super(message);
  }
}

export interface ValidatedRoot {
  /** Canonical absolute path (symlinks resolved). Local metadata only. */
  canonicalRoot: string;
  /** Basename of the root, safe to export. */
  displayName: string;
}

/** Resolves and validates the scan root once. */
export async function validateRoot(input: string): Promise<ValidatedRoot> {
  const resolved = path.resolve(input);
  let canonical: string;
  try {
    canonical = await realpath(resolved);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    throw new ScanPathError(`path does not exist: ${input}`, code === "EACCES" || code === "EPERM" ? "access_denied" : "not_found");
  }
  let st;
  try {
    st = await stat(canonical);
  } catch {
    throw new ScanPathError(`cannot access path: ${input}`, "access_denied");
  }
  if (!st.isDirectory()) throw new ScanPathError(`not a directory: ${input}`, "not_directory");
  const displayName = path.basename(canonical) || "root";
  return { canonicalRoot: canonical, displayName };
}

/** Converts an OS-relative path to a normalized repository-relative POSIX path (NFC). */
export function toPosixRelative(rel: string): string {
  return rel.split(path.sep).join("/").normalize("NFC");
}
