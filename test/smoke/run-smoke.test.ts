import { appendFile, mkdir, readFile, rm, stat, writeFile } from "node:fs/promises"
import { dirname, join, resolve } from "node:path"

import { afterEach, describe, expect, test } from "vitest"

import {
  createArtifactRoot,
  createGeneratedApp,
  spawnProcess,
} from "../../packages/devkit/src/testing/index.ts"
import {
  cleanupTrackedTempDirs,
  createPackagedInstaller,
  createTrackedTempDir,
  markTrackedTempDirForPreserve,
  type TrackedTempDir,
} from "../generated/harness.ts"

const SMOKE_ROOT = resolve(import.meta.dirname)
const tempDirs: TrackedTempDir[] = []

type SmokeEntryKind = "graph" | "workflow"
type SmokeFixtureName = "graph-basic" | "workflow-basic"

interface SmokeOverlay {
  readonly deleteFiles?: readonly string[]
  readonly entryKind: SmokeEntryKind
  readonly entryModule: string
  readonly files?: Readonly<Record<string, string>>
  readonly input: Record<string, unknown>
}

interface SmokeScenarioResult {
  readonly artifactRoot: string
  readonly fixtureName: SmokeFixtureName
  readonly output: unknown
  readonly status: "passed"
  readonly transcriptPath: string
}

afterEach(async () => {
  await cleanupTrackedTempDirs(tempDirs)
})

describe("runtime smoke harness", () => {
  test("boots the graph fixture and executes one canonical flow", { timeout: 180_000 }, async () => {
    const result = await runSmokeScenario("graph-basic")

    expect(result).toMatchObject({
      fixtureName: "graph-basic",
      status: "passed",
    })
    expect(result.output).toEqual({
      greeting: "Hello, graph-tenant!",
      tenant: "graph-tenant",
    })
    await expect(stat(result.transcriptPath)).resolves.toBeDefined()
  })

  test("boots the workflow fixture and executes one canonical flow", {
    timeout: 180_000,
  }, async () => {
    const result = await runSmokeScenario("workflow-basic")

    expect(result).toMatchObject({
      fixtureName: "workflow-basic",
      status: "passed",
    })
    expect(result.output).toEqual({
      greeting: "Hello, workflow-tenant!",
      tenant: "workflow-tenant",
    })
    await expect(stat(result.transcriptPath)).resolves.toBeDefined()
  })
})

async function runSmokeScenario(fixtureName: SmokeFixtureName): Promise<SmokeScenarioResult> {
  const tempRoot = await createTrackedTempDir("dsm-", tempDirs)
  const artifactRoot = await createArtifactRoot({
    baseDir: tempRoot,
    lane: fixtureName,
    runId: "smoke",
  })
  const transcriptPath = join(artifactRoot, "transcripts", `${fixtureName}.log`)

  await mkdir(dirname(transcriptPath), { recursive: true })

  try {
    const overlay = await readOverlay(fixtureName)
    const { tarballs } = await createPackagedInstaller({
      packageNames: ["@dawn/cli", "@dawn/config-typescript", "@dawn/core", "@dawn/langgraph"],
      tempRoot,
      transcriptPath,
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
    await installAndPrepareApp({
      appRoot: generatedApp.appRoot,
      transcriptPath,
    })

    const output = await executeCanonicalFlow({
      appRoot: generatedApp.appRoot,
      overlay,
      transcriptPath,
    })

    return {
      artifactRoot,
      fixtureName,
      output,
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

async function installAndPrepareApp(options: {
  readonly appRoot: string
  readonly transcriptPath: string
}): Promise<void> {
  await runCommand({
    args: ["install"],
    command: "pnpm",
    cwd: options.appRoot,
    transcriptPath: options.transcriptPath,
  })
  await runCommand({
    args: ["exec", "dawn", "verify", "--json"],
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
}

async function executeCanonicalFlow(options: {
  readonly appRoot: string
  readonly overlay: SmokeOverlay
  readonly transcriptPath: string
}): Promise<unknown> {
  const buildDir = join(options.appRoot, ".dawn-smoke-dist")
  const runnerPath = join(options.appRoot, ".dawn-smoke-runner.mjs")

  await rm(buildDir, { force: true, recursive: true })
  await runCommand({
    args: ["exec", "tsc", "-p", "tsconfig.json", "--outDir", ".dawn-smoke-dist", "--noEmit", "false"],
    command: "pnpm",
    cwd: options.appRoot,
    transcriptPath: options.transcriptPath,
  })

  const compiledEntryPath = join(
    buildDir,
    options.overlay.entryModule.replace(/\.ts$/u, ".js"),
  )
  await expect(stat(compiledEntryPath)).resolves.toBeDefined()

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
      "process.stdout.write(JSON.stringify({ kind: normalized.kind, output }));",
      "",
    ].join("\n"),
    "utf8",
  )

  const runnerResult = await runCommand({
    args: [runnerPath, compiledEntryPath, options.overlay.entryKind, JSON.stringify(options.overlay.input)],
    command: "node",
    cwd: options.appRoot,
    transcriptPath: options.transcriptPath,
  })
  const parsed = JSON.parse(runnerResult.stdout) as {
    readonly kind: SmokeEntryKind
    readonly output: unknown
  }

  expect(parsed.kind).toBe(options.overlay.entryKind)

  return parsed.output
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
