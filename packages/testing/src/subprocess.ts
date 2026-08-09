import { type ChildProcess, spawn } from "node:child_process"
import { createServer } from "node:net"
import { dirname, resolve } from "node:path"
import { setTimeout as delay } from "node:timers/promises"
import { fileURLToPath } from "node:url"

export interface SubprocessApp {
  readonly baseUrl: string
  close(): Promise<void>
  [Symbol.asyncDispose](): Promise<void>
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

async function terminateSubprocess(
  child: ChildProcess,
  groupPid: number,
  closed: Promise<void>,
): Promise<void> {
  if (child.exitCode === null && child.signalCode === null) {
    process.kill(-groupPid, "SIGTERM")
  }
  await closed
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
    closePromise ??= terminateSubprocess(child, groupPid, closed)
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
