import { constants } from "node:fs"
import { access, appendFile, cp, mkdir, readFile, rm, stat, writeFile } from "node:fs/promises"
import { dirname, join, resolve } from "node:path"
import { pathToFileURL } from "node:url"

import { afterEach, describe, expect, test } from "vitest"

import { createArtifactRoot, spawnProcess } from "../../packages/devkit/src/testing/index.ts"
import { getTestRegistryUrl } from "../harness/local-registry.ts"
import {
  cleanupTrackedTempDirs,
  createTrackedTempDir,
  markTrackedTempDirForPreserve,
  runPackagedCommand,
  type TrackedTempDir,
} from "../harness/packaged-app.ts"
import { writeRegistryNpmrc } from "../harness/scaffold-packaging.js"
import { expectBasicAuthoringLane } from "./harness.ts"

// @dawn-ai workspace packages a generated app may depend on. Used only to build
// the internal-mode <repo:...> fixture (external mode installs from the registry).
const SCAFFOLD_PACKAGES: readonly string[] = [
  "@dawn-ai/cli",
  "@dawn-ai/config-typescript",
  "@dawn-ai/core",
  "@dawn-ai/evals",
  "@dawn-ai/langchain",
  "@dawn-ai/langgraph",
  "@dawn-ai/permissions",
  "@dawn-ai/sdk",
  "@dawn-ai/sqlite-storage",
  "@dawn-ai/testing",
  "@dawn-ai/workspace",
]

