import { type ChildProcess, spawn } from "node:child_process"
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { createServer } from "node:net"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { afterEach, describe, expect, test } from "vitest"

import { startRuntimeServer } from "../src/lib/dev/runtime-server.js"

const tempDirs: string[] = []
const servers: Array<{ close: () => Promise<void> }> = []
const devProcesses: DevProcessHandle[] = []

afterEach(async () => {
  await Promise.all(devProcesses.splice(0).map((process) => process.stop()))
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { force: true, recursive: true })))
  await Promise.all(servers.splice(0).map((server) => server.close()))
})

describe("dawn dev runtime server", () => {
  test("returns healthz ready", async () => {
    const appRoot = await createFixtureApp({
      "dawn.config.ts": "export default {};\n",
      "package.json": "{}\n",
      "src/app/support/[tenant]/index.ts": `export const graph = async () => ({ ok: true });\n`,
    })

    const server = await startRuntimeServer({ appRoot })
    servers.push(server)

    const response = await fetch(new URL("/healthz", server.url))

    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({ status: "ready" })
  })

  test("executes graph routes by mode-qualified assistant_id", async () => {
    const appRoot = await createFixtureApp({
      "dawn.config.ts": "export default {};\n",
      "package.json": "{}\n",
      "src/app/support/[tenant]/index.ts": `export const graph = async (input: { tenant: string }) => ({ mode: "graph", tenant: input.tenant });\n`,
    })

    const server = await startRuntimeServer({ appRoot })
    servers.push(server)

    const graphResponse = await fetch(new URL("/runs/wait", server.url), {
      body: JSON.stringify({
        assistant_id: "/support/[tenant]#graph",
        input: { tenant: "graph" },
        metadata: {
          dawn: {
            mode: "graph",
            route_id: "/support/[tenant]",
            route_path: "src/app/support/[tenant]/index.ts",
          },
        },
        on_completion: "delete",
      }),
      headers: {
        "content-type": "application/json",
      },
      method: "POST",
    })

    expect(graphResponse.status).toBe(200)
    expect(await graphResponse.json()).toMatchObject({ mode: "graph", tenant: "graph" })
  })

  test("rejects metadata mismatches as non-execution request failures", async () => {
    const appRoot = await createFixtureApp({
      "dawn.config.ts": "export default {};\n",
      "package.json": "{}\n",
      "src/app/support/[tenant]/index.ts": `export const graph = async () => ({ ok: true });\n`,
    })

    const server = await startRuntimeServer({ appRoot })
    servers.push(server)

    const response = await fetch(new URL("/runs/wait", server.url), {
      body: JSON.stringify({
        assistant_id: "/support/[tenant]#graph",
        input: { tenant: "graph" },
        metadata: {
          dawn: {
            mode: "workflow",
            route_id: "/support/[tenant]",
            route_path: "src/app/support/[tenant]/index.ts",
          },
        },
        on_completion: "delete",
      }),
      headers: {
        "content-type": "application/json",
      },
      method: "POST",
    })

    expect(response.status).toBe(400)
    expect(await response.json()).toMatchObject({
      error: {
        kind: "request_error",
      },
    })
  })

  test("rejects malformed request bodies and unknown assistant ids", async () => {
    const appRoot = await createFixtureApp({
      "dawn.config.ts": "export default {};\n",
      "package.json": "{}\n",
      "src/app/support/[tenant]/index.ts": `export const graph = async () => ({ ok: true });\n`,
    })

    const server = await startRuntimeServer({ appRoot })
    servers.push(server)

    const malformedResponse = await fetch(new URL("/runs/wait", server.url), {
      body: "{not-json",
      headers: {
        "content-type": "application/json",
      },
      method: "POST",
    })

    const unknownAssistantResponse = await fetch(new URL("/runs/wait", server.url), {
      body: JSON.stringify({
        assistant_id: "/support/[tenant]#workflow",
        input: { tenant: "graph" },
        metadata: {
          dawn: {
            mode: "workflow",
            route_id: "/support/[tenant]",
            route_path: "src/app/support/[tenant]/index.ts",
          },
        },
        on_completion: "delete",
      }),
      headers: {
        "content-type": "application/json",
      },
      method: "POST",
    })

    expect(malformedResponse.status).toBe(400)
    expect(unknownAssistantResponse.status).toBe(404)
  })

  test("returns execution_error for actual route exceptions", async () => {
    const appRoot = await createFixtureApp({
      "dawn.config.ts": "export default {};\n",
      "package.json": "{}\n",
      "src/app/support/[tenant]/index.ts": `export const graph = async () => { throw new Error("boom"); };\n`,
    })

    const server = await startRuntimeServer({ appRoot })
    servers.push(server)

    const response = await fetch(new URL("/runs/wait", server.url), {
      body: JSON.stringify({
        assistant_id: "/support/[tenant]#graph",
        input: { tenant: "graph" },
        metadata: {
          dawn: {
            mode: "graph",
            route_id: "/support/[tenant]",
            route_path: "src/app/support/[tenant]/index.ts",
          },
        },
        on_completion: "delete",
      }),
      headers: {
        "content-type": "application/json",
      },
      method: "POST",
    })

    expect(response.status).toBe(500)
    expect(await response.json()).toMatchObject({
      error: {
        kind: "execution_error",
      },
    })
  })

  test("returns a classified shutdown failure for an in-flight route", async () => {
    const appRoot = await createFixtureApp({
      "dawn.config.ts": "export default {};\n",
      "package.json": "{}\n",
      "src/app/support/[tenant]/index.ts": `
        export const graph = async (_input: unknown, context?: { signal?: AbortSignal }) => {
          await new Promise((resolve, reject) => {
            const signal = context?.signal
            if (!signal) {
              reject(new Error("Missing shutdown signal"))
              return
            }

            const onAbort = () => {
              signal.removeEventListener("abort", onAbort)
              reject(new Error("Route canceled"))
            }

            signal.addEventListener("abort", onAbort, { once: true })
          })
        };
      `,
    })

    const server = await startRuntimeServer({ appRoot })
    servers.push(server)

    const responsePromise = fetch(new URL("/runs/wait", server.url), {
      body: JSON.stringify({
        assistant_id: "/support/[tenant]#graph",
        input: {},
        metadata: {
          dawn: {
            mode: "graph",
            route_id: "/support/[tenant]",
            route_path: "src/app/support/[tenant]/index.ts",
          },
        },
        on_completion: "delete",
      }),
      headers: {
        "content-type": "application/json",
      },
      method: "POST",
    })

    await new Promise((resolve) => setTimeout(resolve, 25))
    const closePromise = server.close()

    const response = await responsePromise
    await closePromise

    expect(response.status).toBe(503)
    expect(await response.json()).toMatchObject({
      error: {
        kind: "request_error",
      },
    })
  })
})

