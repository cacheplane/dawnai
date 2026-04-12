import { appendFile, mkdir, readFile, rm, stat, writeFile } from "node:fs/promises"
import { dirname, join, relative, resolve } from "node:path"

import { afterEach, describe, expect, test } from "vitest"

import {
  createArtifactRoot,
  createGeneratedApp,
  type HarnessLaneResult,
  type HarnessPhaseResult,
  spawnProcess,
} from "../../packages/devkit/src/testing/index.ts"
import {
  cleanupTrackedTempDirs,
  createPackagedInstaller,
  createTrackedTempDir,
  markTrackedTempDirForPreserve,
  type TrackedTempDir,
} from "../harness/packaged-app.ts"

const SMOKE_ROOT = resolve(import.meta.dirname)
const tempDirs: TrackedTempDir[] = []

type SmokeEntryKind = "graph" | "workflow"
type SmokeFixtureName = "graph-basic" | "workflow-basic"

interface SmokeOverlay {
  readonly deleteFiles?: readonly string[]
  readonly entryKind: SmokeEntryKind
  readonly files?: Readonly<Record<string, string>>
  readonly input: Record<string, unknown>
}

interface SmokeRouteDefinition {
  readonly entryFile: string
  readonly entryKind: string
  readonly id: string
  readonly pathname: string
  readonly routeDir: string
  readonly segments: readonly unknown[]
}

interface SmokeRouteManifest {
  readonly appRoot: string
  readonly routes: readonly SmokeRouteDefinition[]
}

afterEach(async () => {
  await cleanupTrackedTempDirs(tempDirs)
})

describe("runtime smoke harness", () => {
  test("boots the graph fixture and executes one canonical flow", { timeout: 180_000 }, async () => {
    const result = await runSmokeScenario("graph-basic")
    const output = await readSmokeOutput(result)

    expect(result).toMatchObject({
      failureReason: null,
      lane: "smoke",
      name: "graph-basic",
      status: "passed",
    })
    expect(result.phases.map((phase) => phase.name)).toEqual([
      "packaged-installer",
      "install",
      "discover-routes",
      "typecheck",
      "compile",
      "execute",
    ])
    expect(output).toEqual({
      greeting: "Hello, graph-tenant!",
      tenant: "graph-tenant",
    })
    await expect(stat(result.transcriptPath)).resolves.toBeDefined()
  })

  test("boots the workflow fixture and executes one canonical flow", {
    timeout: 180_000,
  }, async () => {
    const result = await runSmokeScenario("workflow-basic")
    const output = await readSmokeOutput(result)

    expect(result).toMatchObject({
      failureReason: null,
      lane: "smoke",
      name: "workflow-basic",
      status: "passed",
    })
    expect(result.phases.map((phase) => phase.name)).toEqual([
      "packaged-installer",
      "install",
      "discover-routes",
      "typecheck",
      "compile",
      "execute",
    ])
    expect(output).toEqual({
      greeting: "Hello, workflow-tenant!",
      tenant: "workflow-tenant",
    })
    await expect(stat(result.transcriptPath)).resolves.toBeDefined()
  })
})

