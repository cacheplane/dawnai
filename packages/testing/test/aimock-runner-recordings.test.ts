import { afterAll, expect, it } from "vitest"
import { startAimock } from "../src/aimock-runner.js"

it("getRecordings() captures a proxied response from a local upstream", async () => {
  const upstream = await startAimock({
    fixtures: [{ match: {}, response: { content: "from upstream" } }],
  })
  const recorder = await startAimock({
    fixtures: [],
    proxy: { openai: upstream.baseUrl.replace(/\/v1$/, "") },
    record: true,
  })
  afterAll(async () => {
    await recorder.stop()
    await upstream.stop()
  })

  const res = await fetch(`${recorder.baseUrl}/chat/completions`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: "Bearer test" },
    body: JSON.stringify({ model: "gpt-4o-mini", messages: [{ role: "user", content: "ping" }] }),
  })
  expect(res.ok).toBe(true)

  const recordings = recorder.getRecordings()
  expect(recordings).toHaveLength(1)
  expect(recordings[0]?.response).toEqual({ content: "from upstream" })
  expect(recordings[0]?.request.messages?.[0]).toEqual({ role: "user", content: "ping" })
}, 30_000)
