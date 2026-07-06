import { spawn } from "node:child_process"
import { appendFile, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { basename, join, resolve } from "node:path"

import { spawnProcess } from "../../packages/devkit/src/testing/index.ts"
import {
  appendDevServerTranscript,
  type DevServerHandle,
  startDevServer,
} from "../runtime/support/dev-server.ts"
import { getTestRegistryUrl } from "./local-registry.ts"

const REPO_ROOT = resolve(import.meta.dirname, "../..")

export interface TrackedTempDir {
  path: string
  preserve: boolean
}

export interface PackagedDevServerSession {
  readonly devServer: DevServerHandle
  readonly url: string
}

export async function createTrackedTempDir(
  prefix: string,
  registry: TrackedTempDir[],
): Promise<string> {
  const path = await mkdtemp(join(tmpdir(), prefix))
  registry.push({ path, preserve: false })
  return path
}

export function markTrackedTempDirForPreserve(registry: TrackedTempDir[], path: string): void {
  const tracked = registry.find((entry) => entry.path === path)

  if (tracked) {
    tracked.preserve = true
  }
}

export async function cleanupTrackedTempDirs(registry: TrackedTempDir[]): Promise<void> {
  const tracked = registry.splice(0)

  await Promise.all(
    tracked
      .filter((entry) => !entry.preserve)
      // maxRetries handles the ENOTEMPTY race where a just-killed dev server's
      // child flushes a SQLite WAL file into .dawn/ between readdir and rmdir.
      .map((entry) =>
        rm(entry.path, { force: true, maxRetries: 5, recursive: true, retryDelay: 100 }),
      ),
  )
}

/**
 * Pack the CURRENT create-dawn-ai-app source and install it into a temp installer
 * dir, returning that dir. Lets a standalone test run `pnpm exec create-dawn-ai-app`
 * with the local build (not the published npmjs version).
 *
 * The scaffolder declares `@dawn-ai/devkit` as a runtime dep. Pack and override
 * the current local devkit too so tests exercise the templates in this checkout
 * instead of whatever candidate package the ephemeral registry last published.
 * Requires the registry globalSetup to have run (DAWN_TEST_REGISTRY_URL set);
 * getTestRegistryUrl() throws otherwise.
 */
export async function installPackagedScaffolder(
  tempRoot: string,
): Promise<{ installerDir: string }> {
  const packsDir = join(tempRoot, "packs")
  const installerDir = join(tempRoot, "installer")

  await mkdir(packsDir, { recursive: true })
  await mkdir(installerDir, { recursive: true })

  const devkitTarballPath = await packCurrentPackage("@dawn-ai/devkit", packsDir)
  const scaffolderTarballPath = await packCurrentPackage("create-dawn-ai-app", packsDir)

  await writeFile(
    join(installerDir, "package.json"),
    `${JSON.stringify({ name: "installer", private: true }, null, 2)}\n`,
    "utf8",
  )
  await writeFile(
    join(installerDir, "pnpm-workspace.yaml"),
    [
      "packages:",
      "  - .",
      "",
      "onlyBuiltDependencies:",
      "  - esbuild",
      "",
      "allowBuilds:",
      "  esbuild: true",
      "",
      "overrides:",
      `  "@dawn-ai/devkit": ${JSON.stringify(`file:${devkitTarballPath}`)}`,
      "",
    ].join("\n"),
    "utf8",
  )

  await runPackagedCommand({
    args: ["add", devkitTarballPath, scaffolderTarballPath],
    command: "pnpm",
    cwd: installerDir,
    env: { npm_config_registry: getTestRegistryUrl() },
  })

  return { installerDir }
}

async function packCurrentPackage(packageName: string, packsDir: string): Promise<string> {
  await runPackagedCommand({
    args: ["--filter", packageName, "build"],
    command: "pnpm",
    cwd: REPO_ROOT,
  })

  const packResult = await runPackagedCommand({
    args: ["--filter", packageName, "pack", "--pack-destination", packsDir],
    command: "pnpm",
    cwd: REPO_ROOT,
  })

  const tarballName = packResult.stdout
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .find((line) => line.endsWith(".tgz"))

  if (!tarballName) {
    throw new Error(
      `Could not determine tarball name for ${packageName} from pnpm pack stdout:\n${packResult.stdout}`,
    )
  }

  return join(packsDir, basename(tarballName))
}

export async function runPackagedCommand(options: {
  readonly args: readonly string[]
  readonly command: string
  readonly cwd: string
  readonly env?: NodeJS.ProcessEnv
  readonly stdin?: string
  readonly transcriptPath?: string
}) {
  const result =
    typeof options.stdin === "undefined"
      ? await spawnProcess({
          args: options.args,
          command: options.command,
          cwd: options.cwd,
          env: {
            // Suppress Node.js experimental-feature warnings (e.g. node:sqlite)
            // so the harness does not treat non-empty stderr as a failure.
            NODE_NO_WARNINGS: "1",
            ...options.env,
          },
        })
      : await spawnWithStdin(options)

  if (options.transcriptPath) {
    await appendFile(
      options.transcriptPath,
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

  if (!result.ok) {
    throw new Error(
      [`Command failed: ${options.command} ${options.args.join(" ")}`, result.stdout, result.stderr]
        .filter(Boolean)
        .join("\n"),
    )
  }

  return result
}

export async function withPackagedDevServer<T>(
  options: {
    readonly appRoot: string
    readonly env?: Readonly<Record<string, string>>
    readonly port?: number
    readonly transcriptPath: string
  },
  action: (session: PackagedDevServerSession) => Promise<T>,
): Promise<T> {
  const devServer = await startDevServer({
    cwd: options.appRoot,
    env: options.env,
    port: options.port,
  })

  try {
    const url = await devServer.waitForReady()

    return await action({
      devServer,
      url,
    })
  } finally {
    await devServer.stop()
    await appendDevServerTranscript(options.transcriptPath, devServer)
  }
}

async function spawnWithStdin(options: {
  readonly args: readonly string[]
  readonly command: string
  readonly cwd: string
  readonly stdin: string
}): Promise<{
  readonly args: readonly string[]
  readonly command: string
  readonly cwd: string
  readonly exitCode: number | null
  readonly ok: boolean
  readonly stderr: string
  readonly stdout: string
}> {
  return await new Promise((resolve, reject) => {
    const child = spawn(options.command, [...options.args], {
      cwd: options.cwd,
      env: {
        ...process.env,
        // Suppress Node.js experimental-feature warnings (e.g. node:sqlite)
        // so the harness does not treat non-empty stderr as a failure.
        NODE_NO_WARNINGS: "1",
      },
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
    child.on("error", reject)
    child.on("close", (exitCode) => {
      resolve({
        args: options.args,
        command: options.command,
        cwd: options.cwd,
        exitCode,
        ok: exitCode === 0,
        stderr,
        stdout,
      })
    })

    child.stdin.end(options.stdin)
  })
}
