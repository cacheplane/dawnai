import { mkdtemp, rm, symlink, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { dirname, join, resolve } from "node:path"
import { pathToFileURL } from "node:url"
import { MemorySaver } from "@langchain/langgraph"
import { build, type Metafile } from "esbuild"
import { afterEach, describe, expect, it } from "vitest"

import type { createRuntimeFetchHandler as createFetchHandler } from "../src/lib/dev/runtime-fetch-core.js"
import {
  chatFixtureApp,
  fakeMemoryStore,
  fakePermissionsStore,
  inMemoryFilesystem,
  memoryThreadsStore,
  simpleScript,
} from "./helpers/fetch-entry-fixture.js"
import {
  buildStaticModulesForFixture,
  cleanup,
  runChatTurn,
  withAimock,
} from "./helpers/static-modules-fixture.js"

const pkgRoot = resolve(dirname(new URL(import.meta.url).pathname), "..")

/**
 * Externals for the graph under test. Deliberately short: the model/provider
 * layer is the app's concern (and langgraph's `async_hooks` use is a
 * documented `nodejs_compat` allowance), so it is excluded — but every Dawn
 * package (and zod) is BUNDLED, which is the whole point of the gate. `node:*`
 * is external only so the bundle resolves; the assertions below are what
 * decide whether a `node:` import is acceptable.
 */
const MODEL_LAYER_EXTERNALS = ["@langchain/*", "langchain", "openai"]

/**
 * The node TypeScript-loading machinery. It cannot be bundled at all (esbuild's
 * own runtime imports `fs`/`os`/`child_process` by BARE specifier, which
 * `platform: "neutral"` refuses to resolve), so it must be external for the
 * build to complete. That does not weaken the gate: the loader-edge assertion
 * below requires ZERO import edges into it, so a new one still fails.
 */
const LOADER_EXTERNALS = ["tsx", "tsx/*", "typescript", "esbuild"]

/**
 * Bundle a `src/` entry and return both its metafile (what the gate reads)
 * and its code (what the functional proof executes).
 *
 * IMPORTANT — the gate reads BUILT output for the workspace packages: every
 * `@dawn-ai/*` specifier resolves through the workspace link to that package's
 * `dist/`, because that is what its `exports` map points at. A new `node:`
 * import added to, say, `packages/core/src` is therefore INVISIBLE to the
 * assertions below until `pnpm build` has run. CI builds before it tests, so
 * the gate is honest there; a local `pnpm test` against stale `dist/` can
 * pass falsely. Re-run `pnpm build` before trusting a local green.
 */
async function bundle(entry: string): Promise<{ metafile: Metafile; code: string }> {
  const result = await build({
    // Pin esbuild's working directory so metafile paths are relative to the
    // package, not to whatever cwd the test runner was launched from —
    // otherwise the edge strings below only match a package-local run.
    absWorkingDir: pkgRoot,
    bundle: true,
    conditions: ["import"],
    entryPoints: [join(pkgRoot, "src", entry)],
    external: [...MODEL_LAYER_EXTERNALS, ...LOADER_EXTERNALS, "node:*"],
    format: "esm",
    logLevel: "silent",
    mainFields: ["module", "main"],
    metafile: true,
    // Never written to disk (`write: false`) — esbuild only needs a name.
    outfile: join(pkgRoot, "fetch-entry-purity.bundle.mjs"),
    platform: "neutral",
    write: false,
  })
  const output = result.outputFiles?.[0]
  if (!output || !result.metafile) throw new Error("esbuild produced no output")
  return { code: output.text, metafile: result.metafile }
}

/**
 * Link the same entry the way a shim-less runtime would: `platform: "browser"`
 * has no node-builtin resolution at all, and `node:*` is NOT external, so any
 * surviving `node:` import is an unresolvable specifier and the build fails.
 * This is the closest available proxy for a workerd/edge link check without
 * standing up workerd, and it is the exact failure mode PR2a removed.
 *
 * Externals are only the model/provider layer (the app's concern, same as
 * above). The loader externals are deliberately NOT repeated: the loader is
 * unreachable from this entry, so nothing needs them here.
 */
async function bundleForBrowser(entry: string): Promise<void> {
  await build({
    absWorkingDir: pkgRoot,
    bundle: true,
    conditions: ["import"],
    entryPoints: [join(pkgRoot, "src", entry)],
    external: [...MODEL_LAYER_EXTERNALS],
    format: "esm",
    logLevel: "silent",
    mainFields: ["module", "main"],
    outfile: join(pkgRoot, "fetch-entry-purity.browser.bundle.mjs"),
    platform: "browser",
    write: false,
  })
}

/** Every `node:` / bare-builtin / loader import in the graph, as `spec <- file`. */
function nodeImportEdges(metafile: Metafile): string[] {
  const edges = new Set<string>()
  for (const [file, info] of Object.entries(metafile.inputs)) {
    for (const record of info.imports ?? []) {
      if (record.external !== true) continue
      if (!record.path.startsWith("node:")) continue
      edges.add(`${record.path} <- ${file}`)
    }
  }
  return [...edges].sort()
}

/** The same, restricted to files `@dawn-ai/cli` itself owns. */
function ownNodeImportEdges(metafile: Metafile): string[] {
  return nodeImportEdges(metafile).filter((edge) => edge.includes("<- src/"))
}

/** Every import edge into the node TypeScript-loading machinery. */
function loaderImportEdges(metafile: Metafile): string[] {
  const edges = new Set<string>()
  for (const [file, info] of Object.entries(metafile.inputs)) {
    for (const record of info.imports ?? []) {
      if (record.external !== true) continue
      if (!/^(tsx|typescript|esbuild)(\/|$)/.test(record.path)) continue
      edges.add(`${record.path} <- ${file}`)
    }
  }
  return [...edges].sort()
}

function graphInputs(metafile: Metafile): string[] {
  return Object.keys(metafile.inputs)
}

// The gate is CLOSED: the upstream ratchet inventory that used to live here
// (`KNOWN_UPSTREAM_NODE_EDGES`) and its loader counterpart are gone, replaced
// by strict equality against zero. Every package the fetch graph reaches now
// has the same pure/node split `@dawn-ai/cli` has; the last edges — core's
// path jail — moved to the pure helpers behind an adversarial containment
// suite (`packages/core/test/capabilities/path-jail-adversarial.test.ts`).
// A new `node:` import anywhere in the graph fails here, and there is no
// inventory to add it to.

describe("@dawn-ai/cli/fetch graph purity", () => {
  it("contains no node: import from any @dawn-ai/cli source file", async () => {
    const { metafile } = await bundle("fetch-exports.ts")
    expect(ownNodeImportEdges(metafile)).toEqual([])
  }, 120_000)

  it("reaches no sqlite and no commander module", async () => {
    const { metafile } = await bundle("fetch-exports.ts")
    const inputs = graphInputs(metafile)
    expect(inputs.filter((i) => i.includes("sqlite"))).toEqual([])
    expect(inputs.filter((i) => i.includes("commander"))).toEqual([])
  }, 120_000)

  it("contains no node: import from anywhere in the graph", async () => {
    const { metafile } = await bundle("fetch-exports.ts")
    expect(nodeImportEdges(metafile)).toEqual([])
  }, 120_000)

  it("never reaches the node TS loader", async () => {
    const { metafile } = await bundle("fetch-exports.ts")
    expect(loaderImportEdges(metafile)).toEqual([])
  }, 120_000)

  it("links under platform: browser with no node: externals", async () => {
    // Before PR2a this threw on unresolvable `node:fs` and friends; it is the
    // only assertion here that exercises RESOLUTION rather than inspecting a
    // metafile, so it catches a `node:` dependency even if the edge inventory
    // above were somehow mis-filtered.
    await expect(bundleForBrowser("fetch-exports.ts")).resolves.toBeUndefined()
  }, 120_000)

  // Negative control: the same gate applied to the node runtime entry MUST
  // fail every check above, proving the assertions can actually detect a
  // violation (and are not passing because the metafile is empty or the
  // filters never match).
  it("detects violations — the node ./runtime entry fails every check", async () => {
    const { metafile } = await bundle("runtime-exports.ts")
    expect(ownNodeImportEdges(metafile).length).toBeGreaterThan(0)
    expect(graphInputs(metafile).some((i) => i.includes("sqlite"))).toBe(true)
    expect(nodeImportEdges(metafile).length).toBeGreaterThan(0)
    expect(loaderImportEdges(metafile).length).toBeGreaterThan(0)
    await expect(bundleForBrowser("runtime-exports.ts")).rejects.toThrow(/Could not resolve/)
  }, 120_000)

  // …and the commander check against the CLI bin, the one entry that has it.
  it("detects violations — the CLI bin entry pulls commander", async () => {
    const { metafile } = await bundle("index.ts")
    expect(graphInputs(metafile).some((i) => i.includes("commander"))).toBe(true)
  }, 120_000)
})

// ---------------------------------------------------------------------------
// The functional proof: the BUNDLED graph serves a real AG-UI turn.
// ---------------------------------------------------------------------------

/**
 * Write the bundle to a scratch dir whose `node_modules` symlinks to
 * `packages/langchain/`'s — the only place the externals the bundle still
 * imports by bare specifier (`@langchain/core`, and the `@langchain/openai`
 * the provider layer loads on demand) all resolve from. A data: URL cannot
 * resolve bare specifiers at all, which is why this is a real file; keeping it
 * out of the repo means no build artifact can be left behind by a crashed run.
 */
async function writeBundle(code: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "dawn-fetch-bundle-"))
  cleanup.push(() => rm(dir, { force: true, maxRetries: 5, recursive: true, retryDelay: 100 }))
  await symlink(join(pkgRoot, "..", "langchain", "node_modules"), join(dir, "node_modules"), "dir")
  const bundlePath = join(dir, "bundle.mjs")
  await writeFile(bundlePath, code, "utf8")
  return bundlePath
}

