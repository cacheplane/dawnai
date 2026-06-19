import { rmSync } from "node:fs"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import { afterAll, beforeAll, expect, it } from "vitest"
import { script } from "../src/fixture-builder.js"
import { createAgentHarness } from "../src/harness.js"

const appRoot = fileURLToPath(new URL("./fixtures/probe-app", import.meta.url))
const dbBase = join(appRoot, ".dawn", "memory.sqlite")
function cleanDb() {
  for (const suffix of ["", "-wal", "-shm"]) rmSync(`${dbBase}${suffix}`, { force: true })
}

beforeAll(cleanDb)
afterAll(cleanDb)

it("remembers a fact in one run and recalls it in a separate run (cross-thread)", async () => {
  const h = await createAgentHarness({ appRoot, route: "/memory-chat#agent" })
  try {
    // Run 1: agent stores the fact (auto mode → active)
    h.reset()
    const stored = await h.run({
      input: "Remember that acme escalates billing above 500.",
      fixtures: script()
        .user("Remember that acme escalates billing above 500.")
        .callsTool("remember", {
          data: { subject: "billing", predicate: "escalate_above", value: "500" },
          content: "acme escalates billing above 500",
        })
        .replies("Noted."),
    })
    expect(stored.finalMessage).toContain("Noted")

    // Run 2: fresh thread; agent recalls it
    h.reset()
    const recalled = await h.run({
      input: "What is acme's billing escalation threshold?",
      fixtures: script()
        .user("What is acme's billing escalation threshold?")
        .callsTool("recall", { query: "billing" })
        .replies("acme escalates billing above 500."),
    })
    // Strong assertion: the recall tool must have returned the stored memory to the model.
    const recallResult = recalled.toolResults.find((t) => t.name === "recall")
    expect(recallResult, "recall tool must have been executed").toBeDefined()
    expect(String(recallResult?.content ?? "")).toContain("acme escalates billing above 500")
    expect(recalled.finalMessage).toContain("500")
  } finally {
    await h.close()
  }
}, 60_000)
