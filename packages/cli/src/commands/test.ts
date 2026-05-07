import { expectError, expectMeta, expectOutput } from "@dawn-ai/sdk/testing"
import { type Command, CommanderError } from "commander"

import { CliError, type CommandIo, formatErrorMessage, writeLine } from "../lib/output.js"
import { executeRoute } from "../lib/runtime/execute-route.js"
import { executeRouteServer } from "../lib/runtime/execute-route-server.js"
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
    result = scenario.run?.url
      ? await executeRouteServer({
          appRoot: scenario.appRoot,
          baseUrl: scenario.run.url,
          input: scenario.input,
          mode: scenario.mode,
          routeId: scenario.routeId,
          routePath: scenario.routePath,
        })
      : await executeRoute({
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

  return await evaluateScenario(scenario, result)
}

async function evaluateScenario(
  scenario: LoadedRunScenario,
  result: RuntimeExecutionResult,
): Promise<ScenarioOutcome> {
  const declarativeMismatch = scenario.expect
    ? evaluateDeclarativeExpectation(scenario.expect, result)
    : null

  if (declarativeMismatch) {
    return {
      kind: declarativeMismatch.kind,
      message: declarativeMismatch.message,
    }
  }

  if (!scenario.assert) {
    return { kind: "passed" }
  }

  try {
    await scenario.assert(result)
    return { kind: "passed" }
  } catch (error) {
    return {
      kind: "assertion",
      message: formatErrorMessage(error),
    }
  }
}

function evaluateDeclarativeExpectation(
  expectation: NonNullable<LoadedRunScenario["expect"]>,
  result: RuntimeExecutionResult,
): Exclude<ScenarioOutcome, ScenarioPass> | null {
  if (result.status === "failed" && expectation.status === "passed") {
    return {
      kind: "execution",
      message: result.error.message,
    }
  }

  if (result.status === "passed" && expectation.status === "failed") {
    return {
      kind: "assertion",
      message: "Expected status failed but received passed",
    }
  }

  try {
    if (expectation.meta) {
      expectMeta(result, expectation.meta)
    }

    if (result.status === "passed" && Object.hasOwn(expectation, "output")) {
      expectOutput(result, expectation.output)
    }

    if (result.status === "failed" && expectation.error) {
      expectError(result, expectation.error)
    }

    return null
  } catch (error) {
    return {
      kind: "assertion",
      message: formatErrorMessage(error),
    }
  }
}