describe("dawn dev lifecycle", () => {
  test("disposes a newly spawned child when startup readiness fails", {
    timeout: 12_000,
  }, async () => {
    const pidPath = join(tmpdir(), `dawn-dev-child-pid-${Date.now()}.txt`)
    const appRoot = await createFixtureApp({
      "dawn.config.ts": "export default {};\n",
      "package.json": "{}\n",
      "src/app/support/[tenant]/index.ts": `export const graph = async () => ({ ok: true });\n`,
    })

    const dev = await startDevProcess({
      cwd: appRoot,
      env: {
        DAWN_DEV_CHILD_PID_PATH: pidPath,
        DAWN_DEV_CHILD_TEST_MODE: "report-ready-without-server",
      },
    })
    devProcesses.push(dev)

    const exitCode = await dev.waitForExit()
    await waitForPath(pidPath)

    const pid = Number((await readFile(pidPath, "utf8")).trim())

    expect(exitCode).toBe(1)
    expect(dev.stderr).toContain("Timed out waiting for")
    expect(isProcessAlive(pid)).toBe(false)
  })

  test("discovers the app from cwd and prints the listening URL", async () => {
    const appRoot = await createFixtureApp({
      "dawn.config.ts": "export default {};\n",
      "package.json": "{}\n",
      "src/app/support/[tenant]/index.ts": `export const graph = async (input: { tenant: string }) => ({ tenant: input.tenant, greeting: \`Hello, \${input.tenant}!\` });\n`,
    })
    const routeDir = join(appRoot, "src/app/support/[tenant]")

    const dev = await startDevProcess({
      cwd: routeDir,
    })
    devProcesses.push(dev)

    const url = await dev.waitForReady()
    const response = await invokeRunsWait(url, {
      assistantId: "/support/[tenant]#graph",
      input: { tenant: "cwd" },
      mode: "graph",
      routeId: "/support/[tenant]",
      routePath: "src/app/support/[tenant]/index.ts",
    })

    expect(dev.stdout).toContain(`http://127.0.0.1:${new URL(url).port}`)
    expect(response.status).toBe(200)
    expect(await response.json()).toMatchObject({
      greeting: "Hello, cwd!",
      tenant: "cwd",
    })
  })

  test("keeps a stable port and serves new behavior after a watched route edit restart", async () => {
    const appRoot = await createFixtureApp({
      "dawn.config.ts": "export default {};\n",
      "package.json": "{}\n",
      "src/app/support/[tenant]/index.ts": `export const graph = async () => ({ version: "v1" });\n`,
    })
    const routePath = join(appRoot, "src/app/support/[tenant]/index.ts")
    const port = await allocatePort()

    const dev = await startDevProcess({
      cwd: appRoot,
      port,
    })
    devProcesses.push(dev)

    const url = await dev.waitForReady()
    const readyCount = dev.readyCount()
    const initialResponse = await invokeRunsWait(url, {
      assistantId: "/support/[tenant]#graph",
      input: {},
      mode: "graph",
      routeId: "/support/[tenant]",
      routePath: "src/app/support/[tenant]/index.ts",
    })

    expect(await initialResponse.json()).toMatchObject({ version: "v1" })

    await writeFile(routePath, `export const graph = async () => ({ version: "v2" });\n`, "utf8")

    await dev.waitForLog(/Restarting Dawn dev server/)
    const restartedUrl = await dev.waitForNextReady(readyCount)
    const updatedResponse = await invokeRunsWait(restartedUrl, {
      assistantId: "/support/[tenant]#graph",
      input: {},
      mode: "graph",
      routeId: "/support/[tenant]",
      routePath: "src/app/support/[tenant]/index.ts",
    })

    expect(new URL(restartedUrl).port).toBe(String(port))
    expect(countOccurrences(dev.stdout, "Restarting Dawn dev server")).toBeGreaterThanOrEqual(1)
    expect(await updatedResponse.json()).toMatchObject({ version: "v2" })
  })

  test("coalesces bursty edits during restart into at most one follow-up restart", async () => {
    const appRoot = await createFixtureApp({
      "dawn.config.ts": "export default {};\n",
      "package.json": "{}\n",
      "src/app/support/[tenant]/index.ts": `export const graph = async () => ({ version: "v1" });\n`,
    })
    const routePath = join(appRoot, "src/app/support/[tenant]/index.ts")

    const dev = await startDevProcess({
      cwd: appRoot,
      env: {
        DAWN_DEV_CHILD_STARTUP_DELAY_MS: "200",
      },
    })
    devProcesses.push(dev)

    const url = await dev.waitForReady()
    const readyCount = dev.readyCount()

    await writeFile(routePath, `export const graph = async () => ({ version: "v2" });\n`, "utf8")
    await dev.waitForLog(/Restarting Dawn dev server/)
    await writeFile(routePath, `export const graph = async () => ({ version: "v3" });\n`, "utf8")
    await writeFile(routePath, `export const graph = async () => ({ version: "v4" });\n`, "utf8")

    await dev.waitForNextReady(readyCount)
    await delay(350)
    await dev.waitForReady()

    const response = await invokeRunsWait(url, {
      assistantId: "/support/[tenant]#graph",
      input: {},
      mode: "graph",
      routeId: "/support/[tenant]",
      routePath: "src/app/support/[tenant]/index.ts",
    })

    expect(await response.json()).toMatchObject({ version: "v4" })
    expect(countOccurrences(dev.stdout, "Restarting Dawn dev server")).toBeLessThanOrEqual(2)
  })

  test("surfaces restart-induced in-flight cancellation as a non-execution failure", async () => {
    const markerPath = join(tmpdir(), `dawn-dev-cancel-${Date.now()}.txt`)
    const appRoot = await createFixtureApp({
      "dawn.config.ts": "export default {};\n",
      "package.json": "{}\n",
      "src/app/support/[tenant]/index.ts": `
        import { writeFile } from "node:fs/promises";

        export const graph = async (_input: unknown, context?: { signal?: AbortSignal }) => {
          await writeFile(${JSON.stringify(markerPath)}, "started", "utf8")
          await new Promise((resolve, reject) => {
            const signal = context?.signal

            if (!signal) {
              reject(new Error("Missing signal"))
              return
            }

            const onAbort = () => {
              signal.removeEventListener("abort", onAbort)
              reject(new Error("Canceled during restart"))
            }

            signal.addEventListener("abort", onAbort, { once: true })
          })
        };
      `,
    })
    const routePath = join(appRoot, "src/app/support/[tenant]/index.ts")

    const dev = await startDevProcess({ cwd: appRoot })
    devProcesses.push(dev)

    const url = await dev.waitForReady()
    const responsePromise = invokeRunsWait(url, {
      assistantId: "/support/[tenant]#graph",
      input: {},
      mode: "graph",
      routeId: "/support/[tenant]",
      routePath: "src/app/support/[tenant]/index.ts",
    })

    await waitForPath(markerPath)
    await writeFile(
      routePath,
      `export const graph = async () => ({ version: "after-restart" });\n`,
      "utf8",
    )

    const response = await responsePromise
    expect(response.status).toBe(503)
    expect(await response.json()).toMatchObject({
      error: {
        kind: "request_error",
      },
    })
  })

  test("stays alive in a broken-but-watching state after a bad watched edit and recovers after a fixing edit", async () => {
    const appRoot = await createFixtureApp({
      "dawn.config.ts": "export default {};\n",
      "package.json": "{}\n",
      "src/app/support/[tenant]/index.ts": `export const graph = async () => ({ version: "healthy" });\n`,
    })
    const configPath = join(appRoot, "dawn.config.ts")

    const dev = await startDevProcess({ cwd: appRoot })
    devProcesses.push(dev)

    const url = await dev.waitForReady()
    const readyCount = dev.readyCount()

    await writeFile(
      configPath,
      'const appDir = "src/missing";\nexport default { appDir };\n',
      "utf8",
    )

    await dev.waitForLog(/Restart failed; watching for changes/)
    await dev.waitForNotReady()

    expect(dev.exited).toBe(false)

    await writeFile(configPath, "export default {};\n", "utf8")

    await dev.waitForNextReady(readyCount)
    const response = await invokeRunsWait(url, {
      assistantId: "/support/[tenant]#graph",
      input: {},
      mode: "graph",
      routeId: "/support/[tenant]",
      routePath: "src/app/support/[tenant]/index.ts",
    })

    expect(response.status).toBe(200)
    expect(await response.json()).toMatchObject({ version: "healthy" })
  })

  test("terminates the session for fatal appDir changes outside the discovered app root", async () => {
    const appRoot = await createFixtureApp({
      "dawn.config.ts": "export default {};\n",
      "package.json": "{}\n",
      "src/app/support/[tenant]/index.ts": `export const graph = async () => ({ version: "healthy" });\n`,
    })
    const configPath = join(appRoot, "dawn.config.ts")

    const dev = await startDevProcess({ cwd: appRoot })
    devProcesses.push(dev)

    await dev.waitForReady()
    await writeFile(
      configPath,
      'const appDir = "../outside";\nexport default { appDir };\n',
      "utf8",
    )

    const exitCode = await dev.waitForExit()

    expect(exitCode).toBe(1)
    expect(dev.stderr).toContain("Fatal dev session error")
    expect(dev.stderr).toContain("configured appDir must stay within the discovered app root")
  })

  test("terminates the session for fatal restart-time environment failures such as port rebinding", async () => {
    const appRoot = await createFixtureApp({
      "dawn.config.ts": "export default {};\n",
      "package.json": "{}\n",
      "src/app/support/[tenant]/index.ts": `export const graph = async () => ({ version: "healthy" });\n`,
    })
    const routePath = join(appRoot, "src/app/support/[tenant]/index.ts")
    const port = await allocatePort()

    const dev = await startDevProcess({
      cwd: appRoot,
      env: {
        DAWN_DEV_CHILD_STARTUP_DELAY_MS: "250",
      },
      port,
    })
    devProcesses.push(dev)

    await dev.waitForReady()
    await writeFile(
      routePath,
      `export const graph = async () => ({ version: "restart" });\n`,
      "utf8",
    )
    await dev.waitForLog(/Restarting Dawn dev server/)
    await dev.waitForNotReady()

    const blocker = await bindPort(port)
    try {
      const exitCode = await dev.waitForExit()
      expect(exitCode).toBe(1)
      expect(dev.stderr).toContain("Fatal dev session error")
      expect(dev.stderr).toContain(`Port ${port} is unavailable`)
    } finally {
      await blocker.close()
    }
  })

  test("force-kills a stuck child after the shutdown timeout and replaces it", async () => {
    const markerPath = join(tmpdir(), `dawn-dev-stuck-${Date.now()}.txt`)
    const appRoot = await createFixtureApp({
      "dawn.config.ts": "export default {};\n",
      "package.json": "{}\n",
      "src/app/support/[tenant]/index.ts": `
        import { writeFile } from "node:fs/promises";

        export const graph = async () => {
          await writeFile(${JSON.stringify(markerPath)}, "started", "utf8")
          await new Promise(() => {})
        };
      `,
    })
    const routePath = join(appRoot, "src/app/support/[tenant]/index.ts")

    const dev = await startDevProcess({
      cwd: appRoot,
      env: {
        DAWN_DEV_SHUTDOWN_TIMEOUT_MS: "150",
      },
    })
    devProcesses.push(dev)

    const url = await dev.waitForReady()
    const readyCount = dev.readyCount()
    void invokeRunsWait(url, {
      assistantId: "/support/[tenant]#graph",
      input: {},
      mode: "graph",
      routeId: "/support/[tenant]",
      routePath: "src/app/support/[tenant]/index.ts",
    }).catch((error) => error)

    await waitForPath(markerPath)
    await writeFile(
      routePath,
      `export const graph = async () => ({ version: "replaced" });\n`,
      "utf8",
    )

    await dev.waitForLog(/Force-killed stuck dev child/)
    await dev.waitForNextReady(readyCount)

    const replacementResponse = await invokeRunsWait(url, {
      assistantId: "/support/[tenant]#graph",
      input: {},
      mode: "graph",
      routeId: "/support/[tenant]",
      routePath: "src/app/support/[tenant]/index.ts",
    })

    expect(await replacementResponse.json()).toMatchObject({ version: "replaced" })
  })
})

