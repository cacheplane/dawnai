import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { afterEach, describe, expect, test } from "vitest"

import { serveRuntime } from "../src/lib/dev/serve-runtime.js"

const tempDirs: string[] = []
const handles: Array<{ close: () => Promise<void> }> = []

afterEach(async () => {
  await Promise.all(handles.splice(0).map((handle) => handle.close()))
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { force: true, recursive: true })))
})

describe("serveRuntime", () => {
  test("boots the runtime server and serves healthz", async () => {
    const appRoot = await createFixtureApp({
      "dawn.config.ts": "export default {};\n",
      "package.json": "{}\n",
      "src/app/support/[tenant]/index.ts": `export const graph = async () => ({ ok: true });\n`,
    })

    const handle = await serveRuntime({
      appRoot,
      host: "127.0.0.1",
      installSignalHandlers: false,
      port: 0,
    })
    handles.push(handle)

    expect(handle.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/)

    const response = await fetch(new URL("/healthz", handle.url))
    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({ status: "ready" })
  })

  test("does not register process signal handlers when installSignalHandlers is omitted", async () => {
    const appRoot = await createFixtureApp({
      "dawn.config.ts": "export default {};\n",
      "package.json": "{}\n",
      "src/app/support/[tenant]/index.ts": `export const graph = async () => ({ ok: true });\n`,
    })

    const sigtermBefore = process.listenerCount("SIGTERM")
    const sigintBefore = process.listenerCount("SIGINT")

    const handle = await serveRuntime({ appRoot, host: "127.0.0.1", port: 0 })
    handles.push(handle)

    expect(process.listenerCount("SIGTERM")).toBe(sigtermBefore)
    expect(process.listenerCount("SIGINT")).toBe(sigintBefore)
  })

  test("registers idempotent signal handlers and removes them after close() when opted in", async () => {
    const appRoot = await createFixtureApp({
      "dawn.config.ts": "export default {};\n",
      "package.json": "{}\n",
      "src/app/support/[tenant]/index.ts": `export const graph = async () => ({ ok: true });\n`,
    })

    const sigtermBefore = process.listenerCount("SIGTERM")
    const sigintBefore = process.listenerCount("SIGINT")

    const handle = await serveRuntime({
      appRoot,
      host: "127.0.0.1",
      installSignalHandlers: true,
      port: 0,
    })

    expect(process.listenerCount("SIGTERM")).toBe(sigtermBefore + 1)
    expect(process.listenerCount("SIGINT")).toBe(sigintBefore + 1)

    await handle.close()

    expect(process.listenerCount("SIGTERM")).toBe(sigtermBefore)
    expect(process.listenerCount("SIGINT")).toBe(sigintBefore)

    // close() must be safe to call again (idempotent).
    await handle.close()
  })
})

async function createFixtureApp(files: Readonly<Record<string, string>>) {
  const appRoot = await mkdtemp(join(tmpdir(), "dawn-cli-serve-"))
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
