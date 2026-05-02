import { readFile } from "node:fs/promises"
import { resolve } from "node:path"

import { afterEach, describe, expect, test } from "vitest"

import {
  cleanupTrackedTempDirs,
  createTrackedTempDir,
  expectBasicAuthoringLane,
  prepareGeneratedRuntimeApp,
  readGeneratedExpectedFixture,
  runGeneratedRuntimeScenario,
  type TrackedTempDir,
} from "./harness.ts"

const tempDirs: TrackedTempDir[] = []
const REPO_ROOT = resolve(import.meta.dirname, "../..")

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

    await expectBasicAuthoringLane(prepared.appRoot)
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

  test("supports contributor-local runtime lifecycle", { timeout: 180_000 }, async () => {
    const tempRoot = await createTrackedTempDir("dgr-", tempDirs)
    const prepared = await prepareGeneratedRuntimeApp({
      fixtureName: "basic",
      registry: tempDirs,
      scaffoldMode: "internal",
      tempRoot,
    })

    await expectBasicAuthoringLane(prepared.appRoot)
    const result = await runGeneratedRuntimeScenario(prepared)
    const expected = await readGeneratedExpectedFixture("basic")
    const transcript = await readFile(prepared.transcriptPath, "utf8")

    expectGeneratedRuntimeScenario(result, expected)
    expect(transcript).toContain(
      `$ (cd ${REPO_ROOT} && pnpm --filter create-dawn-ai-app build)`,
    )
    expect(transcript).toContain(
      `node packages/create-dawn-app/dist/index.js ${prepared.appRoot} --mode internal`,
    )
    expect(transcript).toContain(`$ (cd ${prepared.appRoot} && pnpm install)`)
    expect(transcript).toContain(
      `$ (cd ${prepared.appRoot} && pnpm exec dawn run src/app/(public)/hello/[tenant]/index.ts)`,
    )
    expect(transcript).toContain(
      `$ (cd ${prepared.appRoot} && pnpm exec dawn run src/app/(public)/hello/[tenant]/index.ts --url`,
    )
    expect(transcript).toContain(`$ (cd ${prepared.appRoot} && pnpm exec dawn test)`)
    expect(transcript).toContain("$ dawn dev")
    expect(transcript).not.toContain("--pack-destination")
    expect(transcript).not.toContain("pnpm add ")
  })
})

function expectGeneratedRuntimeScenario(result: unknown, expected: unknown): void {
  expect(result).toMatchObject({
    devServerHealth: {
      status: "ready",
    },
    serverRequestUrl: "/runs/wait",
  })
  expect(stripGeneratedRuntimeProof(result)).toEqual(expected)
}

function stripGeneratedRuntimeProof(result: unknown): unknown {
  if (!result || typeof result !== "object" || Array.isArray(result)) {
    return result
  }

  const {
    devServerHealth: _devServerHealth,
    serverRequestUrl: _serverRequestUrl,
    ...rest
  } = result

  return rest
}
