// Deterministic (aimock) e2e for per-tool approval gating (tools.approve).
// The probe-app approval-chat route approve-lists deployProd; each call runs
// gateToolOp → in interactive mode an "unknown" decision fires a LangGraph
// interrupt (kind "tool"). Resume decisions: "once" runs the tool now, "always"
// persists allow.tool to <appRoot>/.dawn/permissions.json then runs, "deny"
// makes the denial reason the tool's RESULT (a string — rendered JSON-quoted
// through the tool-result path, so assertions use regex, never equality).
// Runs in CI (no API key — aimock).
import { readFileSync, rmSync } from "node:fs"
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
  // "always" persists allow.tool into permissions.json and would leak an
  // allow decision across scenarios (and test runs). It also appends a
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

it("approve-listed tool interrupts, then resume(once) runs it", async () => {
  const h = await createAgentHarness({ appRoot: probeRoot, route: "/approval-chat#agent" })
  try {
    const run = await h.run({
      input: "deploy to staging",
      fixtures: script()
        .user("deploy to staging")
        .callsTool("deployProd", { env: "staging" })
        .replies("Deployed."),
    })
    expectInterrupt(run).ofKind("tool").withDetail({ toolName: "deployProd" })

    const resumed = await h.resume({ decision: "once" })
    expectToolCalled(resumed, "deployProd")
    expect(toolResultText(resumed, "deployProd")).toContain("deployed to staging")
  } finally {
    await h.close()
  }
}, 60_000)

it("resume(deny) makes the denial reason the tool result", async () => {
  const h = await createAgentHarness({ appRoot: probeRoot, route: "/approval-chat#agent" })
  try {
    const run = await h.run({
      input: "deploy to staging",
      fixtures: script()
        .user("deploy to staging")
        .callsTool("deployProd", { env: "staging" })
        .replies("Understood, not deploying."),
    })
    expectInterrupt(run).ofKind("tool").withDetail({ toolName: "deployProd" })

    const resumed = await h.resume({ decision: "deny" })
    // The denial string renders JSON-quoted through the tool-result path —
    // match with regex, never exact equality.
    expect(toolResultText(resumed, "deployProd")).toMatch(/denied.*deployProd/i)
    // The tool body itself must NOT have run.
    expect(toolResultText(resumed, "deployProd")).not.toContain("deployed to staging")
  } finally {
    await h.close()
  }
}, 60_000)

it("resume(always) persists allow.tool and a fresh run does not prompt", async () => {
  const h = await createAgentHarness({ appRoot: probeRoot, route: "/approval-chat#agent" })
  try {
    const run = await h.run({
      input: "deploy to staging",
      fixtures: script()
        .user("deploy to staging")
        .callsTool("deployProd", { env: "staging" })
        .replies("Deployed."),
    })
    expectInterrupt(run).ofKind("tool").withDetail({ toolName: "deployProd" })

    const resumed = await h.resume({ decision: "always" })
    expectToolCalled(resumed, "deployProd")

    // The "always" decision is persisted under the reserved "tool" key.
    const persisted = JSON.parse(readFileSync(permissionsPath, "utf8")) as {
      allow?: Record<string, string[]>
    }
    expect(persisted.allow?.tool).toContain("deployProd")

    // Fresh thread, same process: the persisted allow releases the gate silently.
    h.reset()
    const run2 = await h.run({
      input: "deploy to staging",
      fixtures: script()
        .user("deploy to staging")
        .callsTool("deployProd", { env: "staging" })
        .replies("Deployed again."),
    })
    expectNoInterrupt(run2)
    expectToolCalled(run2, "deployProd")
    expect(toolResultText(run2, "deployProd")).toContain("deployed to staging")
  } finally {
    await h.close()
  }
}, 60_000)

it("subagent approve-listed tool interrupt surfaces on the parent stream", async () => {
  const h = await createAgentHarness({ appRoot: probeRoot, route: "/approval-chat#agent" })
  try {
    const childInput = "send the report to ops"
    const run = await h.run({
      input: "have the worker send the report",
      fixtures: script()
        // Parent: dispatch to the worker subagent.
        .user("have the worker send the report")
        .callsTool("task", { subagent: "worker", input: childInput })
        .replies("Report dispatched.")
        // Child: the dispatcher seeds the child's user message with the task
        // `input` value, so the child fixture matches on that text.
        .user(childInput)
        .callsTool("sendReport", { to: "ops" })
        .replies("Report sent."),
    })
    expectInterrupt(run).ofKind("tool").withDetail({ toolName: "sendReport" })
  } finally {
    await h.close()
  }
}, 60_000)
