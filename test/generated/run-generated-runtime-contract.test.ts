import { afterEach, describe, expect, test } from "vitest"

import {
  cleanupTrackedTempDirs,
  createTrackedTempDir,
  prepareGeneratedRuntimeApp,
  readGeneratedExpectedFixture,
  runGeneratedRuntimeScenario,
  type TrackedTempDir,
} from "./harness.ts"

const tempDirs: TrackedTempDir[] = []

afterEach(async () => {
  await cleanupTrackedTempDirs(tempDirs)
})

describe("generated app runtime contract", () => {
  test("validates the packaged basic app runtime contract", { timeout: 180_000 }, async () => {
    const tempRoot = await createTrackedTempDir("dgr-", tempDirs)
    const prepared = await prepareGeneratedRuntimeApp({
      fixtureName: "basic",
      registry: tempDirs,
      tempRoot,
    })

    const result = await runGeneratedRuntimeScenario(prepared)
    const expected = await readGeneratedExpectedFixture("basic")

    expectGeneratedRuntimeScenario(result, expected)
  })

  test("validates the packaged custom-app-dir runtime contract", {
    timeout: 180_000,
  }, async () => {
    const tempRoot = await createTrackedTempDir("dgr-", tempDirs)
    const prepared = await prepareGeneratedRuntimeApp({
      fixtureName: "custom-app-dir",
      registry: tempDirs,
      tempRoot,
    })

    const result = await runGeneratedRuntimeScenario(prepared)
    const expected = await readGeneratedExpectedFixture("custom-app-dir")

    expectGeneratedRuntimeScenario(result, expected)
  })

  test("validates the handwritten external app runtime contract", {
    timeout: 180_000,
  }, async () => {
    const tempRoot = await createTrackedTempDir("dgr-", tempDirs)
    const prepared = await prepareGeneratedRuntimeApp({
      fixtureName: "handwritten",
      registry: tempDirs,
      tempRoot,
    })

    const result = await runGeneratedRuntimeScenario(prepared)
    const expected = await readGeneratedExpectedFixture("handwritten")

    expectGeneratedRuntimeScenario(result, expected)
  })
})

function expectGeneratedRuntimeScenario(result: unknown, expected: unknown): void {
  expect(result).toMatchObject({
    devServerHealth: {
      status: "ready",
    },
  })
  expect(stripGeneratedRuntimeProof(result)).toEqual(expected)
}

function stripGeneratedRuntimeProof(result: unknown): unknown {
  if (!result || typeof result !== "object" || Array.isArray(result)) {
    return result
  }

  const { devServerHealth: _devServerHealth, ...rest } = result

  return rest
}
