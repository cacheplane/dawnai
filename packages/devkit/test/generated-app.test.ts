import { readFile } from "node:fs/promises"
import { resolve } from "node:path"

import { describe, expect, it } from "vitest"

import { createArtifactRoot, createGeneratedApp } from "../src/testing/index.ts"

describe("generated app helper", () => {
  it("materializes the basic template and returns artifact metadata", async () => {
    const artifactRoot = await createArtifactRoot({
      baseDir: process.cwd(),
      lane: "generated",
      runId: "run-generated-app-test",
    })

    const generatedApp = await createGeneratedApp({
      appName: "sample-generated-app",
      artifactRoot,
      specifiers: {
        dawnCli: "workspace:*",
        dawnConfigTypescript: "workspace:*",
        dawnCore: "workspace:*",
        dawnLanggraph: "workspace:*",
      },
      template: "basic",
    })

    const packageJson = await readFile(resolve(generatedApp.appRoot, "package.json"), "utf8")

    expect(generatedApp.appRoot).toBe(resolve(artifactRoot, "app"))
    expect(generatedApp.artifactRoot).toBe(artifactRoot)
    expect(generatedApp.template).toBe("basic")
    expect(generatedApp.transcriptPath).toBe(resolve(artifactRoot, "transcripts", "generated-app.log"))
    expect(packageJson).toContain('"name": "sample-generated-app"')
    expect(packageJson).toContain('"@dawn/cli": "workspace:*"')
  })
})
