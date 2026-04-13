import { constants } from "node:fs"
import { access, readdir } from "node:fs/promises"
import { basename, dirname, join, resolve } from "node:path"
import { pathToFileURL } from "node:url"

import { findDawnApp } from "@dawn/core"

import { registerTsxLoader } from "./register-tsx-loader.js"

const RUN_TEST_FILE = "run.test.ts"

export interface RunScenarioExpectation {
  readonly error?: {
    readonly kind?: string
    readonly message?: string
  }
  readonly output?: unknown
  readonly status: "failed" | "passed"
}

export interface LoadedRunScenario {
  readonly appRoot: string
  readonly expect: RunScenarioExpectation
  readonly input: unknown
  readonly name: string
  readonly routeFile: string
  readonly scenarioFile: string
}

export interface LoadRunScenariosOptions {
  readonly cwd?: string
  readonly invocationCwd?: string
  readonly narrowingPath?: string
}

export class RunScenarioLoadError extends Error {
  constructor(message: string) {
    super(message)
    this.name = "RunScenarioLoadError"
  }
}

export async function loadRunScenarios(
  options: LoadRunScenariosOptions,
): Promise<readonly LoadedRunScenario[]> {
  const app = await findDawnApp(options.cwd ? { cwd: options.cwd } : {})
  const scenarioFiles = await discoverScenarioFiles({
    appRoot: app.appRoot,
    ...(options.invocationCwd ? { invocationCwd: options.invocationCwd } : {}),
    ...(options.narrowingPath ? { narrowingPath: options.narrowingPath } : {}),
    routesDir: app.routesDir,
  })

  await registerTsxLoader()

  return (
    await Promise.all(
      scenarioFiles.map(async (scenarioFile) => {
        return await loadScenarioFile({
          appRoot: app.appRoot,
          scenarioFile,
        })
      }),
    )
  ).flat()
}

async function discoverScenarioFiles(options: {
  readonly appRoot: string
  readonly invocationCwd?: string
  readonly narrowingPath?: string
  readonly routesDir: string
}): Promise<readonly string[]> {
  if (!options.narrowingPath) {
    return await collectScenarioFiles(options.routesDir)
  }

  const narrowingTarget = resolveNarrowingTarget(options.narrowingPath, {
    appRoot: options.appRoot,
    ...(options.invocationCwd ? { invocationCwd: options.invocationCwd } : {}),
  })

  if (!(await pathExists(narrowingTarget))) {
    throw new RunScenarioLoadError(`Narrowing path does not exist: ${narrowingTarget}`)
  }

  const targetName = basename(narrowingTarget)

  if (targetName === "graph.ts" || targetName === "workflow.ts") {
    throw new RunScenarioLoadError("Route-file narrowing is not supported in v1")
  }

  if (targetName === RUN_TEST_FILE) {
    return [narrowingTarget]
  }

  const directoryEntries = await readdir(narrowingTarget, { withFileTypes: true }).catch(() => null)

  if (!directoryEntries) {
    throw new RunScenarioLoadError(`Unsupported narrowing target: ${narrowingTarget}`)
  }

  return await collectScenarioFiles(narrowingTarget)
}

async function collectScenarioFiles(rootDir: string): Promise<readonly string[]> {
  const discovered: string[] = []

  await walkScenarioTree(rootDir, discovered)

  return discovered.sort((left, right) => left.localeCompare(right))
}

async function walkScenarioTree(currentDir: string, discovered: string[]): Promise<void> {
  const entries = await readdir(currentDir, { withFileTypes: true })

  for (const entry of entries) {
    const entryPath = join(currentDir, entry.name)

    if (entry.isDirectory()) {
      await walkScenarioTree(entryPath, discovered)
      continue
    }

    if (entry.isFile() && entry.name === RUN_TEST_FILE) {
      discovered.push(entryPath)
    }
  }
}

async function loadScenarioFile(options: {
  readonly appRoot: string
  readonly scenarioFile: string
}): Promise<readonly LoadedRunScenario[]> {
  const scenarioModule = (await import(pathToFileURL(options.scenarioFile).href)) as {
    readonly default?: unknown
  }

  if (!Array.isArray(scenarioModule.default)) {
    throw new RunScenarioLoadError(
      `Scenario file ${options.scenarioFile} must default export an array of scenario objects`,
    )
  }

  return await Promise.all(
    scenarioModule.default.map(
      async (rawScenario, index) =>
        await validateScenario({
          appRoot: options.appRoot,
          rawScenario,
          scenarioFile: options.scenarioFile,
          scenarioIndex: index,
        }),
    ),
  )
}

async function validateScenario(options: {
  readonly appRoot: string
  readonly rawScenario: unknown
  readonly scenarioFile: string
  readonly scenarioIndex: number
}): Promise<LoadedRunScenario> {
  if (!isRecord(options.rawScenario)) {
    throw new RunScenarioLoadError(
      `Scenario file ${options.scenarioFile} contains a non-object scenario at index ${options.scenarioIndex}`,
    )
  }

  const name = options.rawScenario.name
  const target = options.rawScenario.target
  const input = options.rawScenario.input
  const expectation = options.rawScenario.expect

  if (typeof name !== "string" || name.length === 0) {
    throw new RunScenarioLoadError(
      `Scenario file ${options.scenarioFile} contains a scenario with a missing name at index ${options.scenarioIndex}`,
    )
  }

  if (target !== "./graph.ts" && target !== "./workflow.ts") {
    throw new RunScenarioLoadError(
      `Scenario "${name}" target must be exactly "./graph.ts" or "./workflow.ts"`,
    )
  }

  if (
    !isRecord(expectation) ||
    (expectation.status !== "passed" && expectation.status !== "failed")
  ) {
    throw new RunScenarioLoadError(
      `Scenario "${name}" must define expect.status as "passed" or "failed"`,
    )
  }

  const routeFile = resolve(dirname(options.scenarioFile), target)

  if (!(await pathExists(routeFile))) {
    throw new RunScenarioLoadError(`Scenario "${name}" target does not exist: ${routeFile}`)
  }

  return {
    appRoot: options.appRoot,
    expect: {
      ...(isRecord(expectation.error) ? { error: expectation.error } : {}),
      ...(Object.hasOwn(expectation, "output") ? { output: expectation.output } : {}),
      status: expectation.status,
    },
    input,
    name,
    routeFile,
    scenarioFile: options.scenarioFile,
  }
}

function resolveNarrowingTarget(
  narrowingPath: string,
  options: {
    readonly appRoot: string
    readonly invocationCwd?: string
  },
): string {
  if (narrowingPath.startsWith("./") || narrowingPath.startsWith("../")) {
    return resolve(options.invocationCwd ?? process.cwd(), narrowingPath)
  }

  return resolve(options.appRoot, narrowingPath)
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
