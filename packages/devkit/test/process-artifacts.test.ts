import { constants } from "node:fs"
import { access, mkdtemp, readFile, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { resolve } from "node:path"
import { setTimeout as delay } from "node:timers/promises"

import { describe, expect, it, vi } from "vitest"

import { createArtifactRoot, spawnProcess } from "../src/testing/index.ts"
import { removeEnvironmentVariables } from "../src/testing/process.ts"

const hangingProcessTreeFixture = resolve(import.meta.dirname, "fixtures/hanging-process-tree.mjs")

function processIsRunning(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    if (error && typeof error === "object" && Reflect.get(error, "code") === "ESRCH") return false
    throw error
  }
}

async function expectProcessStopped(pid: number): Promise<void> {
  const deadline = Date.now() + 2_000
  while (processIsRunning(pid) && Date.now() < deadline) {
    await delay(25)
  }
  expect(processIsRunning(pid)).toBe(false)
}

async function waitForTopology(path: string): Promise<{
  readonly descendantPid: number
  readonly leaderPid: number
}> {
  const deadline = Date.now() + 2_000
  while (Date.now() < deadline) {
    try {
      return JSON.parse(await readFile(path, "utf8")) as {
        readonly descendantPid: number
        readonly leaderPid: number
      }
    } catch (error) {
      const retryable =
        error instanceof SyntaxError ||
        (error !== null && typeof error === "object" && Reflect.get(error, "code") === "ENOENT")
      if (!retryable) throw error
      await delay(25)
    }
  }
  throw new Error(`Hanging process fixture did not become ready at ${path}`)
}

describe("removeEnvironmentVariables", () => {
  it("removes every case-insensitive match on Windows", () => {
    const env: NodeJS.ProcessEnv = {
      OpenAI_Api_Key: "mixed-case-secret",
      OPENAI_API_KEY: "uppercase-secret",
      SAFE_VALUE: "preserved",
    }

    removeEnvironmentVariables(env, ["OPENAI_API_KEY"], "win32")

    expect(env).toEqual({ SAFE_VALUE: "preserved" })
  })

  it("removes exact names only on non-Windows platforms", () => {
    const env: NodeJS.ProcessEnv = {
      OpenAI_Api_Key: "mixed-case-secret",
      OPENAI_API_KEY: "uppercase-secret",
    }

    removeEnvironmentVariables(env, ["OPENAI_API_KEY"], "linux")

    expect(env).toEqual({ OpenAI_Api_Key: "mixed-case-secret" })
  })
})