async function runSmokeScenario(fixtureName: SmokeFixtureName): Promise<HarnessLaneResult> {
  const tempRoot = await createTrackedTempDir("dsm-", tempDirs)
  const artifactRoot = await createArtifactRoot({
    baseDir: tempRoot,
    lane: fixtureName,
    runId: "smoke",
  })
  const transcriptPath = join(artifactRoot, "transcripts", `${fixtureName}.log`)
  const phases: HarnessPhaseResult[] = []
  const artifacts: string[] = []
  const startedAt = Date.now()

  await mkdir(dirname(transcriptPath), { recursive: true })

  try {
    const overlay = await readOverlay(fixtureName)
    const { tarballs } = await recordPhase(phases, "packaged-installer", async () => {
      return await createPackagedInstaller({
        packageNames: ["@dawn/cli", "@dawn/config-typescript", "@dawn/core", "@dawn/langgraph"],
        tempRoot,
        transcriptPath,
      })
    })
    const generatedApp = await createGeneratedApp({
      appName: fixtureName,
      artifactRoot,
      specifiers: {
        dawnCli: tarballs["@dawn/cli"],
        dawnConfigTypescript: tarballs["@dawn/config-typescript"],
        dawnCore: tarballs["@dawn/core"],
        dawnLanggraph: tarballs["@dawn/langgraph"],
      },
      template: "basic",
    })

    await rewriteDependenciesToTarballs({
      appRoot: generatedApp.appRoot,
      tarballs,
    })
    await applyOverlay({ appRoot: generatedApp.appRoot, overlay })

    await recordPhase(phases, "install", async () => {
      await runCommand({
        args: ["install"],
        command: "pnpm",
        cwd: generatedApp.appRoot,
        transcriptPath,
      })
    })

    const manifestArtifactPath = join(artifactRoot, "route-manifest.json")
    const discoveredRoute = await recordPhase(phases, "discover-routes", async () => {
      const manifest = await discoverRoutes({
        appRoot: generatedApp.appRoot,
        expectedEntryKind: overlay.entryKind,
        transcriptPath,
      })
      await writeJsonArtifact(manifestArtifactPath, manifest)
      artifacts.push(manifestArtifactPath)
      return selectExecutableRoute(manifest, overlay.entryKind)
    })

    await recordPhase(phases, "typecheck", async () => {
      await runCommand({
        args: ["typecheck"],
        command: "pnpm",
        cwd: generatedApp.appRoot,
        transcriptPath,
      })
    })

    const compiledEntryPath = await recordPhase(phases, "compile", async () => {
      return await compileDiscoveredRoute({
        appRoot: generatedApp.appRoot,
        entryFile: discoveredRoute.entryFile,
        transcriptPath,
      })
    })

    const outputArtifactPath = join(artifactRoot, "canonical-output.json")
    await recordPhase(phases, "execute", async () => {
      const output = await executeCanonicalFlow({
        appRoot: generatedApp.appRoot,
        compiledEntryPath,
        input: overlay.input,
        transcriptPath,
        expectedKind: overlay.entryKind,
      })

      await writeJsonArtifact(outputArtifactPath, output)
      artifacts.push(outputArtifactPath)
    })

    return {
      artifacts,
      durationMs: Date.now() - startedAt,
      failureReason: null,
      lane: "smoke",
      name: fixtureName,
      phases,
      status: "passed",
      transcriptPath,
    }
  } catch (error) {
    markTrackedTempDirForPreserve(tempDirs, tempRoot)
    const message = error instanceof Error ? error.message : String(error)

    throw new Error(
      [
        message,
        `Preserved smoke artifacts at ${artifactRoot}`,
        `Transcript: ${transcriptPath}`,
      ].join("\n"),
    )
  }
}

async function readOverlay(fixtureName: SmokeFixtureName): Promise<SmokeOverlay> {
  return JSON.parse(
    await readFile(join(SMOKE_ROOT, `${fixtureName}.overlay.json`), "utf8"),
  ) as SmokeOverlay
}

async function applyOverlay(options: {
  readonly appRoot: string
  readonly overlay: SmokeOverlay
}): Promise<void> {
  await Promise.all(
    (options.overlay.deleteFiles ?? []).map(async (relativePath) =>
      rm(join(options.appRoot, relativePath), { force: true }),
    ),
  )

  await Promise.all(
    Object.entries(options.overlay.files ?? {}).map(async ([relativePath, source]) => {
      const outputPath = join(options.appRoot, relativePath)
      await mkdir(dirname(outputPath), { recursive: true })
      await writeFile(outputPath, source, "utf8")
    }),
  )
}

async function rewriteDependenciesToTarballs(options: {
  readonly appRoot: string
  readonly tarballs: Readonly<Record<string, string>>
}): Promise<void> {
  const packageJsonPath = join(options.appRoot, "package.json")
  const packageJson = JSON.parse(await readFile(packageJsonPath, "utf8")) as {
    dependencies?: Record<string, string>
    devDependencies?: Record<string, string>
    pnpm?: {
      overrides?: Record<string, string>
    }
  }

  packageJson.dependencies = {
    ...packageJson.dependencies,
    "@dawn/cli": options.tarballs["@dawn/cli"],
    "@dawn/core": options.tarballs["@dawn/core"],
    "@dawn/langgraph": options.tarballs["@dawn/langgraph"],
  }
  packageJson.devDependencies = {
    ...packageJson.devDependencies,
    "@dawn/config-typescript": options.tarballs["@dawn/config-typescript"],
  }
  packageJson.pnpm = {
    ...(packageJson.pnpm ?? {}),
    overrides: {
      ...(packageJson.pnpm?.overrides ?? {}),
      "@dawn/cli": options.tarballs["@dawn/cli"],
      "@dawn/config-typescript": options.tarballs["@dawn/config-typescript"],
      "@dawn/core": options.tarballs["@dawn/core"],
      "@dawn/langgraph": options.tarballs["@dawn/langgraph"],
    },
  }

  await writeFile(packageJsonPath, `${JSON.stringify(packageJson, null, 2)}\n`, "utf8")
}

async function discoverRoutes(options: {
  readonly appRoot: string
  readonly expectedEntryKind: SmokeEntryKind
  readonly transcriptPath: string
}): Promise<SmokeRouteManifest> {
  const result = await runCommand({
    args: ["exec", "dawn", "routes", "--json"],
    command: "pnpm",
    cwd: options.appRoot,
    transcriptPath: options.transcriptPath,
  })
  const manifest = JSON.parse(result.stdout) as SmokeRouteManifest
  const matchingRoutes = manifest.routes.filter((route) => route.entryKind === options.expectedEntryKind)

  if (matchingRoutes.length !== 1) {
    throw new Error(
      `Expected exactly one ${options.expectedEntryKind} route, found ${matchingRoutes.length}`,
    )
  }

  return manifest
}

