import { mkdtemp, readFile, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { resolve } from "node:path"

import { describe, expect, it } from "vitest"

import { createArtifactRoot, createGeneratedApp } from "../src/testing/index.ts"

describe("generated app helper", () => {
  it("materializes the basic template in an isolated temp root with default specifiers", async () => {
    const baseDir = await mkdtemp(resolve(tmpdir(), "dawn-devkit-generated-app-"))

    try {
      const artifactRoot = await createArtifactRoot({
        baseDir,
        lane: "generated",
        runId: "run-generated-app-test",
      })

      const generatedApp = await createGeneratedApp({
        appName: "sample-generated-app",
        artifactRoot,
        template: "basic",
      })

      const packageJson = await readFile(resolve(generatedApp.appRoot, "package.json"), "utf8")

      expect(generatedApp.appRoot).toBe(resolve(artifactRoot, "app"))
      expect(generatedApp.artifactRoot).toBe(artifactRoot)
      expect(generatedApp.template).toBe("basic")
      expect(generatedApp.transcriptPath).toBe(
        resolve(artifactRoot, "transcripts", "generated-app.log"),
      )
      expect(packageJson).toContain('"name": "sample-generated-app"')
      expect(packageJson).toContain('"@dawn-ai/cli": "workspace:*"')
      expect(packageJson).toContain('"@dawn-ai/core": "workspace:*"')
      expect(packageJson).toContain('"@dawn-ai/langchain": "workspace:*"')
      expect(packageJson).toContain('"@dawn-ai/config-typescript": "workspace:*"')
      expect(packageJson).toContain('"zod": "3.24.4"')
    } finally {
      await rm(baseDir, { force: true, recursive: true })
    }
  })
})
