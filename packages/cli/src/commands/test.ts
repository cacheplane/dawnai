import { isDeepStrictEqual } from "node:util"

import { type Command, CommanderError } from "commander"

import { CliError, type CommandIo, formatErrorMessage, writeLine } from "../lib/output.js"
import { executeRoute } from "../lib/runtime/execute-route.js"
import {
  type LoadedRunScenario,
  loadRunScenarios,
  RunScenarioLoadError,
} from "../lib/runtime/load-run-scenarios.js"
import type { RuntimeExecutionResult } from "../lib/runtime/result.js"

interface TestOptions {
  readonly cwd?: string
}

interface ScenarioPass {
  readonly kind: "passed"
}

interface ScenarioAssertionFailure {
  readonly kind: "assertion"
  readonly message: string
}

interface ScenarioExecutionFailure {
  readonly kind: "execution"
  readonly message: string
}

type ScenarioOutcome = ScenarioAssertionFailure | ScenarioExecutionFailure | ScenarioPass

export function registerTestCommand(program: Command, io: CommandIo): void {
  program
    .command("test [path]")
    .description("Run Dawn route scenarios")
    .option("--cwd <path>", "Path to the Dawn app root or a child directory within it")
    .action(async (path: string | undefined, options: TestOptions) => {
      await runTestCommand(path, options, io)
    })
}

export async function runTestCommand(
  narrowingPath: string | undefined,
  options: TestOptions,
  io: CommandIo,
): Promise<void> {
  try {
    const scenarios = await loadRunScenarios({
      ...(options.cwd ? { cwd: options.cwd } : {}),
      invocationCwd: process.cwd(),
      ...(narrowingPath ? { narrowingPath } : {}),
    })

    if (scenarios.length === 0) {
      throw new CliError("No run.test.ts scenarios found", 1)
    }

    let passed = 0
    let failed = 0

    for (const scenario of scenarios) {
      const outcome = await runScenario(scenario)

      if (outcome.kind === "passed") {
        passed += 1
        writeLine(io.stdout, `PASS ${scenario.name}`)
        continue
      }

      failed += 1
      writeLine(io.stdout, `FAIL ${scenario.name} [${outcome.kind}] ${outcome.message}`)
    }

    writeLine(io.stdout, `Summary: ${passed} passed, ${failed} failed`)

    if (failed > 0) {
      throw new CommanderError(1, "dawn.test.failed", "")
    }
  } catch (error) {
    if (error instanceof CliError || error instanceof CommanderError) {
      throw error
    }

    if (error instanceof RunScenarioLoadError) {
      throw new CliError(`Scenario-load failure: ${error.message}`, 2)
    }

    throw new CliError(`Scenario-load failure: ${formatErrorMessage(error)}`, 2)
  }
}

async function runScenario(scenario: LoadedRunScenario): Promise<ScenarioOutcome> {
  let result: RuntimeExecutionResult

  try {
    result = await executeRoute({
      appRoot: scenario.appRoot,
      input: scenario.input,
      routeFile: scenario.routeFile,
    })
  } catch (error) {
    return {
      kind: "execution",
      message: formatErrorMessage(error),
    }
  }

  return evaluateScenario(scenario, result)
}

function evaluateScenario(
  scenario: LoadedRunScenario,
  result: RuntimeExecutionResult,
): ScenarioOutcome {
  if (result.status === "failed" && scenario.expect.status === "passed") {
    return {
      kind: "execution",
      message: result.error.message,
    }
  }

  if (result.status === "passed" && scenario.expect.status === "failed") {
    return {
      kind: "assertion",
      message: "Expected status failed but received passed",
    }
  }

  if (result.status === "passed") {
    const mismatch = Object.hasOwn(scenario.expect, "output")
      ? findOutputMismatch(scenario.expect.output, result.output, "output")
      : null

    if (mismatch) {
      return {
        kind: "assertion",
        message: mismatch,
      }
    }

    return { kind: "passed" }
  }

  if (scenario.expect.error?.kind && scenario.expect.error.kind !== result.error.kind) {
    return {
      kind: "assertion",
      message: `Expected error.kind ${scenario.expect.error.kind} but received ${result.error.kind}`,
    }
  }

  if (scenario.expect.error?.message && scenario.expect.error.message !== result.error.message) {
    return {
      kind: "assertion",
      message: `Expected error.message "${scenario.expect.error.message}" but received "${result.error.message}"`,
    }
  }

  return { kind: "passed" }
}

function findOutputMismatch(expected: unknown, actual: unknown, path: string): string | null {
  if (!isPlainObject(expected) || !isPlainObject(actual)) {
    return isDeepStrictEqual(actual, expected)
      ? null
      : `Expected ${path} to equal ${JSON.stringify(expected)} but received ${JSON.stringify(actual)}`
  }

  for (const [key, expectedValue] of Object.entries(expected)) {
    const nextPath = `${path}.${key}`

    if (!Object.hasOwn(actual, key)) {
      return `Expected ${nextPath} to equal ${JSON.stringify(expectedValue)} but received undefined`
    }

    const mismatch = findOutputMismatch(expectedValue, actual[key], nextPath)

    if (mismatch) {
      return mismatch
    }
  }

  return null
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}
