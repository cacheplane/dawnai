import { expect, it } from "vitest"
import { DAWN_TESTING_PACKAGE } from "../src/index.js"

it("package barrel loads", () => {
  expect(DAWN_TESTING_PACKAGE).toBe("@dawn-ai/testing")
})
