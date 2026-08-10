import { constants } from "node:fs"
import { access, readdir } from "node:fs/promises"
import { dirname, join, resolve } from "node:path"
import { pathToFileURL } from "node:url"

import { discoverRoutes, findDawnApp } from "@dawn-ai/core/node"
import {
  isScenarioSuite,
  type RuntimeErrorExpectation,
  type RuntimeMetaExpectation,
  readScenarioSuite,
  type ScenarioDescriptor,
  type ScenarioSuiteDescriptor,
} from "@dawn-ai/sdk/testing"
import { loadRouteKind } from "./load-route-kind.js"
import { registerTsxLoader } from "./register-tsx-loader.js"
import type { RuntimeExecutionResult } from "./result.js"
import { deriveRouteIdentity } from "./route-identity-node.js"
import { discoverToolDefinitions } from "./tool-discovery.js"

const RUN_TEST_FILE = "run.test.ts"

export interface RunScenarioExpectation {
  readonly error?: RuntimeErrorExpectation
  readonly meta?: RuntimeMetaExpectation
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
  readonly mode: "agent" | "chain" | "graph" | "workflow"
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
  const defaultExport = await importScenarioDefault(options.scenarioFile)

  if (!isScenarioSuite(defaultExport)) {
    throw new RunScenarioLoadError(
      `Scenario file ${options.scenarioFile} must default export scenarios("<route>").scenario(...) from "@dawn-ai/sdk/testing".\nPlain scenario arrays are not supported.`,
    )
  }

  const suite = readScenarioSuite(defaultExport)
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

  if (suite.route !== routeIdentity.routeId) {
    throw new RunScenarioLoadError(
      `Scenario file ${options.scenarioFile} declares route "${suite.route}" but is colocated with route "${routeIdentity.routeId}"`,
    )
  }

  await validateScenarioToolMocks({
    appRoot: options.appRoot,
    routeDir: dirname(indexFile),
    scenarioFile: options.scenarioFile,
    suite,
  })

  const routeContext = {
    appRoot: options.appRoot,
    mode,
    routeFile: indexFile,
    routeId: routeIdentity.routeId,
    routePath: routeIdentity.routePath,
  }

  return suite.scenarios.map((scenario) =>
    loadScenarioDescriptor({
      routeContext,
      scenario,
      scenarioFile: options.scenarioFile,
    }),
  )
}

async function importScenarioDefault(scenarioFile: string): Promise<unknown> {
  try {
    const scenarioModule = (await import(pathToFileURL(scenarioFile).href)) as {
      readonly default?: unknown
    }
    return scenarioModule.default
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error)
    throw new RunScenarioLoadError(`Scenario file ${scenarioFile} failed to load: ${detail}`)
  }
}

async function loadRouteKindSafe(
  scenarioFile: string,
  indexFile: string,
): Promise<"agent" | "chain" | "graph" | "workflow"> {
  try {
    return await loadRouteKind(indexFile)
  } catch {
    throw new RunScenarioLoadError(
      `Scenario file ${scenarioFile} sibling index.ts exports neither "workflow", "graph", nor "chain"`,
    )
  }
}

function loadScenarioDescriptor(options: {
  readonly routeContext: {
    readonly appRoot: string
    readonly mode: "agent" | "chain" | "graph" | "workflow"
    readonly routeFile: string
    readonly routeId: string
    readonly routePath: string
  }
  readonly scenario: ScenarioDescriptor
  readonly scenarioFile: string
}): LoadedRunScenario {
  return {
    appRoot: options.routeContext.appRoot,
    ...(options.scenario.assert ? { assert: options.scenario.assert } : {}),
    expect: {
      ...(options.scenario.expectedError !== undefined
        ? { error: options.scenario.expectedError }
        : {}),
      ...(options.scenario.expectedMeta !== undefined
        ? { meta: options.scenario.expectedMeta }
        : {}),
      ...(Object.hasOwn(options.scenario, "expectedOutput")
        ? { output: options.scenario.expectedOutput }
        : {}),
      status: options.scenario.expectedStatus,
    },
    input: options.scenario.input,
    mode: options.routeContext.mode,
    name: options.scenario.name,
    routeId: options.routeContext.routeId,
    routeFile: options.routeContext.routeFile,
    routePath: options.routeContext.routePath,
    ...(options.scenario.execution === "in-process"
      ? {}
      : { run: { url: options.scenario.execution.serverUrl } }),
    scenarioFile: options.scenarioFile,
  }
}

async function validateScenarioToolMocks(options: {
  readonly appRoot: string
  readonly routeDir: string
  readonly scenarioFile: string
  readonly suite: ScenarioSuiteDescriptor
}): Promise<void> {
  if (!options.suite.scenarios.some((scenario) => scenario.toolMocks.length > 0)) {
    return
  }

  const discoveredTools = await discoverToolDefinitions({
    appRoot: options.appRoot,
    routeDir: options.routeDir,
  }).catch((error: unknown) => {
    const detail = error instanceof Error ? error.message : String(error)
    throw new RunScenarioLoadError(
      `Scenario file ${options.scenarioFile} failed to discover application tools: ${detail}`,
    )
  })
  const availableToolNames = discoveredTools
    .map((tool) => tool.name)
    .sort((left, right) => left.localeCompare(right))
  const availableTools = new Set(availableToolNames)

  for (const scenario of options.suite.scenarios) {
    const unknownToolNames = scenario.toolMocks
      .map((mock) => mock.name)
      .filter((name) => !availableTools.has(name))
      .sort((left, right) => left.localeCompare(right))

    if (unknownToolNames.length === 0) {
      continue
    }

    const unknownTools =
      unknownToolNames.length === 1
        ? `tool "${unknownToolNames[0]}"`
        : `tools ${unknownToolNames.map((name) => `"${name}"`).join(", ")}`
    const availableNames = availableToolNames.length > 0 ? availableToolNames.join(", ") : "(none)"

    throw new RunScenarioLoadError(
      `Scenario "${scenario.name}" mocks unknown application ${unknownTools}. Available tools: ${availableNames}. Scenario file: ${options.scenarioFile}`,
    )
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
