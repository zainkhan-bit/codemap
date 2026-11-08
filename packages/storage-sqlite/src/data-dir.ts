import os from "node:os";
import path from "node:path";

/**
 * Platform-aware user data directory. Never inside the scanned repository.
 * CODEMAP_DATA_DIR overrides it (used by tests and portable setups).
 */
export function defaultDataDirectory(env: NodeJS.ProcessEnv = process.env, platform: NodeJS.Platform = process.platform): string {
  if (env.CODEMAP_DATA_DIR) return path.resolve(env.CODEMAP_DATA_DIR);
  const home = os.homedir();
  if (platform === "win32") return path.join(env.LOCALAPPDATA || path.join(home, "AppData", "Local"), "CodeMap");
  if (platform === "darwin") return path.join(home, "Library", "Application Support", "CodeMap");
  return path.join(env.XDG_DATA_HOME || path.join(home, ".local", "share"), "codemap");
}

export const DATABASE_FILE_NAME = "codemap.db";
