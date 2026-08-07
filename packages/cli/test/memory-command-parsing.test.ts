import { describe, expect, it } from "vitest"

import { createProgram } from "../src/index.js"
import type { CommandIo } from "../src/lib/output.js"

/**
 * `dawn memory` is registered as `memory [subcommand] [args...]`, so every flag the
 * subcommands document (`prune --cap`, `consolidate --dry-run`, …) has to survive
 * commander's own option parsing before the handler ever sees it.
 *
 * The rest of the memory suite calls `runMemoryCommand([...])` directly, which skips
 * commander entirely — so the flags were exercised at the handler but were rejected by
 * the real CLI with `error: unknown option`. These tests drive the actual program.
 */
function collectIo(): { io: CommandIo; stderr: string[] } {
  const stderr: string[] = []
  const io: CommandIo = {
    stderr: (message: string) => {
      stderr.push(message)
    },
    stdout: () => {},
  }
  return { io, stderr }
}

async function parse(argv: string[]): Promise<{ error?: unknown; stderr: string[] }> {
  const { io, stderr } = collectIo()
  const program = createProgram(io)
  // Stop before doing any work: we are asserting on ARG PARSING, not behavior.
  const memory = program.commands.find((command) => command.name() === "memory")
  if (!memory) throw new Error("memory command is not registered")
  const captured: string[][] = []
  memory.action(async (_subcommand: string, args: string[]) => {
    captured.push(args)
  })

  try {
    await program.parseAsync(["node", "dawn", ...argv])
  } catch (error) {
    return { error, stderr }
  }
  return { stderr }
}

describe("dawn memory flag parsing", () => {
  it.each([
    ["prune", ["--cap", "100"]],
    ["prune", ["--namespace", "team/a"]],
    ["consolidate", ["--dry-run"]],
    ["consolidate", ["--max-batches", "2"]],
    ["reflect", ["--dry-run", "--namespace", "team/a"]],
    ["reflect", ["--model", "gpt-5-mini", "--provider", "openai"]],
  ])("accepts documented flags on `memory %s`", async (subcommand, flags) => {
    const { error, stderr } = await parse(["memory", subcommand, ...flags])

    expect(stderr.join("")).not.toMatch(/unknown option/)
    expect(error).toBeUndefined()
  })

  it("still parses the memory-level --cwd option", async () => {
    const { error, stderr } = await parse(["memory", "--cwd", "/tmp/app", "prune", "--cap", "5"])

    expect(stderr.join("")).not.toMatch(/unknown option/)
    expect(error).toBeUndefined()
  })
})
