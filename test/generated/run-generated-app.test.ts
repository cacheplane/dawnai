import { constants } from "node:fs"
import { access, appendFile, cp, mkdir, readFile, rm, stat, writeFile } from "node:fs/promises"
import { dirname, join, resolve } from "node:path"
import { pathToFileURL } from "node:url"

import { afterEach, describe, expect, test } from "vitest"

import { createArtifactRoot, spawnProcess } from "../../packages/devkit/src/testing/index.ts"
import {
  cleanupTrackedTempDirs,
  createPackagedInstaller,
  createTrackedTempDir,
  markTrackedTempDirForPreserve,
  type TrackedTempDir,
} from "../harness/packaged-app.ts"
import { expectBasicAuthoringLane } from "./harness.ts"

const REPO_ROOT = resolve(import.meta.dirname, "../..")
const FIXTURE_ROOT = resolve(import.meta.dirname, "fixtures")
const CUSTOM_APP_DIR_FIXTURE_ROOT = resolve(
  REPO_ROOT,
  "test/fixtures/contracts/valid-custom-app-dir",
)
const tempDirs: TrackedTempDir[] = []

interface PackedTarballs {
  readonly cli: string
  readonly configTypescript: string
  readonly core: string
  readonly createApp: string
  readonly devkit: string
  readonly langgraph: string
  readonly sdk: string
}

interface GeneratedAppScenarioResult {
  readonly packageJson: unknown
  readonly routesJson: unknown
  readonly typegenOutput: string
  readonly verifyJson: unknown
}

interface GeneratedAppScenario {
  readonly artifacts: {
    readonly appRoot: string
    readonly transcriptPath: string
  }
  readonly result: GeneratedAppScenarioResult
}

interface GeneratedAppScenarioOptions {
  readonly expectedFixtureName: string
  readonly mutateApp?: (appRoot: string) => Promise<void>
  readonly scaffoldMode?: "external" | "internal"
  readonly targetDirName: string
}

afterEach(async () => {
  await cleanupTrackedTempDirs(tempDirs)
})

describe("generated app publish harness", () => {
  test("cleans successful tracked temp roots", async () => {
    const tracked: TrackedTempDir[] = []
    const tempRoot = await createTrackedTempDir("dgh-", tracked)
    await writeFile(join(tempRoot, "marker.txt"), "ok", "utf8")

    await cleanupTrackedTempDirs(tracked)

    await expect(access(tempRoot, constants.F_OK)).rejects.toThrow()
  })

  test("preserves tracked temp roots when marked for debugging", async () => {
    const tracked: TrackedTempDir[] = []
    const tempRoot = await createTrackedTempDir("dgh-", tracked)
    const markerPath = join(tempRoot, "marker.txt")
    await writeFile(markerPath, "debug", "utf8")

    markTrackedTempDirForPreserve(tracked, tempRoot)
    await cleanupTrackedTempDirs(tracked)

    await expect(readFile(markerPath, "utf8")).resolves.toBe("debug")
    await rm(tempRoot, { force: true, recursive: true })
  })

  test("scaffolds a packaged basic app and runs the published lifecycle", {
    timeout: 180_000,
  }, async () => {
    const scenario = await runGeneratedAppScenario({
      expectedFixtureName: "basic",
      targetDirName: "app",
    })

    await expectBasicAuthoringLane(scenario.artifacts.appRoot)
  })

  test("supports the same packaged lifecycle for a custom configured appDir", {
    timeout: 180_000,
  }, async () => {
    await runGeneratedAppScenario({
      expectedFixtureName: "custom-app-dir",
      mutateApp: rewriteToCustomAppDirLayout,
      targetDirName: "app",
    })
  })

  test("supports contributor-local verify lifecycle", { timeout: 180_000 }, async () => {
    await runGeneratedAppScenario({ expectedFixtureName: "basic", targetDirName: "app" })

    const contributorLocal = await runGeneratedAppScenario({
      expectedFixtureName: "basic",
      scaffoldMode: "internal",
      targetDirName: "contributor-app",
    })
    const expected = await createExpectedInternalFixture("basic", "contributor-app")
    const transcript = await readFile(contributorLocal.artifacts.transcriptPath, "utf8")

    expect(
      normalizeForInternalFixture(contributorLocal.result, {
        appRoot: contributorLocal.artifacts.appRoot,
      }),
    ).toEqual(expected)
    await expectBasicAuthoringLane(contributorLocal.artifacts.appRoot)
    expect(transcript).toContain(
      `$ (cd ${REPO_ROOT} && pnpm --filter create-dawn-app build)`,
    )
    expect(transcript).toContain(
      `node packages/create-dawn-app/dist/index.js ${contributorLocal.artifacts.appRoot} --mode internal`,
    )
    expect(transcript).toContain(`$ (cd ${contributorLocal.artifacts.appRoot} && pnpm install)`)
    expect(transcript).toContain(
      `$ (cd ${contributorLocal.artifacts.appRoot} && pnpm exec dawn verify --json)`,
    )
    expect(transcript).toContain(
      `$ (cd ${contributorLocal.artifacts.appRoot} && pnpm exec dawn routes --json)`,
    )
    expect(transcript).toContain(`$ (cd ${contributorLocal.artifacts.appRoot} && pnpm exec dawn typegen)`)
    expect(transcript).not.toContain("--pack-destination")
    expect(transcript).not.toContain("pnpm add ")
  })
})

