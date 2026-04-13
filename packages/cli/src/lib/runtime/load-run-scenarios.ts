import { constants } from "node:fs"
import { access, readdir } from "node:fs/promises"
import { basename, dirname, join, resolve } from "node:path"
import { pathToFileURL } from "node:url"

import { findDawnApp } from "@dawn/core"
import { registerTsxLoader } from "./register-tsx-loader.js"
import type { RuntimeExecutionResult } from "./result.js"
import { deriveRouteIdentity } from "./route-identity.js"

const RUN_TEST_FILE = "run.test.ts"

export interface RunScenarioExpectation {
  readonly error?: {
    readonly kind?: string
    readonly message?: string | { readonly includes: string }
  }
  readonly meta?: {
    readonly executionSource?: "in-process" | "server"
    readonly mode?: "graph" | "workflow"
    readonly routeId?: string
    readonly routePath?: string
  }
  readonly output?: unknown
  readonly status: "failed" | "passed"
}

export interface RunScenarioRunOptions {
  readonly url?: string
}

export interface LoadedRunScenario {
  readonly appRoot: string
  readonly assert?: (result: RuntimeExecutionResult) => unknown | Promise<unknown>
  readonly expect?: RunScenarioExpectation
  readonly input: unknown
  readonly mode: "graph" | "workflow"
  readonly name: string
  readonly routeId: string
  readonly routeFile: string
  readonly routePath: string
  readonly run?: RunScenarioRunOptions
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
          routesDir: app.routesDir,
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
  readonly routesDir: string
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
          routesDir: options.routesDir,
          scenarioFile: options.scenarioFile,
          scenarioIndex: index,
        }),
    ),
  )
}

async function validateScenario(options: {
  readonly appRoot: string
  readonly rawScenario: unknown
  readonly routesDir: string
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
  const hasInput = Object.hasOwn(options.rawScenario, "input")
  const input = options.rawScenario.input
  const expectation = options.rawScenario.expect
  const expectationRecord = isRecord(expectation) ? expectation : null
  const assert = options.rawScenario.assert
  const runOptions = options.rawScenario.run

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

  if (!hasInput) {
    throw new RunScenarioLoadError(`Scenario "${name}" must define input`)
  }

  if (typeof expectation !== "undefined" && !expectationRecord) {
    throw new RunScenarioLoadError(`Scenario "${name}" expect must be an object when provided`)
  }

  if (!expectationRecord && typeof assert !== "function") {
    throw new RunScenarioLoadError(
      `Scenario "${name}" must define at least one of expect or assert`,
    )
  }

  if (expectationRecord && !isRunScenarioStatus(expectationRecord.status)) {
    throw new RunScenarioLoadError(
      `Scenario "${name}" must define expect.status as "passed" or "failed"`,
    )
  }

  if (typeof assert !== "undefined" && !isScenarioAssert(assert)) {
    throw new RunScenarioLoadError(`Scenario "${name}" assert must be a function when provided`)
  }

  if (typeof runOptions !== "undefined" && !isRecord(runOptions)) {
    throw new RunScenarioLoadError(`Scenario "${name}" run must be an object when provided`)
  }

  if (
    isRecord(runOptions) &&
    typeof runOptions.url !== "undefined" &&
    typeof runOptions.url !== "string"
  ) {
    throw new RunScenarioLoadError(`Scenario "${name}" run.url must be a string when provided`)
  }

  if (isRecord(expectationRecord?.error) && !isValidErrorExpectation(expectationRecord.error)) {
    throw new RunScenarioLoadError(
      `Scenario "${name}" expect.error must use kind and message strings or { includes: string }`,
    )
  }

  if (
    typeof expectationRecord?.meta !== "undefined" &&
    !isValidMetaExpectation(expectationRecord.meta)
  ) {
    throw new RunScenarioLoadError(
      `Scenario "${name}" expect.meta must use string fields for mode, routeId, routePath, and executionSource`,
    )
  }

  const routeFile = resolve(dirname(options.scenarioFile), target)

  if (!(await pathExists(routeFile))) {
    throw new RunScenarioLoadError(`Scenario "${name}" target does not exist: ${routeFile}`)
  }

  const routeIdentity = deriveRouteIdentity({
    appRoot: options.appRoot,
    routeFile,
    routesDir: options.routesDir,
  })

  if (!routeIdentity.ok) {
    throw new RunScenarioLoadError(`Scenario "${name}" target is outside the configured appDir`)
  }

  const mode = target === "./graph.ts" ? "graph" : "workflow"

  return {
    appRoot: options.appRoot,
    ...(isScenarioAssert(assert) ? { assert } : {}),
    ...(expectationRecord
      ? {
          expect: {
            ...(isRecord(expectationRecord.error) ? { error: expectationRecord.error } : {}),
            ...(isRecord(expectationRecord.meta) ? { meta: expectationRecord.meta } : {}),
            ...(Object.hasOwn(expectationRecord, "output")
              ? { output: expectationRecord.output }
              : {}),
            status: expectationRecord.status as RunScenarioExpectation["status"],
          },
        }
      : {}),
    input,
    mode,
    name,
    routeId: routeIdentity.routeId,
    routeFile,
    routePath: routeIdentity.routePath,
    ...(isRecord(runOptions) && typeof runOptions.url === "string"
      ? { run: { url: runOptions.url } }
      : {}),
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

function isRunScenarioStatus(value: unknown): value is RunScenarioExpectation["status"] {
  return value === "passed" || value === "failed"
}

function isScenarioAssert(value: unknown): value is NonNullable<LoadedRunScenario["assert"]> {
  return typeof value === "function"
}

function isValidErrorExpectation(value: Record<string, unknown>): boolean {
  if (typeof value.kind !== "undefined" && typeof value.kind !== "string") {
    return false
  }

  if (typeof value.message === "undefined") {
    return true
  }

  return (
    typeof value.message === "string" ||
    (isRecord(value.message) && typeof value.message.includes === "string")
  )
}

function isValidMetaExpectation(
  value: unknown,
): value is NonNullable<RunScenarioExpectation["meta"]> {
  if (!isRecord(value)) {
    return false
  }

  return ["executionSource", "mode", "routeId", "routePath"].every((key) => {
    return typeof value[key] === "undefined" || typeof value[key] === "string"
  })
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await access(path, constants.F_OK)
    return true
  } catch {
    return false
  }
}
