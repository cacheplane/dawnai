import { constants } from "node:fs"
import {
  access,
  appendFile,
  cp,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  stat,
  writeFile,
} from "node:fs/promises"
import { tmpdir } from "node:os"
import { basename, dirname, join, resolve } from "node:path"

import { afterEach, describe, expect, test } from "vitest"

import { createArtifactRoot, spawnProcess } from "../../packages/devkit/src/testing/index.ts"

const REPO_ROOT = resolve(import.meta.dirname, "../..")
const FIXTURE_ROOT = resolve(import.meta.dirname, "fixtures")
const CUSTOM_APP_DIR_FIXTURE_ROOT = resolve(
  REPO_ROOT,
  "test/fixtures/contracts/valid-custom-app-dir",
)
const tempDirs: string[] = []

interface PackedTarballs {
  readonly cli: string
  readonly configTypescript: string
  readonly core: string
  readonly createApp: string
  readonly devkit: string
  readonly langgraph: string
}

interface GeneratedAppScenarioResult {
  readonly packageJson: unknown
  readonly routesJson: unknown
  readonly typegenOutput: string
  readonly verifyJson: unknown
}

interface GeneratedAppScenarioOptions {
  readonly expectedFixtureName: string
  readonly mutateApp?: (appRoot: string) => Promise<void>
  readonly targetDirName: string
}

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { force: true, recursive: true })))
})

