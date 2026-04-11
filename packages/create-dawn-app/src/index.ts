#!/usr/bin/env node

import { access, mkdir, readdir } from "node:fs/promises";
import { constants } from "node:fs";
import { basename, dirname, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { resolveTemplateDir, writeTemplate } from "@dawn/devkit";

interface CliOptions {
  readonly targetDir: string;
  readonly template: string;
}

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const repoRoot = resolve(packageRoot, "../..");

export async function run(argv: readonly string[] = process.argv.slice(2)): Promise<number> {
  try {
    const options = parseArgs(argv);
    await scaffoldApp(options);
    return 0;
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    return 1;
  }
}

async function scaffoldApp(options: CliOptions): Promise<void> {
  const appRoot = resolve(options.targetDir);
  const templateDir = await resolveTemplateDir(options.template);

  await assertTargetDirIsWritable(appRoot);

  await writeTemplate({
    replacements: {
      appName: basename(appRoot),
      dawnCorePackagePath: toPortablePath(relative(appRoot, resolve(repoRoot, "packages/core"))),
      dawnCliPackagePath: toPortablePath(relative(appRoot, resolve(repoRoot, "packages/cli"))),
      dawnConfigTypescriptPackagePath: toPortablePath(relative(appRoot, resolve(repoRoot, "packages/config-typescript"))),
      dawnLanggraphPackagePath: toPortablePath(relative(appRoot, resolve(repoRoot, "packages/langgraph"))),
    },
    targetDir: appRoot,
    templateDir,
  });
}

function parseArgs(argv: readonly string[]): CliOptions {
  const args = [...argv];
  const targetDir = args.shift();

  if (!targetDir || targetDir.startsWith("-")) {
    throw new Error("Usage: create-dawn-app <target-directory> [--template basic]");
  }

  let template = "basic";

  while (args.length > 0) {
    const current = args.shift();

    if (current === "--template") {
      const value = args.shift();

      if (!value) {
        throw new Error('Missing value for "--template"');
      }

      template = value;
      continue;
    }

    throw new Error(`Unknown argument "${current}"`);
  }

  return {
    targetDir,
    template,
  };
}

async function assertTargetDirIsWritable(targetDir: string): Promise<void> {
  try {
    await access(targetDir, constants.F_OK);
    const entries = await readdir(targetDir);

    if (entries.length > 0) {
      throw new Error(`Target directory already exists and is not empty: ${targetDir}`);
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      await mkdir(targetDir, { recursive: true });
      return;
    }

    throw error;
  }
}

function toPortablePath(relativePath: string): string {
  if (relativePath.startsWith(".")) {
    return relativePath;
  }

  return `./${relativePath}`;
}

if (fileURLToPath(import.meta.url) === resolve(process.argv[1] ?? "")) {
  const exitCode = await run(process.argv.slice(2));
  process.exit(exitCode);
}
