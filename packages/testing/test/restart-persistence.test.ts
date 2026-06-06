import { fileURLToPath } from "node:url"
import { expect, it } from "vitest"
import { script, startAimock, startSubprocessApp } from "../src/index.js"

const appRoot = fileURLToPath(new URL("./fixtures/probe-app", import.meta.url))

it("persists thread state across a real dawn dev process restart (Layer C)", async () => {
  const mock = await startAimock({
    fixtures: script().user("remember the number 42").replies("Got it, 42.").build(),
  })
  const env = { OPENAI_BASE_URL: mock.baseUrl, OPENAI_API_KEY: "test-not-used" }

  // --- process #1: create a thread and run one turn ---
  const app1 = await startSubprocessApp({ appRoot, env })
  let threadId: string
  try {
    const created = await fetch(new URL("/threads", app1.baseUrl), {
      method: "POST",
      body: "{}",
      headers: { "content-type": "application/json" },
    })
    threadId = ((await created.json()) as { thread_id: string }).thread_id
    const run = await fetch(new URL(`/threads/${threadId}/runs/wait`, app1.baseUrl), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        route: "/chat#agent",
        input: { messages: [{ role: "user", content: "remember the number 42" }] },
      }),
    })
    expect(run.status, await run.clone().text()).toBe(200)
  } finally {
    await app1.stop()
  }

  // --- process #2: fresh process, same appRoot/sqlite — state must survive ---
  const app2 = await startSubprocessApp({ appRoot, env })
  try {
    const stateRes = await fetch(new URL(`/threads/${threadId}/state`, app2.baseUrl))
    expect(stateRes.status).toBe(200)
    const state = (await stateRes.json()) as {
      values?: { messages?: Array<Record<string, unknown>> }
    }
    const messages = state.values?.messages ?? []
    const humanCount = messages.filter((m) => {
      const id = (m as { id?: string[] }).id
      return Array.isArray(id) && id[2] === "HumanMessage"
    }).length
    expect(
      humanCount,
      `expected the turn-1 human message to persist; got: ${JSON.stringify(messages).slice(0, 400)}`,
    ).toBeGreaterThanOrEqual(1)
  } finally {
    await app2.stop()
    await mock.stop()
  }
}, 180_000)
