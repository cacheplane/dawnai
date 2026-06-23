// LIVE SMOKE — long-term memory against a real model. Gated on OPENAI_API_KEY:
// SKIPS in CI (no key) and runs only locally. Never add to a CI lane; never print the key.
import { rmSync } from "node:fs"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import { runMemoryCommand } from "@dawn-ai/cli/runtime"
import { sqliteMemoryStore } from "@dawn-ai/memory"
import { afterEach, beforeEach, expect, it } from "vitest"
import { createAgentHarness } from "../src/harness.js"
import { expectToolCalled } from "../src/matchers.js"

const live = Boolean(process.env.OPENAI_API_KEY)
const probeRoot = fileURLToPath(new URL("./fixtures/probe-app", import.meta.url))
const candidateRoot = fileURLToPath(
  new URL("./fixtures/probe-app-memory-candidate", import.meta.url),
)

function dbPath(root: string): string {
  return join(root, ".dawn", "memory.sqlite")
}
function cleanDb(root: string): void {
  for (const s of ["", "-wal", "-shm"]) rmSync(`${dbPath(root)}${s}`, { force: true })
}
const io = { stdout: () => {}, stderr: () => {} }

beforeEach(() => {
  cleanDb(probeRoot)
  cleanDb(candidateRoot)
})
afterEach(() => {
  cleanDb(probeRoot)
  cleanDb(candidateRoot)
})

it.skipIf(!live)(
  "remembers a fact and recalls it cross-thread (auto mode)",
  async () => {
    const h = await createAgentHarness({
      appRoot: probeRoot,
      route: "/memory-chat#agent",
      live: true,
    })
    try {
      h.reset()
      const r1 = await h.run({
        input: "Remember this durable fact for later: acme escalates billing above 500 dollars.",
      })
      expectToolCalled(r1, "remember")

      const store = sqliteMemoryStore({ path: dbPath(probeRoot) })
      const active = await store.search({
        namespace: "route=/memory-chat",
        status: "active",
        query: "billing",
      })
      expect(active.length).toBeGreaterThanOrEqual(1)

      h.reset()
      const r2 = await h.run({
        input: "Using your long-term memory, what is acme's billing escalation threshold?",
      })
      expectToolCalled(r2, "recall")
      const recall = r2.toolResults.find((t) => t.name === "recall")
      expect(String(recall?.content ?? "")).toContain("500")
      expect(r2.finalMessage).toContain("500")
    } finally {
      await h.close()
    }
  },
  120_000,
)

it.skipIf(!live)(
  "supersedes a contradicting value (auto mode)",
  async () => {
    const h = await createAgentHarness({
      appRoot: probeRoot,
      route: "/memory-chat#agent",
      live: true,
    })
    try {
      h.reset()
      // Pin the identity (subject + predicate) so the real model reuses it on the
      // update — supersession keys on identity, so an explicit prompt makes the
      // machinery (not the model's free-form phrasing) the thing under test.
      await h.run({
        input:
          "Use the remember tool now. data: subject 'acme', predicate 'billing-escalation-threshold', value '500 dollars'.",
      })
      h.reset()
      await h.run({
        input:
          "The threshold changed. Use the remember tool to update it. data: subject 'acme', predicate 'billing-escalation-threshold', value '750 dollars'.",
      })

      const store = sqliteMemoryStore({ path: dbPath(probeRoot) })
      const active = await store.search({
        namespace: "route=/memory-chat",
        status: "active",
        query: "billing",
      })
      // The current value must be active; the old value must NOT still be active.
      // Had the model used a different identity (two ADDs instead of a SUPERSEDE),
      // 500 would remain active and the second assertion would catch it.
      expect(active.some((r) => JSON.stringify(r.data).includes("750"))).toBe(true)
      expect(active.some((r) => JSON.stringify(r.data).includes("500"))).toBe(false)

      h.reset()
      const r = await h.run({
        input: "Recall the current acme billing escalation threshold.",
      })
      expect(String(r.toolResults.find((t) => t.name === "recall")?.content ?? "")).toContain("750")
    } finally {
      await h.close()
    }
  },
  150_000,
)

