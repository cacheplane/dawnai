#!/usr/bin/env node

export { config } from "@dawn-ai/core"

import { realpathSync } from "node:fs"
import { resolve } from "node:path"
import { fileURLToPath } from "node:url"

import { Command, CommanderError } from "commander"

import { registerAddCommand } from "./commands/add.js"
import { registerBuildCommand } from "./commands/build.js"
import { registerCheckCommand } from "./commands/check.js"
import { registerDevCommand } from "./commands/dev.js"
import { registerDocsCommand } from "./commands/docs.js"
import { registerEvalCommand } from "./commands/eval.js"
import { registerMemoryCommand } from "./commands/memory.js"
import { registerRoutesCommand } from "./commands/routes.js"
import { registerRunCommand } from "./commands/run.js"
import { registerTestCommand } from "./commands/test.js"
import { registerTypegenCommand } from "./commands/typegen.js"
import { registerVerifyCommand } from "./commands/verify.js"
import { registerDevChildCommand } from "./lib/dev/dev-child.js"
import { diagnose } from "./lib/diagnostics.js"
import { CliError, type CommandIo, createNodeIo, writeLine } from "./lib/output.js"

export function renderError(error: unknown): string {
  const diag = diagnose(error)
  if (diag) return `${diag.summary}\n\n${diag.hint}`
  return error instanceof Error ? error.message : String(error)
}

export function createProgram(io: CommandIo): Command {
  const program = new Command()

  program
    .name("dawn")
    .description("Dawn CLI")
    .exitOverride()
    .configureOutput({
      writeErr: (message) => {
        io.stderr(message)
      },
      writeOut: (message) => {
        io.stdout(message)
      },
    })

  registerAddCommand(program, io)
  registerBuildCommand(program, io)
  registerCheckCommand(program, io)
  registerDevCommand(program, io)
  registerDocsCommand(program, io)
  registerEvalCommand(program, io)
  registerMemoryCommand(program, io)
  registerRunCommand(program, io)
  registerRoutesCommand(program, io)
  registerTestCommand(program, io)
  registerTypegenCommand(program, io)
  registerVerifyCommand(program, io)
  registerDevChildCommand(program)

  return program
}

export async function run(
  argv: readonly string[],
  io: CommandIo = createNodeIo(),
): Promise<number> {
  const program = createProgram(io)

  try {
    await program.parseAsync([...argv], { from: "user" })
    return 0
  } catch (error) {
    if (error instanceof CliError) {
      writeLine(io.stderr, error.message)
      return error.exitCode
    }

    if (error instanceof CommanderError) {
      return error.exitCode
    }

    writeLine(io.stderr, renderError(error))
    return 1
  }
}

export function isExecutedAsMain(importMetaUrl: string, argv1 = process.argv[1]): boolean {
  if (!argv1) {
    return false
  }

  try {
    return realpathSync(resolve(argv1)) === realpathSync(fileURLToPath(importMetaUrl))
  } catch {
    return false
  }
}

if (isExecutedAsMain(import.meta.url)) {
  run(process.argv.slice(2)).then(
    (exitCode) => {
      process.exit(exitCode)
    },
    (error) => {
      process.stderr.write(`${renderError(error)}\n`)
      process.exit(1)
    },
  )
}
