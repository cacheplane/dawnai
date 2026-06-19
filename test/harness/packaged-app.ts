import { spawn } from "node:child_process"
import { appendFile, mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { spawnProcess } from "../../packages/devkit/src/testing/index.ts"
import {
  appendDevServerTranscript,
  type DevServerHandle,
  startDevServer,
} from "../runtime/support/dev-server.ts"

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