async function runGeneratedAppScenario(
  options: GeneratedAppScenarioOptions,
): Promise<GeneratedAppScenario> {
  const tempRoot = await createTrackedTempDir("dg-", tempDirs)
  const scaffoldMode = options.scaffoldMode ?? "external"

  const artifactRoot = await createArtifactRoot({
    baseDir: tempRoot,
    lane: options.expectedFixtureName === "basic" ? "b" : "c",
    runId: "ga",
  })
  const transcriptPath = join(artifactRoot, "transcripts", "generated-app.log")
  const appRoot = join(tempRoot, options.targetDirName)

  await mkdir(dirname(transcriptPath), { recursive: true })
  try {
    let installerDir: string | undefined
    let tarballs: PackedTarballs | undefined

    if (scaffoldMode === "internal") {
      await buildLocalContributorPackages(transcriptPath)
    } else {
      const packagedInstaller = await createPackagedInstaller({
        packageNames: [
          "@dawn/cli",
          "@dawn/config-typescript",
          "@dawn/core",
          "@dawn/langgraph",
          "@dawn/sdk",
        ],
        tempRoot,
        transcriptPath,
      })

      installerDir = packagedInstaller.installerDir
      tarballs = toPackedTarballs(packagedInstaller.tarballs)
    }

    await scaffoldApp({
      appRoot,
      installerDir,
      mode: scaffoldMode,
      transcriptPath,
    })

    if (options.mutateApp) {
      await options.mutateApp(appRoot)
    }

    if (scaffoldMode === "external" && tarballs) {
      await rewriteDependenciesToTarballs({ appRoot, tarballs })
    }

    const result = await runLifecycle({ appRoot, transcriptPath })
    if (scaffoldMode === "external" && tarballs) {
      const expected = await readExpectedFixture(options.expectedFixtureName)

      expect(normalizeForFixture(result, { appRoot, tarballs })).toEqual(expected)
    }

    return {
      artifacts: {
        appRoot,
        transcriptPath,
      },
      result,
    }
  } catch (error) {
    markTrackedTempDirForPreserve(tempDirs, tempRoot)
    const message = error instanceof Error ? error.message : String(error)
    throw new Error(
      [
        message,
        `Preserved generated app artifacts at ${artifactRoot}`,
        `Transcript: ${transcriptPath}`,
      ].join("\n"),
    )
  }
}

