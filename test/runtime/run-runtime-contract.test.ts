import { spawn } from "node:child_process"
import { appendFile, mkdir, readFile, rm, writeFile } from "node:fs/promises"
import { dirname, join, resolve } from "node:path"

import { afterEach, describe, expect, test } from "vitest"

import { executeRoute } from "../../packages/cli/src/lib/runtime/execute-route.ts"
import type {
  RuntimeExecutionErrorKind,
  RuntimeExecutionMode,
  RuntimeExecutionResult,
} from "../../packages/cli/src/lib/runtime/result.ts"
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

const RUNTIME_ROOT = resolve(import.meta.dirname)
const tempDirs: TrackedTempDir[] = []

type RuntimeFixtureName = "graph-basic" | "graph-failure" | "workflow-basic" | "workflow-failure"

interface RuntimeOverlay {
  readonly deleteFiles?: readonly string[]
  readonly files?: Readonly<Record<string, string>>
  readonly input: Record<string, unknown>
  readonly routeFile: string
  readonly expected: {
    readonly error?: {
      readonly kind: RouteExecutionErrorKind
      readonly message?: string
    }
    readonly mode?: RouteExecutionMode
    readonly output?: unknown
    readonly status: "failed" | "passed"
  }
}

afterEach(async () => {
  await cleanupTrackedTempDirs(tempDirs)
})

describe("runtime contract harness", () => {
  test("executes passing graph fixture through direct runtime primitive", { timeout: 180_000 }, async () => {
    const result = await runRuntimeScenario("graph-basic")

    expect(result).toMatchObject({
      failureReason: null,
      lane: "runtime",
      name: "graph-basic",
      status: "passed",
    })
    expect(result.phases.map((phase) => phase.name)).toEqual([
      "packaged-installer",
      "install",
      "execute-direct",
      "execute-cli",
    ])
  })

  test("executes failing graph fixture through direct runtime primitive", {
    timeout: 180_000,
  }, async () => {
    const result = await runRuntimeScenario("graph-failure")

    expect(result).toMatchObject({
      failureReason: null,
      lane: "runtime",
      name: "graph-failure",
      status: "passed",
    })
    expect(result.phases.map((phase) => phase.name)).toEqual([
      "packaged-installer",
      "install",
      "execute-direct",
      "execute-cli",
    ])
  })

  test("executes passing workflow fixture through direct runtime primitive", {
    timeout: 180_000,
  }, async () => {
    const result = await runRuntimeScenario("workflow-basic")

    expect(result).toMatchObject({
      failureReason: null,
      lane: "runtime",
      name: "workflow-basic",
      status: "passed",
    })
    expect(result.phases.map((phase) => phase.name)).toEqual([
      "packaged-installer",
      "install",
      "execute-direct",
      "execute-cli",
    ])
  })

  test("executes failing workflow fixture through direct runtime primitive", {
    timeout: 180_000,
  }, async () => {
    const result = await runRuntimeScenario("workflow-failure")

    expect(result).toMatchObject({
      failureReason: null,
      lane: "runtime",
      name: "workflow-failure",
      status: "passed",
    })
    expect(result.phases.map((phase) => phase.name)).toEqual([
      "packaged-installer",
      "install",
      "execute-direct",
      "execute-cli",
    ])
  })
})

async function runRuntimeScenario(fixtureName: RuntimeFixtureName): Promise<HarnessLaneResult> {
  const tempRoot = await createTrackedTempDir("drt-", tempDirs)
  const artifactRoot = await createArtifactRoot({
    baseDir: tempRoot,
    lane: fixtureName,
    runId: "runtime",
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

    const directOutputArtifactPath = join(artifactRoot, "direct-execution-result.json")
    await recordPhase(phases, "execute-direct", async () => {
      const execution = await executeRoute({
        cwd: generatedApp.appRoot,
        input: overlay.input,
        routeFile: overlay.routeFile,
      })

      assertExecutionMatchesOverlay(execution, overlay)
      await writeJsonArtifact(directOutputArtifactPath, execution)
      artifacts.push(directOutputArtifactPath)
    })

    const cliOutputArtifactPath = join(artifactRoot, "cli-execution-result.json")
    await recordPhase(phases, "execute-cli", async () => {
      const execution = await runCliExecution({
        appRoot: generatedApp.appRoot,
        input: overlay.input,
        routePath: overlay.routeFile,
        transcriptPath,
      })

      assertCliExecutionMatchesOverlay(execution, overlay, generatedApp.appRoot)
      await writeJsonArtifact(cliOutputArtifactPath, execution)
      artifacts.push(cliOutputArtifactPath)
    })

    return {
      artifacts,
      durationMs: Date.now() - startedAt,
      failureReason: null,
      lane: "runtime",
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
        `Preserved runtime artifacts at ${artifactRoot}`,
        `Transcript: ${transcriptPath}`,
      ].join("\n"),
    )
  }
}

