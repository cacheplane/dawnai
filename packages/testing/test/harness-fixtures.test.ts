import { fileURLToPath } from "node:url"
import { afterAll, expect, it } from "vitest"
import { script } from "../src/fixture-builder.js"
import { createAgentHarness } from "../src/harness.js"
import { expectToolCalled } from "../src/matchers.js"

const appRoot = fileURLToPath(new URL("./fixtures/probe-app", import.meta.url))
const h = await createAgentHarness({ appRoot, route: "/chat#agent" })
afterAll(() => h.close())

it("runs a scripted tool round end-to-end in-process", async () => {
  const run = await h.run({
    input: "Filter open items",
    fixtures: script()
      .user("Filter open items")
      .callsTool("applyFilter", { status: "open" })
      .replies("Found 2."),
  })
  expect(run.finalMessage).toContain("Found 2")
  expectToolCalled(run, "applyFilter").withArgs({ status: "open" })
  expect(run.toolCalls).toHaveLength(1)
}, 60_000)

it("supports a second run() with new fixtures on the same persistent aimock (multi-turn)", async () => {
  // Reset to a fresh thread so the accumulated assistant/tool messages from
  // test 1 don't interfere with the turnIndex / hasToolResult matchers.
  // The important invariant being proven: aimock is NOT restarted between runs
  // (same port, no dead-port cache bug) and addFixtures() appends live.
  h.reset()
  const run2 = await h.run({
    input: "Now filter closed items",
    fixtures: script()
      .user("Now filter closed items")
      .callsTool("applyFilter", { status: "closed" })
      .replies("Found 0 closed."),
  })
  expectToolCalled(run2, "applyFilter").withArgs({ status: "closed" })
  expect(run2.finalMessage).toContain("Found 0")
}, 60_000)

it("reset() isolates fixtures across scenarios — a wildcard fixture does not leak", async () => {
  // Run 1 registers a wildcard turn-0 fixture (no userMessage) — mirrors a raw
  // FixtureSet like the offload pattern. Before the fix, addFixtures() only
  // appended and reset() only swapped the threadId, so this fixture stayed
  // registered and shadowed every later run's turn-0 call (findFixture is
  // first-match-in-array-order with no specificity preference).
  h.reset()
  const run1 = await h.run({
    input: "alpha",
    fixtures: [
      { match: { turnIndex: 0, hasToolResult: false }, response: { content: "RUN_1_WILDCARD" } },
    ],
  })
  expect(run1.finalMessage).toBe("RUN_1_WILDCARD")

  h.reset()
  const run2 = await h.run({
    input: "bravo",
    fixtures: script().user("bravo").replies("RUN_2_OWN"),
  })
  // The run-1 wildcard must NOT serve this run; reset() clears it.
  expect(run2.finalMessage).toBe("RUN_2_OWN")
}, 60_000)

it("captures the system prompt the model received", async () => {
  h.reset()
  const run = await h.run({
    input: "hello there",
    fixtures: script().user("hello there").replies("hi"),
  })
  expect(run.systemPrompt).toContain("test agent") // probe app agent systemPrompt: "You are a test agent..."
}, 60_000)

it("exposes a resume method", () => {
  expect(typeof h.resume).toBe("function")
})
