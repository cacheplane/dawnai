import { constants } from "node:fs"
import { access, appendFile, cp, mkdir, readFile, rm, writeFile } from "node:fs/promises"
import { spawn } from "node:child_process"
import { dirname, join, resolve } from "node:path"

import { createArtifactRoot } from "../../packages/devkit/src/testing/index.ts"
import {
  cleanupTrackedTempDirs,
  createPackagedInstaller,
  createTrackedTempDir,
  markTrackedTempDirForPreserve,
  type TrackedTempDir,
} from "../harness/packaged-app.ts"
import { startFakeAgentServer } from "../runtime/support/fake-agent-server.ts"

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

interface PackedTarballs {
  readonly cli: string
  readonly configTypescript: string
  readonly core: string
  readonly createApp: string
  readonly devkit: string
  readonly langgraph: string
}

interface RuntimeFixtureSpec {
  readonly expectedFixturePath: string
  readonly fixtureName: GeneratedRuntimeFixtureName
  readonly input: {
    readonly tenant: string
  }
  readonly mode: "graph" | "workflow"
  readonly routeDir: string
  readonly routeId: string
  readonly routePath: string
  readonly scenarioNames: {
    readonly inProcess: string
    readonly server: string
  }
  readonly source: "generated" | "handwritten"
  readonly target: "./graph.ts" | "./workflow.ts"
}

export interface GeneratedRuntimeApp {
  readonly appRoot: string
  readonly artifactRoot: string
  readonly fixture: RuntimeFixtureSpec
  readonly tarballs: PackedTarballs
  readonly tempRoot: string
  readonly transcriptPath: string
}

const runtimeFixtures: Record<GeneratedRuntimeFixtureName, RuntimeFixtureSpec> = {
  basic: {
    expectedFixturePath: join(FIXTURE_ROOT, "basic-runtime.expected.json"),
    fixtureName: "basic",
    input: {
      tenant: "basic-tenant",
    },
    mode: "workflow",
    routeDir: "src/app/(public)/hello/[tenant]",
    routeId: "/hello/[tenant]",
    routePath: "src/app/(public)/hello/[tenant]/workflow.ts",
    scenarioNames: {
      inProcess: "basic in-process scenario",
      server: "basic server scenario",
    },
    source: "generated",
    target: "./workflow.ts",
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
    routePath: "src/dawn-app/support/[tenant]/graph.ts",
    scenarioNames: {
      inProcess: "custom appDir in-process scenario",
      server: "custom appDir server scenario",
    },
    source: "generated",
    target: "./graph.ts",
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
    routePath: "src/app/(public)/hello/[tenant]/graph.ts",
    scenarioNames: {
      inProcess: "handwritten in-process scenario",
      server: "handwritten server scenario",
    },
    source: "handwritten",
    target: "./graph.ts",
  },
}

