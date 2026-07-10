import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { afterEach, describe, expect, test } from "vitest"

import { startRuntimeServer } from "../src/lib/dev/runtime-server.js"

const tempDirs: string[] = []
const servers: Array<{ close: () => Promise<void> }> = []

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => server.close()))
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { force: true, recursive: true })))
})

describe("startRuntimeServer host binding", () => {
  test("binds an explicit 127.0.0.1 host and reports a dialable url", async () => {
    const appRoot = await createFixtureApp({
      "dawn.config.ts": "export default {};\n",
      "package.json": "{}\n",
      "src/app/support/[tenant]/index.ts": `export const graph = async () => ({ ok: true });\n`,
    })

    const server = await startRuntimeServer({ appRoot, host: "127.0.0.1", port: 0 })
    servers.push(server)

    expect(server.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/)
  })

  test("binds 0.0.0.0 but still reports a dialable 127.0.0.1 url", async () => {
    const appRoot = await createFixtureApp({
      "dawn.config.ts": "export default {};\n",
      "package.json": "{}\n",
      "src/app/support/[tenant]/index.ts": `export const graph = async () => ({ ok: true });\n`,
    })

    const server = await startRuntimeServer({ appRoot, host: "0.0.0.0", port: 0 })
    servers.push(server)

    expect(server.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/)
    expect(server.url).not.toContain("0.0.0.0")

    const response = await fetch(new URL("/healthz", server.url))
    expect(response.status).toBe(200)
  })

  test("brackets an IPv6 loopback host in the reported url", async () => {
    const appRoot = await createFixtureApp({
      "dawn.config.ts": "export default {};\n",
      "package.json": "{}\n",
      "src/app/support/[tenant]/index.ts": `export const graph = async () => ({ ok: true });\n`,
    })

    const server = await startRuntimeServer({ appRoot, host: "::1", port: 0 })
    servers.push(server)

    expect(server.url).toMatch(/^http:\/\/\[::1\]:\d+$/)

    const response = await fetch(new URL("/healthz", server.url))
    expect(response.status).toBe(200)
  })

  test("maps the IPv6 wildcard :: to a dialable [::1] url", async () => {
    const appRoot = await createFixtureApp({
      "dawn.config.ts": "export default {};\n",
      "package.json": "{}\n",
      "src/app/support/[tenant]/index.ts": `export const graph = async () => ({ ok: true });\n`,
    })

    const server = await startRuntimeServer({ appRoot, host: "::", port: 0 })
    servers.push(server)

    expect(server.url).toMatch(/^http:\/\/\[::1\]:\d+$/)
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
