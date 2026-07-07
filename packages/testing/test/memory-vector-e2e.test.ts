// Deterministic (aimock) e2e proving the VECTOR/HYBRID recall WIRING end to end
// with a network-free fake embedder. The sibling fixture `probe-app-vector`
// enables `memory.vector.embedder` (an inline bag-of-token-hash embedder,
// id "fake:e2e") so the memory capability embeds writes + queries and the store
// runs its hybrid keyword+vector path. aimock scripts only the model; runtime,
// capability, embedding, SQLite persistence, and search are all real. Runs in
// CI (no API key, no network).
//
// Scope note: the fake embedder is LEXICAL (bag-of-token-hash), so it cannot
// demonstrate zero-token-overlap semantic matching — that is the job of the
// gated live smoke in Task 9. What this test proves deterministically is the
// WIRING: (a) a remember write actually embeds + persists a vector (non-null
// embedding column stamped with the embedder id), and (b) a recall embeds the
// query, runs the hybrid path, and returns the remembered fact.
import { rmSync } from "node:fs"
import { join } from "node:path"
import { DatabaseSync } from "node:sqlite"
import { fileURLToPath } from "node:url"
import { afterAll, beforeAll, expect, it } from "vitest"
import { script } from "../src/fixture-builder.js"
import { createAgentHarness } from "../src/harness.js"

const appRoot = fileURLToPath(new URL("./fixtures/probe-app-vector", import.meta.url))
const dbBase = join(appRoot, ".dawn", "memory.sqlite")
function cleanDb() {
  for (const suffix of ["", "-wal", "-shm"]) rmSync(`${dbBase}${suffix}`, { force: true })
}

beforeAll(cleanDb)
afterAll(cleanDb)

it("embeds + persists a vector on write and recalls it through the hybrid path", async () => {
  const h = await createAgentHarness({ appRoot, route: "/memory-chat#agent" })
  try {
    // (a) Remember through the real agent loop (tool → validate → embed → put).
    // Auto mode → active immediately.
    h.reset()
    await h.run({
      input: "Remember that acme escalates billing above 500 dollars.",
      fixtures: script()
        .user("Remember that acme escalates billing above 500 dollars.")
        .callsTool("remember", {
          data: {
            subject: "acme",
            predicate: "billing-escalation-threshold",
            value: "500 dollars",
          },
          content: "acme escalates billing above 500 dollars",
        })
        .replies("Noted."),
    })

    // Load-bearing wiring proof: open the app's sqlite file directly and assert
    // the persisted row carries a NON-NULL embedding stamped with the embedder id.
    // This proves the write path actually embedded + stored a vector.
    const db = new DatabaseSync(dbBase)
    try {
      const rows = db
        .prepare("SELECT embedding, embedding_model FROM memories WHERE status = 'active'")
        .all() as { embedding: Uint8Array | null; embedding_model: string | null }[]
      expect(rows.length, "the remembered fact must be persisted").toBeGreaterThanOrEqual(1)
      const row = rows[0]
      expect(row?.embedding_model, "write path must stamp the embedder id").toBe("fake:e2e")
      expect(row?.embedding, "write path must persist a non-null embedding").toBeTruthy()
      expect((row?.embedding?.byteLength ?? 0) > 0, "embedding must be non-empty").toBe(true)
    } finally {
      db.close()
    }

    // (b) Recall through the real loop: aimock scripts the CALL; the tool RESULT
    // is real (query embedded → hybrid keyword+vector search → results). The
    // query shares tokens with the stored content so the lexical fake vectors
    // are near.
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
    // ToolMessage content, so the newline-joined string arrives as a quoted JSON
    // string; decode before asserting.
    const raw = String(recall?.content ?? "")
    const text = raw.startsWith('"') ? (JSON.parse(raw) as string) : raw
    expect(text, "hybrid recall must return the remembered fact").toContain(
      "acme escalates billing above 500 dollars",
    )
  } finally {
    await h.close()
  }
}, 60_000)
