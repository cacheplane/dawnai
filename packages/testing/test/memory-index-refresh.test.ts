// Deterministic (aimock) regression: the long-term-memory INDEX HINT must not go
// stale in a long-running process. The index fragment is built from the active
// store rows at agent-materialize time, and the materialized agent is cached
// per descriptor — so a memory written AFTER the first materialize must still
// surface in the index hint on a later run without a process restart. The
// recall tool is always live; this guards the hint specifically. Runs in CI
// (no API key — aimock).
import { rmSync } from "node:fs"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import { sqliteMemoryStore } from "@dawn-ai/memory"
import { afterEach, beforeEach, expect, it } from "vitest"
import { script } from "../src/fixture-builder.js"
import { createAgentHarness } from "../src/harness.js"

const probeRoot = fileURLToPath(new URL("./fixtures/probe-app", import.meta.url))

function dbPath(root: string): string {
  return join(root, ".dawn", "memory.sqlite")
}
function cleanDb(root: string): void {
  for (const s of ["", "-wal", "-shm"]) rmSync(`${dbPath(root)}${s}`, { force: true })
}

beforeEach(() => cleanDb(probeRoot))
afterEach(() => cleanDb(probeRoot))

it("refreshes the memory index hint when a memory is written mid-process (no restart)", async () => {
  const h = await createAgentHarness({ appRoot: probeRoot, route: "/memory-chat#agent" })
  try {
    // Run 1: empty store → the index fragment renders empty, so no hint.
    // This is also what materializes (and caches) the agent for the process.
    const r1 = await h.run({ input: "Hello.", fixtures: script().user("Hello.").replies("Hi.") })
    expect(r1.systemPrompt).not.toContain("Long-Term Memory")

    // Write a memory AFTER the agent was materialized and cached once.
    const store = sqliteMemoryStore({ path: dbPath(probeRoot) })
    await store.put({
      id: "memory_refresh_probe",
      kind: "semantic",
      namespace: "route=/memory-chat",
      content: "acme escalates billing above 500 dollars",
      data: { subject: "acme", predicate: "billing-escalation-threshold", value: "500 dollars" },
      source: { type: "tool", id: "remember" },
      confidence: 1,
      tags: [],
      status: "active",
      createdAt: "2026-06-20T00:00:00.000Z",
      updatedAt: "2026-06-20T00:00:00.000Z",
    })

    // Run 2: same process, cached agent. The index hint must now appear —
    // i.e. the materialize cache re-keyed on the changed memory content.
    h.reset()
    const r2 = await h.run({
      input: "Hello again.",
      fixtures: script().user("Hello again.").replies("Hi."),
    })
    expect(r2.systemPrompt).toContain("Long-Term Memory")
  } finally {
    await h.close()
  }
}, 60_000)
