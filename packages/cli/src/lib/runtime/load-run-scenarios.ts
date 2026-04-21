import { constants } from "node:fs"
import { access, readdir } from "node:fs/promises"
import { dirname, join, resolve } from "node:path"
import { pathToFileURL } from "node:url"

import { discoverRoutes, findDawnApp } from "@dawn/core"
import { loadRouteKind } from "./load-route-kind.js"
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
  readonly mode: "chain" | "graph" | "workflow"
  readonly name: string
  readonly routeId: string
  readonly routeFile: string
  readonly routePath: string
  readonly run?: RunScenarioRunOptions
  readonly scenarioFile: string
}

export interface LoadRunScenariosOptions {
  readonly cwd?: string
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
    ...(options.cwd ? { cwd: options.cwd } : {}),
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
  readonly cwd?: string
  readonly narrowingPath?: string
  readonly routesDir: string
}): Promise<readonly string[]> {
  if (!options.narrowingPath) {
    return await collectScenarioFiles(options.routesDir)
  }

  const normalizedPathname = options.narrowingPath.startsWith("/")
    ? options.narrowingPath
    : `/${options.narrowingPath}`

  const manifest = await discoverRoutes(options.cwd ? { cwd: options.cwd } : {})
  const matchingRoutes = manifest.routes.filter(
    (route) =>
      route.pathname === normalizedPathname || route.pathname.startsWith(`${normalizedPathname}/`),
  )

  if (matchingRoutes.length === 0) {
    throw new RunScenarioLoadError(`No routes match narrowing path: ${normalizedPathname}`)
  }

  const scenarioFiles: string[] = []

  for (const route of matchingRoutes) {
    const routeScenarios = await collectScenarioFiles(route.routeDir)
    scenarioFiles.push(...routeScenarios)
  }

  return scenarioFiles.sort((left, right) => left.localeCompare(right))
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

  const indexFile = resolve(dirname(options.scenarioFile), "index.ts")

  if (!(await pathExists(indexFile))) {
    throw new RunScenarioLoadError(
      `Scenario file ${options.scenarioFile} has no sibling index.ts — run.test.ts must be colocated with a route entry point`,
    )
  }

  const mode = await loadRouteKindSafe(options.scenarioFile, indexFile)

  const routeIdentity = deriveRouteIdentity({
    appRoot: options.appRoot,
    routeFile: indexFile,
    routesDir: options.routesDir,
  })

  if (!routeIdentity.ok) {
    throw new RunScenarioLoadError(
      `Scenario file ${options.scenarioFile} sibling index.ts is outside the configured appDir`,
    )
  }

  const routeContext = {
    appRoot: options.appRoot,
    mode,
    routeFile: indexFile,
    routeId: routeIdentity.routeId,
    routePath: routeIdentity.routePath,
  }

  return await Promise.all(
    scenarioModule.default.map(
      async (rawScenario, index) =>
        await validateScenario({
          rawScenario,
          routeContext,
          scenarioFile: options.scenarioFile,
          scenarioIndex: index,
        }),
    ),
  )
}

async function loadRouteKindSafe(
  scenarioFile: string,
  indexFile: string,
): Promise<"chain" | "graph" | "workflow"> {
  try {
    return await loadRouteKind(indexFile)
  } catch {
    throw new RunScenarioLoadError(
      `Scenario file ${scenarioFile} sibling index.ts exports neither "workflow", "graph", nor "chain"`,
    )
  }
}

async function validateScenario(options: {
  readonly rawScenario: unknown
  readonly routeContext: {
    readonly appRoot: string
    readonly mode: "chain" | "graph" | "workflow"
    readonly routeFile: string
    readonly routeId: string
    readonly routePath: string
  }
  readonly scenarioFile: string
  readonly scenarioIndex: number
}): Promise<LoadedRunScenario> {
  if (!isRecord(options.rawScenario)) {
    throw new RunScenarioLoadError(
      `Scenario file ${options.scenarioFile} contains a non-object scenario at index ${options.scenarioIndex}`,
    )
  }

  const name = options.rawScenario.name
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

  return {
    appRoot: options.routeContext.appRoot,
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
    mode: options.routeContext.mode,
    name,
    routeId: options.routeContext.routeId,
    routeFile: options.routeContext.routeFile,
    routePath: options.routeContext.routePath,
    ...(isRecord(runOptions) && typeof runOptions.url === "string"
      ? { run: { url: runOptions.url } }
      : {}),
    scenarioFile: options.scenarioFile,
  }
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
