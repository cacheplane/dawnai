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

type SmokeRouteKind = "graph" | "workflow"
type SmokeFixtureName = "graph-basic" | "workflow-basic"

interface SmokeOverlay {
  readonly deleteFiles?: readonly string[]
  readonly files?: Readonly<Record<string, string>>
  readonly input: Record<string, unknown>
  readonly kind: SmokeRouteKind
}

interface SmokeRouteDefinition {
  readonly entryFile: string
  readonly id: string
  readonly kind: SmokeRouteKind
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
  test("boots the graph fixture and executes one canonical flow", {
    timeout: 180_000,
  }, async () => {
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
        packageNames: [
          "@dawn-ai/cli",
          "@dawn-ai/config-typescript",
          "@dawn-ai/core",
          "@dawn-ai/langchain",
          "@dawn-ai/langgraph",
          "@dawn-ai/sdk",
        ],
        tempRoot,
        transcriptPath,
      })
    })
    const generatedApp = await createGeneratedApp({
      appName: fixtureName,
      artifactRoot,
      specifiers: {
        dawnCli: tarballs["@dawn-ai/cli"],
        dawnConfigTypescript: tarballs["@dawn-ai/config-typescript"],
        dawnCore: tarballs["@dawn-ai/core"],
        dawnLanggraph: tarballs["@dawn-ai/langgraph"],
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
        expectedKind: overlay.kind,
        transcriptPath,
      })
      await writeJsonArtifact(manifestArtifactPath, manifest)
      artifacts.push(manifestArtifactPath)
      return selectExecutableRoute(manifest, overlay.kind)
    })

    await recordPhase(phases, "typecheck", async () => {
      await runCommand({
        args: ["typecheck"],
        command: "pnpm",
        cwd: generatedApp.appRoot,
        transcriptPath,
      })
    })

    await recordPhase(phases, "compile", async () => {
      await compileDiscoveredRoute({
        appRoot: generatedApp.appRoot,
        entryFile: discoveredRoute.entryFile,
        transcriptPath,
      })
    })

    const outputArtifactPath = join(artifactRoot, "canonical-output.json")
    await recordPhase(phases, "execute", async () => {
      const output = await executeCanonicalFlow({
        appRoot: generatedApp.appRoot,
        input: overlay.input,
        pathname: discoveredRoute.pathname,
        transcriptPath,
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
    "@dawn-ai/cli": options.tarballs["@dawn-ai/cli"],
    "@dawn-ai/core": options.tarballs["@dawn-ai/core"],
    "@dawn-ai/langgraph": options.tarballs["@dawn-ai/langgraph"],
  }
  packageJson.devDependencies = {
    ...packageJson.devDependencies,
    "@dawn-ai/config-typescript": options.tarballs["@dawn-ai/config-typescript"],
  }
  packageJson.pnpm = {
    ...(packageJson.pnpm ?? {}),
    overrides: {
      ...(packageJson.pnpm?.overrides ?? {}),
      "@dawn-ai/cli": options.tarballs["@dawn-ai/cli"],
      "@dawn-ai/config-typescript": options.tarballs["@dawn-ai/config-typescript"],
      "@dawn-ai/core": options.tarballs["@dawn-ai/core"],
      "@dawn-ai/langchain": options.tarballs["@dawn-ai/langchain"],
      "@dawn-ai/langgraph": options.tarballs["@dawn-ai/langgraph"],
      "@dawn-ai/sdk": options.tarballs["@dawn-ai/sdk"],
    },
  }

  await writeFile(packageJsonPath, `${JSON.stringify(packageJson, null, 2)}\n`, "utf8")
}

async function discoverRoutes(options: {
  readonly appRoot: string
  readonly expectedKind: SmokeRouteKind
  readonly transcriptPath: string
}): Promise<SmokeRouteManifest> {
  const result = await runCommand({
    args: ["exec", "dawn", "routes", "--json"],
    command: "pnpm",
    cwd: options.appRoot,
    transcriptPath: options.transcriptPath,
  })
  const manifest = JSON.parse(result.stdout) as SmokeRouteManifest
  const matchingRoutes = manifest.routes.filter((route) => route.kind === options.expectedKind)

  if (matchingRoutes.length !== 1) {
    throw new Error(
      `Expected exactly one ${options.expectedKind} route, found ${matchingRoutes.length}`,
    )
  }

  return manifest
}

function selectExecutableRoute(
  manifest: SmokeRouteManifest,
  expectedKind: SmokeRouteKind,
): SmokeRouteDefinition {
  const route = manifest.routes.find((candidate) => candidate.kind === expectedKind)

  if (!route) {
    throw new Error(`Could not find discovered ${expectedKind} route`)
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
    args: [
      "exec",
      "tsc",
      "-p",
      "tsconfig.json",
      "--outDir",
      ".dawn-smoke-dist",
      "--noEmit",
      "false",
    ],
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
  readonly input: Record<string, unknown>
  readonly pathname: string
  readonly transcriptPath: string
}): Promise<unknown> {
  const runnerResult = await runCommand({
    args: ["exec", "dawn", "run", options.pathname],
    command: "pnpm",
    cwd: options.appRoot,
    stdin: JSON.stringify(options.input),
    transcriptPath: options.transcriptPath,
  })
  const payload = JSON.parse(runnerResult.stdout) as { readonly output: unknown }

  return payload.output
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
  readonly stdin?: string
  readonly transcriptPath: string
}) {
  const result = await spawnProcess({
    args: options.args,
    command: options.command,
    cwd: options.cwd,
    ...(typeof options.stdin === "string" ? { stdin: options.stdin } : {}),
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
