import { readFile } from "node:fs/promises";
import path from "node:path";
import { DEFAULT_CONFIG, parseCodeMapConfig, type CodeMapConfig } from "@codemap/contracts";

export const CONFIG_FILE_NAME = "codemap.config.json";

export class ConfigError extends Error {
  constructor(
    message: string,
    readonly details: string[],
  ) {
    super(message);
  }
}

export interface LoadedConfig {
  config: CodeMapConfig;
  /** Whether a codemap.config.json was found. */
  fromFile: boolean;
  warnings: string[];
}

/** Loads codemap.config.json from the project root. A missing file yields defaults. */
export async function loadProjectConfig(root: string, overrides: Partial<Pick<CodeMapConfig, "maxFileSizeBytes">> = {}): Promise<LoadedConfig> {
  let text: string | undefined;
  try {
    text = await readFile(path.join(root, CONFIG_FILE_NAME), "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw new ConfigError(`cannot read ${CONFIG_FILE_NAME}`, [String((err as Error).message)]);
  }
  if (text === undefined) return { config: { ...DEFAULT_CONFIG, ...overrides }, fromFile: false, warnings: [] };
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (err) {
    throw new ConfigError(`${CONFIG_FILE_NAME} is not valid JSON`, [(err as Error).message]);
  }
  const res = parseCodeMapConfig(raw);
  if (!res.ok || !res.value) throw new ConfigError(`${CONFIG_FILE_NAME} is invalid`, res.errors);
  return { config: { ...res.value, ...overrides }, fromFile: true, warnings: res.warnings };
}
