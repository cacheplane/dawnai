import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { Command } from "commander"
import { afterEach, describe, expect, test } from "vitest"

import { registerStartCommand, runStartCommand } from "../src/commands/start.js"
import { CliError, type CommandIo } from "../src/lib/output.js"

const tempDirs: string[] = []
const handles: Array<{ close: () => Promise<void> }> = []

afterEach(async () => {
  await Promise.all(handles.splice(0).map((handle) => handle.close()))
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { force: true, recursive: true })))
})

describe("dawn start", () => {
  test("boots the production runtime, serves healthz, and logs the bound url", async () => {
    const appRoot = await createFixtureApp({
      "dawn.config.ts": "export default {};\n",
      "package.json": "{}\n",
      "src/app/support/[tenant]/index.ts": `export const graph = async () => ({ ok: true });\n`,
    })

    const { io, stdout } = createCapturingIo()

    const handle = await withCwd(appRoot, async () =>
      runStartCommand({ host: "127.0.0.1", port: "0" }, io),
    )
    handles.push(handle)

    expect(handle.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/)
    expect(stdout.join("")).toContain(`dawn start listening on ${handle.url}`)

    const response = await fetch(new URL("/healthz", handle.url))
    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({ status: "ready" })
  })

  test("registers idempotent SIGTERM/SIGINT handlers and removes them after close", async () => {
    const appRoot = await createFixtureApp({
      "dawn.config.ts": "export default {};\n",
      "package.json": "{}\n",
      "src/app/support/[tenant]/index.ts": `export const graph = async () => ({ ok: true });\n`,
    })

    const sigtermBefore = process.listenerCount("SIGTERM")
    const sigintBefore = process.listenerCount("SIGINT")

    const { io } = createCapturingIo()
    const handle = await withCwd(appRoot, async () =>
      runStartCommand({ host: "127.0.0.1", port: "0" }, io),
    )

    expect(process.listenerCount("SIGTERM")).toBe(sigtermBefore + 1)
    expect(process.listenerCount("SIGINT")).toBe(sigintBefore + 1)

    await handle.close()

    expect(process.listenerCount("SIGTERM")).toBe(sigtermBefore)
    expect(process.listenerCount("SIGINT")).toBe(sigintBefore)

    // close() must be safe to call again (idempotent) — nothing left to tear down.
    await handle.close()
  })

  test("rejects an invalid --port before touching the filesystem", async () => {
    const { io } = createCapturingIo()

    await expect(runStartCommand({ port: "-1" }, io)).rejects.toThrow(CliError)
    await expect(runStartCommand({ port: "not-a-number" }, io)).rejects.toThrow(
      "Invalid port: not-a-number",
    )
  })

  test("accepts --port 0 as a kernel-assigned ephemeral port", async () => {
    const appRoot = await createFixtureApp({
      "dawn.config.ts": "export default {};\n",
      "package.json": "{}\n",
      "src/app/support/[tenant]/index.ts": `export const graph = async () => ({ ok: true });\n`,
    })

    const { io } = createCapturingIo()
    const handle = await withCwd(appRoot, async () =>
      runStartCommand({ host: "127.0.0.1", port: "0" }, io),
    )
    handles.push(handle)

    expect(new URL(handle.url).port).not.toBe("0")
  })

  test("registers a `start` command with --host and --port options", () => {
    const program = new Command()
    const { io } = createCapturingIo()

    registerStartCommand(program, io)

    const start = program.commands.find((command) => command.name() === "start")
    expect(start).toBeDefined()
    expect(start?.description()).toContain("production")

    const optionFlags = (start?.options ?? []).map((option) => option.flags)
    expect(optionFlags).toContain("--host <host>")
    expect(optionFlags).toContain("--port <number>")
  })
})

async function createFixtureApp(files: Readonly<Record<string, string>>) {
  const appRoot = await mkdtemp(join(tmpdir(), "dawn-cli-start-"))
  tempDirs.push(appRoot)

  await Promise.all(
    Object.entries(files).map(async ([relativePath, source]) => {
      const filePath = join(appRoot, relativePath)
      await mkdir(join(filePath, ".."), { recursive: true })
      await writeFile(filePath, source, "utf8")
    }),
  )

  return appRoot
}

function createCapturingIo(): {
  readonly io: CommandIo
  readonly stdout: string[]
  readonly stderr: string[]
} {
  const stdout: string[] = []
  const stderr: string[] = []

  return {
    io: {
      stderr: (message) => {
        stderr.push(message)
      },
      stdout: (message) => {
        stdout.push(message)
      },
    },
    stderr,
    stdout,
  }
}

async function withCwd<T>(cwd: string, fn: () => Promise<T>): Promise<T> {
  const previousCwd = process.cwd()
  process.chdir(cwd)

  try {
    return await fn()
  } finally {
    process.chdir(previousCwd)
  }
}
