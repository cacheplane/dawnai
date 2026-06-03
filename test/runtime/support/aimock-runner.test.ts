import { join } from "node:path"
import { afterEach, describe, expect, it } from "vitest"
import { type AimockHandle, startAimock } from "./aimock-runner.js"

describe("startAimock", () => {
  let handle: AimockHandle | undefined
  afterEach(async () => {
    await handle?.stop()
    handle = undefined
  })

  it("starts, serves a /v1 base URL, and replays a fixture", async () => {
    handle = await startAimock({
      fixturePath: join(import.meta.dirname, "../fixtures/aimock/hello.json"),
    })
    expect(handle.baseUrl).toMatch(/^http:\/\/.+\/v1$/)
    const res = await fetch(`${handle.baseUrl}/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: "Bearer test" },
      body: JSON.stringify({ model: "gpt-4o-mini", messages: [{ role: "user", content: "ping" }] }),
    })
    expect(res.status).toBe(200)
    const body = (await res.json()) as { choices: Array<{ message: { content: string } }> }
    expect(body.choices[0]?.message.content).toBe("pong")
  })
})