async function createFixtureApp(files: Readonly<Record<string, string>>) {
  const appRoot = await mkdtemp(join(tmpdir(), "dawn-cli-dev-"))
  tempDirs.push(appRoot)

  await Promise.all(
    Object.entries(files).map(async ([relativePath, source]) => {
      const filePath = join(appRoot, relativePath)
      await mkdir(join(filePath, ".."), { recursive: true })
      await writeFile(filePath, source, "utf8")
    }),
  )

  return appRoot
}

async function invokeRunsWait(
  baseUrl: string,
  options: {
    readonly assistantId: string
    readonly input: unknown
    readonly mode: "graph" | "workflow"
    readonly routeId: string
    readonly routePath: string
  },
) {
  return await fetch(new URL("/runs/wait", baseUrl), {
    body: JSON.stringify({
      assistant_id: options.assistantId,
      input: options.input,
      metadata: {
        dawn: {
          mode: options.mode,
          route_id: options.routeId,
          route_path: options.routePath,
        },
      },
      on_completion: "delete",
    }),
    headers: {
      "content-type": "application/json",
    },
    method: "POST",
  })
}

async function allocatePort(): Promise<number> {
  const server = createServer()

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject)
    server.listen(0, "127.0.0.1", () => {
      resolve()
    })
  })

  const address = server.address()

  if (!address || typeof address === "string") {
    throw new Error("Failed to allocate a TCP port")
  }

  const port = address.port

  await new Promise<void>((resolve, reject) => {
    server.close((error) => {
      if (error) {
        reject(error)
        return
      }

      resolve()
    })
  })

  return port
}

