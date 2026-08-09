import { type ChildProcess, execFile, spawn } from "node:child_process"
import { createConnection, createServer } from "node:net"
import { dirname, resolve } from "node:path"
import { setTimeout as delay } from "node:timers/promises"
import { fileURLToPath } from "node:url"

export interface SubprocessApp {
  readonly baseUrl: string
  close(): Promise<void>
  [Symbol.asyncDispose](): Promise<void>
}

export interface TerminationTimings {
  readonly graceMs: number
  readonly forceMs: number
  readonly probeIntervalMs: number
  readonly probeTimeoutMs: number
}

const DEFAULT_TERMINATION_TIMINGS: TerminationTimings = {
  graceMs: 2_000,
  forceMs: 2_000,
  probeIntervalMs: 25,
  probeTimeoutMs: 100,
}

/** Bind to port 0, read the OS-assigned port, release it. */
async function getFreePort(): Promise<number> {
  return await new Promise((resolve, reject) => {
    const srv = createServer()
    srv.unref()
    srv.on("error", reject)
    srv.listen(0, "127.0.0.1", () => {
      const addr = srv.address()
      const port = typeof addr === "object" && addr ? addr.port : 0
      srv.close(() => resolve(port))
    })
  })
}

async function waitReady(url: string, timeoutMs: number): Promise<void> {
  const start = Date.now()
  while (Date.now() - start < timeoutMs) {
    try {
      const res = await fetch(url)
      if (res.ok) {
        const body = (await res.json()) as { readonly status?: string }
        if (body.status === "ready") return
      }
    } catch {
      // not up yet
    }
    await delay(300)
  }
  throw new Error(`subprocess app not ready at ${url} within ${timeoutMs}ms`)
}

/**
 * Resolve the absolute path to the dawn CLI entry point so the subprocess can
 * be spawned without relying on the probe-app's local node_modules or PATH.
 * We look relative to this module's own location inside the testing package.
 */
function resolveDawnCliEntry(): string {
  // import.meta.url resolves to something like:
  //   .../packages/testing/src/subprocess.ts  (ts-node / source)
  //   .../packages/testing/dist/subprocess.js (compiled)
  const here = dirname(fileURLToPath(import.meta.url))
  // Climb up to packages/testing, then into node_modules/.bin dawn → ../cli/dist/index.js
  // The shell script points at: $basedir/../@dawn-ai/cli/dist/index.js
  // $basedir = packages/testing/node_modules/.bin
  // So the entry is: packages/testing/node_modules/@dawn-ai/cli/dist/index.js
  //
  // "here" is either packages/testing/src or packages/testing/dist — one level below the package root.
  const pkgRoot = resolve(here, "..")
  return resolve(pkgRoot, "node_modules", "@dawn-ai", "cli", "dist", "index.js")
}

function childClosePromise(child: ChildProcess): Promise<void> {
  return new Promise((resolve, reject) => {
    child.once("error", reject)
    child.once("close", () => resolve())
  })
}

function portAcceptsConnections(baseUrl: string, timeoutMs: number): Promise<boolean> {
  const url = new URL(baseUrl)
  return new Promise((resolve) => {
    let settled = false
    const socket = createConnection({ host: url.hostname, port: Number(url.port) })
    const finish = (accepting: boolean): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      socket.destroy()
      resolve(accepting)
    }
    const timer = setTimeout(() => finish(true), timeoutMs)
    socket.once("connect", () => finish(true))
    socket.once("error", () => finish(false))
  })
}

async function waitUntilStopped(
  childState: { closed: boolean; failed: boolean; error: unknown },
  baseUrl: string,
  timeoutMs: number,
  timings: TerminationTimings,
): Promise<boolean> {
  const deadline = Date.now() + timeoutMs
  while (true) {
    const remainingMs = Math.max(0, deadline - Date.now())
    const accepting = await portAcceptsConnections(
      baseUrl,
      Math.min(timings.probeTimeoutMs, remainingMs),
    )
    if (childState.failed) throw childState.error
    if (childState.closed && !accepting) return true

    const waitMs = Math.min(timings.probeIntervalMs, deadline - Date.now())
    if (waitMs <= 0) return false
    await delay(waitMs)
  }
}

function taskkillProcessTree(pid: number, timeoutMs: number): Promise<void> {
  return new Promise((resolve, reject) => {
    execFile(
      "taskkill.exe",
      ["/PID", String(pid), "/T", "/F"],
      { windowsHide: true, timeout: Math.max(1, timeoutMs), maxBuffer: 64 * 1024 },
      (error) => (error ? reject(error) : resolve()),
    )
  })
}

