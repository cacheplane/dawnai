import { fileURLToPath } from "node:url"
import { afterAll, it } from "vitest"
import { createAgentHarness, expectFinalMessage, expectToolCalled, script } from "../src/index.js"

const appRoot = fileURLToPath(new URL("./fixtures/probe-app", import.meta.url))
const h = await createAgentHarness({ appRoot, route: "/chat#agent" })
afterAll(() => h.close())

it("asserts tool call + final message via the public barrel", async () => {
  const run = await h.run({
    input: "Filter open items",
    fixtures: script()
      .user("Filter open items")
      .callsTool("applyFilter", { status: "open" })
      .replies("Found 2 items."),
  })
  expectToolCalled(run, "applyFilter").withArgs({ status: "open" })
  expectFinalMessage(run).toContain("Found 2")
}, 60_000)
