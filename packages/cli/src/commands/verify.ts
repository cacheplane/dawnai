import { existsSync } from "node:fs"
import { dirname, join, resolve } from "node:path"

import { discoverRoutes, findDawnApp, renderRouteTypes, type RouteManifest } from "@dawn/core"
import { type Command, CommanderError } from "commander"

import { CliError, type CommandIo, formatErrorMessage, writeLine } from "../lib/output.js"
import {
  loadAuthoringRouteDefinition,
  loadAuthoringRouteHandler,
} from "../lib/runtime/route-definition.js"
import { discoverToolDefinitions } from "../lib/runtime/tool-discovery.js"

interface VerifyOptions {
  readonly cwd?: string
  readonly json?: boolean
}

interface VerifyCheckCounts {
  readonly failed: number
  readonly passed: number
  readonly total: number
}

interface VerifyAppCheckResult {
  readonly appRoot: string
  readonly configPath: string
  readonly name: "app"
  readonly routesDir: string
  readonly status: "passed"
}

interface VerifyRoutesCheckResult {
  readonly name: "routes"
  readonly routeCount: number
  readonly status: "passed"
}

interface VerifyTypegenCheckResult {
  readonly name: "typegen"
  readonly renderedBytes: number
  readonly status: "passed"
}

interface VerifyFailedCheckResult {
  readonly error: {
    readonly message: string
  }
  readonly name: "app" | "routes" | "typegen"
  readonly status: "failed"
}

type VerifyCheckResult =
  | VerifyAppCheckResult
  | VerifyFailedCheckResult
  | VerifyRoutesCheckResult
  | VerifyTypegenCheckResult

type DawnApp = Awaited<ReturnType<typeof findDawnApp>>

interface VerifySuccessResult {
  readonly appRoot: string
  readonly checks: readonly VerifyCheckResult[]
  readonly counts: VerifyCheckCounts
  readonly status: "passed"
}

interface VerifyFailureResult {
  readonly appRoot: string
  readonly checks: readonly VerifyCheckResult[]
  readonly counts: VerifyCheckCounts
  readonly status: "failed"
}

const FAILED_STATUS = "failed" as const
const PASSED_STATUS = "passed" as const

export function registerVerifyCommand(program: Command, io: CommandIo): void {
  program
    .command("verify")
    .description("Verify Dawn app integrity")
    .option("--cwd <path>", "Path to the Dawn app root or a child directory within it")
    .option("--json", "Print the normalized verify result as JSON")
    .action(async (options: VerifyOptions) => {
      await runVerifyCommand(options, io)
    })
}

export async function runVerifyCommand(options: VerifyOptions, io: CommandIo): Promise<void> {
  if (options.json) {
    const result = await verifyApp(options)
    writeLine(io.stdout, JSON.stringify(result, null, 2))

    if (result.status === FAILED_STATUS) {
      throw new CommanderError(1, "dawn.verify.failed", "")
    }

    return
  }

  const result = await verifyApp(options)

  if (result.status === PASSED_STATUS) {
    const routesCheck = result.checks.find(
      (check): check is VerifyRoutesCheckResult => check.name === "routes",
    )

    writeLine(
      io.stdout,
      `Dawn app integrity OK: ${result.counts.passed} checks passed, ${routesCheck?.routeCount ?? 0} routes discovered.`,
    )
    return
  }

  throw new CliError(`Verify failed: ${getFailureMessage(result)}`)
}

async function verifyApp(
  options: VerifyOptions,
): Promise<VerifySuccessResult | VerifyFailureResult> {
  let app: DawnApp

  try {
    app = await findDawnApp(options.cwd ? { cwd: options.cwd } : {})
  } catch (error) {
    return createVerifyFailureResult(
      inferFailureAppRoot(options, formatErrorMessage(error)),
      [],
      "app",
      error,
    )
  }

  const checks: VerifyCheckResult[] = [
    {
      appRoot: app.appRoot,
      configPath: app.configPath,
      name: "app",
      routesDir: app.routesDir,
      status: PASSED_STATUS,
    },
  ]

  let manifest: Awaited<ReturnType<typeof discoverRoutes>>

  try {
    manifest = await discoverRoutes({ appRoot: app.appRoot })
    await validateAuthoringRoutes(manifest)
  } catch (error) {
    return createVerifyFailureResult(app.appRoot, checks, "routes", error)
  }

  checks.push({
    name: "routes",
    routeCount: manifest.routes.length,
    status: PASSED_STATUS,
  })

  let renderedTypes: string

  try {
    renderedTypes = renderRouteTypes(manifest)
  } catch (error) {
    return createVerifyFailureResult(app.appRoot, checks, "typegen", error)
  }

  checks.push({
    name: "typegen",
    renderedBytes: Buffer.byteLength(renderedTypes, "utf8"),
    status: PASSED_STATUS,
  })

  return {
    appRoot: app.appRoot,
    checks,
    counts: {
      failed: 0,
      passed: checks.length,
      total: checks.length,
    },
    status: PASSED_STATUS,
  }
}

function createVerifyFailureResult(
  appRoot: string,
  checks: readonly VerifyCheckResult[],
  name: VerifyFailedCheckResult["name"],
  error: unknown,
): VerifyFailureResult {
  const message = formatErrorMessage(error)
  const nextChecks: VerifyCheckResult[] = [
    ...checks,
    {
      error: {
        message,
      },
      name,
      status: FAILED_STATUS,
    },
  ]
  const passed = nextChecks.filter((check) => check.status === PASSED_STATUS).length

  return {
    appRoot,
    checks: nextChecks,
    counts: {
      failed: 1,
      passed,
      total: nextChecks.length,
    },
    status: FAILED_STATUS,
  }
}

function getFailureMessage(result: VerifyFailureResult): string {
  const failedCheck = [...result.checks].reverse().find((check) => check.status === FAILED_STATUS)

  return failedCheck?.error.message ?? "Verification failed."
}

function inferFailureAppRoot(options: VerifyOptions, message: string): string {
  const fromMessage = /^Invalid Dawn app at (.+?)\. Missing: /u.exec(message)?.[1]

  if (fromMessage) {
    return fromMessage
  }

  return findAppRootFromCwd(options.cwd) ?? resolve(options.cwd ?? process.cwd())
}

function findAppRootFromCwd(cwd = process.cwd()): string | null {
  let currentDir = resolve(cwd)

  while (true) {
    if (existsSync(join(currentDir, "dawn.config.ts"))) {
      return currentDir
    }

    const parentDir = dirname(currentDir)

    if (parentDir === currentDir) {
      return null
    }

    currentDir = parentDir
  }
}

async function validateAuthoringRoutes(manifest: RouteManifest): Promise<void> {
  for (const route of manifest.routes) {
    if (route.entryKind !== "route") {
      continue
    }

    const definition = await loadAuthoringRouteDefinition(route.entryFile)

    if (!definition) {
      throw new Error(`Route definition ${route.entryFile} must export a Dawn route definition`)
    }

    await loadAuthoringRouteHandler(definition)
    await discoverToolDefinitions({
      appRoot: manifest.appRoot,
      routeDir: route.routeDir,
    })
  }
}
