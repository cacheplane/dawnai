import { resolve } from "node:path"

import { discoverRoutes, findDawnApp, renderRouteTypes } from "@dawn/core"
import { type Command, CommanderError } from "commander"

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

interface VerifyFailedCheckResult {
  readonly error: {
    readonly message: string
  }
  readonly name: "app"
  readonly status: "failed"
}

type VerifyCheckResult =
  | VerifyAppCheckResult
  | VerifyFailedCheckResult
  | VerifyRoutesCheckResult
  | VerifyTypegenCheckResult

interface VerifySuccessResult {
  readonly appRoot: string
  readonly checks: readonly VerifyCheckResult[]
  readonly counts: VerifyCheckCounts
  readonly status: "passed"
}

interface VerifyFailureResult {
  readonly appRoot: string
  readonly checks: readonly [VerifyFailedCheckResult]
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
    try {
      const result = await verifyApp(options)
      writeLine(io.stdout, JSON.stringify(result, null, 2))
      return
    } catch (error) {
      writeLine(io.stdout, JSON.stringify(createVerifyFailureResult(options, error), null, 2))
      throw new CommanderError(1, "dawn.verify.failed", "")
    }
  }

  try {
    const result = await verifyApp(options)
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

async function verifyApp(options: VerifyOptions): Promise<VerifySuccessResult> {
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

function createVerifyFailureResult(options: VerifyOptions, error: unknown): VerifyFailureResult {
  const message = formatErrorMessage(error)

  return {
    appRoot: inferFailureAppRoot(options, message),
    checks: [
      {
        error: {
          message,
        },
        name: "app",
        status: FAILED_STATUS,
      },
    ],
    counts: {
      failed: 1,
      passed: 0,
      total: 1,
    },
    status: FAILED_STATUS,
  }
}

function inferFailureAppRoot(options: VerifyOptions, message: string): string {
  const fromMessage = /^Invalid Dawn app at (.+?)\. Missing: /u.exec(message)?.[1]

  return fromMessage ?? resolve(options.cwd ?? process.cwd())
}
