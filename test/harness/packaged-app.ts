import { spawn } from "node:child_process"
import { appendFile, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { basename, join, resolve } from "node:path"

import { spawnProcess } from "../../packages/devkit/src/testing/index.ts"
import {
  appendDevServerTranscript,
  startDevServer,
  type DevServerHandle,
} from "../runtime/support/dev-server.ts"

const REPO_ROOT = resolve(import.meta.dirname, "../..")

export interface TrackedTempDir {
  path: string
  preserve: boolean
}

export interface CreatePackagedInstallerOptions {
  readonly packageNames?: readonly string[]
  readonly tempRoot: string
  readonly transcriptPath?: string
}

export interface CreatePackagedInstallerResult {
  readonly installerDir: string
  readonly packsDir: string
  readonly tarballs: Readonly<Record<string, string>>
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
      .map((entry) => rm(entry.path, { force: true, recursive: true })),
  )
}

export async function createPackagedInstaller(
  options: CreatePackagedInstallerOptions,
): Promise<CreatePackagedInstallerResult> {
  const packsDir = join(options.tempRoot, "packs")
  const installerDir = join(options.tempRoot, "installer")
  const packageNames = ["@dawn/devkit", "create-dawn-app", ...(options.packageNames ?? [])].filter(
    (value, index, allValues) => allValues.indexOf(value) === index,
  )

  await mkdir(packsDir, { recursive: true })
  await mkdir(installerDir, { recursive: true })

  await runPackagedCommand({
    args: ["--filter", "create-dawn-app", "build"],
    command: "pnpm",
    cwd: REPO_ROOT,
    transcriptPath: options.transcriptPath,
  })

  const tarballs = Object.fromEntries(
    await Promise.all(
      packageNames.map(async (packageName) => [
        packageName,
        await packPackage(packageName, { packsDir, transcriptPath: options.transcriptPath }),
      ]),
    ),
  )

  await writeFile(
    join(installerDir, "package.json"),
    `${JSON.stringify(
      {
        name: "installer",
        private: true,
        packageManager: "pnpm@10.33.0",
        pnpm: {
          overrides: {
            "@dawn/devkit": tarballs["@dawn/devkit"],
            "@dawn/langchain": tarballs["@dawn/langchain"],
          },
        },
      },
      null,
      2,
    )}\n`,
    "utf8",
  )

  await runPackagedCommand({
    args: ["add", tarballs["@dawn/devkit"]],
    command: "pnpm",
    cwd: installerDir,
    transcriptPath: options.transcriptPath,
  })
  await runPackagedCommand({
    args: ["add", tarballs["create-dawn-app"]],
    command: "pnpm",
    cwd: installerDir,
    transcriptPath: options.transcriptPath,
  })

  return {
    installerDir,
    packsDir,
    tarballs,
  }
}

async function packPackage(
  packageName: string,
  options: { readonly packsDir: string; readonly transcriptPath?: string },
): Promise<string> {
  const packResult = await runPackagedCommand({
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

export async function runPackagedCommand(options: {
  readonly args: readonly string[]
  readonly command: string
  readonly cwd: string
  readonly stdin?: string
  readonly transcriptPath?: string
}) {
  const result =
    typeof options.stdin === "undefined"
      ? await spawnProcess({
          args: options.args,
          command: options.command,
          cwd: options.cwd,
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
      env: process.env,
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
