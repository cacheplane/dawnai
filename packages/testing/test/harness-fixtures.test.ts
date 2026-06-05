import { fileURLToPath } from "node:url"
import { afterAll, expect, it } from "vitest"
import { createAgentHarness } from "../src/harness.js"
import { script } from "../src/fixture-builder.js"

const appRoot = fileURLToPath(new URL("./fixtures/probe-app", import.meta.url))
const h = await createAgentHarness({ appRoot, route: "/chat#agent" })
afterAll(() => h.close())

it("runs a scripted tool round end-to-end in-process", async () => {
  const run = await h.run({
    input: "Filter open items",
    fixtures: script().user("Filter open items").callsTool("applyFilter", { status: "open" }).replies("Found 2."),
  })
  expect(run.finalMessage).toContain("Found 2")
}, 60_000)
