import { fileURLToPath } from "node:url"
import { runEval } from "@dawn-ai/evals"
import { createAgentHarness } from "@dawn-ai/testing"
import { describe, expect, it } from "vitest"
import evalDef from "../src/app/chat/evals/smoke.eval.js"

const appRoot = fileURLToPath(new URL("..", import.meta.url))

describe("chat example eval (replay)", () => {
  it("passes the gated chat smoke eval deterministically", async () => {
    const h = await createAgentHarness({ appRoot, route: "/chat#agent" })
    try {
      const report = await runEval(evalDef, {
        runCase: async (c) => {
          h.reset()
          return h.run({
            input: String(c.input),
            ...(c.fixtures ? { fixtures: c.fixtures } : {}),
          })
        },
      })
      expect(report.passed).toBe(true)
    } finally {
      await h.close()
    }
  }, 60_000)
})
