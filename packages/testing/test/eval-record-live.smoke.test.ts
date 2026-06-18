// LIVE: records real-model fixtures via aimock record mode. Gated on OPENAI_API_KEY,
// so it SKIPS in CI (no key secret) and runs only locally with a real key.
import { fileURLToPath } from "node:url"
import { afterAll, expect, it } from "vitest"
import { createAgentHarness } from "../src/harness.js"

const appRoot = fileURLToPath(new URL("./fixtures/probe-app", import.meta.url))
const live = Boolean(process.env.OPENAI_API_KEY)

it.skipIf(!live)(
  "records real-model fixtures and re-keys them with turnIndex",
  async () => {
    const h = await createAgentHarness({ appRoot, route: "/chat#agent", record: true })
    afterAll(() => h.close())
    await h.run({ input: "Say the single word ready." })
    const fixtures = h.getRecordedFixtures()
    expect(fixtures.length).toBeGreaterThanOrEqual(1)
    expect(fixtures[0]?.match.turnIndex).toBe(0)
    expect(fixtures[0]?.response).toBeDefined()
  },
  60_000,
)
