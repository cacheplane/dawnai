// LIVE SMOKE — argument-level constraints (tools.constrain) against a real
// model. Gated on OPENAI_API_KEY: SKIPS in CI, runs only locally. The aimock
// e2e scripts the tool call; this proves a REAL model, told to deploy, produces
// arguments the constraint evaluates: env==="staging" is allowed and runs,
// while env==="prod" escalates to the HITL gate.
import { rmSync } from "node:fs"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import { afterEach, beforeEach, it } from "vitest"
import { createAgentHarness } from "../src/harness.js"
import { expectInterrupt, expectNoInterrupt, expectToolCalled } from "../src/matchers.js"

const live = Boolean(process.env.OPENAI_API_KEY)
const probeRoot = fileURLToPath(new URL("./fixtures/probe-app", import.meta.url))
const permissionsPath = join(probeRoot, ".dawn", "permissions.json")

beforeEach(() => rmSync(permissionsPath, { force: true }))
afterEach(() => rmSync(permissionsPath, { force: true }))

it.skipIf(!live)(
  "a real model deploying to staging is allowed; deploying to prod escalates to the HITL gate",
  async () => {
    const staging = await createAgentHarness({
      appRoot: probeRoot,
      route: "/constrain-chat#agent",
      live: true,
    })
    try {
      staging.reset()
      const run = await staging.run({
        input: 'Call the deployProd tool now with env set to "staging".',
      })
      // env==="staging" satisfies the constraint → the tool runs, no interrupt.
      expectNoInterrupt(run)
      expectToolCalled(run, "deployProd")
    } finally {
      await staging.close()
    }

    const prod = await createAgentHarness({
      appRoot: probeRoot,
      route: "/constrain-chat#agent",
      live: true,
    })
    try {
      prod.reset()
      const run = await prod.run({
        input: 'Call the deployProd tool now with env set to "prod".',
      })
      // env==="prod" escalates → parked as a kind:"tool" permission interrupt.
      expectInterrupt(run).ofKind("tool").withDetail({ toolName: "deployProd" })
    } finally {
      await prod.close()
    }
  },
  180_000,
)
