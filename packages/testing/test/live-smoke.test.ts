// LIVE: hits the real model via aimock proxy-record. Gated on OPENAI_API_KEY,
// so it SKIPS in CI (no key secret) and runs only locally with a real key.
import { fileURLToPath } from "node:url"
import { afterAll, expect, it } from "vitest"
import { createAgentHarness, expectToolCalled } from "../src/index.js"

const appRoot = fileURLToPath(new URL("./fixtures/probe-app", import.meta.url))

it.skipIf(!process.env.OPENAI_API_KEY)(
  "live: the real model drives the applyFilter tool",
  async () => {
    const h = await createAgentHarness({ appRoot, route: "/chat#agent", live: true })
    try {
      const run = await h.run({ input: "Filter the open items, please." })
      expectToolCalled(run, "applyFilter") // real model should call the tool
      expect(run.finalMessage.length).toBeGreaterThan(0)
      expect(run.systemPrompt.length).toBeGreaterThan(0) // proxy-record retains systemPrompt
    } finally {
      await h.close()
    }
  },
  120_000,
)
