import { describe, expect, it } from "vitest"
import { resolveTailRequest } from "../src/commands/threads.js"
import { createProgram } from "../src/index.js"
import { CliError, type CommandIo } from "../src/lib/output.js"

/**
 * `dawn threads` is registered as `threads [subcommand] [args...]`. Unlike `memory`,
 * its flags (`--url`, `--header`, `--json`) are declared directly on the command
 * rather than hand-parsed out of `args`, specifically so `scripts/check-docs.mjs`
 * (which enumerates `command.options` from the built CLI) can see them. These tests
 * drive the real `createProgram` to prove commander actually binds them given the
 * program's `enablePositionalOptions()` (set for `memory`'s sake) rather than
 * swallowing them as extra positional `args`.
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

async function parse(
  argv: string[],
): Promise<{ error?: unknown; stderr: string[]; options: Record<string, unknown> | undefined }> {
  const { io, stderr } = collectIo()
  const program = createProgram(io)
  const threads = program.commands.find((command) => command.name() === "threads")
  if (!threads) throw new Error("threads command is not registered")
  let captured: Record<string, unknown> | undefined
  threads.action(async (_subcommand: string, _args: string[], options: Record<string, unknown>) => {
    captured = options
  })

  try {
    await program.parseAsync(["node", "dawn", ...argv])
  } catch (error) {
    return { error, stderr, options: captured }
  }
  return { stderr, options: captured }
}

describe("dawn threads tail flag parsing", () => {
  it("binds --url, repeated --header, and --json to the threads command", async () => {
    const { error, stderr, options } = await parse([
      "threads",
      "tail",
      "t1",
      "--url",
      "http://127.0.0.1:9/",
      "--header",
      "x-a: 1",
      "--header",
      "x-b: 2",
      "--json",
    ])

    expect(stderr.join("")).not.toMatch(/unknown option/)
    expect(error).toBeUndefined()
    expect(options?.url).toBe("http://127.0.0.1:9/")
    expect(options?.json).toBe(true)
    // Repeated --header accumulates into a list rather than overwriting.
    expect(options?.header).toEqual(["x-a: 1", "x-b: 2"])
  })
})

describe("dawn threads dispatch", () => {
  it("rejects a missing subcommand naming the usage", async () => {
    const { io } = collectIo()
    const program = createProgram(io)
    await expect(program.parseAsync(["node", "dawn", "threads"])).rejects.toThrow()
  })
})

describe("resolveTailRequest", () => {
  it("builds the attach URL against the default base", () => {
    const request = resolveTailRequest("t1", {})
    expect(request.url.toString()).toBe("http://127.0.0.1:3000/threads/t1/runs/stream")
    expect(request.json).toBe(false)
    expect(request.headers).toEqual({})
  })

  it("encodes the thread id and honours a custom --url base", () => {
    const request = resolveTailRequest("t 1", { url: "http://example.test:9/" })
    expect(request.url.toString()).toBe("http://example.test:9/threads/t%201/runs/stream")
  })

  it("parses repeated --header on the first colon only, keeping later colons in the value", () => {
    const request = resolveTailRequest("t1", { header: ["x-a: 1", "x-b: http://x:1"] })
    expect(request.headers).toEqual({ "x-a": "1", "x-b": "http://x:1" })
  })

  it("sets json from --json", () => {
    const request = resolveTailRequest("t1", { json: true })
    expect(request.json).toBe(true)
  })

  it("rejects a header with no colon", () => {
    expect(() => resolveTailRequest("t1", { header: ["nocolon"] })).toThrow(CliError)
  })

  it("rejects a header with an empty name", () => {
    expect(() => resolveTailRequest("t1", { header: [": value"] })).toThrow(CliError)
  })

  it("throws a CliError(2) for an unparseable --url", () => {
    try {
      resolveTailRequest("t1", { url: "not a url" })
      throw new Error("expected resolveTailRequest to throw")
    } catch (error) {
      expect(error).toBeInstanceOf(CliError)
      expect((error as CliError).exitCode).toBe(2)
    }
  })
})
