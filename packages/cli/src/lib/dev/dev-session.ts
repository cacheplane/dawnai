import { isAbsolute, relative, resolve } from "node:path"

import { findDawnApp, loadDawnConfig } from "@dawn-ai/core"

import { type CommandIo, formatErrorMessage, writeLine } from "../output.js"
import { allocateFreePort } from "./allocate-port.js"
import { buildRuntimeServerOptions } from "./boot-runtime.js"
import { classifyChange, describeChangeReason } from "./classify-change.js"
import { DevChildStartupError, type SpawnedDevChild, spawnDevChild } from "./dev-child.js"
import { waitForDevServerReady } from "./health.js"
import { loadAppEnv } from "./load-app-env.js"
import { type AppWatcher, watchApp } from "./watch-app.js"

export interface DevSession {
  readonly close: () => Promise<void>
  readonly url: string
  readonly waitUntilClosed: () => Promise<void>
}

export async function startDevSession(options: {
  readonly cwd: string
  readonly io: CommandIo
  readonly port?: number
  readonly envFile?: string
}): Promise<DevSession> {
  const discoveredApp = await discoverInitialApp(options.cwd)

  await loadAppEnv({
    appRoot: discoveredApp.appRoot,
    flag: options.envFile,
    io: options.io,
    cwd: options.cwd,
  })

  const port = options.port ?? (await allocateFreePort())
  const url = `http://127.0.0.1:${port}`
  const session = new InternalDevSession({
    appRoot: discoveredApp.appRoot,
    io: options.io,
    port,
    url,
  })

  await session.start()

  return {
    close: async () => {
      await session.close()
    },
    url,
    waitUntilClosed: async () => {
      await session.waitUntilClosed()
    },
  }
}

class InternalDevSession {
  private currentChild: SpawnedDevChild | null = null
  private readonly io: CommandIo
  private readonly appRoot: string
  private readonly port: number
  private readonly url: string
  private watcher: AppWatcher | null = null
  private closed = false
  private hasBeenReady = false
  private restartInFlight = false
  private pendingRestart = false
  private pendingRestartReason: string | undefined
  private resolveClosed!: () => void
  private rejectClosed!: (error: Error) => void
  private readonly closedPromise: Promise<void>

  constructor(options: {
    readonly appRoot: string
    readonly io: CommandIo
    readonly port: number
    readonly url: string
  }) {
    this.appRoot = options.appRoot
    this.io = options.io
    this.port = options.port
    this.url = options.url
    this.closedPromise = new Promise<void>((resolve, reject) => {
      this.resolveClosed = resolve
      this.rejectClosed = reject
    })
  }

  async start(): Promise<void> {
    this.watcher = watchApp({
      appRoot: this.appRoot,
      onChange: (path) => {
        this.handleChange(path)
      },
    })

    await this.startOrRestart()
    writeLine(this.io.stdout, `Dawn dev ready at ${this.url}`)
  }

  async close(): Promise<void> {
    if (this.closed) {
      return
    }

    this.closed = true

    this.watcher?.close()
    this.watcher = null

    if (this.currentChild) {
      const child = this.currentChild
      this.currentChild = null
      await child.stop(readShutdownTimeoutMs())
    }

    this.resolveClosed()
  }

  async waitUntilClosed(): Promise<void> {
    await this.closedPromise
  }

  private async requestRestart(reason: string): Promise<void> {
    if (this.closed) {
      return
    }

    if (this.restartInFlight) {
      this.pendingRestart = true
      this.pendingRestartReason = reason
      return
    }

    this.restartInFlight = true
    let currentReason = reason

    try {
      do {
        this.pendingRestart = false
        writeLine(this.io.stdout, `Restarting Dawn dev server (${currentReason})`)
        await this.startOrRestart()
        currentReason = this.pendingRestartReason ?? currentReason
        this.pendingRestartReason = undefined
      } while (this.pendingRestart && !this.closed)

      if (!this.closed) {
        writeLine(this.io.stdout, `Dawn dev ready at ${this.url}`)
      }
    } catch (error) {
      if (isFatalDevSessionError(error)) {
        await this.failFatal(error)
        return
      }

      if (this.hasBeenReady) {
        this.currentChild = null
        writeLine(
          this.io.stderr,
          `Restart failed; watching for changes: ${formatErrorMessage(error)}`,
        )
        return
      }

      await this.failFatal(new Error(`Fatal dev session error: ${formatErrorMessage(error)}`))
      return
    } finally {
      this.restartInFlight = false
    }
  }

  private handleChange(absolutePath: string): void {
    if (this.closed) return

    const relative = absolutePath.startsWith(this.appRoot)
      ? absolutePath.slice(this.appRoot.length + 1)
      : absolutePath

    // Node's recursive fs.watch can fire with a null/empty fileName (notably
    // under high-frequency writes like the checkpointer's .dawn/*.sqlite-wal
    // updates). We cannot attribute such an event to a source file, so treat
    // it as a no-op rather than triggering a restart — a spurious restart can
    // fail to rebind the still-held port and crash the dev session.
    if (relative === "") {
      return
    }

    // Ignore generated output inside .dawn/
    if (relative.startsWith(".dawn/") || relative === ".dawn") {
      return
    }

    const classification = classifyChange(relative)

    if (classification === "ignore") {
      return
    }

    void this.requestRestart(describeChangeReason(relative))
  }