it.skipIf(!live)(
  "isolates memory by route namespace",
  async () => {
    const a = await createAgentHarness({
      appRoot: probeRoot,
      route: "/memory-chat#agent",
      live: true,
    })
    try {
      a.reset()
      await a.run({
        input: "Remember: the secret code for chat is ALPHA-111.",
      })
    } finally {
      await a.close()
    }
    const b = await createAgentHarness({
      appRoot: probeRoot,
      route: "/memory-other#agent",
      live: true,
    })
    try {
      b.reset()
      const r = await b.run({
        input:
          "Using your memory, what is the secret code for chat? If you have no memory of it, say you don't know.",
      })
      const recall = r.toolResults.find((t) => t.name === "recall")
      expect(String(recall?.content ?? "")).not.toContain("ALPHA-111")
      expect(r.finalMessage).not.toContain("ALPHA-111")
    } finally {
      await b.close()
    }
  },
  150_000,
)

it.skipIf(!live)(
  "injects a memory index into the system prompt once memories exist",
  async () => {
    // Seed the store BEFORE the harness boots so this assertion rides on a known
    // index rather than real-model write variance. (Mid-process refresh of the
    // index hint — a memory written AFTER first materialize — is covered
    // deterministically by memory-index-refresh.test.ts; the materialize cache
    // re-keys on the fragment's cacheKey. The recall tool is always live.)
    const store = sqliteMemoryStore({ path: dbPath(probeRoot) })
    await store.put({
      id: "memory_seed_index",
      kind: "semantic",
      namespace: "route=/memory-chat",
      content: "acme escalates billing above 500 dollars",
      data: {
        subject: "acme",
        predicate: "billing-escalation-threshold",
        value: "500 dollars",
      },
      source: { type: "tool", id: "remember" },
      confidence: 1,
      tags: [],
      status: "active",
      createdAt: "2026-06-19T00:00:00.000Z",
      updatedAt: "2026-06-19T00:00:00.000Z",
    })

    const h = await createAgentHarness({
      appRoot: probeRoot,
      route: "/memory-chat#agent",
      live: true,
    })
    try {
      h.reset()
      const r = await h.run({ input: "Hello." })
      // The memory-index prompt fragment is appended to the system message; it lists
      // the in-scope memories the agent can recall.
      expect(r.systemPrompt).toContain("Long-Term Memory")
    } finally {
      await h.close()
    }
  },
  120_000,
)

it.skipIf(!live)(
  "candidate write is not recalled until approved via dawn memory CLI",
  async () => {
    const store = sqliteMemoryStore({ path: dbPath(candidateRoot) })

    const h1 = await createAgentHarness({
      appRoot: candidateRoot,
      route: "/notes#agent",
      live: true,
    })
    try {
      h1.reset()
      const r1 = await h1.run({
        input: "Remember: this project uses pnpm as its package manager.",
      })
      expectToolCalled(r1, "remember")
    } finally {
      await h1.close()
    }
    const candidates = await store.listCandidates("")
    expect(candidates.length).toBeGreaterThanOrEqual(1)
    const candidateId = candidates[0]!.id

    const h2 = await createAgentHarness({
      appRoot: candidateRoot,
      route: "/notes#agent",
      live: true,
    })
    try {
      h2.reset()
      const r2 = await h2.run({
        input:
          "Recall: what package manager does this project use? Say you don't know if you have no memory.",
      })
      expect(String(r2.toolResults.find((t) => t.name === "recall")?.content ?? "")).not.toContain(
        "pnpm",
      )
    } finally {
      await h2.close()
    }

    await runMemoryCommand(["approve", candidateId], { cwd: candidateRoot }, io)
    expect((await store.get(candidateId))?.status).toBe("active")

    const h3 = await createAgentHarness({
      appRoot: candidateRoot,
      route: "/notes#agent",
      live: true,
    })
    try {
      h3.reset()
      const r3 = await h3.run({
        input: "Recall: what package manager does this project use?",
      })
      expect(String(r3.toolResults.find((t) => t.name === "recall")?.content ?? "")).toContain(
        "pnpm",
      )
    } finally {
      await h3.close()
    }

    await runMemoryCommand(["forget", candidateId], { cwd: candidateRoot }, io)
    expect(await store.get(candidateId)).toBeNull()
  },
  180_000,
)
