/**
 * CORS through the real fetch handler.
 *
 * `cors.test.ts` pins the policy in isolation; this file pins the wiring —
 * that the wrapper covers every exit path (dispatch, 404, and the shutdown
 * 503), that a preflight never reaches the route table, and above all that an
 * app with no `server.cors` is unchanged.
 */

import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { __clearDawnConfigCacheForTests } from "@dawn-ai/core"
import { afterEach, expect, it } from "vitest"
import { createRuntimeFetchHandler } from "../src/lib/dev/runtime-fetch-handler.js"

const ORIGIN = "http://localhost:3010"

const cleanup: Array<() => Promise<void> | void> = []

afterEach(async () => {
  for (const fn of cleanup.splice(0).reverse()) await fn()
  // The config memo is keyed by appRoot and lives for the process; each test
  // here boots a DIFFERENT config from a fresh temp root, so a leftover memo
  // from a previous test would be read instead of this one's.
  __clearDawnConfigCacheForTests()
})

async function bootHandler(configSource: string) {
  const appRoot = await mkdtemp(join(tmpdir(), "dawn-cors-"))
  cleanup.push(() => rm(appRoot, { force: true, maxRetries: 5, recursive: true, retryDelay: 100 }))
  for (const [rel, body] of Object.entries({
    "dawn.config.ts": configSource,
    "package.json": '{ "name": "cors-fixture", "type": "module" }\n',
    "src/app/.gitkeep": "",
  })) {
    const filePath = join(appRoot, rel)
    await mkdir(join(filePath, ".."), { recursive: true })
    await writeFile(filePath, body, "utf8")
  }
  const handler = await createRuntimeFetchHandler({ appRoot })
  cleanup.push(() => handler.close())
  return handler
}

const ALLOWING_CONFIG = `export default { server: { cors: { origins: ["${ORIGIN}"] } } }\n`

it("sends no CORS header at all when server.cors is absent", async () => {
  const handler = await bootHandler("export default {}\n")
  const response = await handler.fetch(
    new Request("http://127.0.0.1:3002/healthz", { headers: { origin: ORIGIN } }),
  )
  expect(response.status).toBe(200)
  expect(response.headers.get("access-control-allow-origin")).toBeNull()
  expect(response.headers.get("vary")).toBeNull()
})

it("leaves OPTIONS falling through to the router's 404 when CORS is off", async () => {
  const handler = await bootHandler("export default {}\n")
  const response = await handler.fetch(
    new Request("http://127.0.0.1:3002/healthz", {
      headers: { origin: ORIGIN, "access-control-request-method": "GET" },
      method: "OPTIONS",
    }),
  )
  expect(response.status).toBe(404)
})

it("stamps an allowed origin onto a normal response", async () => {
  const handler = await bootHandler(ALLOWING_CONFIG)
  const response = await handler.fetch(
    new Request("http://127.0.0.1:3002/healthz", { headers: { origin: ORIGIN } }),
  )
  expect(response.status).toBe(200)
  expect(response.headers.get("access-control-allow-origin")).toBe(ORIGIN)
  expect(response.headers.get("vary")).toBe("Origin")
})

it("answers a preflight without consulting the route table", async () => {
  const handler = await bootHandler(ALLOWING_CONFIG)
  // /agui/... exists only for POST, and there is no OPTIONS route anywhere —
  // a 204 here proves the preflight short-circuits before dispatch.
  const response = await handler.fetch(
    new Request("http://127.0.0.1:3002/agui/%2Fresearch%23agent", {
      headers: {
        origin: ORIGIN,
        "access-control-request-headers": "content-type",
        "access-control-request-method": "POST",
      },
      method: "OPTIONS",
    }),
  )
  expect(response.status).toBe(204)
  expect(response.headers.get("access-control-allow-origin")).toBe(ORIGIN)
  expect(response.headers.get("access-control-allow-methods")).toContain("POST")
  expect(response.headers.get("access-control-allow-headers")).toBe("content-type")
})

it("stamps error responses too, so the browser can read the failure", async () => {
  const handler = await bootHandler(ALLOWING_CONFIG)
  const response = await handler.fetch(
    new Request("http://127.0.0.1:3002/no-such-route", { headers: { origin: ORIGIN } }),
  )
  expect(response.status).toBe(404)
  // Without this the browser reports an opaque CORS failure instead of the
  // 404 the server actually sent — the single most confusing way to debug.
  expect(response.headers.get("access-control-allow-origin")).toBe(ORIGIN)
})

it("stamps the shutdown 503", async () => {
  const handler = await bootHandler(ALLOWING_CONFIG)
  await handler.close()
  const response = await handler.fetch(
    new Request("http://127.0.0.1:3002/healthz", { headers: { origin: ORIGIN } }),
  )
  expect(response.status).toBe(503)
  expect(response.headers.get("access-control-allow-origin")).toBe(ORIGIN)
})

it("ignores an origin that is not on the list", async () => {
  const handler = await bootHandler(ALLOWING_CONFIG)
  const response = await handler.fetch(
    new Request("http://127.0.0.1:3002/healthz", { headers: { origin: "http://evil.test" } }),
  )
  // Still served — the browser is what refuses to hand it to the page. A 403
  // here would break every non-browser client that happens to send an Origin.
  expect(response.status).toBe(200)
  expect(response.headers.get("access-control-allow-origin")).toBeNull()
})

it("refuses to boot on an invalid origin list", async () => {
  await expect(
    bootHandler('export default { server: { cors: { origins: ["not-an-origin"] } } }\n'),
  ).rejects.toThrow(/Invalid server\.cors config/)
})
