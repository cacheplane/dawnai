import { readdir, readFile } from "node:fs/promises"
import { dirname, join, resolve } from "node:path"
import { fileURLToPath } from "node:url"

import { describe, expect, it } from "vitest"
import { resolveTemplateDir, TEMPLATE_NAMES } from "../src/templates.js"

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../../..")
const exampleTestDir = resolve(repoRoot, "examples/research/server/test")

/**
 * Every test file the research template shares VERBATIM with `examples/research/server`,
 * DERIVED from what is on disk rather than listed here.
 *
 * The example is dogfooded by the repo's own suites, so a behavior change gets caught
 * there and fixed there — while the template copy, which only ever runs inside a
 * scaffolded app, silently keeps the old expectation. That is exactly how #377's CLI
 * rewording (`Approved: <id>` -> `approved <id> (activated)`) shipped a research
 * scaffold whose `npm test` failed out of the box from 0.8.14 through 0.8.17.
 *
 * Derived, because a hard-coded list fails OPEN: add a third shared test file and a
 * literal list silently stops covering it while still reporting green — the same rot
 * that `assertPackedClosureIsComplete` exists to prevent on the packing side.
 *
 * `package.json` is deliberately excluded: the example depends on the workspace and the
 * template on published versions, so those two legitimately differ.
 */
async function sharedTestFiles(): Promise<string[]> {
  const templateDir = await resolveTemplateDir("research")
  const templateNames = await readdir(join(templateDir, "test"))
  const exampleNames = new Set(await readdir(exampleTestDir))

  return templateNames
    .filter((name) => name.endsWith(".test.ts.template"))
    .map((name) => name.slice(0, -".template".length))
    .filter((name) => exampleNames.has(name))
    .map((name) => `test/${name}`)
    .sort()
}

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
  it("keeps every shared test file identical to the dogfooded example", async () => {
    const templateDir = await resolveTemplateDir("research")
    const shared = await sharedTestFiles()

    // An empty list would make every assertion below vacuous, so the guard would
    // report green precisely when it had stopped guarding anything.
    expect(shared.length).toBeGreaterThan(0)

    const drifted: string[] = []
    for (const relative of shared) {
      const [template, example] = await Promise.all([
        readFile(join(templateDir, `${relative}.template`), "utf8"),
        readFile(join(repoRoot, "examples/research/server", relative), "utf8"),
      ])
      if (template !== example) drifted.push(relative)
    }

    expect(drifted).toEqual([])
  })

  it("covers every test file the example and template both have", async () => {
    const exampleTests = (await readdir(exampleTestDir))
      .filter((name) => name.endsWith(".test.ts"))
      .map((name) => `test/${name}`)
      .sort()

    // If the example grows a test the template also ships, the parity check must pick
    // it up automatically. Listing files by hand is what let #377's drift through.
    expect(await sharedTestFiles()).toEqual(exampleTests)
  })
})