describe("generated app publish harness", () => {
  test("scaffolds a packaged basic app and runs the published lifecycle", {
    timeout: 180_000,
  }, async () => {
    await runGeneratedAppScenario({ expectedFixtureName: "basic", targetDirName: "app" })
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
})

async function runGeneratedAppScenario(
  options: GeneratedAppScenarioOptions,
): Promise<GeneratedAppScenarioResult> {
  const tempRoot = await mkdtemp(join(tmpdir(), "dg-"))
  tempDirs.push(tempRoot)

  const artifactRoot = await createArtifactRoot({
    baseDir: tempRoot,
    lane: options.expectedFixtureName === "basic" ? "b" : "c",
    runId: "ga",
  })
  const transcriptPath = join(artifactRoot, "transcripts", "generated-app.log")
  const packsDir = join(tempRoot, "p")
  const installerDir = join(tempRoot, "i")
  const appRoot = join(tempRoot, options.targetDirName)

  await mkdir(dirname(transcriptPath), { recursive: true })
  await mkdir(packsDir, { recursive: true })
  await mkdir(installerDir, { recursive: true })

  const tarballs = await packPublishedPackages({ packsDir, transcriptPath })
  await installPackagedInitializer({ installerDir, tarballs, transcriptPath })
  await scaffoldApp({ appRoot, installerDir, transcriptPath })

  if (options.mutateApp) {
    await options.mutateApp(appRoot)
  }

  await rewriteDependenciesToTarballs({ appRoot, tarballs })

  const result = await runLifecycle({ appRoot, transcriptPath })
  const expected = await readExpectedFixture(options.expectedFixtureName)

  expect(normalizeForFixture(result, { appRoot, tarballs })).toEqual(expected)

  return result
}

async function packPublishedPackages(options: {
  readonly packsDir: string
  readonly transcriptPath: string
}): Promise<PackedTarballs> {
  await runCommand({
    args: ["--filter", "create-dawn-app", "build"],
    command: "pnpm",
    cwd: REPO_ROOT,
    transcriptPath: options.transcriptPath,
  })

  return {
    cli: await packPackage("@dawn/cli", options),
    configTypescript: await packPackage("@dawn/config-typescript", options),
    core: await packPackage("@dawn/core", options),
    createApp: await packPackage("create-dawn-app", options),
    devkit: await packPackage("@dawn/devkit", options),
    langgraph: await packPackage("@dawn/langgraph", options),
  }
}

async function packPackage(
  packageName: string,
  options: { readonly packsDir: string; readonly transcriptPath: string },
): Promise<string> {
  const packResult = await runCommand({
    args: ["--filter", packageName, "pack", "--pack-destination", options.packsDir],
    command: "pnpm",
    cwd: REPO_ROOT,
    transcriptPath: options.transcriptPath,
  })

  const tarballName = packResult.stdout
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .find((line) => line.endsWith(".tgz"))

  if (!tarballName) {
    throw new Error(`Could not determine tarball name for ${packageName}`)
  }

  return join(options.packsDir, basename(tarballName))
}

async function installPackagedInitializer(options: {
  readonly installerDir: string
  readonly tarballs: PackedTarballs
  readonly transcriptPath: string
}): Promise<void> {
  await writeFile(
    join(options.installerDir, "package.json"),
    `${JSON.stringify(
      {
        name: "installer",
        private: true,
        packageManager: "pnpm@10.33.0",
        pnpm: {
          overrides: {
            "@dawn/devkit": options.tarballs.devkit,
          },
        },
      },
      null,
      2,
    )}\n`,
    "utf8",
  )

  await runCommand({
    args: ["add", options.tarballs.devkit],
    command: "pnpm",
    cwd: options.installerDir,
    transcriptPath: options.transcriptPath,
  })
  await runCommand({
    args: ["add", options.tarballs.createApp],
    command: "pnpm",
    cwd: options.installerDir,
    transcriptPath: options.transcriptPath,
  })
}

async function scaffoldApp(options: {
  readonly appRoot: string
  readonly installerDir: string
  readonly transcriptPath: string
}): Promise<void> {
  await runCommand({
    args: ["exec", "create-dawn-app", options.appRoot, "--dist-tag", "next"],
    command: "pnpm",
    cwd: options.installerDir,
    transcriptPath: options.transcriptPath,
  })

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
    scripts?: Record<string, string>
    pnpm?: {
      overrides?: Record<string, string>
    }
  }

  packageJson.dependencies = {
    ...packageJson.dependencies,
    "@dawn/cli": options.tarballs.cli,
    "@dawn/core": options.tarballs.core,
    "@dawn/langgraph": options.tarballs.langgraph,
  }
  packageJson.devDependencies = {
    ...packageJson.devDependencies,
    "@dawn/config-typescript": options.tarballs.configTypescript,
  }
  packageJson.scripts = {
    ...packageJson.scripts,
    build: packageJson.scripts?.build ?? "tsc -p tsconfig.json",
  }
  packageJson.pnpm = {
    ...(packageJson.pnpm ?? {}),
    overrides: {
      ...(packageJson.pnpm?.overrides ?? {}),
      "@dawn/cli": options.tarballs.cli,
      "@dawn/config-typescript": options.tarballs.configTypescript,
      "@dawn/core": options.tarballs.core,
      "@dawn/langgraph": options.tarballs.langgraph,
    },
  }

  await writeFile(packageJsonPath, `${JSON.stringify(packageJson, null, 2)}\n`, "utf8")
}

async function rewriteToCustomAppDirLayout(appRoot: string): Promise<void> {
  await rm(join(appRoot, "src"), { force: true, recursive: true })
  await cp(join(CUSTOM_APP_DIR_FIXTURE_ROOT, "src"), join(appRoot, "src"), { recursive: true })
  await cp(join(CUSTOM_APP_DIR_FIXTURE_ROOT, "dawn.config.ts"), join(appRoot, "dawn.config.ts"))
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
    args: ["check"],
    command: "pnpm",
    cwd: options.appRoot,
    transcriptPath: options.transcriptPath,
  })
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

function normalizeForFixture(
  value: GeneratedAppScenarioResult,
  context: { readonly appRoot: string; readonly tarballs: PackedTarballs },
): GeneratedAppScenarioResult {
  return normalizeValue(value, [
    [`/private${context.appRoot}`, "<app-root>"],
    [context.appRoot, "<app-root>"],
    [`/private${dirname(context.tarballs.cli)}`, "<packs-dir>"],
    [dirname(context.tarballs.cli), "<packs-dir>"],
    [context.tarballs.cli, `<packs-dir>/${basename(context.tarballs.cli)}`],
    [
      context.tarballs.configTypescript,
      `<packs-dir>/${basename(context.tarballs.configTypescript)}`,
    ],
    [context.tarballs.core, `<packs-dir>/${basename(context.tarballs.core)}`],
    [context.tarballs.createApp, `<packs-dir>/${basename(context.tarballs.createApp)}`],
    [context.tarballs.devkit, `<packs-dir>/${basename(context.tarballs.devkit)}`],
    [context.tarballs.langgraph, `<packs-dir>/${basename(context.tarballs.langgraph)}`],
  ]) as GeneratedAppScenarioResult
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
