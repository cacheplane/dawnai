import { fileURLToPath } from "node:url"
import { afterAll, expect, it } from "vitest"
import { createAgentHarness } from "../src/harness.js"

const appRoot = fileURLToPath(new URL("./fixtures/probe-app", import.meta.url))
const h = await createAgentHarness({ appRoot, route: "/chat#agent" })
afterAll(() => h.close())

it("constructs: boots aimock, runs typegen, resolves the route", () => {
  expect(h.baseUrl).toMatch(/\/v1$/)
  expect(process.env.OPENAI_BASE_URL).toBe(h.baseUrl)
})

it("disposes via `await using` (no-throw, idempotent close)", async () => {
  const harness = await createAgentHarness({ appRoot, route: "/chat#agent" })
  {
    await using disposable = harness
    expect(disposable.baseUrl).toMatch(/\/v1$/)
  }
  // Dispose delegated to close(); a second explicit close must be a safe no-op.
  await expect(harness.close()).resolves.toBeUndefined()
})