async function scaffoldApp(options: {
  readonly appRoot: string
  readonly installerDir?: string
  readonly mode: "external" | "internal"
  readonly transcriptPath: string
}): Promise<void> {
  if (options.mode === "internal") {
    await runCommand({
      args: ["packages/create-dawn-app/dist/index.js", options.appRoot, "--mode", "internal"],
      command: "node",
      cwd: REPO_ROOT,
      transcriptPath: options.transcriptPath,
    })
  } else {
    if (!options.installerDir) {
      throw new Error("Expected packaged installer directory for external generated-app scaffolding")
    }

    await runCommand({
      args: ["exec", "create-dawn-app", options.appRoot, "--dist-tag", "next"],
      command: "pnpm",
      cwd: options.installerDir,
      transcriptPath: options.transcriptPath,
    })
  }

  await expect(
    access(join(options.appRoot, "package.json"), constants.F_OK),
  ).resolves.toBeUndefined()
}

async function rewriteDependenciesToTarballs(options: {
  readonly appRoot: string
  readonly tarballs: PackedTarballs
}): Promise<void> {
  const packageJsonPath = join(options.appRoot, "package.json")
  const packageJson = JSON.parse(await readFile(packageJsonPath, "utf8")) as {
    devDependencies?: Record<string, string>
    dependencies?: Record<string, string>
    pnpm?: {
      overrides?: Record<string, string>
    }
  }

  packageJson.dependencies = {
    ...packageJson.dependencies,
    "@dawn/cli": options.tarballs.cli,
    "@dawn/core": options.tarballs.core,
    "@dawn/langgraph": options.tarballs.langgraph,
    "@dawn/sdk": options.tarballs.sdk,
  }
  packageJson.devDependencies = {
    ...packageJson.devDependencies,
    "@dawn/config-typescript": options.tarballs.configTypescript,
  }
  packageJson.pnpm = {
    ...(packageJson.pnpm ?? {}),
    overrides: {
      ...(packageJson.pnpm?.overrides ?? {}),
      "@dawn/cli": options.tarballs.cli,
      "@dawn/config-typescript": options.tarballs.configTypescript,
      "@dawn/core": options.tarballs.core,
      "@dawn/langgraph": options.tarballs.langgraph,
      "@dawn/sdk": options.tarballs.sdk,
    },
  }

  await writeFile(packageJsonPath, `${JSON.stringify(packageJson, null, 2)}\n`, "utf8")
}

async function rewriteToCustomAppDirLayout(appRoot: string): Promise<void> {
  await rm(join(appRoot, "src"), { force: true, recursive: true })
  await cp(join(CUSTOM_APP_DIR_FIXTURE_ROOT, "dawn.config.ts"), join(appRoot, "dawn.config.ts"))
  await mkdir(join(appRoot, "src/dawn-app/support/[tenant]"), { recursive: true })
  await writeFile(
    join(appRoot, "src/dawn-app/support/[tenant]/index.ts"),
    [
      'import type { SupportTenantState } from "./state.js"',
      "",
      "export const graph = async (state: SupportTenantState): Promise<SupportTenantState> => ({",
      "  ...state,",
      "  greeting: `Hello, ${state.tenant}!`,",
      "})",
      "",
    ].join("\n"),
    "utf8",
  )
  await writeFile(
    join(appRoot, "src/dawn-app/support/[tenant]/state.ts"),
    [
      "export interface SupportTenantState {",
      "  greeting?: string",
      "  tenant: string",
      "}",
      "",
    ].join("\n"),
    "utf8",
  )
}