  private async runTypegenSafe(): Promise<void> {
    try {
      await buildRuntimeServerOptions({ appRoot: this.appRoot })
    } catch (error) {
      writeLine(this.io.stderr, `Typegen failed: ${formatErrorMessage(error)}`)
    }
  }

  private async startOrRestart(): Promise<void> {
    if (this.currentChild) {
      const child = this.currentChild
      this.currentChild = null
      const stopResult = await child.stop(readShutdownTimeoutMs())

      if (stopResult.forced) {
        writeLine(this.io.stderr, "Force-killed stuck dev child")
      }
    }

    const app = await validateWatchedAppRoot(this.appRoot)

    // Regenerate types before every spawn (initial boot and every restart) so
    // the child's dawn.generated.d.ts reflects the route tree it's about to
    // serve. Tool/state/reducer edits used to get this via a debounced
    // typegen-only reaction with no restart; now that those edits restart
    // the child (see classifyChange), typegen runs unconditionally here
    // instead of on a separate schedule.
    await this.runTypegenSafe()

    const child = spawnDevChild({
      appRoot: app.appRoot,
      port: this.port,
    })

    try {
      await child.waitForReady()
      await waitForDevServerReady(this.url, { timeoutMs: readReadyTimeoutMs() })
    } catch (error) {
      await child.stop(readShutdownTimeoutMs())

      if (error instanceof DevChildStartupError && error.code === "EADDRINUSE") {
        throw new FatalDevSessionError(`Port ${this.port} is unavailable`)
      }

      throw error
    }

    this.currentChild = child
    this.hasBeenReady = true

    void child.waitForUnexpectedExit().then((code) => {
      if (this.closed || this.currentChild !== child) {
        return
      }

      void this.failFatal(
        new Error(
          `Fatal dev session error: Dev child exited unexpectedly with code ${code ?? "unknown"}`,
        ),
      )
    })
  }

  private async failFatal(error: Error): Promise<void> {
    if (this.closed) {
      return
    }

    this.closed = true
    this.watcher?.close()
    this.watcher = null
    const child = this.currentChild
    this.currentChild = null

    if (child) {
      await child.stop(readShutdownTimeoutMs())
    }

    writeLine(this.io.stderr, error.message)
    this.rejectClosed(error)
  }
}

class FatalDevSessionError extends Error {
  constructor(message: string) {
    super(`Fatal dev session error: ${message}`)
    this.name = "FatalDevSessionError"
  }
}

function isFatalDevSessionError(error: unknown): error is FatalDevSessionError {
  return error instanceof FatalDevSessionError
}

/**
 * Discover the Dawn app root from a starting directory, validating that the
 * configured routes directory stays within it. Shared with `dawn start`
 * (see ../../commands/start.ts) so both commands resolve the app root the
 * same way.
 */
export async function discoverInitialApp(cwd: string): Promise<{ readonly appRoot: string }> {
  const app = await findDawnApp({ cwd })
  assertRoutesDirWithinAppRoot(app.appRoot, app.routesDir)

  return {
    appRoot: resolve(app.appRoot),
  }
}

async function validateWatchedAppRoot(appRoot: string): Promise<{ readonly appRoot: string }> {
  await assertConfiguredAppDirWithinAppRoot(appRoot)
  const app = await findDawnApp({ appRoot })
  assertRoutesDirWithinAppRoot(app.appRoot, app.routesDir)

  return {
    appRoot: resolve(app.appRoot),
  }
}

async function assertConfiguredAppDirWithinAppRoot(appRoot: string): Promise<void> {
  const loadedConfig = await loadDawnConfig({ appRoot })
  const routesDir = resolve(appRoot, loadedConfig.config.appDir ?? "src/app")

  assertRoutesDirWithinAppRoot(appRoot, routesDir)
}

function assertRoutesDirWithinAppRoot(appRoot: string, routesDir: string): void {
  const relativeRoutesDir = relative(appRoot, routesDir)

  if (
    relativeRoutesDir.startsWith("..") ||
    relativeRoutesDir === ".." ||
    isAbsolute(relativeRoutesDir)
  ) {
    throw new FatalDevSessionError("configured appDir must stay within the discovered app root")
  }
}

function readShutdownTimeoutMs(): number {
  const rawValue = process.env.DAWN_DEV_SHUTDOWN_TIMEOUT_MS

  if (!rawValue) {
    return 1_000
  }

  const parsedValue = Number(rawValue)
  return Number.isFinite(parsedValue) ? parsedValue : 1_000
}

function readReadyTimeoutMs(): number {
  const rawValue = process.env.DAWN_DEV_READY_TIMEOUT_MS

  if (!rawValue) {
    return 5_000
  }

  const parsedValue = Number(rawValue)
  return Number.isFinite(parsedValue) ? parsedValue : 5_000
}
