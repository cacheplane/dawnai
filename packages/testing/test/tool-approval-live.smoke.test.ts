// LIVE SMOKE — per-tool approval gating (tools.approve, PR #291) against a real
// model. Gated on OPENAI_API_KEY: SKIPS in CI, runs only locally. The aimock
// e2e (tool-approval.e2e.test.ts) scripts the tool call; this proves a REAL
// model, told to deploy, actually calls the gated tool and hits the HITL gate.
import { rmSync } from "node:fs"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import { afterEach, beforeEach, expect, it } from "vitest"
import { createAgentHarness } from "../src/harness.js"
import { expectInterrupt, expectToolCalled } from "../src/matchers.js"

const live = Boolean(process.env.OPENAI_API_KEY)
const probeRoot = fileURLToPath(new URL("./fixtures/probe-app", import.meta.url))
const permissionsPath = join(probeRoot, ".dawn", "permissions.json")

beforeEach(() => rmSync(permissionsPath, { force: true }))
afterEach(() => rmSync(permissionsPath, { force: true }))

it.skipIf(!live)(
  "a real model calling a gated tool triggers the kind:'tool' interrupt, then resume(once) runs it",
  async () => {
    const h = await createAgentHarness({
      appRoot: probeRoot,
      route: "/approval-chat#agent",
      live: true,
    })
    try {
      h.reset()
      const run = await h.run({ input: "Deploy the app to the staging environment now." })
      // The real model must have chosen to call deployProd, and the approval
      // wrapper must have parked it as a kind:"tool" permission interrupt.
      expectInterrupt(run).ofKind("tool").withDetail({ toolName: "deployProd" })

      const resumed = await h.resume({ decision: "once" })
      expectToolCalled(resumed, "deployProd")
      const result = resumed.toolResults.find((t) => t.name === "deployProd")
      expect(String(result?.content ?? "")).toContain("deployed to")
    } finally {
      await h.close()
    }
  },
  120_000,
)
