#!/usr/bin/env node

import { constants } from "node:fs"
import { access, mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises"
import { basename, dirname, resolve } from "node:path"
import { fileURLToPath, pathToFileURL } from "node:url"

import { resolveTemplateDir, writeTemplate } from "@dawn-ai/devkit"

interface CliOptions {
  readonly distTag: string
  readonly mode: "external" | "internal"
  readonly targetDir: string
  readonly template: string
}

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..")
const repoRoot = resolve(packageRoot, "../..")

export async function run(argv: readonly string[] = process.argv.slice(2)): Promise<number> {
  try {
    const options = parseArgs(argv)
    await scaffoldApp(options)
    return 0
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error))
    return 1
  }
}

async function scaffoldApp(options: CliOptions): Promise<void> {
  const appRoot = resolve(options.targetDir)
  const templateDir = await resolveTemplateDir(options.template)
  const replacements = createTemplateReplacements(appRoot, options)

  await assertTargetDirIsWritable(appRoot)
  await assertInternalModeWorkspace(options.mode)

  await writeTemplate({
    replacements,
    targetDir: appRoot,
    templateDir,
  })

  if (options.mode === "internal") {
    await applyInternalModePackageOverrides(appRoot, replacements)
  } else {
    await rm(resolve(appRoot, ".npmrc"), { force: true })
  }
}

async function assertInternalModeWorkspace(mode: CliOptions["mode"]): Promise<void> {
  if (mode !== "internal") {
    return
  }

  const requiredPaths = [
    resolve(repoRoot, "pnpm-workspace.yaml"),
    resolve(repoRoot, "packages/core/package.json"),
    resolve(repoRoot, "packages/cli/package.json"),
    resolve(repoRoot, "packages/langchain/package.json"),
    resolve(repoRoot, "packages/langgraph/package.json"),
    resolve(repoRoot, "packages/sdk/package.json"),
    resolve(repoRoot, "packages/config-typescript/package.json"),
  ]

  const isValidCheckout = await Promise.all(requiredPaths.map((path) => pathExists(path))).then(
    (results) => results.every(Boolean),
  )

  if (!isValidCheckout) {
    throw new Error(
      "Internal mode requires a Dawn monorepo checkout with local packages available.",
    )
  }
}

function parseArgs(argv: readonly string[]): CliOptions {
  const args = [...argv]
  let targetDir: string | undefined
  let template = "basic"
  let mode: CliOptions["mode"] = "external"
  let distTag = "latest"

  while (args.length > 0) {
    const current = args.shift()

    if (!current) {
      continue
    }

    if (!current.startsWith("-")) {
      if (targetDir) {
        throw new Error(`Unknown argument "${current}"`)
      }

      targetDir = current
      continue
    }

    if (current === "--template") {
      const value = args.shift()

      if (!value) {
        throw new Error('Missing value for "--template"')
      }

      template = value
      continue
    }

    if (current === "--mode") {
      const value = args.shift()

      if (value !== "external" && value !== "internal") {
        throw new Error('Expected "--mode" to be one of: external, internal')
      }

      mode = value
      continue
    }

    if (current === "--dist-tag") {
      const value = args.shift()

      if (!value) {
        throw new Error('Missing value for "--dist-tag"')
      }

      distTag = value
      continue
    }

    throw new Error(`Unknown argument "${current}"`)
  }

  if (!targetDir) {
    throw new Error(
      "Usage: create-dawn-ai-app <target-directory> [--template basic] [--mode external|internal] [--dist-tag latest]",
    )
  }

  return {
    distTag,
    mode,
    targetDir,
    template,
  }
}

async function assertTargetDirIsWritable(targetDir: string): Promise<void> {
  try {
    await access(targetDir, constants.F_OK)
    const entries = await readdir(targetDir)

    if (entries.length > 0) {
      throw new Error(`Target directory already exists and is not empty: ${targetDir}`)
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      await mkdir(targetDir, { recursive: true })
      return
    }

    throw error
  }
}

function createAbsoluteFileSpecifier(path: string): string {
  return pathToFileURL(path).toString()
}

function createTemplateReplacements(
  appRoot: string,
  options: CliOptions,
): {
  readonly appName: string
  readonly dawnCliSpecifier: string
  readonly dawnConfigTypescriptSpecifier: string
  readonly dawnCoreSpecifier: string
  readonly dawnLangchainSpecifier: string
  readonly dawnLanggraphSpecifier: string
  readonly dawnSdkSpecifier: string
} {
  if (options.mode === "internal") {
    return {
      appName: basename(appRoot),
      dawnCliSpecifier: createAbsoluteFileSpecifier(resolve(repoRoot, "packages/cli")),
      dawnConfigTypescriptSpecifier: createAbsoluteFileSpecifier(
        resolve(repoRoot, "packages/config-typescript"),
      ),
      dawnCoreSpecifier: createAbsoluteFileSpecifier(resolve(repoRoot, "packages/core")),
      dawnLangchainSpecifier: createAbsoluteFileSpecifier(resolve(repoRoot, "packages/langchain")),
      dawnLanggraphSpecifier: createAbsoluteFileSpecifier(resolve(repoRoot, "packages/langgraph")),
      dawnSdkSpecifier: createAbsoluteFileSpecifier(resolve(repoRoot, "packages/sdk")),
    }
  }

  return {
    appName: basename(appRoot),
    dawnCliSpecifier: options.distTag,
    dawnConfigTypescriptSpecifier: options.distTag,
    dawnCoreSpecifier: options.distTag,
    dawnLangchainSpecifier: options.distTag,
    dawnLanggraphSpecifier: options.distTag,
    dawnSdkSpecifier: options.distTag,
  }
}

async function applyInternalModePackageOverrides(
  appRoot: string,
  replacements: ReturnType<typeof createTemplateReplacements>,
): Promise<void> {
  const packageJsonPath = resolve(appRoot, "package.json")
  const packageJson = JSON.parse(await readFile(packageJsonPath, "utf8")) as {
    dependencies?: Record<string, string>
    devDependencies?: Record<string, string>
    pnpm?: {
      overrides?: Record<string, string>
    }
  }

  packageJson.pnpm = {
    ...(packageJson.pnpm ?? {}),
    overrides: {
      ...(packageJson.pnpm?.overrides ?? {}),
      "@dawn-ai/cli": replacements.dawnCliSpecifier,
      "@dawn-ai/config-typescript": replacements.dawnConfigTypescriptSpecifier,
      "@dawn-ai/core": replacements.dawnCoreSpecifier,
      "@dawn-ai/langchain": replacements.dawnLangchainSpecifier,
      "@dawn-ai/langgraph": replacements.dawnLanggraphSpecifier,
      "@dawn-ai/sdk": replacements.dawnSdkSpecifier,
    },
  }

  await writeFile(packageJsonPath, `${JSON.stringify(packageJson, null, 2)}\n`, "utf8")
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await access(path, constants.F_OK)
    return true
  } catch {
    return false
  }
}

if (fileURLToPath(import.meta.url) === resolve(process.argv[1] ?? "")) {
  const exitCode = await run(process.argv.slice(2))
  process.exit(exitCode)
}
