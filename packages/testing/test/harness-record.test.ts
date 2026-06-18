import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import { afterAll, expect, it } from "vitest"
import { createAimock } from "../src/aimock-runner.js"
import { loadFixtures, writeFixtures } from "../src/fixture-file.js"
import { createAgentHarness } from "../src/harness.js"

const appRoot = fileURLToPath(new URL("./fixtures/probe-app", import.meta.url))

it("records a case against a local upstream, then replays it deterministically", async () => {
  // Record mode does not inject a dummy key (so a real upstream gets the real key).
  // For this local-upstream test, set a placeholder so the OpenAI SDK client
  // initialises; the fake upstream ignores auth entirely.
  process.env.OPENAI_API_KEY = process.env.OPENAI_API_KEY ?? "test-record-placeholder"

  const upstream = await createAimock({
    fixtures: [{ match: {}, response: { content: "RECORDED ANSWER" } }],
  })
  const recordH = await createAgentHarness({
    appRoot,
    route: "/chat#agent",
    record: true,
    recordUpstream: upstream.baseUrl.replace(/\/v1$/, ""),
  })
  afterAll(async () => {
    await recordH.close()
    await upstream.close()
  })

  const run = await recordH.run({ input: "what is up" })
  expect(run.finalMessage).toContain("RECORDED ANSWER")

  const fixtures = recordH.getRecordedFixtures()
  expect(fixtures.length).toBeGreaterThanOrEqual(1)
  expect(fixtures[0]?.match.turnIndex).toBe(0)

  const dir = mkdtempSync(join(tmpdir(), "dawn-rec-"))
  const file = join(dir, "smoke.case.fixtures.json")
  writeFixtures(file, fixtures)

  const replayH = await createAgentHarness({
    appRoot,
    route: "/chat#agent",
    fixtures: loadFixtures(file),
  })
  try {
    const replay = await replayH.run({ input: "what is up" })
    expect(replay.finalMessage).toContain("RECORDED ANSWER")
  } finally {
    await replayH.close()
    rmSync(dir, { recursive: true, force: true })
  }
}, 60_000)
