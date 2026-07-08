import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { createServer, type Server } from "node:http"
import type { AddressInfo } from "node:net"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { afterEach, expect, it } from "vitest"
import { createAimock, script } from "../../testing/dist/index.js"
import { createRuntimeRequestListener } from "../src/lib/dev/runtime-server.js"

const cleanup: Array<() => Promise<void> | void> = []

afterEach(async () => {
  for (const fn of cleanup.splice(0).reverse()) await fn()
})

async function fixtureApp(): Promise<string> {
  const appRoot = await mkdtemp(join(tmpdir(), "dawn-agui-"))
  cleanup.push(() => rm(appRoot, { force: true, recursive: true }))
  const files: Record<string, string> = {
    "dawn.config.ts": "export default {}\n",
    "package.json": '{ "name": "agui-fixture", "type": "module" }\n',
    "src/app/chat/index.ts":
      'import { agent } from "@dawn-ai/sdk"\nexport default agent({ model: "gpt-5-mini", systemPrompt: "You are helpful." })\n',
  }
  for (const [rel, body] of Object.entries(files)) {
    const p = join(appRoot, rel)
    await mkdir(join(p, ".."), { recursive: true })
    await writeFile(p, body, "utf8")
  }
  return appRoot
}

it("streams AG-UI events from POST /agui/<route>", async () => {
  const aimock = await createAimock({ fixtures: [] })
  cleanup.push(() => aimock.close())
  const prevBaseUrl = process.env.OPENAI_BASE_URL
  const prevKey = process.env.OPENAI_API_KEY
  process.env.OPENAI_BASE_URL = aimock.baseUrl
  process.env.OPENAI_API_KEY = process.env.OPENAI_API_KEY ?? "test-not-used"
  cleanup.push(() => {
    if (prevBaseUrl === undefined) delete process.env.OPENAI_BASE_URL
    else process.env.OPENAI_BASE_URL = prevBaseUrl
    if (prevKey === undefined) delete process.env.OPENAI_API_KEY
    else process.env.OPENAI_API_KEY = prevKey
  })
  aimock.addFixtures(script().user("hello").replies("Hi there!").build())

  const appRoot = await fixtureApp()
  const { listener, close } = await createRuntimeRequestListener({ appRoot })
  cleanup.push(() => close())

  const server: Server = createServer(listener)
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
  cleanup.push(() => new Promise<void>((resolve) => server.close(() => resolve())))
  const { port } = server.address() as AddressInfo

  const routeKey = encodeURIComponent("/chat#agent")
  const res = await fetch(`http://127.0.0.1:${port}/agui/${routeKey}`, {
    method: "POST",
    headers: { "content-type": "application/json", accept: "text/event-stream" },
    body: JSON.stringify({
      threadId: "th1",
      runId: "rn1",
      state: {},
      messages: [{ id: "1", role: "user", content: "hello" }],
      tools: [],
      context: [],
      forwardedProps: {},
    }),
  })
  const text = await res.text()
  expect(res.status).toBe(200)
  expect(text).toContain('"type":"RUN_STARTED"')
  expect(text).toContain('"type":"TEXT_MESSAGE_CONTENT"')
  expect(text).toContain("Hi there!")
  expect(text).toContain('"type":"RUN_FINISHED"')
}, 60_000)
