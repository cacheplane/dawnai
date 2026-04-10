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
  const evaluatedConfig = evaluateDawnConfigSource(source);

  if (!isRecord(evaluatedConfig)) {
    return {};
  }

  const appDir = evaluatedConfig.appDir;

  return typeof appDir === "string" ? { appDir } : {};
}

function evaluateDawnConfigSource(source: string): unknown {
  const sanitizedSource = sanitizeDawnConfigSource(source);

  try {
    return Function(`"use strict";\n${sanitizedSource}`)();
  } catch (cause) {
    throw new Error("Failed to evaluate dawn.config.ts", { cause });
  }
}

function sanitizeDawnConfigSource(source: string): string {
  return source
    .replace(/^\uFEFF/, "")
    .replace(/^\s*import\s+type[\s\S]*?;\s*$/gm, "")
    .replace(/^\s*export\s+type[\s\S]*?;\s*$/gm, "")
    .replace(/^\s*type\s+[A-Za-z_$][\w$]*\s*=\s*[\s\S]*?;\s*$/gm, "")
    .replace(/^\s*interface\s+[A-Za-z_$][\w$]*\s*\{[\s\S]*?^\}\s*$/gm, "")
    .replace(
      /\b(const|let|var)\s+([A-Za-z_$][\w$]*)\s*:\s*([^=;]+?)\s*=/g,
      (_match, declarationKeyword: string, identifier: string) => `${declarationKeyword} ${identifier} =`,
    )
    .replace(/\s+as\s+const\b/g, "")
    .replace(/\s+satisfies\s+[^;\n]+/g, "")
    .replace(/export\s+default\s+/g, "return ");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
