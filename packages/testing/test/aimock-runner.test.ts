import { expect, it } from "vitest"
import { createAimock } from "../src/aimock-runner.js"

it("boots an aimock server on an OS-assigned port and serves the /v1 base url", async () => {
  const mock = await createAimock({ fixtures: [{ match: {}, response: { content: "ok" } }] })
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
    await mock.close()
  }
})

it("accepts a proxy option and exposes the journal", async () => {
  const mock = await createAimock({ fixtures: [], proxy: { openai: "https://api.openai.com" } })
  try {
    expect(mock.baseUrl).toMatch(/\/v1$/)
    expect(Array.isArray(mock.getRequests())).toBe(true)
  } finally {
    await mock.close()
  }
})

it("close() is idempotent", async () => {
  const mock = await createAimock({ fixtures: [] })
  await mock.close()
  await mock.close()
})

it("disposes via `await using` and leaves the mock unreachable", async () => {
  let baseUrl: string
  {
    await using mock = await createAimock({ fixtures: [] })
    baseUrl = mock.baseUrl
    expect(mock.port).toBeGreaterThan(0)
  }
  // After the block, the server has been stopped — the URL is no longer reachable.
  await expect(fetch(`${baseUrl}/models`)).rejects.toThrow()
})

it("exposes received requests via getRequests()", async () => {
  const mock = await createAimock({ fixtures: [{ match: {}, response: { content: "ok" } }] })
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
    await mock.close()
  }
})
