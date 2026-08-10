import { constants } from "node:fs"
import { access, mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { resolve } from "node:path"

import { describe, expect, it } from "vitest"

import { createArtifactRoot, spawnProcess } from "../src/testing/index.ts"
import { removeEnvironmentVariables } from "../src/testing/process.ts"

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
