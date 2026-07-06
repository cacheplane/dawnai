import { constants } from "node:fs"
import { access, mkdtemp, readFile, rm } from "node:fs/promises"
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
      expect(packageJson).toContain('"@dawn-ai/sdk": "workspace:*"')
      expect(packageJson).toContain('"@dawn-ai/config-typescript": "workspace:*"')
      expect(packageJson).toContain('"@dawn-ai/testing": "workspace:*"')
      expect(packageJson).toContain('"@dawn-ai/evals": "workspace:*"')
      expect(packageJson).toContain('"test": "vitest run"')
      expect(packageJson).toContain('"eval": "dawn eval"')
      await expect(
        access(resolve(generatedApp.appRoot, "test/agent.test.ts"), constants.F_OK),
      ).resolves.toBeUndefined()
      await expect(
        access(
          resolve(generatedApp.appRoot, "src/app/(public)/hello/[tenant]/evals/smoke.eval.ts"),
          constants.F_OK,
        ),
      ).resolves.toBeUndefined()
    } finally {
      await rm(baseDir, { force: true, recursive: true })
    }
  })

  it("materializes the research template with sandbox-ready shared tools and memory scripts", async () => {
    const baseDir = await mkdtemp(resolve(tmpdir(), "dawn-devkit-generated-research-app-"))

    try {
      const artifactRoot = await createArtifactRoot({
        baseDir,
        lane: "generated",
        runId: "run-generated-research-app-test",
      })

      const generatedApp = await createGeneratedApp({
        appName: "sample-research-app",
        artifactRoot,
        template: "research",
      })

      const packageJson = await readFile(resolve(generatedApp.appRoot, "package.json"), "utf8")
      const pnpmWorkspace = await readFile(
        resolve(generatedApp.appRoot, "pnpm-workspace.yaml"),
        "utf8",
      )
      const readDoc = await readFile(resolve(generatedApp.appRoot, "src/tools/readDoc.ts"), "utf8")
      const searchCorpus = await readFile(
        resolve(generatedApp.appRoot, "src/tools/searchCorpus.ts"),
        "utf8",
      )
      const prompt = await readFile(
        resolve(generatedApp.appRoot, "src/app/research/index.ts"),
        "utf8",
      )
      const generatedTypes = await readFile(
        resolve(generatedApp.appRoot, ".dawn/dawn.generated.d.ts"),
        "utf8",
      )
      const readme = await readFile(resolve(generatedApp.appRoot, "README.md"), "utf8")
      const researchTest = await readFile(
        resolve(generatedApp.appRoot, "test/research.test.ts"),
        "utf8",
      )
      const sandboxTest = await readFile(
        resolve(generatedApp.appRoot, "test/sandbox-docker.test.ts"),
        "utf8",
      )

      expect(packageJson).toContain('"@dawn-ai/sandbox": "workspace:*"')
      expect(packageJson).toContain('"memory:list": "dawn memory list"')
      expect(packageJson).toContain('"memory:approve": "dawn memory approve"')
      expect(packageJson).toContain('"test:sandbox:docker": "DAWN_DEMO_DOCKER_SANDBOX=1')
      expect(packageJson).not.toContain('"pnpm"')
      expect(pnpmWorkspace).toContain("allowBuilds:")
      expect(pnpmWorkspace).toContain("esbuild: true")
      expect(readDoc).toContain("ctx.fs.readFile")
      expect(searchCorpus).toContain("ctx.fs.listDir")
      expect(prompt).toContain("recall({ query:")
      expect(prompt).toContain("remember({")
      expect(generatedTypes).toContain("readonly task:")
      expect(generatedTypes).toContain("readonly recall:")
      expect(generatedTypes).toContain("readonly remember:")
      expect(readme).toContain("Docker sandbox")
      expect(readme).toContain("dawn memory approve")
      expect(researchTest).toContain("seedMemory")
      expect(sandboxTest).toContain("DAWN_DEMO_DOCKER_SANDBOX")
      expect(sandboxTest).toContain("dockerSandbox")
      await expect(
        access(resolve(generatedApp.appRoot, "src/app/research/tools/readDoc.ts"), constants.F_OK),
      ).rejects.toThrow()
    } finally {
      await rm(baseDir, { force: true, recursive: true })
    }
  })
})
