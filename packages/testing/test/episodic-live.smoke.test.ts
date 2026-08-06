// LIVE SMOKE — episodic memory against a real model. Gated on OPENAI_API_KEY:
// SKIPS in CI (no key) and runs only locally. Never add to a CI lane; never print the key.
import { rmSync } from "node:fs"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import { afterEach, beforeEach, expect, it } from "vitest"
import { createAgentHarness } from "../src/harness.js"
import { expectToolCalled } from "../src/matchers.js"

const live = Boolean(process.env.OPENAI_API_KEY)
// Probe app with the runtime episode recorder enabled (episodes: { enabled: true }).
const episodicRoot = fileURLToPath(new URL("./fixtures/probe-app-episodic", import.meta.url))

function dbPath(root: string): string {
  return join(root, ".dawn", "memory.sqlite")
}
function cleanDb(root: string): void {
  for (const s of ["", "-wal", "-shm"]) rmSync(`${dbPath(root)}${s}`, { force: true })
}

beforeEach(() => {
  cleanDb(episodicRoot)
})
afterEach(() => {
  cleanDb(episodicRoot)
})

it.skipIf(!live)(
  "episodic recall: the agent answers what it did recently from recorded episodes",
  async () => {
    const h = await createAgentHarness({
      appRoot: episodicRoot,
      route: "/memory-chat#agent",
      live: true,
    })
    try {
      // Two completed runs with distinctive inputs — the auto-recorder writes
      // one episodic memory per run (input, outcome, tools used, duration).
      h.reset()
      await h.run({
        input: "Check the deployment status of service alpha-rocket",
      })
      h.reset()
      await h.run({
        input: "Summarize the billing report for acme-corp",
      })

      // Third run, fresh thread: ask what happened recently. The model must
      // drive recall's time window itself (since "-24h"); the recorded episodes
      // — not conversation state — are the only place the earlier inputs live.
      h.reset()
      const r = await h.run({
        input:
          'Using your long-term memory with recall\'s since parameter set to "-24h", what did you do in the last day?',
      })
      expectToolCalled(r, "recall")
      // A distinctive token from at least one earlier input must surface from
      // the recall tool result (or the model's summary of it).
      const recall = String(r.toolResults.find((t) => t.name === "recall")?.content ?? "")
      expect(`${recall}\n${r.finalMessage}`).toMatch(/alpha-rocket|acme-corp/)
    } finally {
      await h.close()
    }
  },
  180_000,
)
