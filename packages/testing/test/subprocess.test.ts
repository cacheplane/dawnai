import { fileURLToPath } from "node:url"
import { expect, it } from "vitest"
import { startAimock } from "../src/aimock-runner.js"
import { startSubprocessApp } from "../src/subprocess.js"

const appRoot = fileURLToPath(new URL("./fixtures/probe-app", import.meta.url))

it("boots a real dawn dev subprocess and serves the AP", async () => {
  const mock = await startAimock({ fixtures: [{ match: {}, response: { content: "ok" } }] })
  const app = await startSubprocessApp({
    appRoot,
    env: { OPENAI_BASE_URL: mock.baseUrl, OPENAI_API_KEY: "test-not-used" },
  })
  try {
    const res = await fetch(new URL("/threads", app.baseUrl), {
      method: "POST",
      body: "{}",
      headers: { "content-type": "application/json" },
    })
    expect(res.status).toBe(200)
    const body = (await res.json()) as { thread_id?: string }
    expect(body.thread_id).toBeTruthy()
  } finally {
    await app.stop()
    await mock.stop()
  }
}, 120_000)
