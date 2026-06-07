import { constants } from "node:fs"
import { access, readdir } from "node:fs/promises"
import { basename, dirname, join, resolve, sep } from "node:path"
import { pathToFileURL } from "node:url"

import { findDawnApp } from "@dawn-ai/core"

import { createRuntimeRegistry, type RuntimeRegistry } from "../dev/runtime-registry.js"
import { registerTsxLoader } from "./register-tsx-loader.js"

const EVAL_FILE_SUFFIX = ".eval.ts"
const EVALS_DIR = "evals"
const INDEX_FILE = "index.ts"

/**
 * Structural shape of an eval definition's default export. Kept local (rather
 * than importing `EvalDefinition` from `@dawn-ai/evals`) because `@dawn-ai/evals`
 * transitively depends on `@dawn-ai/cli` via `@dawn-ai/testing`, so a direct
 * dependency would introduce a build-graph cycle. The eval file itself imports
 * the real `@dawn-ai/evals` (resolved from the app), so loading it still
 * exercises the genuine package.
 */
export interface EvalDefinition {
  readonly name: string
  readonly route?: string
  readonly dataset: unknown
  readonly scorers: readonly unknown[]
  readonly threshold?: number
  readonly gate?: unknown
}

export interface LoadedEval {
  readonly definition: EvalDefinition
  readonly route: string
  readonly appRoot: string
  readonly baseDir: string
  readonly evalFile: string
}

export interface LoadEvalsOptions {
  readonly cwd?: string
  readonly narrowingPath?: string
}

export class EvalLoadError extends Error {
  constructor(message: string) {
    super(message)
    this.name = "EvalLoadError"
  }
}

export async function loadEvals(options: LoadEvalsOptions = {}): Promise<LoadedEval[]> {
  const app = await findDawnApp(options.cwd ? { cwd: options.cwd } : {})
  const srcDir = resolve(app.appRoot, "src")
  const evalFiles = await collectEvalFiles(srcDir, options.narrowingPath)

  await registerTsxLoader()

  const registry = await createRuntimeRegistry(app.appRoot)

  return await Promise.all(
    evalFiles.map(async (evalFile) => loadEvalFile({ appRoot: app.appRoot, evalFile, registry })),
  )
}

async function collectEvalFiles(
  srcDir: string,
  narrowingPath: string | undefined,
): Promise<readonly string[]> {
  if (!(await pathExists(srcDir))) {
    return []
  }

  const discovered: string[] = []
  await walkEvalTree(srcDir, discovered)

  const filtered = narrowingPath
    ? discovered.filter((evalFile) => evalFile.includes(`${sep}${narrowingPath}${sep}`))
    : discovered

  return filtered.sort((left, right) => left.localeCompare(right))
}

async function walkEvalTree(currentDir: string, discovered: string[]): Promise<void> {
  const entries = await readdir(currentDir, { withFileTypes: true })

  for (const entry of entries) {
    const entryPath = join(currentDir, entry.name)

    if (entry.isDirectory()) {
      await walkEvalTree(entryPath, discovered)
      continue
    }

    if (
      entry.isFile() &&
      entry.name.endsWith(EVAL_FILE_SUFFIX) &&
      basename(currentDir) === EVALS_DIR
    ) {
      discovered.push(entryPath)
    }
  }
}

async function loadEvalFile(options: {
  readonly appRoot: string
  readonly evalFile: string
  readonly registry: RuntimeRegistry
}): Promise<LoadedEval> {
  const evalModule = (await import(pathToFileURL(options.evalFile).href)) as {
    readonly default?: unknown
  }

  const definition = validateDefinition(evalModule.default, options.evalFile)
  const baseDir = dirname(options.evalFile)
  const route = await resolveRoute({
    appRoot: options.appRoot,
    baseDir,
    definition,
    evalFile: options.evalFile,
    registry: options.registry,
  })

  return {
    appRoot: options.appRoot,
    baseDir,
    definition,
    evalFile: options.evalFile,
    route,
  }
}

function validateDefinition(value: unknown, evalFile: string): EvalDefinition {
  if (!isRecord(value)) {
    throw new EvalLoadError(`Eval file ${evalFile} must default export an eval definition object`)
  }

  if (typeof value.name !== "string" || value.name.length === 0) {
    throw new EvalLoadError(`Eval file ${evalFile} must define a non-empty string "name"`)
  }

  if (typeof value.dataset === "undefined") {
    throw new EvalLoadError(`Eval "${value.name}" must define a "dataset"`)
  }

  if (!Array.isArray(value.scorers)) {
    throw new EvalLoadError(`Eval "${value.name}" must define a "scorers" array`)
  }

  return value as unknown as EvalDefinition
}

async function resolveRoute(options: {
  readonly appRoot: string
  readonly baseDir: string
  readonly definition: EvalDefinition
  readonly evalFile: string
  readonly registry: RuntimeRegistry
}): Promise<string> {
  const explicitRoute = (options.definition as { readonly route?: unknown }).route
  if (typeof explicitRoute === "string" && explicitRoute.length > 0) {
    return explicitRoute
  }

  const indexFile = await findNearestRouteIndex(options.baseDir, options.appRoot)
  if (!indexFile) {
    throw new EvalLoadError(
      `Eval file ${options.evalFile} is not co-located with a route — add an explicit "route" or place it under a route directory containing index.ts`,
    )
  }

  const entry = options.registry.entries.find((candidate) => candidate.routeFile === indexFile)
  if (!entry) {
    throw new EvalLoadError(
      `Eval file ${options.evalFile} resolves to ${indexFile}, which is not a recognized Dawn route`,
    )
  }

  return entry.assistantId
}

async function findNearestRouteIndex(baseDir: string, appRoot: string): Promise<string | null> {
  let currentDir = baseDir

  while (true) {
    const indexFile = resolve(currentDir, INDEX_FILE)
    if (await pathExists(indexFile)) {
      return indexFile
    }

    if (currentDir === appRoot) {
      return null
    }

    const parentDir = dirname(currentDir)
    if (parentDir === currentDir) {
      return null
    }

    currentDir = parentDir
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await access(path, constants.F_OK)
    return true
  } catch {
    return false
  }
}
