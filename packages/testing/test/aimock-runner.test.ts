import { expect, it } from "vitest"
import { startAimock } from "../src/aimock-runner.js"

it("boots an aimock server on an OS-assigned port and serves the /v1 base url", async () => {
  const mock = await startAimock({ fixtures: [{ match: {}, response: { content: "ok" } }] })
  try {
    expect(mock.port).toBeGreaterThan(0)
    expect(mock.baseUrl).toMatch(/\/v1$/)
    const res = await fetch(new URL("/v1/chat/completions", mock.baseUrl.replace(/\/v1$/, "")), {
      method: "POST",
      headers: { "content-type": "application/json", authorization: "Bearer test" },
      body: JSON.stringify({ model: "gpt-4o-mini", messages: [{ role: "user", content: "hi" }] }),
    })
    expect(res.status).toBe(200)
  } finally {
    await mock.stop()
  }
})

it("stop() is idempotent", async () => {
  const mock = await startAimock({ fixtures: [] })
  await mock.stop()
  await mock.stop()
})

it("exposes received requests via getRequests()", async () => {
  const mock = await startAimock({ fixtures: [{ match: {}, response: { content: "ok" } }] })
  try {
    await fetch(new URL("/v1/chat/completions", mock.baseUrl.replace(/\/v1$/, "")), {
      method: "POST",
      headers: { "content-type": "application/json", authorization: "Bearer test" },
      body: JSON.stringify({
        model: "gpt-4o-mini",
        messages: [
          { role: "system", content: "SYS-MARKER" },
          { role: "user", content: "hi" },
        ],
      }),
    })
    const reqs = mock.getRequests()
    expect(reqs.length).toBeGreaterThanOrEqual(1)
    const last = reqs[reqs.length - 1] as {
      body?: { messages?: { role: string; content: unknown }[] }
    }
    const sys = (last.body?.messages ?? [])
      .filter((m) => m.role === "system")
      .map((m) => m.content)
      .join("\n")
    expect(sys).toContain("SYS-MARKER")
  } finally {
    await mock.stop()
  }
})
