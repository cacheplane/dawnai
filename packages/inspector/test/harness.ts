import { type ChildProcess, spawn } from "node:child_process"
import { existsSync, mkdirSync, rmSync } from "node:fs"
import { request as httpRequest } from "node:http"
import { createServer } from "node:net"
import { join } from "node:path"
import { fileURLToPath } from "node:url"

/** e2e tests boot the built standalone server — gated behind an explicit flag. */
export const gated = process.env.DAWN_TEST_INSPECTOR === "1"

export const pkgRoot = fileURLToPath(new URL("..", import.meta.url))
const serverJs = join(pkgRoot, ".next/standalone/packages/inspector/server.js")

export interface InspectorServer {
  readonly base: string
  readonly port: number
  stop(): Promise<void>
}

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = createServer()
    srv.on("error", reject)
    srv.unref()
    srv.listen(0, "127.0.0.1", () => {
      const address = srv.address()
      if (address && typeof address === "object") srv.close(() => resolve(address.port))
      else reject(new Error("no port"))
    })
  })
}

async function waitReady(url: string): Promise<void> {
  for (let i = 0; i < 120; i++) {
    try {
      const res = await fetch(url)
      if (res.ok) return
    } catch {}
    await new Promise((r) => setTimeout(r, 500))
  }
  throw new Error(`server never became ready at ${url}`)
}

/** Wipe and recreate <appRoot>/.dawn so each run seeds a fresh store. */
export function resetDawnDir(appRoot: string): void {
  rmSync(join(appRoot, ".dawn"), { recursive: true, force: true })
  mkdirSync(join(appRoot, ".dawn"), { recursive: true })
}

export function removeDawnDir(appRoot: string): void {
  rmSync(join(appRoot, ".dawn"), { recursive: true, force: true })
}

/** Boot the built standalone inspector server against the given app root. */
export async function startInspector(appRoot: string): Promise<InspectorServer> {
  if (!existsSync(serverJs)) {
    throw new Error(`${serverJs} missing — run \`pnpm --filter @dawn-ai/inspector build\` first`)
  }
  const port = await freePort()
  const base = `http://127.0.0.1:${port}`
  const spawned: ChildProcess = spawn(process.execPath, [serverJs], {
    env: { ...process.env, DAWN_APP_ROOT: appRoot, PORT: String(port), HOSTNAME: "127.0.0.1" },
    stdio: "inherit",
  })
  // Fail fast if the server dies at startup instead of polling out the clock.
  const exited = new Promise<never>((_, reject) => {
    spawned.once("exit", (code, signal) => {
      reject(new Error(`inspector server exited before ready (code ${code}, signal ${signal})`))
    })
  })
  await Promise.race([waitReady(`${base}/healthz`), exited])
  return {
    base,
    port,
    async stop() {
      if (spawned.exitCode === null && spawned.signalCode === null) {
        // SIGTERM → short grace → SIGKILL, and await the exit before callers
        // clean up a fixture .dawn dir the server may still have open.
        const done = new Promise<void>((resolve) => {
          spawned.once("exit", () => resolve())
        })
        spawned.kill("SIGTERM")
        const backstop = setTimeout(() => spawned.kill("SIGKILL"), 2_000)
        await done
        clearTimeout(backstop)
      }
    },
  }
}

/**
 * Issue a request with a FORGED Host header. undici's fetch silently strips
 * `host` (it is a forbidden header name), so exercising the guard's Host check
 * needs a raw node:http request.
 */
export function rawRequestWithHost(
  port: number,
  path: string,
  host: string,
  method = "GET",
): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const req = httpRequest(
      { host: "127.0.0.1", port, path, method, headers: { Host: host } },
      (res) => {
        let body = ""
        res.setEncoding("utf8")
        res.on("data", (chunk: string) => {
          body += chunk
        })
        res.on("end", () => resolve({ status: res.statusCode ?? 0, body }))
      },
    )
    req.on("error", reject)
    req.end()
  })
}
