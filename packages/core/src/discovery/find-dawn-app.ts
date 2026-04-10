import { access } from "node:fs/promises";
import { constants } from "node:fs";
import { dirname, join, resolve } from "node:path";

import { DAWN_CONFIG_FILE, loadDawnConfig } from "../config.js";
import type { DiscoveredDawnApp, FindDawnAppOptions } from "../types.js";

const PACKAGE_JSON_FILE = "package.json";
const DEFAULT_APP_DIR = "src/app";

export async function findDawnApp(options: FindDawnAppOptions = {}): Promise<DiscoveredDawnApp> {
  const appRoot = options.appRoot ? resolve(options.appRoot) : await findAppRootFromCwd(options.cwd);
  await assertDawnAppFiles(appRoot);

  const loadedConfig = await loadDawnConfig({ appRoot });
  const routesDir = resolve(appRoot, loadedConfig.config.appDir ?? DEFAULT_APP_DIR);
  await assertCanonicalDawnApp(appRoot, routesDir);

  return {
    appRoot,
    configPath: loadedConfig.configPath,
    routesDir,
  };
}

async function findAppRootFromCwd(cwd = process.cwd()): Promise<string> {
  let currentDir = resolve(cwd);

  while (true) {
    if (await fileExists(join(currentDir, DAWN_CONFIG_FILE))) {
      return currentDir;
    }

    const parentDir = dirname(currentDir);

    if (parentDir === currentDir) {
      throw new Error(`Could not find ${DAWN_CONFIG_FILE} from ${cwd}`);
    }

    currentDir = parentDir;
  }
}

async function assertDawnAppFiles(appRoot: string): Promise<void> {
  const missingPaths = await Promise.all([
    join(appRoot, PACKAGE_JSON_FILE),
    join(appRoot, DAWN_CONFIG_FILE),
  ].map(async (filePath) => ((await fileExists(filePath)) ? null : filePath)));

  throwIfMissing(appRoot, missingPaths);
}

export async function assertCanonicalDawnApp(appRoot: string, routesDir = join(appRoot, DEFAULT_APP_DIR)): Promise<void> {
  const missingPaths = await Promise.all([routesDir].map(async (filePath) => ((await fileExists(filePath)) ? null : filePath)));

  throwIfMissing(appRoot, missingPaths);
}

function throwIfMissing(appRoot: string, missingPaths: ReadonlyArray<string | null>): void {
  const missing = missingPaths.filter((value): value is string => value !== null);

  if (missing.length > 0) {
    throw new Error(`Invalid Dawn app at ${appRoot}. Missing: ${missing.join(", ")}`);
  }
}

async function fileExists(filePath: string): Promise<boolean> {
  try {
    await access(filePath, constants.F_OK);
    return true;
  } catch {
    return false;
  }
}
