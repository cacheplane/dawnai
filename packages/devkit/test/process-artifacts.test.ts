import { constants } from "node:fs"
import { access, mkdtemp, rm } from "node:fs/promises"
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
    const startedAt = Date.now()
    const result = await spawnProcess({
      args: [hangingProcessTreeFixture, "4000"],
      command: process.execPath,
      timeoutMs: 100,
    })
    const elapsedMs = Date.now() - startedAt
    const topology = JSON.parse(result.stdout.trim()) as {
      readonly descendantPid: number
      readonly leaderPid: number
    }

    expect(result).toMatchObject({ ok: false, timedOut: true, timeoutMs: 100 })
    expect(elapsedMs).toBeLessThan(3_000)
    await expectProcessStopped(topology.leaderPid)
    await expectProcessStopped(topology.descendantPid)
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
      Object.defineProperty(process, "platform", { configurable: true, value: "win32" })
      try {
        const startedAt = Date.now()
        const result = await spawnProcess({
          args: [hangingProcessTreeFixture, "250"],
          command: process.execPath,
          timeoutMs: 50,
        })
        const topology = JSON.parse(result.stdout.trim()) as {
          readonly descendantPid: number
          readonly leaderPid: number
        }

        expect(result).toMatchObject({ ok: false, timedOut: true, timeoutMs: 50 })
        expect(Date.now() - startedAt).toBeLessThan(2_000)
        await expectProcessStopped(topology.leaderPid)
        await expectProcessStopped(topology.descendantPid)
      } finally {
        if (platformDescriptor !== undefined) {
          Object.defineProperty(process, "platform", platformDescriptor)
        }
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
