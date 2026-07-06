import { constants } from "node:fs"
import { access } from "node:fs/promises"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import { afterAll, expect, it } from "vitest"
import { script } from "../src/fixture-builder.js"
import { createAgentHarness } from "../src/harness.js"
import { expectFinalMessage, expectToolCalled } from "../src/matchers.js"

const appRoot = fileURLToPath(
  new URL("../../../test/runtime/fixtures/sandbox-app", import.meta.url),
)
const h = await createAgentHarness({ appRoot, route: "/agent#agent" })

afterAll(() => h.close())

it("routes harness workspace tools into the configured sandbox and isolates threads", async () => {
  await expect(access(join(appRoot, "workspace"), constants.F_OK)).rejects.toThrow()

  h.reset()
  const written = await h.run({
    input: "Write and read a sandbox note.",
    fixtures: script()
      .user("Write and read a sandbox note.")
      .callsTool("writeFile", { path: "notes/sandbox.txt", content: "sandbox-only" })
      .callsTool("readFile", { path: "notes/sandbox.txt" })
      .replies("The sandbox note says sandbox-only."),
  })
  expectToolCalled(written, "writeFile")
  expectToolCalled(written, "readFile")
  expectFinalMessage(written).toContain("sandbox-only")

  h.reset()
  const isolated = await h.run({
    input: "Read the sandbox note from a fresh thread.",
    fixtures: script()
      .user("Read the sandbox note from a fresh thread.")
      .callsTool("readFile", { path: "notes/sandbox.txt" })
      .replies("The fresh thread cannot read the note."),
  })
  expectToolCalled(isolated, "readFile")
  expect(isolated.toolResults.find((t) => t.name === "readFile")?.isError).toBe(true)
})
