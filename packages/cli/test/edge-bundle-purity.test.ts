import { join } from "node:path"
import { build, type Metafile } from "esbuild"
import { afterEach, describe, expect, test } from "vitest"

import { buildFixture, createFixtureApp, removeFixtureApp } from "./helpers/hono-edge-fixture.js"

// ---------------------------------------------------------------------------
// THE EDGE BUNDLE'S node: GATE — the cheap half of the workerd lane.
//
// `fetch-entry-purity.test.ts` is the older and broader gate, and it is not
// redundant with this one: it pins Dawn's own module graph, forbids the loader
// machinery, and carries the inventory of `node:` specifiers still reachable
// through upstream packages. But it externalizes the model layer
// (`@langchain/*`, `langchain`, `openai`) on the reasonable ground that a
// provider package is the app's concern — and that hole is exactly where a real
// defect lived: `packages/langchain/src` imported
// "@langchain/core/callbacks/dispatch", whose entry statically imports
// `node:async_hooks`. The gate could not see it, so the first thing to notice
// was `wrangler dev` refusing to boot in the gated workerd lane.
//
// This test closes that hole from the other side. It bundles the REAL emitted
// `app.mjs` the way `wrangler deploy` does — everything linked in, nothing
// external but `node:` itself, resolved with Workers' export conditions — and
// requires the answer to be ZERO. No inventory and no allowlist: the `hono`
// target's whole claim is that its output needs no `nodejs_compat`, and one
// reachable `node:` specifier falsifies that.
//
// It needs no Docker, no workerd binary and no network, so unlike the lane it
// runs on every CI run. The lane is still the thing that proves the bundle
// EXECUTES; this only proves it links.
//
// ⚠ The one thing this cannot see is a bare Node-only GLOBAL (`process.foo`
// with no import edge) — a metafile records imports, not identifiers. That is
// what `fetch-entry-purity`'s own global-scan assertion is for, on Dawn-owned
// code; on upstream code neither gate can see it and only the workerd lane can.
// ---------------------------------------------------------------------------

/**
 * Wrangler's resolution, as closely as esbuild can reproduce it: browser
 * platform, Workers conditions, and `node:*` external ONLY so the bundle
 * completes and the metafile can be inspected — never because such an import
 * would be acceptable.
 */
async function bundleEmittedApp(buildDir: string): Promise<Metafile> {
  const result = await build({
    bundle: true,
    conditions: ["workerd", "worker", "browser", "import"],
    entryPoints: [join(buildDir, "app.mjs")],
    external: ["node:*"],
    format: "esm",
    logLevel: "silent",
    mainFields: ["module", "main"],
    metafile: true,
    outfile: join(buildDir, "edge-purity.bundle.mjs"),
    platform: "browser",
    write: false,
  })
  if (!result.metafile) throw new Error("esbuild produced no metafile")
  return result.metafile
}

/** Every `node:` specifier in the graph, with the file that imported it. */
function nodeImports(metafile: Metafile): string[] {
  const found: string[] = []
  for (const [file, info] of Object.entries(metafile.inputs)) {
    for (const imported of info.imports) {
      if (!imported.path.startsWith("node:")) continue
      found.push(`${imported.path} ← ${file.replace(/^.*node_modules\//, "")}`)
    }
  }
  return found.sort()
}

const created: string[] = []

afterEach(async () => {
  await Promise.all(created.splice(0).map(removeFixtureApp))
})

describe("the hono target's emitted bundle, resolved as wrangler resolves it", () => {
  test("links with zero node: specifiers, so no nodejs_compat flag is needed", async () => {
    const appRoot = await createFixtureApp("dawn-edge-bundle-purity-")
    created.push(appRoot)
    const buildDir = await buildFixture(appRoot)

    const found = nodeImports(await bundleEmittedApp(buildDir))

    // Named, not counted: the failure that matters is "which import, from
    // where", and a bare length assertion sends the reader back to esbuild.
    expect(found).toEqual([])
  }, 120_000)
})
