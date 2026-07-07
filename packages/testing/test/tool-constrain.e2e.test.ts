// Deterministic (aimock) e2e for argument-level tool constraints (tools.constrain).
// The probe-app constrain-chat route runs a per-call predicate against the tool
// args: env "staging" → true (allow), env "prod" → { approve: true } (fires a
// LangGraph interrupt of kind "tool"), anything else → a deny string returned as
// the tool RESULT. The escalation path's resume("always") would persist
// allow.tool into <appRoot>/.dawn/permissions.json, so clean it between
// scenarios. Runs in CI (no API key — aimock).
import { rmSync } from "node:fs"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import { afterEach, beforeEach, expect, it } from "vitest"
import { script } from "../src/fixture-builder.js"
import { createAgentHarness } from "../src/harness.js"
import { expectInterrupt, expectNoInterrupt, expectToolCalled } from "../src/matchers.js"
import type { AgentRunResult } from "../src/run-result.js"

const probeRoot = fileURLToPath(new URL("./fixtures/probe-app", import.meta.url))
const permissionsPath = join(probeRoot, ".dawn", "permissions.json")

function cleanPersistedState(): void {
  // The { approve: true } escalation, if resumed "always", persists allow.tool
  // into permissions.json and would leak across scenarios. It also appends a
  // .gitignore inside the probe app (ensureGitignoreEntry) — the fixture has
  // none committed, so removing it keeps the repo clean.
  rmSync(permissionsPath, { force: true })
  rmSync(join(probeRoot, ".gitignore"), { force: true })
}

beforeEach(cleanPersistedState)
afterEach(cleanPersistedState)

/** Concatenated string content of all tool results for the named tool. */
function toolResultText(run: AgentRunResult, name: string): string {
  return run.toolResults
    .filter((r) => r.name === name)
    .map((r) => (typeof r.content === "string" ? r.content : JSON.stringify(r.content)))
    .join("\n")
}

it("allowed arg (staging) runs the tool without an interrupt", async () => {
  const h = await createAgentHarness({ appRoot: probeRoot, route: "/constrain-chat#agent" })
  try {
    const run = await h.run({
      input: "deploy to staging",
      fixtures: script()
        .user("deploy to staging")
        .callsTool("deployProd", { env: "staging" })
        .replies("Done."),
    })
    expectNoInterrupt(run)
    expectToolCalled(run, "deployProd")
    // The result comes from the REAL deployProd fn, not the fixture reply.
    expect(toolResultText(run, "deployProd")).toContain("deployed to staging")
  } finally {
    await h.close()
  }
}, 60_000)

it("escalating arg (prod) raises the kind:'tool' interrupt, then resume(once) runs it", async () => {
  const h = await createAgentHarness({ appRoot: probeRoot, route: "/constrain-chat#agent" })
  try {
    const run = await h.run({
      input: "deploy to prod",
      fixtures: script()
        .user("deploy to prod")
        .callsTool("deployProd", { env: "prod" })
        .replies("Done."),
    })
    expectInterrupt(run).ofKind("tool").withDetail({ toolName: "deployProd" })

    const resumed = await h.resume({ decision: "once" })
    expectToolCalled(resumed, "deployProd")
    // The result comes from the REAL deployProd fn, not the fixture reply.
    expect(toolResultText(resumed, "deployProd")).toContain("deployed to prod")
  } finally {
    await h.close()
  }
}, 60_000)

it("disallowed arg returns the deny reason as the tool result", async () => {
  const h = await createAgentHarness({ appRoot: probeRoot, route: "/constrain-chat#agent" })
  try {
    const run = await h.run({
      input: "deploy to qa",
      fixtures: script()
        .user("deploy to qa")
        .callsTool("deployProd", { env: "qa" })
        .replies("Understood."),
    })
    expectNoInterrupt(run)
    // The deny string renders JSON-quoted through the tool-result path — match
    // with regex, never exact equality.
    expect(toolResultText(run, "deployProd")).toMatch(/staging or prod/i)
    // The tool body itself must NOT have run.
    expect(toolResultText(run, "deployProd")).not.toContain("deployed to qa")
  } finally {
    await h.close()
  }
}, 60_000)
