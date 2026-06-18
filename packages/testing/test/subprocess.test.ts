import { fileURLToPath } from "node:url"
import { expect, it } from "vitest"
import { createAimock } from "../src/aimock-runner.js"
import { createSubprocessApp } from "../src/subprocess.js"

const appRoot = fileURLToPath(new URL("./fixtures/probe-app", import.meta.url))

it("boots a real dawn dev subprocess and serves the AP", async () => {
  const mock = await createAimock({ fixtures: [{ match: {}, response: { content: "ok" } }] })
  const app = await createSubprocessApp({
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
    await app.close()
    await mock.close()
  }
}, 120_000)

it("disposes the subprocess via `await using` and leaves it unreachable", async () => {
  const mock = await createAimock({ fixtures: [{ match: {}, response: { content: "ok" } }] })
  let baseUrl: string
  try {
    {
      await using app = await createSubprocessApp({
        appRoot,
        env: { OPENAI_BASE_URL: mock.baseUrl, OPENAI_API_KEY: "test-not-used" },
      })
      baseUrl = app.baseUrl
      const res = await fetch(new URL("/healthz", app.baseUrl))
      expect(res.ok).toBe(true)
    }
    // After the block the child process has been killed — the port is gone.
    await expect(fetch(new URL("/healthz", baseUrl))).rejects.toThrow()
  } finally {
    await mock.close()
  }
}, 120_000)
