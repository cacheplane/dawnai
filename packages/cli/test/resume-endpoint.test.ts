import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { afterEach, beforeEach, describe, expect, test } from "vitest"

import { startRuntimeServer } from "../src/lib/dev/runtime-server.js"
import { __resetPendingForTests, setPending } from "../src/lib/runtime/pending-interrupts.js"

const tempDirs: string[] = []
const servers: Array<{ close: () => Promise<void> }> = []

beforeEach(() => {
  __resetPendingForTests()
})

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { force: true, recursive: true })))
  await Promise.all(servers.splice(0).map((server) => server.close()))
})

describe("POST /threads/:thread_id/resume", () => {
  test("returns 200 and invokes resolve when interrupt_id matches", async () => {
    const appRoot = await createFixtureApp({
      "dawn.config.ts": "export default {};\n",
      "package.json": "{}\n",
      "src/app/noop/index.ts": "export const graph = async () => ({ ok: true });\n",
    })
    const server = await startRuntimeServer({ appRoot })
    servers.push(server)

    let resolvedWith: string | undefined
    setPending("thread-1", {
      interruptId: "perm-abc",
      resolve: (decision) => {
        resolvedWith = decision
      },
    })

    const response = await fetch(new URL("/threads/thread-1/resume", server.url), {
      body: JSON.stringify({ interrupt_id: "perm-abc", decision: "once" }),
      headers: { "content-type": "application/json" },
      method: "POST",
    })

    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({ ok: true })
    expect(resolvedWith).toBe("once")
  })

  test("returns 409 when interrupt_id is stale", async () => {
    const appRoot = await createFixtureApp({
      "dawn.config.ts": "export default {};\n",
      "package.json": "{}\n",
      "src/app/noop/index.ts": "export const graph = async () => ({ ok: true });\n",
    })
    const server = await startRuntimeServer({ appRoot })
    servers.push(server)

    setPending("thread-2", {
      interruptId: "perm-current",
      resolve: () => {
        throw new Error("resolve should not fire for stale interrupt_id")
      },
    })

    const response = await fetch(new URL("/threads/thread-2/resume", server.url), {
      body: JSON.stringify({ interrupt_id: "perm-old", decision: "once" }),
      headers: { "content-type": "application/json" },
      method: "POST",
    })

    expect(response.status).toBe(409)
    const body = (await response.json()) as { error?: { message?: string } }
    expect(body.error?.message).toMatch(/stale/i)
  })

  test("returns 400 when no pending interrupt exists for the thread", async () => {
    const appRoot = await createFixtureApp({
      "dawn.config.ts": "export default {};\n",
      "package.json": "{}\n",
      "src/app/noop/index.ts": "export const graph = async () => ({ ok: true });\n",
    })
    const server = await startRuntimeServer({ appRoot })
    servers.push(server)

    const response = await fetch(new URL("/threads/missing-thread/resume", server.url), {
      body: JSON.stringify({ interrupt_id: "perm-x", decision: "deny" }),
      headers: { "content-type": "application/json" },
      method: "POST",
    })

    expect(response.status).toBe(400)
    const body = (await response.json()) as { error?: { message?: string } }
    expect(body.error?.message).toMatch(/no parked interrupt/i)
  })

  test("returns 400 when decision is not one of once/always/deny", async () => {
    const appRoot = await createFixtureApp({
      "dawn.config.ts": "export default {};\n",
      "package.json": "{}\n",
      "src/app/noop/index.ts": "export const graph = async () => ({ ok: true });\n",
    })
    const server = await startRuntimeServer({ appRoot })
    servers.push(server)

    setPending("thread-3", { interruptId: "p1", resolve: () => undefined })

    const response = await fetch(new URL("/threads/thread-3/resume", server.url), {
      body: JSON.stringify({ interrupt_id: "p1", decision: "bogus" }),
      headers: { "content-type": "application/json" },
      method: "POST",
    })

    expect(response.status).toBe(400)
  })
})

async function createFixtureApp(files: Readonly<Record<string, string>>) {
  const appRoot = await mkdtemp(join(tmpdir(), "dawn-cli-resume-"))
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
