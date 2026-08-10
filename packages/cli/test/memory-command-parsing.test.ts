import { readFile } from "node:fs/promises"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"

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

describe("dawn memory --help", () => {
  it("lists the subcommands and their flags", async () => {
    // `USAGE` already enumerates every subcommand, but it was only reachable by
    // triggering an error (missing/unknown subcommand). `dawn memory --help` showed
    // just the description and --cwd, so there was no way to discover `consolidate`,
    // `reflect`, or any subcommand flag from the CLI itself.
    const stdout: string[] = []
    const io: CommandIo = { stderr: () => {}, stdout: (message) => stdout.push(message) }
    const program = createProgram(io)

    // commander's exitOverride turns `--help` into a thrown CommanderError after it
    // has already written the help text.
    await expect(program.parseAsync(["node", "dawn", "memory", "--help"])).rejects.toThrow()

    const help = stdout.join("")
    for (const expected of [
      "list",
      "search",
      "approve",
      "prune",
      "consolidate",
      "reflect",
      "--dry-run",
      "--cap",
    ]) {
      expect(help).toContain(expected)
    }
  })
})

describe("dawn memory help text covers the real dispatch table", () => {
  it("lists every subcommand the command actually handles", async () => {
    // `--help` renders a hand-written USAGE string while dispatch happens in a
    // `switch`. Nothing ties them together, so a subcommand added to the switch is
    // invisible in help — which is the bug fixed for `consolidate`/`reflect`, able to
    // return through a different door. Reading the source keeps the two honest.
    const source = await readFile(
      join(dirname(fileURLToPath(import.meta.url)), "../src/commands/memory.ts"),
      "utf8",
    )

    const dispatched = [...source.matchAll(/^\s+case "([a-z-]+)":/gm)].flatMap((m) =>
      m[1] ? [m[1]] : [],
    )
    expect(dispatched.length).toBeGreaterThan(0)

    const usage = source.slice(source.indexOf("const USAGE"), source.indexOf("export function"))
    const missing = dispatched.filter((name) => !usage.includes(name))

    expect(missing).toEqual([])
  })
})
