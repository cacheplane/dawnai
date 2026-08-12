import { expect, it } from "vitest"
import * as api from "../src/index.js"

it("exports only the canonical runtime adapter surface from the package root", () => {
  expect(Object.keys(api).sort()).toEqual([
    "DAWN_PLAN_ACTIVITY_TYPE",
    "DAWN_SUBAGENT_ACTIVITY_TYPE",
    "createCounterIdFactory",
    "createDefaultIdFactory",
    "fromRunAgentInput",
    "toAguiEvents",
  ])
})

it("exports stable activity type literals", () => {
  expect(api.DAWN_PLAN_ACTIVITY_TYPE).toBe("dawn.plan")
  expect(api.DAWN_SUBAGENT_ACTIVITY_TYPE).toBe("dawn.subagent")
})
