import { afterAll, expect, it } from "vitest"
import { startAimock } from "../src/aimock-runner.js"

it("getRecordingsSince windows to a single run (no cross-burst misalignment)", async () => {
  const upstream = await startAimock({
    fixtures: [
      { match: { userMessage: "first" }, response: { content: "ONE" } },
      { match: { userMessage: "second" }, response: { content: "TWO" } },
    ],
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

  const call = async (content: string) => {
    const r = await fetch(`${recorder.baseUrl}/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: "Bearer test" },
      body: JSON.stringify({ model: "gpt-4o-mini", messages: [{ role: "user", content }] }),
    })
    expect(r.ok).toBe(true)
  }

  // Burst 1
  const j0 = 0,
    f0 = recorder.getFixtureCount()
  await call("first")
  const burst1 = recorder.getRecordingsSince(j0, f0)
  expect(burst1).toHaveLength(1)
  expect(burst1[0]?.response).toEqual({ content: "ONE" })
  expect(burst1[0]?.request.messages?.[0]).toEqual({ role: "user", content: "first" })

  // Burst 2 — windowed from AFTER burst 1; must NOT re-surface burst 1 or mis-pair
  const j1 = (recorder.getRequests() as unknown[]).length
  const f1 = recorder.getFixtureCount()
  await call("second")
  const burst2 = recorder.getRecordingsSince(j1, f1)
  expect(burst2).toHaveLength(1)
  expect(burst2[0]?.response).toEqual({ content: "TWO" })
  expect(burst2[0]?.request.messages?.[0]).toEqual({ role: "user", content: "second" })
}, 30_000)

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