const REPO_ROOT = resolve(import.meta.dirname, "../..")
const FIXTURE_ROOT = resolve(import.meta.dirname, "fixtures")
const CUSTOM_APP_DIR_FIXTURE_ROOT = resolve(
  REPO_ROOT,
  "test/fixtures/contracts/valid-custom-app-dir",
)
const tempDirs: TrackedTempDir[] = []

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
    expect(transcript).toContain(`$ (cd ${REPO_ROOT} && pnpm --filter create-dawn-ai-app build)`)
    expect(transcript).toContain(
      `node packages/create-dawn-app/dist/bin.js ${contributorLocal.artifacts.appRoot} --mode internal --template basic`,
    )
    expect(transcript).toContain(`$ (cd ${contributorLocal.artifacts.appRoot} && pnpm install)`)
    expect(transcript).toContain(
      `$ (cd ${contributorLocal.artifacts.appRoot} && pnpm exec dawn verify --json)`,
    )
    expect(transcript).toContain(
      `$ (cd ${contributorLocal.artifacts.appRoot} && pnpm exec dawn routes --json)`,
    )
    expect(transcript).toContain(
      `$ (cd ${contributorLocal.artifacts.appRoot} && pnpm exec dawn typegen)`,
    )
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
    if (scaffoldMode === "internal") {
      await buildLocalContributorPackages(transcriptPath)
    }

    await scaffoldApp({
      appRoot,
      mode: scaffoldMode,
      transcriptPath,
    })

    if (options.expectedFixtureName === "basic") {
      await writeFile(
        join(appRoot, "src/app/(public)/hello/[tenant]/index.ts"),
        [
          'import greet from "./tools/greet.js"',
          "",
          "export const agent = {",
          "  async invoke(input: { tenant: string }) {",
          "    const info = await greet(input)",
          "    return {",
          "      greeting: `Hello, ${info.name}!`,",
          "      tenant: info.name,",
          "    }",
          "  },",
          "}",
          "",
        ].join("\n"),
        "utf8",
      )
      await removeLangchainFromPackageJson(appRoot)
    }

    if (options.mutateApp) {
      await options.mutateApp(appRoot)
    }

    if (scaffoldMode === "external") {
      await writeRegistryNpmrc(appRoot, getTestRegistryUrl())
    }

    const result = await runLifecycle({ appRoot, transcriptPath })
    if (scaffoldMode === "external") {
      const expected = await readExpectedFixture(options.expectedFixtureName)

      expect(
        normalizeForFixture(result, { appRoot, dawnVersion: await readDawnVersion() }),
      ).toEqual(expected)
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
  readonly mode: "external" | "internal"
  readonly transcriptPath: string
}): Promise<void> {
  if (options.mode === "internal") {
    await runCommand({
      args: [
        "packages/create-dawn-app/dist/bin.js",
        options.appRoot,
        "--mode",
        "internal",
        "--template",
        "basic",
      ],
      command: "node",
      cwd: REPO_ROOT,
      transcriptPath: options.transcriptPath,
    })
  } else {
    // external mode: scaffold using the published create-dawn-ai-app, resolved
    // from the test registry — exactly what a real user runs. pnpm dlx does not
    // accept --registry, so the registry is passed via npm_config_registry; the
    // unique per-run URL busts dlx's cache.
    await runPackagedCommand({
      args: ["dlx", "create-dawn-ai-app", options.appRoot, "--template", "basic"],
      command: "pnpm",
      cwd: REPO_ROOT,
      env: { npm_config_registry: getTestRegistryUrl() },
      transcriptPath: options.transcriptPath,
    })
  }

  await expect(
    access(join(options.appRoot, "package.json"), constants.F_OK),
  ).resolves.toBeUndefined()
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

  expect(typegenResult.stdout).toContain("Wrote types for")
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
  const typegenOutputPath = join(options.appRoot, ".dawn", "dawn.generated.d.ts")
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

async function removeLangchainFromPackageJson(appRoot: string): Promise<void> {
  const packageJsonPath = join(appRoot, "package.json")
  const packageJson = JSON.parse(await readFile(packageJsonPath, "utf8")) as {
    dependencies?: Record<string, string>
  }
  if (packageJson.dependencies) {
    delete packageJson.dependencies.langchain
    delete packageJson.dependencies["@langchain/openai"]
  }
  await writeFile(packageJsonPath, `${JSON.stringify(packageJson, null, 2)}\n`, "utf8")
}

async function readExpectedFixture(fixtureName: string): Promise<unknown> {
  return JSON.parse(await readFile(join(FIXTURE_ROOT, `${fixtureName}.expected.json`), "utf8"))
}

async function buildLocalContributorPackages(transcriptPath: string): Promise<void> {
  await runCommand({
    args: ["--filter", "create-dawn-ai-app", "build"],
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
    }
  }

  // Internal mode rewrites every dawn specifier from "latest" to a repo file: URL (normalized
  // to <repo:...>) and adds a pnpm.overrides block covering all SCAFFOLD_PACKAGES.
  // We build the overrides block directly from SCAFFOLD_PACKAGES rather than reading
  // it from the external fixture (which has no pnpm key in the Verdaccio-install shape).
  const repoOverrides = Object.fromEntries(
    SCAFFOLD_PACKAGES.map((name) => [name, `<repo:${name}>`]),
  )

  return {
    ...expected,
    packageJson: {
      ...expected.packageJson,
      name: appName,
      dependencies: {
        ...expected.packageJson.dependencies,
        "@dawn-ai/cli": "<repo:@dawn-ai/cli>",
        "@dawn-ai/core": "<repo:@dawn-ai/core>",
        "@dawn-ai/langchain": "<repo:@dawn-ai/langchain>",
        "@dawn-ai/sdk": "<repo:@dawn-ai/sdk>",
      },
      devDependencies: {
        ...expected.packageJson.devDependencies,
        "@dawn-ai/config-typescript": "<repo:@dawn-ai/config-typescript>",
        "@dawn-ai/evals": "<repo:@dawn-ai/evals>",
        "@dawn-ai/testing": "<repo:@dawn-ai/testing>",
      },
      pnpm: {
        overrides: repoOverrides,
      },
    },
  }
}

function normalizeForFixture(
  value: GeneratedAppScenarioResult,
  context: { readonly appRoot: string; readonly dawnVersion: string },
): GeneratedAppScenarioResult {
  return normalizeValue(value, [
    [`/private${context.appRoot}`, "<app-root>"],
    [context.appRoot, "<app-root>"],
    [context.dawnVersion, "<dawn-version>"],
    ["25.6.0", "<version:@types/node>"],
    ["6.0.2", "<version:typescript>"],
    ["4.1.4", "<version:vitest>"],
  ]) as GeneratedAppScenarioResult
}

async function readDawnVersion(): Promise<string> {
  const corePackageJson = JSON.parse(
    await readFile(resolve(REPO_ROOT, "packages/core/package.json"), "utf8"),
  ) as { version?: string }

  if (!corePackageJson.version) {
    throw new Error("Could not read @dawn-ai/core version for fixture normalization")
  }

  return corePackageJson.version
}

function normalizeForInternalFixture(
  value: GeneratedAppScenarioResult,
  context: { readonly appRoot: string },
): GeneratedAppScenarioResult {
  const repoPairs: Array<readonly [string, string]> = SCAFFOLD_PACKAGES.map(
    (name) => [pathToRepoPackageFileSpecifier(name), `<repo:${name}>`] as const,
  )

  return normalizeValue(value, [
    [`/private${context.appRoot}`, "<app-root>"],
    [context.appRoot, "<app-root>"],
    ...repoPairs,
    ["25.6.0", "<version:@types/node>"],
    ["6.0.2", "<version:typescript>"],
    ["4.1.4", "<version:vitest>"],
  ]) as GeneratedAppScenarioResult
}

function pathToRepoPackageFileSpecifier(packageName: string): string {
  const packageDir = resolve(REPO_ROOT, "packages", packageName.replace("@dawn-ai/", ""))

  return pathToFileURL(packageDir).toString()
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