async function signalProcessTree(
  child: ChildProcess,
  childState: { readonly closed: boolean },
  groupPid: number,
  signal: NodeJS.Signals,
  timeoutMs: number,
  dispatchErrors: unknown[],
): Promise<void> {
  if (process.platform === "win32") {
    if (childState.closed || child.exitCode !== null || child.signalCode !== null) return
    const deadline = Date.now() + timeoutMs
    try {
      await taskkillProcessTree(groupPid, timeoutMs)
      return
    } catch (error) {
      dispatchErrors.push(error)
      if (signal !== "SIGKILL") return
      if (Date.now() >= deadline) return
      if (childState.closed || child.exitCode !== null || child.signalCode !== null) return
      try {
        child.kill(signal)
      } catch (childError) {
        dispatchErrors.push(childError)
      }
      return
    }
  }

  try {
    process.kill(-groupPid, signal)
  } catch (error) {
    dispatchErrors.push(error)
    try {
      child.kill(signal)
    } catch (childError) {
      dispatchErrors.push(childError)
    }
  }
}

export async function terminateSubprocess(
  child: ChildProcess,
  groupPid: number,
  closed: Promise<void>,
  baseUrl: string,
  timings: TerminationTimings = DEFAULT_TERMINATION_TIMINGS,
): Promise<void> {
  const childState: { closed: boolean; failed: boolean; error: unknown } = {
    closed: false,
    failed: false,
    error: undefined,
  }
  void closed.then(
    () => {
      childState.closed = true
    },
    (error: unknown) => {
      childState.failed = true
      childState.error = error
    },
  )

  const portAccepting = await portAcceptsConnections(baseUrl, timings.probeTimeoutMs)
  if (childState.failed) throw childState.error
  if (childState.closed && !portAccepting) return

  const dispatchErrors: unknown[] = []
  const waitForPhase = async (signal: NodeJS.Signals, phaseMs: number): Promise<boolean> => {
    const deadline = Date.now() + phaseMs
    await signalProcessTree(
      child,
      childState,
      groupPid,
      signal,
      Math.max(0, deadline - Date.now()),
      dispatchErrors,
    )
    return await waitUntilStopped(childState, baseUrl, Math.max(0, deadline - Date.now()), timings)
  }

  if (await waitForPhase("SIGTERM", timings.graceMs)) return
  if (await waitForPhase("SIGKILL", timings.forceMs)) return
  const message = `subprocess group ${groupPid} did not stop within ${timings.graceMs + timings.forceMs}ms after SIGTERM and SIGKILL`
  if (dispatchErrors.length === 0) throw new Error(message)
  const cause =
    dispatchErrors.length === 1
      ? dispatchErrors[0]
      : new AggregateError(dispatchErrors, "subprocess termination signal dispatch failed")
  throw new Error(message, { cause })
}

export async function createSubprocessApp(opts: {
  readonly appRoot: string
  readonly env?: Record<string, string>
  readonly port?: number
  readonly readyTimeoutMs?: number
}): Promise<SubprocessApp> {
  const port = opts.port ?? (await getFreePort())
  const cliEntry = resolveDawnCliEntry()

  const child: ChildProcess = spawn(process.execPath, [cliEntry, "dev", "--port", String(port)], {
    cwd: opts.appRoot,
    env: { ...process.env, ...opts.env },
    stdio: "pipe",
    detached: true,
  })
  const groupPid = child.pid
  const closed = childClosePromise(child)
  if (groupPid === undefined) {
    await closed
    throw new Error("dawn dev subprocess has no process id")
  }

  // surface server logs for debugging on failure
  child.stdout?.on("data", (b) => process.stdout.write(`[dawn dev] ${b}`))
  child.stderr?.on("data", (b) => process.stderr.write(`[dawn dev] ${b}`))

  const baseUrl = `http://127.0.0.1:${port}`
  let closePromise: Promise<void> | undefined
  const close = (): Promise<void> => {
    closePromise ??= terminateSubprocess(
      child,
      groupPid,
      closed,
      baseUrl,
      DEFAULT_TERMINATION_TIMINGS,
    )
    return closePromise
  }

  try {
    await waitReady(`${baseUrl}/healthz`, opts.readyTimeoutMs ?? 60_000)
  } catch (err) {
    await close()
    throw err
  }

  const app: SubprocessApp = {
    baseUrl,
    close,
    [Symbol.asyncDispose](): Promise<void> {
      return close()
    },
  }
  return app
}