async function bindPort(port: number): Promise<{ close: () => Promise<void> }> {
  const server = createServer()

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject)
    server.listen(port, "127.0.0.1", () => {
      resolve()
    })
  })

  return {
    close: async () => {
      await new Promise<void>((resolve, reject) => {
        server.close((error) => {
          if (error) {
            reject(error)
            return
          }

          resolve()
        })
      })
    },
  }
}

function countOccurrences(input: string, needle: string): number {
  return input.split(needle).length - 1
}

async function delay(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms))
}

async function waitForPath(path: string, timeoutMs = 2_000): Promise<void> {
  const startedAt = Date.now()

  while (Date.now() - startedAt < timeoutMs) {
    try {
      await access(path)
      return
    } catch {}

    await delay(25)
  }

  throw new Error(`Timed out waiting for path ${path}`)
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

async function startDevProcess(options: {
  readonly cwd: string
  readonly env?: Readonly<Record<string, string>>
  readonly port?: number
}): Promise<DevProcessHandle> {
  const packageRoot = join(import.meta.dirname, "..")
  const entryPath = join(import.meta.dirname, "..", "src", "index.ts")
  const tsxLoaderPath = join(packageRoot, "node_modules", "tsx", "dist", "loader.mjs")
  const args = ["--import", tsxLoaderPath, entryPath, "dev"]

  if (typeof options.port === "number") {
    args.push("--port", String(options.port))
  }

  const child = spawn(process.execPath, args, {
    cwd: options.cwd,
    env: {
      ...process.env,
      ...(options.env ?? {}),
    },
    stdio: ["ignore", "pipe", "pipe"],
  })

  return new DevProcessHandle(child)
}

class DevProcessHandle {
  readonly child: ChildProcess
  readonly exitPromise: Promise<number | null>
  stderr = ""
  stdout = ""
  private exitCode: number | null | undefined

  constructor(child: ChildProcess) {
    this.child = child
    this.exitPromise = new Promise((resolve, reject) => {
      child.once("error", reject)
      child.once("close", (code) => {
        this.exitCode = code
        resolve(code)
      })
    })

    child.stdout?.on("data", (chunk) => {
      this.stdout += String(chunk)
    })
    child.stderr?.on("data", (chunk) => {
      this.stderr += String(chunk)
    })
  }

  get exited(): boolean {
    return this.exitCode !== undefined
  }

  async stop(): Promise<void> {
    if (this.exited) {
      return
    }

    this.child.kill("SIGTERM")

    const code = await Promise.race([
      this.exitPromise,
      delay(2_000).then(() => {
        this.child.kill("SIGKILL")
        return this.exitPromise
      }),
    ])

    await code
  }

  async waitForExit(): Promise<number | null> {
    return await this.exitPromise
  }

  async waitForLog(pattern: RegExp, timeoutMs = 5_000): Promise<void> {
    const startedAt = Date.now()

    while (Date.now() - startedAt < timeoutMs) {
      if (pattern.test(this.stdout) || pattern.test(this.stderr)) {
        return
      }

      if (this.exited) {
        break
      }

      await delay(25)
    }

    throw new Error(
      `Timed out waiting for log ${pattern}\nSTDOUT:\n${this.stdout}\nSTDERR:\n${this.stderr}`,
    )
  }

  async waitForReady(timeoutMs = 8_000): Promise<string> {
    return await this.waitForNextReady(0, timeoutMs)
  }

  readyCount(): number {
    return countOccurrences(this.stdout, "Dawn dev ready at")
  }

  async waitForNextReady(previousCount: number, timeoutMs = 8_000): Promise<string> {
    const url = await this.waitForPrintedUrl(timeoutMs)
    const startedAt = Date.now()

    while (Date.now() - startedAt < timeoutMs) {
      if (this.readyCount() <= previousCount) {
        if (this.exited) {
          break
        }

        await delay(25)
        continue
      }

      try {
        const response = await fetch(new URL("/healthz", url))

        if (response.status === 200) {
          const body = (await response.json()) as { readonly status?: string }

          if (body.status === "ready") {
            return url
          }
        }
      } catch {}

      if (this.exited) {
        break
      }

      await delay(25)
    }

    throw new Error(
      `Timed out waiting for dawn dev readiness\nSTDOUT:\n${this.stdout}\nSTDERR:\n${this.stderr}`,
    )
  }

  async waitForNotReady(timeoutMs = 5_000): Promise<void> {
    const url = await this.waitForPrintedUrl(timeoutMs)
    const startedAt = Date.now()

    while (Date.now() - startedAt < timeoutMs) {
      try {
        const response = await fetch(new URL("/healthz", url))

        if (response.status !== 200) {
          return
        }
      } catch {
        return
      }

      if (this.exited) {
        return
      }

      await delay(25)
    }

    throw new Error(
      `Timed out waiting for dawn dev to become not-ready\nSTDOUT:\n${this.stdout}\nSTDERR:\n${this.stderr}`,
    )
  }

  private async waitForPrintedUrl(timeoutMs: number): Promise<string> {
    const startedAt = Date.now()

    while (Date.now() - startedAt < timeoutMs) {
      const match = this.stdout.match(/http:\/\/127\.0\.0\.1:\d+/)

      if (match) {
        return match[0]
      }

      if (this.exited) {
        break
      }

      await delay(25)
    }

    throw new Error(
      `Timed out waiting for dawn dev URL\nSTDOUT:\n${this.stdout}\nSTDERR:\n${this.stderr}`,
    )
  }
}
