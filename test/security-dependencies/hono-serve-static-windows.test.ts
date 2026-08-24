import { readFileSync, realpathSync } from "node:fs"
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import type { Server } from "node:http"
import { createRequire } from "node:module"
import type { AddressInfo } from "node:net"
import { tmpdir } from "node:os"
import { dirname, join, resolve } from "node:path"

import { describe, expect, it } from "vitest"

const repositoryRoot = resolve(import.meta.dirname, "../..")
const secret = "dawn-windows-static-secret"
const serverStartupDeadlineMs = 5_000
const serverShutdownDeadlineMs = 5_000

type JsonRecord = Record<string, unknown>
type Middleware = (...args: unknown[]) => unknown

interface HonoLike {
  readonly fetch: (request: Request) => Promise<Response> | Response
  use(path: string, middleware: Middleware): void
}

interface HonoConstructor {
  new (): HonoLike
}

interface NodeServerModule {
  readonly serve: (
    options: {
      readonly fetch: HonoLike["fetch"]
      readonly hostname: string
      readonly port: number
    },
    listener: (address: AddressInfo) => void,
  ) => Server
}

interface ServeStaticModule {
  readonly serveStatic: (options: { readonly root: string }) => Middleware
}

function requireRecord(value: unknown, label: string): JsonRecord {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} must be an object`)
  }
  return value as JsonRecord
}

function requireString(value: unknown, label: string): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`${label} must be a non-empty string`)
  }
  return value
}

function readManifest(path: string): JsonRecord {
  return requireRecord(JSON.parse(readFileSync(path, "utf8")), path)
}

function findOwningManifest(entryPath: string, packageName: string): string {
  let current = dirname(realpathSync(entryPath))
  for (;;) {
    const candidate = join(current, "package.json")
    try {
      if (readManifest(candidate).name === packageName) return candidate
    } catch (error) {
      if (!(error instanceof Error) || !("code" in error) || error.code !== "ENOENT") {
        throw error
      }
    }
    const parent = dirname(current)
    if (parent === current) {
      throw new Error(`could not find ${packageName} above ${entryPath}`)
    }
    current = parent
  }
}

async function closeServer(server: Server): Promise<void> {
  const shutdownErrors: unknown[] = []
  try {
    server.closeAllConnections()
  } catch (error) {
    shutdownErrors.push(error)
  }
  try {
    await new Promise<void>((resolveClose, reject) => {
      let settled = false
      const finish = (error: unknown | undefined): void => {
        if (settled) return
        settled = true
        clearTimeout(timeout)
        if (error !== undefined) reject(error)
        else resolveClose()
      }
      const timeout = setTimeout(() => {
        server.unref()
        finish(new Error(`Hono server did not close within ${serverShutdownDeadlineMs}ms`))
      }, serverShutdownDeadlineMs)
      try {
        server.close((error) => finish(error))
      } catch (error) {
        finish(error)
      }
    })
  } catch (error) {
    shutdownErrors.push(error)
  }
  if (shutdownErrors.length > 0) {
    server.unref()
    throw new AggregateError(shutdownErrors, "Hono server shutdown failed")
  }
}

describe.skipIf(process.platform !== "win32")(
  "Windows @hono/node-server static path handling",
  () => {
    it("rejects an encoded backslash before static-file authorization can be bypassed", async () => {
      const appManifestPath = resolve(repositoryRoot, "examples/chat/web/package.json")
      const fromApp = createRequire(appManifestPath)
      const runtimeManifestPath = fromApp.resolve("@copilotkit/runtime/package.json")
      const runtimeManifest = readManifest(runtimeManifestPath)
      const runtimeDependencies = requireRecord(
        runtimeManifest.dependencies,
        "CopilotKit runtime dependencies",
      )
      expect(runtimeDependencies["@hono/node-server"]).toBe("^1.13.5")

      const fromRuntime = createRequire(runtimeManifestPath)
      const nodeServerEntry = fromRuntime.resolve("@hono/node-server")
      const serveStaticEntry = fromRuntime.resolve("@hono/node-server/serve-static")
      const honoEntry = fromRuntime.resolve("hono")
      const nodeServerManifestPath = findOwningManifest(nodeServerEntry, "@hono/node-server")
      expect(findOwningManifest(serveStaticEntry, "@hono/node-server")).toBe(nodeServerManifestPath)
      expect(
        requireString(readManifest(nodeServerManifestPath).version, "node-server version"),
      ).toBe("1.19.17")

      const nodeServer = fromRuntime(nodeServerEntry) as NodeServerModule
      const staticModule = fromRuntime(serveStaticEntry) as ServeStaticModule
      const honoModule = fromRuntime(honoEntry) as { readonly Hono: HonoConstructor }
      if (
        typeof nodeServer.serve !== "function" ||
        typeof staticModule.serveStatic !== "function" ||
        typeof honoModule.Hono !== "function"
      ) {
        throw new Error("resolved Hono server modules have an unexpected shape")
      }

      const staticRoot = await mkdtemp(join(tmpdir(), "dawn-hono-windows-"))
      let server: Server | undefined
      let caseFailed = false
      let caseError: unknown
      const cleanupErrors: unknown[] = []
      try {
        const protectedDirectory = join(staticRoot, "static", "admin")
        await mkdir(protectedDirectory, { recursive: true })
        await writeFile(join(protectedDirectory, "secret.txt"), secret, {
          encoding: "utf8",
          flag: "wx",
        })

        const app = new honoModule.Hono()
        app.use("/static/admin/*", async (...args: unknown[]) => {
          const [context, next] = args as [
            { header(name: string, value: string): void },
            () => Promise<void>,
          ]
          context.header("X-Dawn-Authorization-Sentinel", "visited")
          await next()
        })
        app.use("/static/*", staticModule.serveStatic({ root: staticRoot }))

        const startedAddress = await new Promise<AddressInfo>((resolveStarted, reject) => {
          let settled = false
          let timeout: NodeJS.Timeout | undefined
          const finish = (action: (value: AddressInfo) => void, value: AddressInfo): void => {
            if (settled) return
            settled = true
            if (timeout !== undefined) clearTimeout(timeout)
            server?.off("error", onError)
            action(value)
          }
          const onError = (error: unknown): void => {
            if (settled) return
            settled = true
            if (timeout !== undefined) clearTimeout(timeout)
            server?.off("error", onError)
            reject(error)
          }

          timeout = setTimeout(() => {
            if (settled) return
            settled = true
            server?.off("error", onError)
            reject(new Error(`Hono server did not start within ${serverStartupDeadlineMs}ms`))
          }, serverStartupDeadlineMs)
          try {
            server = nodeServer.serve(
              { fetch: app.fetch, hostname: "127.0.0.1", port: 0 },
              (address) => finish(resolveStarted, address),
            )
            if (!settled) server.once("error", onError)
          } catch (error) {
            onError(error)
          }
        })
        expect(startedAddress.address).toBe("127.0.0.1")

        const response = await fetch(
          `http://127.0.0.1:${startedAddress.port}/static/admin%5Csecret.txt`,
          {
            redirect: "error",
            signal: AbortSignal.timeout(5_000),
          },
        )
        const body = await response.text()
        expect(body.length).toBeLessThanOrEqual(4_096)
        expect(response.status).toBe(404)
        expect(response.headers.get("x-dawn-authorization-sentinel")).toBeNull()
        expect(body).not.toContain(secret)
      } catch (error) {
        caseFailed = true
        caseError = error
      } finally {
        if (server !== undefined) {
          try {
            await closeServer(server)
          } catch (error) {
            cleanupErrors.push(error)
          }
        }
        try {
          await rm(staticRoot, { force: true, recursive: true })
        } catch (error) {
          cleanupErrors.push(error)
        }
      }

      if (caseFailed) {
        if (cleanupErrors.length === 0) throw caseError
        throw new AggregateError(
          [caseError, ...cleanupErrors],
          "Windows Hono static-path case and cleanup both failed",
        )
      }
      if (cleanupErrors.length > 0) {
        throw new AggregateError(cleanupErrors, "Windows Hono static-path cleanup failed")
      }
    })
  },
)