async function runLifecycle(options: {
  readonly appRoot: string
  readonly transcriptPath: string
}): Promise<GeneratedAppScenarioResult> {
  await runCommand({
    args: ["install"],
    command: "pnpm",
    cwd: options.appRoot,
    transcriptPath: options.transcriptPath,
  })

  const verifyResult = await runCommand({
    args: ["exec", "dawn", "verify", "--json"],
    command: "pnpm",
    cwd: options.appRoot,
    transcriptPath: options.transcriptPath,
  })
  const routesResult = await runCommand({
    args: ["exec", "dawn", "routes", "--json"],
    command: "pnpm",
    cwd: options.appRoot,
    transcriptPath: options.transcriptPath,
  })
  const typegenResult = await runCommand({
    args: ["exec", "dawn", "typegen"],
    command: "pnpm",
    cwd: options.appRoot,
    transcriptPath: options.transcriptPath,
  })

  expect(typegenResult.stdout).toContain("Wrote route types")
  await runCommand({
    args: ["typecheck"],
    command: "pnpm",
    cwd: options.appRoot,
    transcriptPath: options.transcriptPath,
  })
  await runCommand({
    args: ["build"],
    command: "pnpm",
    cwd: options.appRoot,
    transcriptPath: options.transcriptPath,
  })

  const packageJson = JSON.parse(await readFile(join(options.appRoot, "package.json"), "utf8")) as {
    packageManager?: string
  }
  delete packageJson.packageManager
  const verifyJson = JSON.parse(verifyResult.stdout)
  const routesJson = JSON.parse(routesResult.stdout)
  const typegenOutputPath = typegenResult.stdout.match(/Wrote route types to (.+)\n?$/u)?.[1]

  if (!typegenOutputPath) {
    throw new Error(`Could not determine typegen output path from: ${typegenResult.stdout}`)
  }

  await expect(stat(typegenOutputPath)).resolves.toBeDefined()

  return {
    packageJson,
    routesJson,
    typegenOutput: await readFile(typegenOutputPath, "utf8"),
    verifyJson,
  }
}

async function runCommand(options: {
  readonly args: readonly string[]
  readonly command: string
  readonly cwd: string
  readonly transcriptPath: string
}) {
  const result = await spawnProcess({
    args: options.args,
    command: options.command,
    cwd: options.cwd,
  })

  await appendTranscript(options.transcriptPath, result)

  if (!result.ok) {
    throw new Error(
      [`Command failed: ${options.command} ${options.args.join(" ")}`, result.stdout, result.stderr]
        .filter(Boolean)
        .join("\n"),
    )
  }

  return result
}

async function appendTranscript(
  transcriptPath: string,
  result: {
    readonly args: readonly string[]
    readonly command: string
    readonly cwd: string
    readonly exitCode: number | null
    readonly stderr: string
    readonly stdout: string
  },
): Promise<void> {
  await appendFile(
    transcriptPath,
    [
      `$ (cd ${result.cwd} && ${result.command} ${result.args.join(" ")})`,
      result.stdout.trimEnd(),
      result.stderr.trimEnd(),
      `[exit ${result.exitCode}]`,
      "",
    ]
      .filter((chunk, index, chunks) => chunk.length > 0 || index === chunks.length - 1)
      .join("\n"),
    "utf8",
  )
}

async function readExpectedFixture(fixtureName: string): Promise<unknown> {
  return JSON.parse(await readFile(join(FIXTURE_ROOT, `${fixtureName}.expected.json`), "utf8"))
}

async function buildLocalContributorPackages(transcriptPath: string): Promise<void> {
  await runCommand({
    args: ["--filter", "create-dawn-app", "build"],
    command: "pnpm",
    cwd: REPO_ROOT,
    transcriptPath,
  })
}

async function createExpectedInternalFixture(
  fixtureName: string,
  appName: string,
): Promise<GeneratedAppScenarioResult> {
  const expected = (await readExpectedFixture(fixtureName)) as GeneratedAppScenarioResult & {
    packageJson: {
      dependencies: Record<string, string>
      devDependencies: Record<string, string>
      name: string
      pnpm: {
        overrides: Record<string, string>
      }
    }
  }

  return {
    ...expected,
    packageJson: {
      ...expected.packageJson,
      name: appName,
      dependencies: {
        ...expected.packageJson.dependencies,
        "@dawn/cli": "<repo:@dawn/cli>",
        "@dawn/core": "<repo:@dawn/core>",
        "@dawn/langgraph": "<repo:@dawn/langgraph>",
        "@dawn/sdk": "<repo:@dawn/sdk>",
      },
      devDependencies: {
        ...expected.packageJson.devDependencies,
        "@dawn/config-typescript": "<repo:@dawn/config-typescript>",
      },
      pnpm: {
        overrides: {
          "@dawn/cli": "<repo:@dawn/cli>",
          "@dawn/config-typescript": "<repo:@dawn/config-typescript>",
          "@dawn/core": "<repo:@dawn/core>",
          "@dawn/langgraph": "<repo:@dawn/langgraph>",
          "@dawn/sdk": "<repo:@dawn/sdk>",
        },
      },
    },
  }
}