export async function prepareGeneratedRuntimeApp(options: {
  readonly fixtureName: GeneratedRuntimeFixtureName
  readonly registry?: TrackedTempDir[]
  readonly tempRoot: string
}): Promise<GeneratedRuntimeApp> {
  const fixture = runtimeFixtures[options.fixtureName]
  const artifactRoot = await createArtifactRoot({
    baseDir: options.tempRoot,
    lane: fixture.fixtureName,
    runId: "generated-runtime",
  })
  const transcriptPath = join(artifactRoot, "transcripts", `${fixture.fixtureName}.log`)
  const appRoot = join(options.tempRoot, "app")

  await mkdir(dirname(transcriptPath), { recursive: true })

  try {
    const { installerDir, tarballs: packagedTarballs } = await createPackagedInstaller({
      packageNames: ["@dawn/cli", "@dawn/config-typescript", "@dawn/core", "@dawn/langgraph"],
      tempRoot: options.tempRoot,
      transcriptPath,
    })
    const tarballs = toPackedTarballs(packagedTarballs)

    if (fixture.source === "generated") {
      await scaffoldApp({ appRoot, installerDir, transcriptPath })
    } else {
      await stageFixtureApp({
        appRoot,
        fixtureRoot: HANDWRITTEN_RUNTIME_FIXTURE_ROOT,
      })
    }

    if (fixture.fixtureName === "custom-app-dir") {
      await rewriteToCustomAppDirRuntimeLayout(appRoot)
    }

    if (fixture.fixtureName !== "handwritten") {
      await writeRunScenarioFile({
        appRoot,
        fixture,
      })
    }

    await rewriteDependenciesToTarballs({ appRoot, tarballs })
    await runCommand({
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

export async function runGeneratedRuntimeScenario(
  prepared: GeneratedRuntimeApp,
): Promise<unknown> {
  const fixture = prepared.fixture

  const runJson = selectRuntimeResult(
    await runDawnRunJson({
      appRoot: prepared.appRoot,
      input: fixture.input,
      routePath: fixture.routePath,
      transcriptPath: prepared.transcriptPath,
    }),
  )

  const server = await startFakeAgentServer(async () => ({
    body: {
      greeting: `Hello, ${fixture.input.tenant}!`,
      tenant: fixture.input.tenant,
    },
    statusCode: 200,
  }))

  try {
    const runServerJson = selectRuntimeResult(
      await runDawnRunJson({
        appRoot: prepared.appRoot,
        input: fixture.input,
        routePath: fixture.routePath,
        transcriptPath: prepared.transcriptPath,
        url: server.url,
      }),
    )

    await replaceInFile(
      join(prepared.appRoot, fixture.routeDir, "run.test.ts"),
      SERVER_URL_PLACEHOLDER,
      server.url,
    )

    const testResult = await runCommand({
      args: ["exec", "dawn", "test"],
      command: "pnpm",
      cwd: prepared.appRoot,
      transcriptPath: prepared.transcriptPath,
    })

    return normalizeGeneratedRuntimeValue(
      {
        runJson,
        runServerJson,
        serverRequest: server.requests.at(-1)?.jsonBody ?? null,
        testStdout: testResult.stdout.trim(),
      },
      {
        appRoot: prepared.appRoot,
      },
    )
  } finally {
    await server.close()
  }
}

export async function readGeneratedExpectedFixture(
  fixtureName: GeneratedRuntimeFixtureName,
): Promise<unknown> {
  return JSON.parse(await readFile(runtimeFixtures[fixtureName].expectedFixturePath, "utf8"))
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

  await access(join(options.appRoot, "package.json"), constants.F_OK)
}

async function stageFixtureApp(options: {
  readonly appRoot: string
  readonly fixtureRoot: string
}): Promise<void> {
  await rm(options.appRoot, { force: true, recursive: true })
  await cp(options.fixtureRoot, options.appRoot, { recursive: true })
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
    },
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
    join(appRoot, "src/dawn-app/support/[tenant]/graph.ts"),
    [
      'import { defineEntry } from "@dawn/langgraph"',
      "",
      'import type { SupportTenantState } from "./state.js"',
      "",
      "const entry = defineEntry({",
      "  graph: async (state: SupportTenantState): Promise<SupportTenantState> => ({",
      "    ...state,",
      "    greeting: `Hello, ${state.tenant}!`,",
      "  }),",
      "})",
      "",
      "export const graph = entry.graph",
      "",
    ].join("\n"),
    "utf8",
  )
  await writeFile(
    join(appRoot, "src/dawn-app/support/[tenant]/route.ts"),
    [
      'export { graph } from "./graph.js"',
      "",
      "export const config = {",
      '  runtime: "node",',
      '  tags: ["support"],',
      "} as const",
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
  const runTestPath = join(options.appRoot, options.fixture.routeDir, "run.test.ts")

  await writeFile(
    runTestPath,
    [
      'import { expectMeta, expectOutput } from "@dawn/cli/testing"',
      "",
      "export default [",
      "  {",
      `    name: ${JSON.stringify(options.fixture.scenarioNames.inProcess)},`,
      `    target: ${JSON.stringify(options.fixture.target)},`,
      `    input: ${JSON.stringify(options.fixture.input)},`,
      "    expect: {",
      '      status: "passed",',
      `      output: ${JSON.stringify(createExpectedOutput(options.fixture))},`,
      "      meta: {",
      '        executionSource: "in-process",',
      `        mode: ${JSON.stringify(options.fixture.mode)},`,
      `        routeId: ${JSON.stringify(options.fixture.routeId)},`,
      `        routePath: ${JSON.stringify(options.fixture.routePath)},`,
      "      },",
      "    },",
      "  },",
      "  {",
      `    name: ${JSON.stringify(options.fixture.scenarioNames.server)},`,
      `    target: ${JSON.stringify(options.fixture.target)},`,
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
      `        routePath: ${JSON.stringify(options.fixture.routePath)},`,
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
    cli: tarballs["@dawn/cli"],
    configTypescript: tarballs["@dawn/config-typescript"],
    core: tarballs["@dawn/core"],
    createApp: tarballs["create-dawn-app"],
    devkit: tarballs["@dawn/devkit"],
    langgraph: tarballs["@dawn/langgraph"],
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

  const result = await runCommand({
    args,
    command: "pnpm",
    cwd: options.appRoot,
    stdin: JSON.stringify(options.input),
    transcriptPath: options.transcriptPath,
  })

  return JSON.parse(result.stdout)
}

async function runCommand(options: {
  readonly args: readonly string[]
  readonly command: string
  readonly cwd: string
  readonly stdin?: string
  readonly transcriptPath: string
}): Promise<{
  readonly exitCode: number | null
  readonly stderr: string
  readonly stdout: string
}> {
  const result = await spawnWithStdin(options)

  await appendFile(
    options.transcriptPath,
    [
      `$ (cd ${options.cwd} && ${options.command} ${options.args.join(" ")})`,
      result.stdout.trimEnd(),
      result.stderr.trimEnd(),
      `[exit ${result.exitCode}]`,
      "",
    ]
      .filter((chunk, index, chunks) => chunk.length > 0 || index === chunks.length - 1)
      .join("\n"),
    "utf8",
  )

  if (result.exitCode !== 0) {
    throw new Error(
      [`Command failed: ${options.command} ${options.args.join(" ")}`, result.stdout, result.stderr]
        .filter(Boolean)
        .join("\n"),
    )
  }

  return result
}

async function spawnWithStdin(options: {
  readonly args: readonly string[]
  readonly command: string
  readonly cwd: string
  readonly stdin?: string
}): Promise<{
  readonly exitCode: number | null
  readonly stderr: string
  readonly stdout: string
}> {
  return await new Promise((resolve, reject) => {
    const child = spawn(options.command, [...options.args], {
      cwd: options.cwd,
      env: process.env,
      stdio: ["pipe", "pipe", "pipe"],
    })

    let stdout = ""
    let stderr = ""

    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString()
    })
    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString()
    })
    child.on("error", reject)
    child.on("close", (exitCode) => {
      resolve({
        exitCode,
        stderr,
        stdout,
      })
    })

    if (typeof options.stdin !== "undefined") {
      child.stdin.end(options.stdin)
    } else {
      child.stdin.end()
    }
  })
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null
}
