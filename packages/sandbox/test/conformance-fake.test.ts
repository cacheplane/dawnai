import { describe } from "vitest"
import { fakeSandbox, runProviderConformance } from "../src/testing/index.ts"

runProviderConformance({
  name: "fakeSandbox",
  makeProvider: () => fakeSandbox(),
  describe,
})
