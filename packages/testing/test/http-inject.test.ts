import { fileURLToPath } from "node:url"
import { expect, it } from "vitest"
import { startAimock } from "../src/aimock-runner.js"
import { script } from "../src/fixture-builder.js"
import { injectAgentProtocol } from "../src/http-inject.js"

const appRoot = fileURLToPath(new URL("./fixtures/probe-app", import.meta.url))

it("creates a thread + runs/wait over the in-process AP pipeline (no port)", async () => {
  const mock = await startAimock({ fixtures: script().user("hello").replies("hi there").build() })
  process.env.OPENAI_BASE_URL = mock.baseUrl
  process.env.OPENAI_API_KEY = "test-not-used"
  const ap = await injectAgentProtocol({ appRoot })
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
    await mock.stop()
  }
}, 60_000)
