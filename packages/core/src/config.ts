import { access, readFile } from "node:fs/promises";
import { constants } from "node:fs";
import { join } from "node:path";

import type { DawnConfig, LoadedDawnConfig, LoadDawnConfigOptions } from "./types.js";

export const DAWN_CONFIG_FILE = "dawn.config.ts";

export async function loadDawnConfig(options: LoadDawnConfigOptions): Promise<LoadedDawnConfig> {
  const configPath = join(options.appRoot, DAWN_CONFIG_FILE);

  await access(configPath, constants.F_OK);

  const source = await readFile(configPath, "utf8");

  return {
    appRoot: options.appRoot,
    config: parseDawnConfig(source),
    configPath,
  };
}

function parseDawnConfig(source: string): DawnConfig {
  const appDirMatch = source.match(/appDir\s*:\s*["'`]([^"'`]+)["'`]/);

  if (!appDirMatch) {
    return {};
  }

  const [, appDir] = appDirMatch;

  return appDir ? { appDir } : {};
}
