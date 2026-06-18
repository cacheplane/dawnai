import { fileURLToPath } from "node:url"
import { expect, it } from "vitest"
import { createAimock } from "../src/aimock-runner.js"
import { script } from "../src/fixture-builder.js"
import { createAgentProtocolInjector } from "../src/http-inject.js"

const appRoot = fileURLToPath(new URL("./fixtures/probe-app", import.meta.url))

it("creates a thread + runs/wait over the in-process AP pipeline (no port)", async () => {
  const mock = await createAimock({ fixtures: script().user("hello").replies("hi there").build() })
  const prevBaseUrl = process.env.OPENAI_BASE_URL
  const prevKey = process.env.OPENAI_API_KEY
  process.env.OPENAI_BASE_URL = mock.baseUrl
  process.env.OPENAI_API_KEY = "test-not-used"
  const ap = await createAgentProtocolInjector({ appRoot })
  try {
    const created = await ap.inject({ method: "POST", url: "/threads", payload: {} })
    expect(created.statusCode).toBe(200)
    const threadId = (JSON.parse(created.body) as { thread_id: string }).thread_id
    expect(threadId).toBeTruthy()

    const run = await ap.inject({
      method: "POST",
      url: `/threads/${threadId}/runs/wait`,
      payload: { route: "/chat#agent", input: { messages: [{ role: "user", content: "hello" }] } },
    })
    expect(run.statusCode, run.body).toBe(200)
    expect(run.body).toContain("hi there")
  } finally {
    await ap.close()
    await mock.close()
    if (prevBaseUrl === undefined) delete process.env.OPENAI_BASE_URL
    else process.env.OPENAI_BASE_URL = prevBaseUrl
    if (prevKey === undefined) delete process.env.OPENAI_API_KEY
    else process.env.OPENAI_API_KEY = prevKey
  }
}, 60_000)

it("disposes the injector via `await using` (no-throw, idempotent close)", async () => {
  const ap = await createAgentProtocolInjector({ appRoot })
  {
    await using disposable = ap
    expect(typeof disposable.inject).toBe("function")
  }
  // Dispose delegated to close(); a second explicit close must be a safe no-op.
  await expect(ap.close()).resolves.toBeUndefined()
}, 60_000)
