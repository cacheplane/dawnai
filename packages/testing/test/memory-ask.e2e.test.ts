// Deterministic (aimock) e2e for memory.writes: "ask" — SUPERSEDE writes (belief
// contradictions) prompt a HITL Once/Always/Deny interrupt (kind "memory"); ADDs
// and idempotent updates flow silently. Mirrors tool-approval.e2e.test.ts's
// structure/conventions. Runs in CI (no API key — aimock).
import { readFileSync, rmSync } from "node:fs"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import { afterEach, beforeEach, expect, it } from "vitest"
import { script } from "../src/fixture-builder.js"
import { createAgentHarness } from "../src/harness.js"
import { expectInterrupt, expectNoInterrupt, expectToolCalled } from "../src/matchers.js"

const askRoot = fileURLToPath(new URL("./fixtures/probe-app-memory-ask", import.meta.url))
const permissionsPath = join(askRoot, ".dawn", "permissions.json")

const NET30 = { subject: "acme", predicate: "payment-terms", value: "net-30" }
const NET45 = { subject: "acme", predicate: "payment-terms", value: "net-45" }
const NET60 = { subject: "acme", predicate: "payment-terms", value: "net-60" }

function cleanPersistedState(): void {
  // Each scenario starts from a clean memory store AND clean permissions —
  // otherwise a prior scenario's "always" persistence or stored fact would
  // leak in (the first write of a scenario must ADD silently, never supersede).
  // "always" also appends a .gitignore inside the fixture (ensureGitignoreEntry)
  // — the fixture has none committed, so removing it keeps the repo clean.
  rmSync(join(askRoot, ".dawn"), { recursive: true, force: true })
  rmSync(join(askRoot, ".gitignore"), { force: true })
}

beforeEach(cleanPersistedState)
afterEach(cleanPersistedState)

const rememberScript = (data: Record<string, string>, content: string, reply: string) =>
  script().user(`remember: ${content}`).callsTool("remember", { data, content }).replies(reply)

it("ADD never interrupts; a contradicting write interrupts with old-vs-new; resume(once) supersedes", async () => {
  const h = await createAgentHarness({ appRoot: askRoot, route: "/notes#agent" })
  try {
    const run1 = await h.run({
      input: "remember: acme prefers net-30",
      fixtures: rememberScript(NET30, "acme prefers net-30", "Noted."),
    })
    expectNoInterrupt(run1)
    expectToolCalled(run1, "remember")

    h.reset()
    const run2 = await h.run({
      input: "remember: acme prefers net-45",
      fixtures: rememberScript(NET45, "acme prefers net-45", "Updated."),
    })
    expectInterrupt(run2).ofKind("memory").withDetail({
      identity: "acme / payment-terms",
      oldContent: "acme prefers net-30",
      newContent: "acme prefers net-45",
    })

    const resumed = await h.resume({ decision: "once" })
    expect(JSON.stringify(resumed)).toContain("Superseded")
  } finally {
    await h.close()
  }
}, 60_000)

it("resume(deny) keeps the old value and reports it to the agent", async () => {
  const h = await createAgentHarness({ appRoot: askRoot, route: "/notes#agent" })
  try {
    await h.run({
      input: "remember: acme prefers net-30",
      fixtures: rememberScript(NET30, "acme prefers net-30", "Noted."),
    })
    h.reset()
    const run = await h.run({
      input: "remember: acme prefers net-45",
      fixtures: rememberScript(NET45, "acme prefers net-45", "Updated."),
    })
    expectInterrupt(run).ofKind("memory")

    const resumed = await h.resume({ decision: "deny" })
    expect(JSON.stringify(resumed)).toContain("Kept existing memory")
  } finally {
    await h.close()
  }
}, 60_000)

it("resume(always) persists the route prefix; a fresh contradiction does not prompt", async () => {
  const h = await createAgentHarness({ appRoot: askRoot, route: "/notes#agent" })
  try {
    await h.run({
      input: "remember: acme prefers net-30",
      fixtures: rememberScript(NET30, "acme prefers net-30", "Noted."),
    })
    h.reset()
    const run = await h.run({
      input: "remember: acme prefers net-45",
      fixtures: rememberScript(NET45, "acme prefers net-45", "Updated."),
    })
    expectInterrupt(run).ofKind("memory")
    await h.resume({ decision: "always" })

    const persisted = JSON.parse(readFileSync(permissionsPath, "utf8")) as {
      allow?: Record<string, string[]>
    }
    expect(persisted.allow?.memory).toContain("workspace=probe-app-memory-ask|route=/notes|")

    h.reset()
    const run3 = await h.run({
      input: "remember: acme prefers net-60",
      fixtures: rememberScript(NET60, "acme prefers net-60", "Updated again."),
    })
    expectNoInterrupt(run3)
    expect(JSON.stringify(run3)).toContain("Superseded")
  } finally {
    await h.close()
  }
}, 60_000)
