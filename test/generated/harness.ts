import { constants } from "node:fs"
import { access, cp, mkdir, readFile, rm, writeFile } from "node:fs/promises"
import { dirname, join, resolve } from "node:path"

import { expect } from "vitest"

import { createArtifactRoot } from "../../packages/devkit/src/testing/index.ts"
import {
  cleanupTrackedTempDirs,
  createPackagedInstaller,
  createTrackedTempDir,
  markTrackedTempDirForPreserve,
  runPackagedCommand,
  type TrackedTempDir,
  withPackagedDevServer,
} from "../harness/packaged-app.ts"
import { startFakeAgentServer } from "../runtime/support/fake-agent-server.ts"

const REPO_ROOT = resolve(import.meta.dirname, "../..")
const FIXTURE_ROOT = resolve(import.meta.dirname, "fixtures")
const HANDWRITTEN_RUNTIME_FIXTURE_ROOT = join(FIXTURE_ROOT, "handwritten-runtime-app")
const SERVER_URL_PLACEHOLDER = "__SERVER_URL__"

export type { TrackedTempDir } from "../harness/packaged-app.ts"
export {
  cleanupTrackedTempDirs,
  createTrackedTempDir,
  markTrackedTempDirForPreserve,
} from "../harness/packaged-app.ts"

export type GeneratedRuntimeFixtureName = "basic" | "custom-app-dir" | "handwritten"
export type GeneratedScaffoldMode = "external" | "internal"

interface PackedTarballs {
  readonly cli: string
  readonly configTypescript: string
  readonly core: string
  readonly createApp: string
  readonly devkit: string
  readonly langchain: string
  readonly langgraph: string
  readonly sdk: string
}

interface RuntimeFixtureSpec {
  readonly expectedFixturePath: string
  readonly fixtureName: GeneratedRuntimeFixtureName
  readonly input: {
    readonly tenant: string
  }
  readonly mode: "agent" | "chain" | "graph" | "workflow"
  readonly routeDir: string
  readonly routeId: string
  readonly routePath: string
  readonly scenarioNames: {
    readonly inProcess: string
    readonly server: string
  }
  readonly source: "generated" | "handwritten"
}

export interface GeneratedRuntimeApp {
  readonly appRoot: string
  readonly artifactRoot: string
  readonly fixture: RuntimeFixtureSpec
  readonly tarballs?: PackedTarballs
  readonly tempRoot: string
  readonly transcriptPath: string
}

export interface GeneratedRuntimeScenarioResult {
  readonly devServerHealth: {
    readonly status: string
  }
  readonly runJson: unknown
  readonly runServerJson: unknown
  readonly serverRequest: {
    readonly assistant_id: string
    readonly input: unknown
    readonly metadata: {
      readonly dawn: {
        readonly mode: "agent" | "chain" | "graph" | "workflow"
        readonly route_id: string
        readonly route_path: string
      }
    }
    readonly on_completion: "delete"
  }
  readonly serverRequestUrl: string | null
  readonly testStdout: string
}

const runtimeFixtures: Record<GeneratedRuntimeFixtureName, RuntimeFixtureSpec> = {
  basic: {
    expectedFixturePath: join(FIXTURE_ROOT, "basic-runtime.expected.json"),
    fixtureName: "basic",
    input: {
      tenant: "basic-tenant",
    },
    mode: "agent",
    routeDir: "src/app/(public)/hello/[tenant]",
    routeId: "/hello/[tenant]",
    routePath: "src/app/(public)/hello/[tenant]/index.ts",
    scenarioNames: {
      inProcess: "basic in-process scenario",
      server: "basic server scenario",
    },
    source: "generated",
  },
  "custom-app-dir": {
    expectedFixturePath: join(FIXTURE_ROOT, "custom-app-dir-runtime.expected.json"),
    fixtureName: "custom-app-dir",
    input: {
      tenant: "custom-tenant",
    },
    mode: "graph",
    routeDir: "src/dawn-app/support/[tenant]",
    routeId: "/support/[tenant]",
    routePath: "src/dawn-app/support/[tenant]/index.ts",
    scenarioNames: {
      inProcess: "custom appDir in-process scenario",
      server: "custom appDir server scenario",
    },
    source: "generated",
  },
  handwritten: {
    expectedFixturePath: join(FIXTURE_ROOT, "handwritten-runtime.expected.json"),
    fixtureName: "handwritten",
    input: {
      tenant: "handwritten-tenant",
    },
    mode: "graph",
    routeDir: "src/app/(public)/hello/[tenant]",
    routeId: "/hello/[tenant]",
    routePath: "src/app/(public)/hello/[tenant]/index.ts",
    scenarioNames: {
      inProcess: "handwritten in-process scenario",
      server: "handwritten server scenario",
    },
    source: "handwritten",
  },
}