function toPackedTarballs(tarballs: Readonly<Record<string, string>>): PackedTarballs {
  return {
    cli: tarballs["@dawn/cli"],
    configTypescript: tarballs["@dawn/config-typescript"],
    core: tarballs["@dawn/core"],
    createApp: tarballs["create-dawn-app"],
    devkit: tarballs["@dawn/devkit"],
    langgraph: tarballs["@dawn/langgraph"],
    sdk: tarballs["@dawn/sdk"],
  }
}

function normalizeForFixture(
  value: GeneratedAppScenarioResult,
  context: { readonly appRoot: string; readonly tarballs: PackedTarballs },
): GeneratedAppScenarioResult {
  return normalizeValue(value, [
    [`/private${context.appRoot}`, "<app-root>"],
    [context.appRoot, "<app-root>"],
    [context.tarballs.cli, "<tarball:@dawn/cli>"],
    [context.tarballs.configTypescript, "<tarball:@dawn/config-typescript>"],
    [context.tarballs.core, "<tarball:@dawn/core>"],
    [context.tarballs.createApp, "<tarball:create-dawn-app>"],
    [context.tarballs.devkit, "<tarball:@dawn/devkit>"],
    [context.tarballs.langgraph, "<tarball:@dawn/langgraph>"],
    [context.tarballs.sdk, "<tarball:@dawn/sdk>"],
    [`/private${dirname(context.tarballs.cli)}`, "<packs-dir>"],
    [dirname(context.tarballs.cli), "<packs-dir>"],
    ["25.6.0", "<version:@types/node>"],
    ["6.0.2", "<version:typescript>"],
  ]) as GeneratedAppScenarioResult
}

function normalizeForInternalFixture(
  value: GeneratedAppScenarioResult,
  context: { readonly appRoot: string },
): GeneratedAppScenarioResult {
  return normalizeValue(value, [
    [`/private${context.appRoot}`, "<app-root>"],
    [context.appRoot, "<app-root>"],
    [pathToRepoPackageFileSpecifier("@dawn/cli"), "<repo:@dawn/cli>"],
    [pathToRepoPackageFileSpecifier("@dawn/config-typescript"), "<repo:@dawn/config-typescript>"],
    [pathToRepoPackageFileSpecifier("@dawn/core"), "<repo:@dawn/core>"],
    [pathToRepoPackageFileSpecifier("@dawn/langgraph"), "<repo:@dawn/langgraph>"],
    [pathToRepoPackageFileSpecifier("@dawn/sdk"), "<repo:@dawn/sdk>"],
    ["25.6.0", "<version:@types/node>"],
    ["6.0.2", "<version:typescript>"],
  ]) as GeneratedAppScenarioResult
}

function pathToRepoPackageFileSpecifier(
  packageName:
    | "@dawn/cli"
    | "@dawn/config-typescript"
    | "@dawn/core"
    | "@dawn/langgraph"
    | "@dawn/sdk",
): string {
  const packageDirByName = {
    "@dawn/cli": "packages/cli",
    "@dawn/config-typescript": "packages/config-typescript",
    "@dawn/core": "packages/core",
    "@dawn/langgraph": "packages/langgraph",
    "@dawn/sdk": "packages/sdk",
  } as const

  return pathToFileURL(resolve(REPO_ROOT, packageDirByName[packageName])).toString()
}

function normalizeValue(
  value: unknown,
  replacements: ReadonlyArray<readonly [string, string]>,
): unknown {
  if (typeof value === "string") {
    return replacements.reduce((normalized, [from, to]) => normalized.replaceAll(from, to), value)
  }

  if (Array.isArray(value)) {
    return value.map((entry) => normalizeValue(entry, replacements))
  }

  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([key, entry]) => [key, normalizeValue(entry, replacements)]),
    )
  }

  return value
}
