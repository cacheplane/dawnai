import { constants } from "node:fs"
import { access, mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { resolve } from "node:path"

import { describe, expect, it } from "vitest"

import { createArtifactRoot, spawnProcess } from "../src/testing/index.ts"

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
