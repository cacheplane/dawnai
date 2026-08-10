import { constants } from "node:fs"
import { access, mkdir, readFile, writeFile } from "node:fs/promises"
import { dirname, join } from "node:path"

import { afterEach, expect, test } from "vitest"

import { createArtifactRoot } from "../../packages/devkit/src/testing/index.ts"
import { createAimock } from "../../packages/testing/dist/index.js"
import { getTestRegistryUrl } from "../harness/local-registry.ts"
import {
  cleanupTrackedTempDirs,
  createTrackedTempDir,
  installRegistryScaffolderWithNpm,
  markTrackedTempDirForPreserve,
  runPackagedCommand,
  type TrackedTempDir,
} from "../harness/packaged-app.ts"
import { writeRegistryNpmrc } from "../harness/scaffold-packaging.ts"

const tempDirs: TrackedTempDir[] = []

afterEach(async () => {
  await cleanupTrackedTempDirs(tempDirs)
})

test("activates the default research scaffold through the complete npm lifecycle", {
  timeout: 600_000,
}, async () => {
  const tempRoot = await createTrackedTempDir("dawn-generated-research-activation-", tempDirs)
  const appRoot = join(tempRoot, "app")
  const installerRoot = join(tempRoot, "installer")
  const expectedArtifactRoot = join(
    tempRoot,
    "artifacts/testing/generated-research-activation/research",
  )
  const commandsTranscriptPath = join(expectedArtifactRoot, "transcripts", "commands.log")
  const agUiTranscriptPath = join(expectedArtifactRoot, "transcripts", "ag-ui.json")
  const childServer = {
    active: undefined as { stop(): Promise<void> } | undefined,
  }
  let aimock: Awaited<ReturnType<typeof createAimock>> | undefined
  let scenarioError: unknown
  let scenarioFailed = false
  let cleanupError: unknown

  try {
    const artifactRoot = await createArtifactRoot({
      baseDir: tempRoot,
      runId: "generated-research-activation",
      lane: "research",
    })
    expect(artifactRoot).toBe(expectedArtifactRoot)
    await mkdir(dirname(commandsTranscriptPath), { recursive: true })
    await writeFile(agUiTranscriptPath, "", "utf8")

    aimock = await createAimock({ fixtures: [] })
    const npmLaunch = {
      command: "npm",
      shell: process.platform === "win32",
    } as const

    const npmVersion = await runPackagedCommand({
      args: ["--version"],
      cwd: tempRoot,
      ...npmLaunch,
      transcriptPath: commandsTranscriptPath,
    })
    expect(Number(process.versions.node.split(".")[0])).toBe(24)
    expect(Number(npmVersion.stdout.trim().split(".")[0])).toBe(11)

    const { installerDir } = await installRegistryScaffolderWithNpm({
      tempRoot,
      transcriptPath: commandsTranscriptPath,
    })
    expect(installerDir).toBe(installerRoot)
    const creatorResult = await runPackagedCommand({
      args: ["exec", "--", "create-dawn-ai-app", appRoot],
      cwd: installerDir,
      ...npmLaunch,
      transcriptPath: commandsTranscriptPath,
    })

    await expect(
      access(join(appRoot, "src/app/research/index.ts"), constants.F_OK),
    ).resolves.toBeUndefined()
    await expect(
      access(join(appRoot, "src/app/(public)/hello/[tenant]/index.ts"), constants.F_OK),
    ).rejects.toThrow()
    expect(creatorResult.stdout).toContain("(research template)")

    const scaffoldTranscript = await readFile(commandsTranscriptPath, "utf8")
    const creatorCommandLines = scaffoldTranscript
      .split("\n")
      .filter((line) => line.startsWith(`$ (cd ${installerDir} && npm exec `))
    expect(creatorCommandLines).toEqual([
      `$ (cd ${installerDir} && npm exec -- create-dawn-ai-app ${appRoot})`,
    ])
    expect(creatorCommandLines[0]?.split(/\s+/)).not.toContain("--template")

    await writeRegistryNpmrc(appRoot, getTestRegistryUrl())
    const envContent = `OPENAI_BASE_URL=${aimock.baseUrl}\nOPENAI_API_KEY=test-not-used\n`
    await writeFile(join(appRoot, ".env"), envContent, "utf8")

    await runPackagedCommand({
      args: ["install"],
      cwd: appRoot,
      ...npmLaunch,
      transcriptPath: commandsTranscriptPath,
    })
    const typegenResult = await runPackagedCommand({
      args: ["run", "typegen"],
      cwd: appRoot,
      ...npmLaunch,
      transcriptPath: commandsTranscriptPath,
    })
    expect(typegenResult.stdout).toContain("Wrote types for")
    const generatedTypesPath = join(appRoot, ".dawn/dawn.generated.d.ts")
    await expect(access(generatedTypesPath, constants.F_OK)).resolves.toBeUndefined()
    const generatedTypesAfterTypegen = await readFile(generatedTypesPath, "utf8")

    const checkResult = await runPackagedCommand({
      args: ["run", "check"],
      cwd: appRoot,
      ...npmLaunch,
      transcriptPath: commandsTranscriptPath,
    })
    expect(checkResult.stdout).toContain("Dawn app is valid:")
    expect(checkResult.stdout).not.toContain("Wrote types for")
    await expect(readFile(generatedTypesPath, "utf8")).resolves.toBe(generatedTypesAfterTypegen)

    await runPackagedCommand({
      args: ["run", "typecheck"],
      cwd: appRoot,
      ...npmLaunch,
      transcriptPath: commandsTranscriptPath,
    })
    await runPackagedCommand({
      args: ["test"],
      cwd: appRoot,
      ...npmLaunch,
      transcriptPath: commandsTranscriptPath,
    })
    await runPackagedCommand({
      args: ["run", "eval"],
      cwd: appRoot,
      ...npmLaunch,
      transcriptPath: commandsTranscriptPath,
    })
    const verifyResult = await runPackagedCommand({
      args: ["run", "verify"],
      cwd: appRoot,
      ...npmLaunch,
      transcriptPath: commandsTranscriptPath,
      unsetEnv: ["OPENAI_BASE_URL", "OPENAI_API_KEY"],
    })
    expect(verifyResult.stdout).not.toContain("Missing environment variables")
    await runPackagedCommand({
      args: ["run", "build"],
      cwd: appRoot,
      ...npmLaunch,
      transcriptPath: commandsTranscriptPath,
    })

    await expect(
      access(join(appRoot, ".dawn/build/server.mjs"), constants.F_OK),
    ).resolves.toBeUndefined()
    const packageManifest = JSON.parse(await readFile(join(appRoot, "package.json"), "utf8")) as {
      scripts: Record<string, string>
    }
    expect(packageManifest.scripts).toEqual({
      dev: "dawn dev --port 3000",
      verify: "dawn verify",
      typegen: "dawn typegen",
      check: "dawn check",
      typecheck: "tsc --noEmit",
      test: "vitest run",
      eval: "dawn eval",
      build: "dawn build",
      start: "node --env-file-if-exists=.env .dawn/build/server.mjs",
      "test:sandbox:docker": "DAWN_DEMO_DOCKER_SANDBOX=1 vitest run test/sandbox-docker.test.ts",
      "memory:list": "dawn memory list",
      "memory:approve": "dawn memory approve",
    })
    await expect(readFile(join(appRoot, "src/app/research/index.ts"), "utf8")).resolves.toContain(
      "recursionLimit: 100",
    )
  } catch (error) {
    scenarioFailed = true
    scenarioError = error
  } finally {
    const cleanupErrors: unknown[] = []
    try {
      await childServer.active?.stop()
    } catch (error) {
      cleanupErrors.push(error)
    }
    try {
      await aimock?.close()
    } catch (error) {
      cleanupErrors.push(error)
    }
    if (cleanupErrors.length > 0) {
      cleanupError =
        cleanupErrors.length === 1
          ? cleanupErrors[0]
          : new AggregateError(cleanupErrors, "Generated research activation cleanup failed")
    }
  }

  if (scenarioFailed || cleanupError !== undefined) {
    markTrackedTempDirForPreserve(tempDirs, tempRoot)
    const cause =
      scenarioFailed && cleanupError !== undefined
        ? new AggregateError(
            [scenarioError, cleanupError],
            "Generated research activation and cleanup both failed",
          )
        : scenarioFailed
          ? scenarioError
          : cleanupError
    throw new Error(
      [
        "Generated research activation failed; preserved its temporary root.",
        `App root: ${appRoot}`,
        `Commands transcript: ${commandsTranscriptPath}`,
        `AG-UI transcript: ${agUiTranscriptPath}`,
      ].join("\n"),
      { cause },
    )
  }
})