function assertExecutionMatchesOverlay(execution: RuntimeExecutionResult, overlay: RuntimeOverlay): void {
  expect(execution.status).toBe(overlay.expected.status)
  expect(execution.executionSource).toBe("in-process")
  expect(execution.startedAt).toEqual(expect.any(String))
  expect(execution.finishedAt).toEqual(expect.any(String))
  expect(execution.durationMs).toEqual(expect.any(Number))

  if (overlay.expected.status === "passed") {
    expect(execution).toMatchObject({
      appRoot: expect.any(String),
      mode: overlay.expected.mode,
      output: overlay.expected.output,
      routeId: expectedRouteId(overlay.routeFile),
      routePath: overlay.routeFile,
      status: "passed",
    } satisfies Partial<RuntimeExecutionResult>)
    return
  }

  expect(execution).toMatchObject({
    appRoot: expect.any(String),
    error: {
      kind: overlay.expected.error?.kind,
    },
    mode: overlay.expected.mode,
    routeId: expectedRouteId(overlay.routeFile),
    routePath: overlay.routeFile,
    status: "failed",
  } satisfies Partial<RuntimeExecutionResult>)

  if (overlay.expected.error?.message) {
    expect(execution.error.message).toBe(overlay.expected.error.message)
  }
}

function assertCliExecutionMatchesOverlay(
  execution: {
    readonly appRoot: string | null
    readonly error?: {
      readonly kind: RuntimeExecutionErrorKind
      readonly message: string
    }
    readonly mode: RuntimeExecutionMode | null
    readonly output?: unknown
    readonly routePath: string
    readonly status: "failed" | "passed"
  },
  overlay: RuntimeOverlay,
  appRoot: string,
): void {
  expect(normalizePrivatePath(execution.appRoot ?? "")).toBe(normalizePrivatePath(appRoot))
  expect(execution.routePath).toBe(overlay.routeFile)
  expect(execution.routeId).toBe(expectedRouteId(overlay.routeFile))
  expect(execution.executionSource).toBe("in-process")
  expect(execution.startedAt).toEqual(expect.any(String))
  expect(execution.finishedAt).toEqual(expect.any(String))
  expect(execution.durationMs).toEqual(expect.any(Number))
  expect(execution.status).toBe(overlay.expected.status)

  if (overlay.expected.status === "passed") {
    expect(execution).toMatchObject({
      mode: overlay.expected.mode,
      output: overlay.expected.output,
      status: "passed",
    })
    return
  }

  expect(execution).toMatchObject({
    error: {
      kind: overlay.expected.error?.kind,
    },
    mode: overlay.expected.mode,
    status: "failed",
  })

  if (overlay.expected.error?.message) {
    expect(execution.error?.message).toBe(overlay.expected.error.message)
  }
}

async function readOverlay(fixtureName: RuntimeFixtureName): Promise<RuntimeOverlay> {
  return JSON.parse(
    await readFile(join(RUNTIME_ROOT, "fixtures", `${fixtureName}.overlay.json`), "utf8"),
  ) as RuntimeOverlay
}

async function applyOverlay(options: {
  readonly appRoot: string
  readonly overlay: RuntimeOverlay
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

async function writeJsonArtifact(path: string, value: unknown): Promise<void> {
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, "utf8")
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

async function runCliExecution(options: {
  readonly appRoot: string
  readonly input: Record<string, unknown>
  readonly routePath: string
  readonly transcriptPath: string
}) {
  const result = await runCommandWithInput({
    args: ["exec", "dawn", "run", options.routePath],
    command: "pnpm",
    cwd: options.appRoot,
    stdin: JSON.stringify(options.input),
    transcriptPath: options.transcriptPath,
  })

  if (result.exitCode !== 0 && result.exitCode !== 1) {
    throw new Error(`dawn run exited with unexpected code ${result.exitCode}`)
  }

  if (result.stderr.trim().length > 0) {
    throw new Error(`dawn run wrote to stderr: ${result.stderr.trim()}`)
  }

  return JSON.parse(result.stdout) as {
    readonly appRoot: string | null
    readonly error?: {
      readonly kind: RuntimeExecutionErrorKind
      readonly message: string
    }
    readonly mode: RuntimeExecutionMode | null
    readonly output?: unknown
    readonly routePath: string
    readonly status: "failed" | "passed"
  }
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

async function runCommandWithInput(options: {
  readonly args: readonly string[]
  readonly command: string
  readonly cwd: string
  readonly stdin: string
  readonly transcriptPath: string
}) {
  const result = await new Promise<{
    readonly args: readonly string[]
    readonly command: string
    readonly cwd: string
    readonly exitCode: number | null
    readonly ok: boolean
    readonly stderr: string
    readonly stdout: string
  }>((resolvePromise, rejectPromise) => {
    const child = spawn(options.command, [...options.args], {
      cwd: options.cwd,
      stdio: ["pipe", "pipe", "pipe"],
    })

    let stdout = ""
    let stderr = ""

    child.stdout.on("data", (chunk) => {
      stdout += String(chunk)
    })
    child.stderr.on("data", (chunk) => {
      stderr += String(chunk)
    })

    child.once("error", rejectPromise)
    child.once("close", (exitCode) => {
      resolvePromise({
        args: options.args,
        command: options.command,
        cwd: options.cwd,
        exitCode,
        ok: exitCode === 0,
        stderr,
        stdout,
      })
    })

    child.stdin.write(options.stdin)
    child.stdin.end()
  })

  await appendTranscript(options.transcriptPath, result)

  return result
}

function normalizePrivatePath(path: string): string {
  return path.replaceAll("/private/var/", "/var/")
}

function expectedRouteId(routeFile: string): string {
  return `/${routeFile.split("/").slice(2, -1).join("/")}`
}
