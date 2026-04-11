#!/usr/bin/env node

import { constants } from "node:fs"
import { access, mkdir, readdir, rm } from "node:fs/promises"
import { basename, dirname, relative, resolve } from "node:path"
import { fileURLToPath } from "node:url"

import { resolveTemplateDir, writeTemplate } from "@dawn/devkit"

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

  await assertTargetDirIsWritable(appRoot)
  await assertInternalModeWorkspace(options.mode)

  await writeTemplate({
    replacements: createTemplateReplacements(appRoot, options),
    targetDir: appRoot,
    templateDir,
  })

  if (options.mode === "external") {
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
    resolve(repoRoot, "packages/langgraph/package.json"),
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
      "Usage: create-dawn-app <target-directory> [--template basic] [--mode external|internal] [--dist-tag latest]",
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

function toPortablePath(relativePath: string): string {
  if (relativePath.startsWith(".")) {
    return relativePath
  }

  return `./${relativePath}`
}

function createTemplateReplacements(appRoot: string, options: CliOptions) {
  if (options.mode === "internal") {
    return {
      appName: basename(appRoot),
      dawnCliSpecifier: `file:${toPortablePath(relative(appRoot, resolve(repoRoot, "packages/cli")))}`,
      dawnConfigTypescriptSpecifier: `file:${toPortablePath(relative(appRoot, resolve(repoRoot, "packages/config-typescript")))}`,
      dawnCoreSpecifier: `file:${toPortablePath(relative(appRoot, resolve(repoRoot, "packages/core")))}`,
      dawnLanggraphSpecifier: `file:${toPortablePath(relative(appRoot, resolve(repoRoot, "packages/langgraph")))}`,
    }
  }

  return {
    appName: basename(appRoot),
    dawnCliSpecifier: options.distTag,
    dawnConfigTypescriptSpecifier: options.distTag,
    dawnCoreSpecifier: options.distTag,
    dawnLanggraphSpecifier: options.distTag,
  }
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
