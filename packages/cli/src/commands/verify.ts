import { discoverRoutes, findDawnApp, renderRouteTypes } from "@dawn/core"
import type { Command } from "commander"

import { CliError, type CommandIo, formatErrorMessage, writeLine } from "../lib/output.js"

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

type VerifyCheckResult =
  | VerifyAppCheckResult
  | VerifyRoutesCheckResult
  | VerifyTypegenCheckResult

interface VerifyResult {
  readonly appRoot: string
  readonly checks: readonly VerifyCheckResult[]
  readonly counts: VerifyCheckCounts
  readonly status: "passed"
}

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
  try {
    const result = await verifyApp(options)

    if (options.json) {
      writeLine(io.stdout, JSON.stringify(result, null, 2))
      return
    }

    const routesCheck = result.checks.find(
      (check): check is VerifyRoutesCheckResult => check.name === "routes",
    )

    writeLine(
      io.stdout,
      `Dawn app integrity OK: ${result.counts.passed} checks passed, ${routesCheck?.routeCount ?? 0} routes discovered.`,
    )
  } catch (error) {
    throw new CliError(`Verify failed: ${formatErrorMessage(error)}`)
  }
}

async function verifyApp(options: VerifyOptions): Promise<VerifyResult> {
  const app = await findDawnApp(options.cwd ? { cwd: options.cwd } : {})
  const manifest = await discoverRoutes({ appRoot: app.appRoot })
  const renderedTypes = renderRouteTypes(manifest)

  const checks: readonly VerifyCheckResult[] = [
    {
      appRoot: app.appRoot,
      configPath: app.configPath,
      name: "app",
      routesDir: app.routesDir,
      status: PASSED_STATUS,
    },
    {
      name: "routes",
      routeCount: manifest.routes.length,
      status: PASSED_STATUS,
    },
    {
      name: "typegen",
      renderedBytes: Buffer.byteLength(renderedTypes, "utf8"),
      status: PASSED_STATUS,
    },
  ]

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