export async function prepareGeneratedRuntimeApp(options: {
  readonly fixtureName: GeneratedRuntimeFixtureName
  readonly registry?: TrackedTempDir[]
  readonly scaffoldMode?: GeneratedScaffoldMode
  readonly tempRoot: string
}): Promise<GeneratedRuntimeApp> {
  const fixture = runtimeFixtures[options.fixtureName]
  const scaffoldMode = options.scaffoldMode ?? "external"
  const artifactRoot = await createArtifactRoot({
    baseDir: options.tempRoot,
    lane: fixture.fixtureName,
    runId: "generated-runtime",
  })
  const transcriptPath = join(artifactRoot, "transcripts", `${fixture.fixtureName}.log`)
  const appRoot = join(options.tempRoot, "app")

  await mkdir(dirname(transcriptPath), { recursive: true })

  try {
    let installerDir: string | undefined
    let tarballs: PackedTarballs | undefined

    if (scaffoldMode === "internal") {
      await buildLocalContributorPackages(transcriptPath)
    } else {
      const packagedInstaller = await createPackagedInstaller({
        packageNames: [
          "@dawn-ai/cli",
          "@dawn-ai/config-typescript",
          "@dawn-ai/core",
          "@dawn-ai/langchain",
          "@dawn-ai/langgraph",
          "@dawn-ai/sdk",
        ],
        tempRoot: options.tempRoot,
        transcriptPath,
      })

      installerDir = packagedInstaller.installerDir
      tarballs = toPackedTarballs(packagedInstaller.tarballs)
    }

    if (fixture.source === "generated") {
      await scaffoldApp({
        appRoot,
        installerDir,
        mode: scaffoldMode,
        transcriptPath,
      })
    } else {
      await stageFixtureApp({
        appRoot,
        fixtureRoot: HANDWRITTEN_RUNTIME_FIXTURE_ROOT,
      })
    }

    if (fixture.fixtureName === "custom-app-dir") {
      await rewriteToCustomAppDirRuntimeLayout(appRoot)
    }

    if (fixture.fixtureName === "basic") {
      await writeFile(
        join(appRoot, fixture.routeDir, "index.ts"),
        [
          'import greet from "./tools/greet.js"',
          "",
          "export const agent = {",
          "  async invoke(input: Record<string, unknown>, config?: Record<string, unknown>) {",
          "    const tenant = (config?.configurable as Record<string, unknown>)?.tenant as string",
          "    const info = await greet({ tenant })",
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

    if (fixture.fixtureName !== "handwritten") {
      await writeRunScenarioFile({
        appRoot,
        fixture,
      })
    }

    if (scaffoldMode === "external" && tarballs) {
      await rewriteDependenciesToTarballs({ appRoot, tarballs })
    }
    await runPackagedCommand({
      args: ["install"],
      command: "pnpm",
      cwd: appRoot,
      transcriptPath,
    })

    return {
      appRoot,
      artifactRoot,
      fixture,
      tarballs,
      tempRoot: options.tempRoot,
      transcriptPath,
    }
  } catch (error) {
    if (options.registry) {
      markTrackedTempDirForPreserve(options.registry, options.tempRoot)
    }
    const message = error instanceof Error ? error.message : String(error)
    throw new Error(
      [
        message,
        `Preserved generated runtime artifacts at ${artifactRoot}`,
        `Transcript: ${transcriptPath}`,
      ].join("\n"),
    )
  }
}

export async function expectBasicAuthoringLane(appRoot: string): Promise<void> {
  await expect(
    access(resolve(appRoot, "src/app/(public)/hello/[tenant]/index.ts"), constants.F_OK),
  ).resolves.toBeUndefined()
  await expect(
    access(resolve(appRoot, "src/app/(public)/hello/[tenant]/state.ts"), constants.F_OK),
  ).resolves.toBeUndefined()
  await expect(
    access(resolve(appRoot, "src/app/(public)/hello/[tenant]/tools/greet.ts"), constants.F_OK),
  ).resolves.toBeUndefined()
}

export async function runGeneratedRuntimeScenario(
  prepared: GeneratedRuntimeApp,
): Promise<GeneratedRuntimeScenarioResult> {
  const fixture = prepared.fixture

  const runJson = selectRuntimeResult(
    await runDawnRunJson({
      appRoot: prepared.appRoot,
      input: fixture.input,
      routePath: fixture.routePath,
      transcriptPath: prepared.transcriptPath,
    }),
  )

  const requestCapture = await captureServerRequest({
    fixture,
    prepared,
  })

  return await withPackagedDevServer(
    {
      appRoot: prepared.appRoot,
      transcriptPath: prepared.transcriptPath,
    },
    async ({ devServer, url }) => {
      const healthResponse = await fetch(new URL("/healthz", url))
      const devServerHealth = (await healthResponse.json()) as { readonly status: string }

      const readyCountBeforeReplace = devServer.readyCount()
      await replaceInFile(
        join(prepared.appRoot, fixture.routeDir, "run.test.ts"),
        SERVER_URL_PLACEHOLDER,
        url,
      )
      await devServer.waitForNextReady(readyCountBeforeReplace)

      const runServerJson = selectRuntimeResult(
        await runDawnRunJson({
          appRoot: prepared.appRoot,
          input: fixture.input,
          routePath: fixture.routePath,
          transcriptPath: prepared.transcriptPath,
          url,
        }),
      )

      const testResult = await runPackagedCommand({
        args: ["exec", "dawn", "test"],
        command: "pnpm",
        cwd: prepared.appRoot,
        transcriptPath: prepared.transcriptPath,
      })

      return normalizeGeneratedRuntimeValue(
        {
          devServerHealth,
          runJson,
          runServerJson,
          serverRequest: requestCapture.serverRequest,
          serverRequestUrl: requestCapture.serverRequestUrl,
          testStdout: testResult.stdout.trim(),
        },
        {
          appRoot: prepared.appRoot,
        },
      ) as GeneratedRuntimeScenarioResult
    },
  )
}

export async function readGeneratedExpectedFixture(
  fixtureName: GeneratedRuntimeFixtureName,
): Promise<unknown> {
  return JSON.parse(await readFile(runtimeFixtures[fixtureName].expectedFixturePath, "utf8"))
}

async function captureServerRequest(options: {
  readonly fixture: RuntimeFixtureSpec
  readonly prepared: GeneratedRuntimeApp
}): Promise<{
  readonly serverRequest: GeneratedRuntimeScenarioResult["serverRequest"]
  readonly serverRequestUrl: string | null
}> {
  const server = await startFakeAgentServer(async () => ({
    body: createExpectedOutput(options.fixture),
    statusCode: 200,
  }))

  try {
    await runDawnRunJson({
      appRoot: options.prepared.appRoot,
      input: options.fixture.input,
      routePath: options.fixture.routePath,
      transcriptPath: options.prepared.transcriptPath,
      url: server.url,
    })

    const request = server.requests.at(-1)

    if (!request) {
      throw new Error("Expected fake server to capture a dawn run --url request")
    }

    return {
      serverRequest: request.jsonBody as GeneratedRuntimeScenarioResult["serverRequest"],
      serverRequestUrl: request.url,
    }
  } finally {
    await server.close()
  }
}

async function scaffoldApp(options: {
  readonly appRoot: string
  readonly installerDir?: string
  readonly mode: GeneratedScaffoldMode
  readonly transcriptPath: string
}): Promise<void> {
  if (options.mode === "internal") {
    await runPackagedCommand({
      args: ["packages/create-dawn-app/dist/bin.js", options.appRoot, "--mode", "internal"],
      command: "node",
      cwd: REPO_ROOT,
      transcriptPath: options.transcriptPath,
    })
  } else {
    if (!options.installerDir) {
      throw new Error(
        "Expected packaged installer directory for external generated runtime scaffolding",
      )
    }

    await runPackagedCommand({
      args: ["exec", "create-dawn-ai-app", options.appRoot, "--dist-tag", "next"],
      command: "pnpm",
      cwd: options.installerDir,
      transcriptPath: options.transcriptPath,
    })
  }

  await access(join(options.appRoot, "package.json"), constants.F_OK)
}

async function stageFixtureApp(options: {
  readonly appRoot: string
  readonly fixtureRoot: string
}): Promise<void> {
  await rm(options.appRoot, { force: true, recursive: true })
  await cp(options.fixtureRoot, options.appRoot, { recursive: true })
}

async function buildLocalContributorPackages(transcriptPath: string): Promise<void> {
  await runPackagedCommand({
    args: ["--filter", "create-dawn-ai-app", "build"],
    command: "pnpm",
    cwd: REPO_ROOT,
    transcriptPath,
  })
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
    "@dawn-ai/cli": options.tarballs.cli,
    "@dawn-ai/core": options.tarballs.core,
    "@dawn-ai/langgraph": options.tarballs.langgraph,
    "@dawn-ai/sdk": options.tarballs.sdk,
  }
  packageJson.devDependencies = {
    ...packageJson.devDependencies,
    "@dawn-ai/config-typescript": options.tarballs.configTypescript,
  }
  packageJson.pnpm = {
    ...(packageJson.pnpm ?? {}),
    overrides: {
      ...(packageJson.pnpm?.overrides ?? {}),
      "@dawn-ai/cli": options.tarballs.cli,
      "@dawn-ai/config-typescript": options.tarballs.configTypescript,
      "@dawn-ai/core": options.tarballs.core,
      "@dawn-ai/langchain": options.tarballs.langchain,
      "@dawn-ai/langgraph": options.tarballs.langgraph,
      "@dawn-ai/sdk": options.tarballs.sdk,
    },
  }

  await writeFile(packageJsonPath, `${JSON.stringify(packageJson, null, 2)}\n`, "utf8")
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

async function rewriteToCustomAppDirRuntimeLayout(appRoot: string): Promise<void> {
  await rm(join(appRoot, "src"), { force: true, recursive: true })
  await mkdir(join(appRoot, "src/dawn-app/support/[tenant]"), { recursive: true })
  await writeFile(
    join(appRoot, "dawn.config.ts"),
    'const appDir = "src/dawn-app";\nexport default { appDir };\n',
    "utf8",
  )
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

async function writeRunScenarioFile(options: {
  readonly appRoot: string
  readonly fixture: RuntimeFixtureSpec
}): Promise<void> {
  const routeDir = join(options.appRoot, options.fixture.routeDir)
  const runTestPath = join(routeDir, "run.test.ts")
  const scenarioRoutePath = options.fixture.routePath

  await writeFile(
    runTestPath,
    [
      'import { expectMeta, expectOutput } from "@dawn-ai/cli/testing"',
      "",
      "export default [",
      "  {",
      `    name: ${JSON.stringify(options.fixture.scenarioNames.inProcess)},`,
      `    input: ${JSON.stringify(options.fixture.input)},`,
      "    expect: {",
      '      status: "passed",',
      `      output: ${JSON.stringify(createExpectedOutput(options.fixture))},`,
      "      meta: {",
      '        executionSource: "in-process",',
      `        mode: ${JSON.stringify(options.fixture.mode)},`,
      `        routeId: ${JSON.stringify(options.fixture.routeId)},`,
      `        routePath: ${JSON.stringify(scenarioRoutePath)},`,
      "      },",
      "    },",
      "  },",
      "  {",
      `    name: ${JSON.stringify(options.fixture.scenarioNames.server)},`,
      `    input: ${JSON.stringify(options.fixture.input)},`,
      "    run: {",
      `      url: ${JSON.stringify(SERVER_URL_PLACEHOLDER)},`,
      "    },",
      "    expect: {",
      '      status: "passed",',
      `      output: ${JSON.stringify(createExpectedOutput(options.fixture))},`,
      "      meta: {",
      '        executionSource: "server",',
      `        mode: ${JSON.stringify(options.fixture.mode)},`,
      `        routeId: ${JSON.stringify(options.fixture.routeId)},`,
      `        routePath: ${JSON.stringify(scenarioRoutePath)},`,
      "      },",
      "    },",
      "    assert(result) {",
      `      expectMeta(result, { executionSource: "server", mode: ${JSON.stringify(options.fixture.mode)} })`,
      `      expectOutput(result, ${JSON.stringify({ tenant: options.fixture.input.tenant })})`,
      "    },",
      "  },",
      "]",
      "",
    ].join("\n"),
    "utf8",
  )
}

async function replaceInFile(filePath: string, search: string, replacement: string): Promise<void> {
  const source = await readFile(filePath, "utf8")
  await writeFile(filePath, source.replace(search, replacement), "utf8")
}

function createExpectedOutput(fixture: RuntimeFixtureSpec): {
  readonly greeting: string
  readonly tenant: string
} {
  return {
    greeting: `Hello, ${fixture.input.tenant}!`,
    tenant: fixture.input.tenant,
  }
}

function selectRuntimeResult(result: unknown): unknown {
  if (!isRecord(result)) {
    return result
  }

  if (result.status === "passed") {
    return {
      appRoot: result.appRoot,
      executionSource: result.executionSource,
      mode: result.mode,
      output: result.output,
      routeId: result.routeId,
      routePath: result.routePath,
      status: result.status,
    }
  }

  return {
    appRoot: result.appRoot,
    error: result.error,
    executionSource: result.executionSource,
    mode: result.mode,
    routeId: result.routeId,
    routePath: result.routePath,
    status: result.status,
  }
}

function normalizeGeneratedRuntimeValue(
  value: unknown,
  context: {
    readonly appRoot: string
  },
): unknown {
  return normalizeValue(value, [
    [`/private${context.appRoot}`, "<app-root>"],
    [context.appRoot, "<app-root>"],
  ])
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

function toPackedTarballs(tarballs: Readonly<Record<string, string>>): PackedTarballs {
  return {
    cli: tarballs["@dawn-ai/cli"],
    configTypescript: tarballs["@dawn-ai/config-typescript"],
    core: tarballs["@dawn-ai/core"],
    createApp: tarballs["create-dawn-ai-app"],
    devkit: tarballs["@dawn-ai/devkit"],
    langchain: tarballs["@dawn-ai/langchain"],
    langgraph: tarballs["@dawn-ai/langgraph"],
    sdk: tarballs["@dawn-ai/sdk"],
  }
}

async function runDawnRunJson(options: {
  readonly appRoot: string
  readonly input: unknown
  readonly routePath: string
  readonly transcriptPath: string
  readonly url?: string
}): Promise<unknown> {
  const args = ["exec", "dawn", "run", options.routePath]

  if (options.url) {
    args.push("--url", options.url)
  }

  const result = await runPackagedCommand({
    args,
    command: "pnpm",
    cwd: options.appRoot,
    stdin: JSON.stringify(options.input),
    transcriptPath: options.transcriptPath,
  })

  return JSON.parse(result.stdout)
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null
}
