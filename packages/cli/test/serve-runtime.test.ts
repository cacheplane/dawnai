import { existsSync } from "node:fs"
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { afterEach, describe, expect, test } from "vitest"
import { createAimock, script } from "../../testing/dist/index.js"

import { resolveServePort, serveRuntime } from "../src/lib/dev/serve-runtime.js"

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

  test("boots without running typegen (never writes .dawn artifacts)", async () => {
    // Fixture app with NO prior .dawn/ — a read-only-rootfs production container
    // must boot without writing anything under .dawn (typegen would EROFS).
    const appRoot = await createFixtureApp({
      "dawn.config.ts": "export default {};\n",
      "package.json": "{}\n",
      "src/app/support/[tenant]/index.ts": `export const graph = async () => ({ ok: true });\n`,
    })

    expect(existsSync(join(appRoot, ".dawn"))).toBe(false)

    const handle = await serveRuntime({
      appRoot,
      host: "127.0.0.1",
      installSignalHandlers: false,
      port: 0,
    })
    handles.push(handle)

    const response = await fetch(new URL("/healthz", handle.url))
    expect(response.status).toBe(200)

    // The serve boot must NOT have generated route types.
    expect(existsSync(join(appRoot, ".dawn/dawn.generated.d.ts"))).toBe(false)
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

  test("serves canonical AG-UI events through production assembly", async () => {
    const aimock = await createAimock({ fixtures: [] })
    aimock.addFixtures(script().user("hello production").replies("Hello from serveRuntime").build())
    const previousBaseUrl = process.env.OPENAI_BASE_URL
    const previousKey = process.env.OPENAI_API_KEY
    process.env.OPENAI_BASE_URL = aimock.baseUrl
    process.env.OPENAI_API_KEY = "test-not-used"
    const appRoot = await createFixtureApp({
      "dawn.config.ts": "export default {};\n",
      "package.json": '{ "type": "module" }\n',
      "src/app/chat/index.ts":
        'import { agent } from "@dawn-ai/sdk";\nexport default agent({ model: "gpt-5-mini", systemPrompt: "You are helpful." });\n',
    })

    try {
      const handle = await serveRuntime({
        appRoot,
        host: "127.0.0.1",
        installSignalHandlers: false,
        port: 0,
      })
      handles.push(handle)
      const response = await fetch(new URL("/agui/%2Fchat%23agent", handle.url), {
        method: "POST",
        headers: { "content-type": "application/json", accept: "text/event-stream" },
        body: JSON.stringify({
          context: [],
          forwardedProps: {},
          messages: [{ id: "1", role: "user", content: "hello production" }],
          runId: "production-run",
          state: {},
          threadId: "production-thread",
          tools: [],
        }),
      })
      const text = await response.text()

      expect(response.status).toBe(200)
      expect(text).toContain('"type":"RUN_STARTED"')
      expect(text).toContain('"type":"TEXT_MESSAGE_CONTENT"')
      expect(text).toContain('"delta":"Hello from serveRuntime"')
      expect(text).toContain('"type":"RUN_FINISHED"')
      expect(text).not.toContain('"type":"CUSTOM"')
      expect(text).not.toContain('"type":"STATE_SNAPSHOT"')
    } finally {
      await aimock.close()
      if (previousBaseUrl === undefined) delete process.env.OPENAI_BASE_URL
      else process.env.OPENAI_BASE_URL = previousBaseUrl
      if (previousKey === undefined) delete process.env.OPENAI_API_KEY
      else process.env.OPENAI_API_KEY = previousKey
    }
  }, 60_000)
})

describe("resolveServePort", () => {
  test("empty PORT env resolves to the 8000 default (not a random port)", () => {
    expect(resolveServePort(undefined, "")).toBe(8000)
  })

  test("unset PORT env resolves to the 8000 default", () => {
    expect(resolveServePort(undefined, undefined)).toBe(8000)
  })

  test("non-numeric PORT env resolves to the 8000 default", () => {
    expect(resolveServePort(undefined, "not-a-number")).toBe(8000)
  })

  test("numeric PORT env is honored", () => {
    expect(resolveServePort(undefined, "3000")).toBe(3000)
  })

  test("explicit port always wins, including 0 for a random port", () => {
    expect(resolveServePort(0, "8000")).toBe(0)
    expect(resolveServePort(5555, "")).toBe(5555)
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
