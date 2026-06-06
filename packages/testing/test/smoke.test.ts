import { expect, it } from "vitest"
import { createAgentHarness } from "../src/index.js"

it("package barrel loads", () => {
  expect(typeof createAgentHarness).toBe("function")
})
