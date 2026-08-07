import { readFile } from "node:fs/promises"
import { dirname, join, resolve } from "node:path"
import { fileURLToPath } from "node:url"

import { describe, expect, it } from "vitest"
import { resolveTemplateDir, TEMPLATE_NAMES } from "../src/templates.js"

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../../..")

/**
 * Test files the research template shares VERBATIM with `examples/research/server`.
 *
 * The example is dogfooded by the repo's own suites, so a behavior change gets caught
 * there and fixed there — while the template copy, which only ever runs inside a
 * scaffolded app, silently keeps the old expectation. That is exactly how #377's CLI
 * rewording (`Approved: <id>` -> `approved <id> (activated)`) shipped a research
 * scaffold whose `npm test` failed out of the box from 0.8.14 through 0.8.17.
 *
 * `package.json` is deliberately NOT listed: the example depends on the workspace and
 * the template on published versions, so those two legitimately differ.
 */
const SHARED_TEST_FILES = ["test/research.test.ts", "test/sandbox-docker.test.ts"]

describe("template registry", () => {
  it("registers the research template", () => {
    expect(TEMPLATE_NAMES).toContain("research")
  })

  it("resolves the research template directory", async () => {
    const dir = await resolveTemplateDir("research")
    expect(dir.endsWith("templates/app-research")).toBe(true)
  })
})

describe("research template parity with examples/research", () => {
  it.each(SHARED_TEST_FILES)("keeps %s identical to the dogfooded example", async (relative) => {
    const templateDir = await resolveTemplateDir("research")
    const [template, example] = await Promise.all([
      readFile(join(templateDir, `${relative}.template`), "utf8"),
      readFile(join(repoRoot, "examples/research/server", relative), "utf8"),
    ])

    expect(template).toBe(example)
  })
})
