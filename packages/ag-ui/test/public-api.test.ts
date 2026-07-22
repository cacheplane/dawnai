import { expect, it } from "vitest"
import * as api from "../src/index.js"

it("exports only the canonical runtime adapter surface from the package root", () => {
  expect(Object.keys(api).sort()).toEqual([
    "createCounterIdFactory",
    "createDefaultIdFactory",
    "fromRunAgentInput",
    "toAguiEvents",
  ])
})
