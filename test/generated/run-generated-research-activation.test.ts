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
  GENERATED_APP_UNSET_ENV,
  installRegistryScaffolderWithNpm,
  markTrackedTempDirForPreserve,
  runGeneratedAppNpmCommand,
  runPackagedNpmCommand,
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
  const inheritedRuntimeEnv = GENERATED_APP_UNSET_ENV.map((name) => ({
    hadOwnProperty: Object.hasOwn(process.env, name),
    name,
    value: Reflect.get(process.env, name),
  }))

  Reflect.set(process.env, "DAWN_DEMO_DOCKER_SANDBOX", "1")
  Reflect.set(process.env, "OPENAI_BASE_URL", "http://127.0.0.1:1/v1")
  Reflect.set(process.env, "OPENAI_API_KEY", "ambient-secret")

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

    const npmVersion = await runPackagedNpmCommand({
      args: ["--version"],
      cwd: tempRoot,
      transcriptPath: commandsTranscriptPath,
    })
    expect(Number(process.versions.node.split(".")[0])).toBe(24)
    expect(Number(npmVersion.stdout.trim().split(".")[0])).toBe(11)

    const { installerDir } = await installRegistryScaffolderWithNpm({
      tempRoot,
      transcriptPath: commandsTranscriptPath,
    })
    expect(installerDir).toBe(installerRoot)
    const creatorResult = await runPackagedNpmCommand({
      args: ["exec", "--", "create-dawn-ai-app", appRoot],
      cwd: installerDir,
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

    await runGeneratedAppNpmCommand({
      args: ["install"],
      cwd: appRoot,
      transcriptPath: commandsTranscriptPath,
    })
    const typegenResult = await runGeneratedAppNpmCommand({
      args: ["run", "typegen"],
      cwd: appRoot,
      transcriptPath: commandsTranscriptPath,
    })
    expect(typegenResult.stdout).toContain("Wrote types for")
    const generatedTypesPath = join(appRoot, ".dawn/dawn.generated.d.ts")
    await expect(access(generatedTypesPath, constants.F_OK)).resolves.toBeUndefined()
    const generatedTypes = await readFile(generatedTypesPath, "utf8")
    const checkSentinel = "// sentinel: dawn check must not generate types\n"
    await writeFile(generatedTypesPath, checkSentinel, "utf8")

    const checkResult = await runGeneratedAppNpmCommand({
      args: ["run", "check"],
      cwd: appRoot,
      transcriptPath: commandsTranscriptPath,
    })
    expect(checkResult.stdout).toContain("Dawn app is valid:")
    expect(checkResult.stdout).not.toContain("Wrote types for")
    await expect(readFile(generatedTypesPath, "utf8")).resolves.toBe(checkSentinel)
    await writeFile(generatedTypesPath, generatedTypes, "utf8")
    await expect(readFile(generatedTypesPath, "utf8")).resolves.toBe(generatedTypes)

    await runGeneratedAppNpmCommand({
      args: ["run", "typecheck"],
      cwd: appRoot,
      transcriptPath: commandsTranscriptPath,
    })
    await runGeneratedAppNpmCommand({
      args: ["test"],
      cwd: appRoot,
      transcriptPath: commandsTranscriptPath,
    })
    await runGeneratedAppNpmCommand({
      args: ["run", "eval"],
      cwd: appRoot,
      transcriptPath: commandsTranscriptPath,
    })
    const verifyResult = await runGeneratedAppNpmCommand({
      args: ["run", "verify"],
      cwd: appRoot,
      transcriptPath: commandsTranscriptPath,
    })
    expect(verifyResult.stdout).not.toContain("Missing environment variables")
    await runGeneratedAppNpmCommand({
      args: ["run", "build"],
      cwd: appRoot,
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
    for (const inherited of inheritedRuntimeEnv) {
      if (inherited.hadOwnProperty) {
        Reflect.set(process.env, inherited.name, inherited.value)
      } else {
        Reflect.deleteProperty(process.env, inherited.name)
      }
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
