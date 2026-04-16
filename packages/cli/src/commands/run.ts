import { type Command, CommanderError } from "commander"

import {
  CliError,
  type CommandIo,
  formatErrorMessage,
  readCommandStdin,
  writeLine,
} from "../lib/output.js"
import { executeRoute } from "../lib/runtime/execute-route.js"
import { executeRouteServer } from "../lib/runtime/execute-route-server.js"
import {
  type ResolvedRouteTarget,
  resolveRouteTarget,
} from "../lib/runtime/resolve-route-target.js"
import type { RuntimeExecutionResult } from "../lib/runtime/result.js"

interface RunOptions {
  readonly cwd?: string
  readonly url?: string
}

export function registerRunCommand(program: Command, io: CommandIo): void {
  program
    .command("run <routePath>")
    .description("Execute one Dawn route invocation")
    .option("--cwd <path>", "Path to the Dawn app root or a child directory within it")
    .option("--url <baseUrl>", "Invoke a Dawn route against a running Agent Server")
    .action(async (routePath: string, options: RunOptions) => {
      await runRunCommand(routePath, options, io)
    })
}

export async function runRunCommand(
  routePath: string,
  options: RunOptions,
  io: CommandIo,
): Promise<void> {
  try {
    const input = await readJsonFromStdin(io)
    const resolvedTarget = await resolveRouteTarget({
      ...(options.cwd ? { cwd: options.cwd } : {}),
      invocationCwd: process.cwd(),
      routePath,
    })

    if ("status" in resolvedTarget && resolvedTarget.status === "failed") {
      writeResult(routePath, resolvedTarget, io)
      throw new CommanderError(1, "dawn.run.failed", "")
    }

    const target = resolvedTarget as ResolvedRouteTarget
    const normalizedResult = options.url
      ? await executeRouteServer({
          appRoot: target.appRoot,
          baseUrl: options.url,
          input,
          routeId: target.routeId,
          routePath: target.routePath,
        })
      : await executeRoute({
          appRoot: target.appRoot,
          input,
          routeFile: target.routeFile,
        })

    writeResult(routePath, normalizedResult, io)

    if (normalizedResult.status === "failed") {
      throw new CommanderError(1, "dawn.run.failed", "")
    }
  } catch (error) {
    if (error instanceof CliError || error instanceof CommanderError) {
      throw error
    }

    throw new CliError(`Run failed: ${formatErrorMessage(error)}`, 2)
  }
}

async function readJsonFromStdin(io: CommandIo): Promise<unknown> {
  const rawInput = await readCommandStdin(io)

  if (rawInput.trim().length === 0) {
    return null
  }

  try {
    return JSON.parse(rawInput)
  } catch (error) {
    throw new CliError(`Failed to read JSON from stdin: ${formatErrorMessage(error)}`, 2)
  }
}

function writeResult(routePath: string, result: RuntimeExecutionResult, io: CommandIo): void {
  const payload =
    result.routePath === null && routePath.length > 0 ? { ...result, routePath } : result

  writeLine(io.stdout, JSON.stringify(payload, null, 2))
}