afterEach(async () => {
  for (const fn of cleanup.splice(0).reverse()) await fn()
})

describe("@dawn-ai/cli/fetch — bundled runtime serves a turn", () => {
  it("boots from the bundle with injected stores and streams AG-UI events", async () => {
    const appRoot = await chatFixtureApp()
    const modules = await buildStaticModulesForFixture(appRoot)
    await withAimock(simpleScript())

    const { code } = await bundle("fetch-exports.ts")
    const bundled = (await import(pathToFileURL(await writeBundle(code)).href)) as {
      readonly createRuntimeFetchHandler: typeof createFetchHandler
    }

    const { store: threadsStore, threads } = memoryThreadsStore()
    const handler = await bundled.createRuntimeFetchHandler({
      appRoot,
      checkpointer: new MemorySaver(),
      // What an edge deployment supplies in place of the disk: an injected
      // workspace backend, so nothing reaches for `localFilesystem()`.
      config: { backends: { filesystem: inMemoryFilesystem() } },
      memoryStore: async () => fakeMemoryStore(),
      modules,
      permissionsStore: fakePermissionsStore(),
      threadsStore,
      // No `bootFallbacks`: this is the edge shape — nothing may read disk.
    })
    cleanup.push(() => handler.close())

    const body = await runChatTurn(handler, "th-bundled-fetch", "hello from the bundle")

    expect(body).toContain("RUN_STARTED")
    expect(body).toContain("bundled reply")
    expect(body).toContain("RUN_FINISHED")
    expect(threads.has("th-bundled-fetch")).toBe(true)
  }, 120_000)

  it("fails loudly when a store is missing and there is no filesystem fallback", async () => {
    const appRoot = await chatFixtureApp()
    const modules = await buildStaticModulesForFixture(appRoot)

    const { code } = await bundle("fetch-exports.ts")
    const bundled = (await import(pathToFileURL(await writeBundle(code)).href)) as {
      readonly createRuntimeFetchHandler: typeof createFetchHandler
    }

    await expect(
      bundled.createRuntimeFetchHandler({ appRoot, config: {}, modules }),
    ).rejects.toThrow(/no instance provided and this runtime has no filesystem fallback/)
  }, 120_000)
})
