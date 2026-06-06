import { fileURLToPath } from "node:url"
import { afterEach, beforeEach, expect, it } from "vitest"
import { createAgentHarness } from "../src/harness.js"
const appRoot = fileURLToPath(new URL("./fixtures/probe-app", import.meta.url))
let savedKey: string | undefined
beforeEach(() => { savedKey = process.env.OPENAI_API_KEY })
afterEach(() => { if (savedKey === undefined) delete process.env.OPENAI_API_KEY; else process.env.OPENAI_API_KEY = savedKey })
it("live mode throws when OPENAI_API_KEY is absent", async () => {
  delete process.env.OPENAI_API_KEY
  await expect(createAgentHarness({ appRoot, route: "/chat#agent", live: true })).rejects.toThrow(/OPENAI_API_KEY/)
})
