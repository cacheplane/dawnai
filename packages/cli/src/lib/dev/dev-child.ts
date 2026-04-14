import type { ChildProcess } from "node:child_process"
import { spawn } from "node:child_process"
import { writeFile } from "node:fs/promises"
import { resolve } from "node:path"

import type { Command } from "commander"

import { CliError, formatErrorMessage } from "../output.js"
import { startRuntimeServer } from "./runtime-server.js"

interface DevChildCommandOptions {
  readonly appRoot: string
  readonly port: string
}

export interface SpawnDevChildOptions {
  readonly appRoot: string
  readonly port: number
}

export class DevChildStartupError extends Error {
  readonly code: string | undefined

  constructor(message: string, code?: string) {
    super(message)
    this.code = code
    this.name = "DevChildStartupError"
  }
}

interface DevChildReadyMessage {
  readonly type: "ready"
  readonly url: string
}

interface DevChildStartupErrorMessage {
  readonly code?: string
  readonly message: string
  readonly type: "startup-error"
}

type DevChildMessage = DevChildReadyMessage | DevChildStartupErrorMessage

export interface SpawnedDevChild {
  readonly stderr: () => string
  readonly stop: (timeoutMs: number) => Promise<{ readonly forced: boolean }>
  readonly waitForReady: () => Promise<string>
  readonly waitForUnexpectedExit: () => Promise<number | null>
}

export function registerDevChildCommand(program: Command): void {
  program
    .command("__dev-child")
    .requiredOption("--app-root <path>")
    .requiredOption("--port <number>")
    .action(async (options: DevChildCommandOptions) => {
      await runDevChildCommand(options)
    })
}

export async function runDevChildCommand(options: DevChildCommandOptions): Promise<void> {
  const port = Number(options.port)

  if (!Number.isInteger(port) || port <= 0) {
    throw new CliError(`Invalid dev child port: ${options.port}`, 1)
  }

  const startupDelayMs = readIntFromEnv("DAWN_DEV_CHILD_STARTUP_DELAY_MS", 0)

  if (startupDelayMs > 0) {
    await delay(startupDelayMs)
  }

  const childTestMode = process.env.DAWN_DEV_CHILD_TEST_MODE
  const pidPath = process.env.DAWN_DEV_CHILD_PID_PATH

  if (pidPath) {
    await writeFile(pidPath, String(process.pid), "utf8")
  }

  if (childTestMode === "report-ready-without-server") {
    process.send?.({
      type: "ready",
      url: `http://127.0.0.1:${port}`,
    } satisfies DevChildReadyMessage)

    await new Promise<void>((resolvePromise) => {
      const resolveOnce = () => {
        resolvePromise()
      }

      process.once("SIGINT", resolveOnce)
      process.once("SIGTERM", resolveOnce)
    })

    return
  }

  let runtimeServer: Awaited<ReturnType<typeof startRuntimeServer>> | null = null
  let shuttingDown = false
  let resolveClosed!: () => void
  const closed = new Promise<void>((resolve) => {
    resolveClosed = resolve
  })

  try {
    runtimeServer = await startRuntimeServer({
      appRoot: options.appRoot,
      port,
    })
  } catch (error) {
    const errorCode = getErrorCode(error)

    process.send?.({
      ...(typeof errorCode === "string" ? { code: errorCode } : {}),
      message: formatErrorMessage(error),
      type: "startup-error",
    } satisfies DevChildStartupErrorMessage)

    throw new CliError(formatErrorMessage(error), 1)
  }

  const shutdown = async () => {
    if (shuttingDown) {
      return
    }

    shuttingDown = true

    try {
      await runtimeServer.close()
    } finally {
      resolveClosed()
    }
  }

  process.once("SIGINT", () => {
    void shutdown()
  })
  process.once("SIGTERM", () => {
    void shutdown()
  })

  process.send?.({
    type: "ready",
    url: runtimeServer.url,
  } satisfies DevChildReadyMessage)

  await closed
}

export function spawnDevChild(options: SpawnDevChildOptions): SpawnedDevChild {
  const childEntryPath = resolve(process.argv[1] ?? "")

  if (childEntryPath.length === 0) {
    throw new Error("Cannot start a dev child without a CLI entry path")
  }

  const child = spawn(
    process.execPath,
    [
      ...process.execArgv,
      childEntryPath,
      "__dev-child",
      "--app-root",
      options.appRoot,
      "--port",
      String(options.port),
    ],
    {
      env: process.env,
      stdio: ["ignore", "pipe", "pipe", "ipc"],
    },
  )

  let resolvedReady = false
  let stderr = ""
  let resolveReady!: (url: string) => void
  let rejectReady!: (error: Error) => void
  const ready = new Promise<string>((resolve, reject) => {
    resolveReady = resolve
    rejectReady = reject
  })
  const unexpectedExit = new Promise<number | null>((resolve) => {
    child.once("close", (code) => {
      if (!resolvedReady) {
        rejectReady(
          new DevChildStartupError(stderr || `Dev child exited with code ${code ?? "unknown"}`),
        )
        return
      }

      resolve(code)
    })
  })

  child.stderr?.on("data", (chunk) => {
    stderr += String(chunk)
  })

  child.on("message", (message: unknown) => {
    if (!isDevChildMessage(message)) {
      return
    }

    if (message.type === "startup-error") {
      rejectReady(new DevChildStartupError(message.message, message.code))
      return
    }

    resolvedReady = true
    resolveReady(message.url)
  })

  return {
    stderr: () => stderr,
    stop: async (timeoutMs) => {
      if (child.exitCode !== null) {
        return { forced: false as const }
      }

      child.kill("SIGTERM")

      const exitedGracefully = await Promise.race([
        waitForExit(child).then(() => true),
        delay(timeoutMs).then(() => false),
      ])

      if (exitedGracefully) {
        return { forced: false as const }
      }

      child.kill("SIGKILL")
      await waitForExit(child)

      return { forced: true as const }
    },
    waitForReady: async () => await ready,
    waitForUnexpectedExit: async () => await unexpectedExit,
  }
}

function getErrorCode(error: unknown): string | undefined {
  return typeof error === "object" &&
    error !== null &&
    "code" in error &&
    typeof error.code === "string"
    ? error.code
    : undefined
}

function isDevChildMessage(value: unknown): value is DevChildMessage {
  return typeof value === "object" && value !== null && "type" in value
}

async function waitForExit(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null) {
    return
  }

  await new Promise<void>((resolve) => {
    child.once("close", () => {
      resolve()
    })
  })
}

async function delay(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms))
}

function readIntFromEnv(name: string, fallback: number): number {
  const rawValue = process.env[name]

  if (!rawValue) {
    return fallback
  }

  const parsedValue = Number(rawValue)
  return Number.isFinite(parsedValue) ? parsedValue : fallback
}
