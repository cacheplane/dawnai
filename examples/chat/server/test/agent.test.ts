import { fileURLToPath } from "node:url"
import { afterAll, it } from "vitest"
import { createAgentHarness, expectFinalMessage, script } from "@dawn-ai/testing"

const appRoot = fileURLToPath(new URL("..", import.meta.url))
const h = await createAgentHarness({ appRoot, route: "/chat#agent" })
afterAll(() => h.close())

it("greets the user", async () => {
  const run = await h.run({ input: "hello", fixtures: script().user("hello").replies("Hi! How can I help?") })
  expectFinalMessage(run).toContain("help")
}, 60_000)
