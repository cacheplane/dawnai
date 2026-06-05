import { expect, it } from "vitest"
import * as rt from "../src/runtime-exports.js"

it("surfaces the programmatic runtime entries", () => {
  expect(typeof rt.streamResolvedRoute).toBe("function")
  expect(typeof rt.executeResolvedRoute).toBe("function")
  expect(typeof rt.invokeResolvedRoute).toBe("function")
  expect(typeof rt.resolveCheckpointer).toBe("function")
  expect(typeof rt.resolveThreadsStore).toBe("function")
  expect(typeof rt.createRuntimeRegistry).toBe("function")
  expect(typeof rt.runTypegen).toBe("function")
})
