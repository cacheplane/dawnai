import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { fileURLToPath } from "node:url"
import { join } from "node:path"
import { afterAll, expect, it } from "vitest"
import { createAgentHarness, expectToolCalled, loadFixtures, script, writeFixtures } from "../src/index.js"
const appRoot = fileURLToPath(new URL("./fixtures/probe-app", import.meta.url))
const dir = mkdtempSync(join(tmpdir(), "dt-fxe2e-"))
afterAll(() => rmSync(dir, { recursive: true, force: true }))
it("a committed fixture file replays through the harness", async () => {
  const path = join(dir, "filter.fixture.json")
  writeFixtures(path, script().user("Filter open items").callsTool("applyFilter", { status: "open" }).replies("Found 2."))
  const h = await createAgentHarness({ appRoot, route: "/chat#agent" })
  try {
    const run = await h.run({ input: "Filter open items", fixtures: loadFixtures(path) })
    expectToolCalled(run, "applyFilter").withArgs({ status: "open" })
    expect(run.finalMessage).toContain("Found 2")
  } finally { await h.close() }
}, 60_000)