function selectExecutableRoute(
  manifest: SmokeRouteManifest,
  expectedEntryKind: SmokeEntryKind,
): SmokeRouteDefinition {
  const route = manifest.routes.find((candidate) => candidate.entryKind === expectedEntryKind)

  if (!route) {
    throw new Error(`Could not find discovered ${expectedEntryKind} route`)
  }

  return route
}

async function compileDiscoveredRoute(options: {
  readonly appRoot: string
  readonly entryFile: string
  readonly transcriptPath: string
}): Promise<string> {
  const buildDir = join(options.appRoot, ".dawn-smoke-dist")

  await rm(buildDir, { force: true, recursive: true })
  await runCommand({
    args: ["exec", "tsc", "-p", "tsconfig.json", "--outDir", ".dawn-smoke-dist", "--noEmit", "false"],
    command: "pnpm",
    cwd: options.appRoot,
    transcriptPath: options.transcriptPath,
  })

  const normalizedAppRoot = normalizePrivatePath(options.appRoot)
  const normalizedEntryFile = normalizePrivatePath(options.entryFile)
  const relativeEntryPath = relative(normalizedAppRoot, normalizedEntryFile)
  const compiledEntryPath = join(buildDir, relativeEntryPath).replace(/\.ts$/u, ".js")
  await stat(compiledEntryPath)

  return compiledEntryPath
}

async function executeCanonicalFlow(options: {
  readonly appRoot: string
  readonly compiledEntryPath: string
  readonly expectedKind: SmokeEntryKind
  readonly input: Record<string, unknown>
  readonly transcriptPath: string
}): Promise<unknown> {
  const runnerPath = join(options.appRoot, ".dawn-smoke-runner.mjs")

  await writeFile(
    runnerPath,
    [
      'import { resolve } from "node:path";',
      'import { pathToFileURL } from "node:url";',
      'import { normalizeRouteModule } from "@dawn/langgraph";',
      "",
      "const [compiledEntryArg, expectedKindArg, inputArg] = process.argv.slice(2);",
      "",
      "if (!compiledEntryArg || !expectedKindArg || !inputArg) {",
      '  throw new Error("Expected compiled entry path, expected kind, and JSON input");',
      "}",
      "",
      "const routeModule = await import(pathToFileURL(resolve(compiledEntryArg)).href);",
      "const normalized = normalizeRouteModule(routeModule);",
      "const input = JSON.parse(inputArg);",
      "",
      "if (normalized.kind !== expectedKindArg) {",
      '  throw new Error(`Expected ${expectedKindArg} entry but received ${normalized.kind}`);',
      "}",
      "",
      "let output;",
      "",
      "if (normalized.kind === \"workflow\") {",
      "  output = await normalized.entry(input);",
      "} else if (typeof normalized.entry === \"function\") {",
      "  output = await normalized.entry(input);",
      "} else if (normalized.entry && typeof normalized.entry.invoke === \"function\") {",
      "  output = await normalized.entry.invoke(input);",
      "} else {",
      '  throw new Error("Graph entry must be a function or expose invoke(input)");',
      "}",
      "",
      "process.stdout.write(JSON.stringify(output));",
      "",
    ].join("\n"),
    "utf8",
  )

  const runnerResult = await runCommand({
    args: [runnerPath, options.compiledEntryPath, options.expectedKind, JSON.stringify(options.input)],
    command: "node",
    cwd: options.appRoot,
    transcriptPath: options.transcriptPath,
  })

  return JSON.parse(runnerResult.stdout)
}

async function recordPhase<T>(
  phases: HarnessPhaseResult[],
  name: string,
  action: () => Promise<T>,
): Promise<T> {
  const startedAt = Date.now()

  try {
    const result = await action()
    phases.push({
      durationMs: Date.now() - startedAt,
      name,
      status: "passed",
    })
    return result
  } catch (error) {
    phases.push({
      durationMs: Date.now() - startedAt,
      name,
      status: "failed",
    })
    throw error
  }
}

async function readSmokeOutput(result: HarnessLaneResult): Promise<unknown> {
  const outputArtifactPath = result.artifacts.find((artifactPath) =>
    artifactPath.endsWith("/canonical-output.json"),
  )

  expect(outputArtifactPath).toBeDefined()

  return JSON.parse(await readFile(outputArtifactPath!, "utf8"))
}

async function writeJsonArtifact(path: string, value: unknown): Promise<void> {
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, "utf8")
}

function normalizePrivatePath(path: string): string {
  return path.startsWith("/private/") ? path.slice("/private".length) : path
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
