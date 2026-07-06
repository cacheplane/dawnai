// Deterministic (aimock) e2e for RANKED recall: a relevant-but-old memory must
// outrank a recent-but-marginal one. Under pure-recency (pre-ranking) recall
// this test FAILS — it is the before/after proof for smarter recall. aimock
// scripts only the model; runtime, capability, SQLite, tokenization, and
// ranking are all real. Runs in CI (no API key).
import { rmSync } from "node:fs"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import { sqliteMemoryStore } from "@dawn-ai/memory"
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

it("ranks a relevant-but-old memory above a recent-but-marginal one", async () => {
  // Seed the backdated relevant fact directly: writes through the remember
  // tool always stamp the request time, so age must be seeded at the store.
  const store = sqliteMemoryStore({ path: dbBase })
  const sixWeeksAgo = new Date(Date.now() - 42 * 24 * 60 * 60 * 1000).toISOString()
  await store.put({
    id: "memory_ranktarget",
    kind: "semantic",
    namespace: "route=/memory-chat",
    content: "acme billing escalation threshold is 500 dollars",
    data: { subject: "acme", predicate: "billing-escalation-threshold", value: "500 dollars" },
    source: { type: "tool", id: "remember" },
    confidence: 1,
    tags: [],
    status: "active",
    createdAt: sixWeeksAgo,
    updatedAt: sixWeeksAgo,
  })

  const h = await createAgentHarness({ appRoot, route: "/memory-chat#agent" })
  try {
    // Fresh marginal distractor written through the REAL agent loop
    // (tool → validate → put → reindex), auto mode → active immediately.
    h.reset()
    await h.run({
      input: "Remember that the acme contact jordan prefers slack.",
      fixtures: script()
        .user("Remember that the acme contact jordan prefers slack.")
        .callsTool("remember", {
          data: { subject: "acme-contact", predicate: "prefers", value: "slack" },
          content: "acme contact jordan prefers slack",
        })
        .replies("Noted."),
    })

    // Recall: aimock scripts the CALL; the tool RESULT (and its ordering) is real.
    h.reset()
    const r = await h.run({
      input: "What is acme's billing escalation threshold?",
      fixtures: script()
        .user("What is acme's billing escalation threshold?")
        .callsTool("recall", { query: "acme billing escalation threshold" })
        .replies("The threshold is 500 dollars."),
    })
    const recall = r.toolResults.find((t) => t.name === "recall")
    expect(recall, "recall tool must have been executed").toBeDefined()
    // The runtime JSON-encodes plain (non-{result}-wrapper) tool returns into
    // ToolMessage content (see unwrapToolResult in @dawn-ai/langchain), so the
    // recall tool's newline-joined string arrives as a quoted JSON string with
    // escaped newlines. Decode before splitting; assertions are unchanged.
    const raw = String(recall?.content ?? "")
    const text = raw.startsWith('"') ? (JSON.parse(raw) as string) : raw
    const lines = text.split("\n")
    // Both memories share the "acme" token, so both are in the result set;
    // the SIX-WEEK-OLD relevant fact must be ranked FIRST. Pure recency
    // (the pre-ranking behavior) puts the fresh distractor first instead.
    expect(lines.length).toBeGreaterThanOrEqual(2)
    expect(lines[0]).toContain("memory_ranktarget")
  } finally {
    await h.close()
  }
}, 60_000)