describe("spawnProcess", () => {
  it("captures stdout, stderr, and non-zero exits", async () => {
    const result = await spawnProcess({
      args: [
        "-e",
        'process.stdout.write("hello stdout\\n"); process.stderr.write("hello stderr\\n"); process.exit(7)',
      ],
      command: process.execPath,
    })

    expect(result.ok).toBe(false)
    expect(result.stdout).toContain("hello stdout")
    expect(result.stderr).toContain("hello stderr")
    expect(result.exitCode).toBe(7)
  })

  it("inherits process.env while applying env overrides", async () => {
    const inheritedPath = process.env.PATH

    expect(inheritedPath).toBeTruthy()

    const result = await spawnProcess({
      args: [
        "-e",
        'process.stdout.write((process.env.PATH ?? "") + "\\n" + (process.env.DAWN_TEST_ENV ?? ""))',
      ],
      command: process.execPath,
      env: {
        DAWN_TEST_ENV: "merged",
      },
    })

    expect(result.exitCode).toBe(0)
    expect(result.stdout).toContain(inheritedPath ?? "")
    expect(result.stdout).toContain("merged")
  })

  it("can remove selected inherited environment variables", async () => {
    process.env.DAWN_TEST_UNSET_ENV = "inherited"
    try {
      const result = await spawnProcess({
        args: ["-e", 'process.stdout.write(process.env.DAWN_TEST_UNSET_ENV ?? "missing")'],
        command: process.execPath,
        unsetEnv: ["DAWN_TEST_UNSET_ENV"],
      })
      expect(result.exitCode).toBe(0)
      expect(result.stdout).toBe("missing")
    } finally {
      delete process.env.DAWN_TEST_UNSET_ENV
    }
  })

  it("terminates a timed-out process tree before returning", async () => {
    const tempRoot = await mkdtemp(resolve(tmpdir(), "dawn-timed-out-process-tree-"))
    const readyPath = resolve(tempRoot, "ready.json")

    try {
      const startedAt = Date.now()
      const processResult = spawnProcess({
        args: [hangingProcessTreeFixture, "6000", readyPath],
        command: process.execPath,
        timeoutMs: 1_500,
      })
      const topology = await waitForTopology(readyPath)
      const result = await processResult
      const elapsedMs = Date.now() - startedAt

      expect(result).toMatchObject({ ok: false, timedOut: true, timeoutMs: 1_500 })
      expect(result.stdout).toContain(JSON.stringify(topology))
      expect(elapsedMs).toBeLessThan(4_000)
      await expectProcessStopped(topology.leaderPid)
      await expectProcessStopped(topology.descendantPid)
    } finally {
      await rm(tempRoot, { force: true, recursive: true })
    }
  })

  it.skipIf(process.platform === "win32")(
    "polls at a bounded cadence while force-stopping a TERM-resistant descendant",
    async () => {
      const tempRoot = await mkdtemp(resolve(tmpdir(), "dawn-force-escalation-"))
      const readyPath = resolve(tempRoot, "ready.json")
      let maximumTimerGapMs = 0
      let lastTimerAt = performance.now()
      const heartbeat = setInterval(() => {
        const now = performance.now()
        maximumTimerGapMs = Math.max(maximumTimerGapMs, now - lastTimerAt)
        lastTimerAt = now
      }, 10)

      try {
        const processResult = spawnProcess({
          args: [hangingProcessTreeFixture, "8000", readyPath, "ignore-term"],
          command: process.execPath,
          timeoutMs: 3_000,
        })
        const topology = await waitForTopology(readyPath)
        const result = await processResult
        await delay(20)

        expect(result).toMatchObject({ ok: false, timedOut: true, timeoutMs: 3_000 })
        expect(maximumTimerGapMs).toBeLessThan(400)
        await expectProcessStopped(topology.leaderPid)
        await expectProcessStopped(topology.descendantPid)
      } finally {
        clearInterval(heartbeat)
        await rm(tempRoot, { force: true, recursive: true })
      }
    },
  )

  it("terminates an aborted process tree before returning", async () => {
    const tempRoot = await mkdtemp(resolve(tmpdir(), "dawn-aborted-process-tree-"))
    const readyPath = resolve(tempRoot, "ready.json")
    const controller = new AbortController()
    const abortReason = new Error("cancel generated lifecycle")

    try {
      const processResult = spawnProcess({
        args: [hangingProcessTreeFixture, "4000", readyPath],
        command: process.execPath,
        signal: controller.signal,
      })
      const topology = await waitForTopology(readyPath)
      const abortedAt = Date.now()
      controller.abort(abortReason)
      const result = await processResult

      expect(result).toMatchObject({ aborted: true, abortReason, ok: false })
      expect(Date.now() - abortedAt).toBeLessThan(2_000)
      await expectProcessStopped(topology.leaderPid)
      await expectProcessStopped(topology.descendantPid)
    } finally {
      await rm(tempRoot, { force: true, recursive: true })
    }
  })

  it("clears the deadline when spawning fails asynchronously", async () => {
    vi.useFakeTimers()
    try {
      const missingCommand = resolve(tmpdir(), `dawn-missing-command-${process.pid}`)

      await expect(
        spawnProcess({ command: missingCommand, timeoutMs: 180_000 }),
      ).rejects.toMatchObject({ code: "ENOENT" })
      expect(vi.getTimerCount()).toBe(0)
    } finally {
      vi.useRealTimers()
    }
  })

  it.runIf(process.platform !== "win32")(
    "awaits a bounded close race when Windows tree termination loses to child exit",
    async () => {
      const platformDescriptor = Object.getOwnPropertyDescriptor(process, "platform")
      const tempRoot = await mkdtemp(resolve(tmpdir(), "dawn-windows-close-race-"))
      const readyPath = resolve(tempRoot, "ready.json")
      Object.defineProperty(process, "platform", { configurable: true, value: "win32" })
      try {
        const startedAt = Date.now()
        const processResult = spawnProcess({
          args: [hangingProcessTreeFixture, "1500", readyPath],
          command: process.execPath,
          timeoutMs: 1_000,
        })
        const topology = await waitForTopology(readyPath)
        const result = await processResult

        expect(result).toMatchObject({ ok: false, timedOut: true, timeoutMs: 1_000 })
        expect(Date.now() - startedAt).toBeLessThan(3_000)
        await expectProcessStopped(topology.leaderPid)
        await expectProcessStopped(topology.descendantPid)
      } finally {
        if (platformDescriptor !== undefined) {
          Object.defineProperty(process, "platform", platformDescriptor)
        }
        await rm(tempRoot, { force: true, recursive: true })
      }
    },
  )
})

describe("createArtifactRoot", () => {
  it("creates a deterministic testing artifact path and ensures it exists", async () => {
    const baseDir = await mkdtemp(resolve(tmpdir(), "dawn-devkit-artifacts-"))

    try {
      const artifactRoot = await createArtifactRoot({
        baseDir,
        lane: "generated",
        runId: "run-123",
      })

      expect(artifactRoot).toBe(resolve(baseDir, "artifacts", "testing", "run-123", "generated"))
      await expect(access(artifactRoot, constants.F_OK)).resolves.toBeUndefined()

      const repeatedArtifactRoot = await createArtifactRoot({
        baseDir,
        lane: "generated",
        runId: "run-123",
      })

      expect(repeatedArtifactRoot).toBe(artifactRoot)
    } finally {
      await rm(baseDir, { force: true, recursive: true })
    }
  })
})
