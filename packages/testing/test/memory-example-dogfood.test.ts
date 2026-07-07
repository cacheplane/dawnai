// Continuous dogfood of the REAL `examples/memory` app — the same app a user
// runs — driven through a scripted remember → recall flow. Two paths:
//
//   ALWAYS (CI-safe): the default SQLite backend, no key, no Docker. Proves the
//     example's memory route works end to end.
//
//   GATED (DAWN_TEST_PGVECTOR=1, needs Docker): a Testcontainers Postgres set as
//     DATABASE_URL, so the example switches to its pgvector store. Drives the
//     SAME flow and asserts recall works through pgvector. This proves the real
//     example app boots on the pgvector store, writes to Postgres, and recalls
//     end-to-end; the hybrid/vector RANKING quality is proven separately by the
//     pgvector conformance kit + the live smoke.
//
// Each block copies the example app into its OWN throwaway dir under
// `examples/memory/` (so `@dawn-ai/*` still resolves up to the example's
// node_modules) BEFORE creating the harness. This matters because
// `dawn.config.ts` reads the backend env at module-eval time and ESM caches
// modules by URL — a distinct copy URL per block guarantees each config
// evaluates against the right env (SQLite vs pgvector) instead of a cached one.
import { cpSync, mkdtempSync, rmSync } from "node:fs"
import { join } from "node:path"
import { DatabaseSync } from "node:sqlite"
import { fileURLToPath } from "node:url"
import { loadDawnConfig } from "@dawn-ai/core"
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql"
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import { script } from "../src/fixture-builder.js"
import { createAgentHarness } from "../src/harness.js"

// The real example app, resolved from this test file up to the repo.
const exampleRoot = fileURLToPath(new URL("../../../examples/memory/server", import.meta.url))

/** Copy the example app (config + src) into a fresh throwaway dir under the
 *  example so `@dawn-ai/*` resolves up to `examples/memory/node_modules`. */
function copyExampleApp(): string {
  const dir = mkdtempSync(join(exampleRoot, ".tmp-dogfood-"))
  for (const entry of ["dawn.config.ts", "src", "tsconfig.json", "package.json"]) {
    cpSync(join(exampleRoot, entry), join(dir, entry), { recursive: true })
  }
  return dir
}

// Note: under the aimock harness the example's config wires openaiEmbedder (the
// harness injects a dummy OPENAI_API_KEY, and the config gates its embedder on
// that var — exactly as a real keyed user runs it). openaiEmbedder returns
// 1536-dim vectors through aimock, matching the pgvector `vector(1536)` column,
// so the write embeds + persists. This dogfood asserts only that the fact is
// remembered and recalled end to end; hybrid/vector RANKING quality is proven
// separately by the pgvector conformance kit + the live smoke, not here.

/** Scripted remember → recall flow against the notes route. Returns the decoded
 *  recall tool output. */
async function driveRememberRecall(appRoot: string): Promise<string> {
  const h = await createAgentHarness({ appRoot, route: "/notes#agent" })
  try {
    h.reset()
    await h.run({
      input: "Remember that Ada prefers dark roast coffee.",
      fixtures: script()
        .user("Remember that Ada prefers dark roast coffee.")
        .callsTool("remember", {
          data: { subject: "Ada", predicate: "prefers", value: "dark roast coffee" },
          content: "Ada prefers dark roast coffee",
        })
        .replies("Noted."),
    })

    h.reset()
    const r = await h.run({
      input: "What coffee does Ada prefer?",
      fixtures: script()
        .user("What coffee does Ada prefer?")
        .callsTool("recall", { query: "Ada coffee preference" })
        .replies("Ada prefers dark roast coffee."),
    })
    const recall = r.toolResults.find((t) => t.name === "recall")
    expect(recall, "recall tool must have been executed").toBeDefined()
    // Plain (non-{result}) tool returns arrive JSON-encoded into ToolMessage
    // content — decode the quoted string before asserting.
    const raw = String(recall?.content ?? "")
    return raw.startsWith('"') ? (JSON.parse(raw) as string) : raw
  } finally {
    await h.close()
  }
}

// ---- ALWAYS: default SQLite backend (no key, no Docker) --------------------
describe("examples/memory dogfood — SQLite (default backend)", () => {
  let appRoot: string
  beforeAll(() => {
    appRoot = copyExampleApp()
  })
  afterAll(() => {
    if (appRoot) rmSync(appRoot, { recursive: true, force: true })
  })

  it("remembers a fact to .dawn/memory.sqlite and recalls it", async () => {
    const text = await driveRememberRecall(appRoot)

    // Load-bearing persistence proof: the example's own SQLite file holds the row.
    const db = new DatabaseSync(join(appRoot, ".dawn", "memory.sqlite"))
    try {
      const rows = db.prepare("SELECT content FROM memories WHERE status = 'active'").all() as {
        content: string
      }[]
      expect(rows.some((row) => row.content.includes("Ada prefers dark roast coffee"))).toBe(true)
    } finally {
      db.close()
    }

    expect(text, "recall must return the remembered fact").toContain(
      "Ada prefers dark roast coffee",
    )
  }, 60_000)
})

// ---- GATED: real Postgres + pgvector (Docker) -----------------------------
const pgvectorEnabled = process.env.DAWN_TEST_PGVECTOR === "1"

describe.skipIf(!pgvectorEnabled)("examples/memory dogfood — pgvector backend", () => {
  let container: StartedPostgreSqlContainer
  let appRoot: string
  let prevUrl: string | undefined

  beforeAll(async () => {
    container = await new PostgreSqlContainer("pgvector/pgvector:pg16").start()
    // Set DATABASE_URL BEFORE copying/loading the example config so it picks the
    // pgvector store. (The config also wires openaiEmbedder because the harness
    // injects a dummy key — see driveRememberRecall for how the embedding
    // fixture keeps that write dimension-compatible with vector(1536).)
    prevUrl = process.env.DATABASE_URL
    process.env.DATABASE_URL = container.getConnectionUri()
    appRoot = copyExampleApp()
  }, 120_000)

  afterAll(async () => {
    // Close the example's pgvector pool BEFORE stopping the container, or its
    // idle connections raise an unhandled "terminating connection" (57P01) when
    // Postgres goes away. The config module is ESM-cached by URL, so this
    // returns the exact store instance the harness used.
    if (appRoot) {
      try {
        const loaded = await loadDawnConfig({ appRoot })
        const store = loaded.config.memory?.store as { close?: () => Promise<void> } | undefined
        await store?.close?.()
      } catch {
        // best-effort — fall through to container teardown
      }
      rmSync(appRoot, { recursive: true, force: true })
    }
    if (prevUrl === undefined) delete process.env.DATABASE_URL
    else process.env.DATABASE_URL = prevUrl
    await container?.stop()
  })

  it("remembers + recalls through the real pgvector store", async () => {
    const text = await driveRememberRecall(appRoot)
    expect(text, "pgvector recall must return the remembered fact").toContain(
      "Ada prefers dark roast coffee",
    )
  }, 120_000)
})
