import { mkdtemp, rm, symlink, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { dirname, join, resolve } from "node:path"
import { pathToFileURL } from "node:url"
import { MemorySaver } from "@langchain/langgraph"
import { build, type Metafile, type Plugin } from "esbuild"
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

// ---------------------------------------------------------------------------
// The Node-only GLOBAL gate.
//
// Everything above inspects IMPORT EDGES. A bare `process.env.X` has no import
// edge at all, so the whole suite passed while six unguarded reads sat on this
// graph — including `OPENAI_BASE_URL` in the openai model constructor, i.e. the
// first turn of the canonical app this target scaffolds. On workerd without
// `nodejs_compat` (what the emitted `wrangler.toml` deliberately asks for)
// `process` is not defined, so those lines are a ReferenceError, not a quiet
// `undefined`.
// ---------------------------------------------------------------------------

/**
 * Globals that Node defines and a bare workerd/browser realm does not. A
 * reference to any of them is a hard crash the moment the line evaluates.
 */
const NODE_ONLY_GLOBALS = [
  "process",
  "Buffer",
  "global",
  "__dirname",
  "__filename",
  "require",
] as const

function sentinelFor(name: string): string {
  return `__DAWN_NODE_GLOBAL_${name}__`
}

/**
 * The mechanism that makes this gate trustworthy. Grepping the bundle for
 * `process` is hopeless — a 4 MB bundle is full of the token inside string
 * literals (a tokenizer vocabulary, `"in-process"`), in comments, as a property
 * name, and as esbuild-renamed locals (`process2`) that shadow nothing.
 *
 * esbuild's `define` substitution is SCOPE-AWARE: it rewrites only genuine
 * references to the global binding, never a string, a comment, a property key,
 * or an identifier shadowed by a local declaration. Bundling with each global
 * mapped to a unique sentinel therefore turns "find the real global reads" into
 * an exact substring search with no false positives.
 */
const GLOBAL_SENTINEL_DEFINES: Record<string, string> = Object.fromEntries(
  NODE_ONLY_GLOBALS.map((name) => [name, sentinelFor(name)]),
)

/**
 * Externalize every non-Dawn package so the bundle holds ONLY code this repo
 * owns. Third-party code legitimately uses short-circuit guards we cannot
 * refactor, so the zero-tolerance rule can only be applied to our own sources.
 */
const externalizeNonDawn: Plugin = {
  name: "externalize-non-dawn",
  setup(pluginBuild) {
    // Bare specifiers only — relative and absolute paths must still resolve.
    pluginBuild.onResolve({ filter: /^[^./]/ }, (args) =>
      args.path.startsWith("@dawn-ai/") ? null : { external: true, path: args.path },
    )
  },
}

/**
 * Link for the browser with every Node-only global replaced by its sentinel,
 * and hand back the code so the assertions can read it.
 */
async function bundleWithGlobalSentinels(source: {
  readonly dawnOnly?: boolean
  readonly entry?: string
  readonly extraExternals?: readonly string[]
  readonly stdin?: string
}): Promise<string> {
  const result = await build({
    absWorkingDir: pkgRoot,
    bundle: true,
    conditions: ["import"],
    define: GLOBAL_SENTINEL_DEFINES,
    ...(source.entry ? { entryPoints: [join(pkgRoot, "src", source.entry)] } : {}),
    external: [...MODEL_LAYER_EXTERNALS, ...(source.extraExternals ?? [])],
    format: "esm",
    logLevel: "silent",
    mainFields: ["module", "main"],
    outfile: join(pkgRoot, "fetch-entry-purity.sentinel.bundle.mjs"),
    platform: "browser",
    ...(source.dawnOnly ? { plugins: [externalizeNonDawn] } : {}),
    ...(source.stdin
      ? { stdin: { contents: source.stdin, loader: "js" as const, resolveDir: pkgRoot } }
      : {}),
    write: false,
  })
  const output = result.outputFiles?.[0]
  if (!output) throw new Error("esbuild produced no output")
  return output.text
}

interface GlobalReference {
  readonly global: string
  readonly guarded: boolean
  readonly line: number
  readonly text: string
}

/**
 * Is this reference protected by a `typeof` check in the SAME statement?
 *
 * This is the one heuristic in the gate, and it exists to admit the real
 * short-circuit form third-party code uses:
 *
 *   typeof process != "object" || process.env.BUF_BIGINT_DISABLE !== "1"
 *
 * The second read there is genuinely safe, and no amount of import-edge
 * inspection can tell us so. We look backwards from the reference to the
 * nearest statement boundary (`;`, `{`, `}`, or start of line — esbuild's
 * un-minified output keeps one statement per line) and ask whether a `typeof`
 * of the SAME global appears in that window. It cannot be fooled by a guard in
 * a neighbouring statement, because the boundary scan cuts it off.
 *
 * Where it is imprecise it is deliberately imprecise in the SAFE direction for
 * Dawn's own code, because Dawn's code is held to the stricter rule below that
 * ignores this function entirely.
 */
function isTypeofGuarded(line: string, at: number, sentinel: string): boolean {
  const statementStart = Math.max(
    line.lastIndexOf(";", at),
    line.lastIndexOf("{", at),
    line.lastIndexOf("}", at),
  )
  const statement = line.slice(statementStart + 1, at + sentinel.length)
  return new RegExp(`typeof\\s+${sentinel}`).test(statement)
}

/** Every real reference to a Node-only global in a sentinel-defined bundle. */
function findNodeGlobalReferences(code: string): GlobalReference[] {
  const found: GlobalReference[] = []
  code.split("\n").forEach((text, index) => {
    for (const name of NODE_ONLY_GLOBALS) {
      const sentinel = sentinelFor(name)
      for (
        let at = text.indexOf(sentinel);
        at !== -1;
        at = text.indexOf(sentinel, at + sentinel.length)
      ) {
        found.push({
          global: name,
          guarded: isTypeofGuarded(text, at, sentinel),
          line: index + 1,
          text: text.trim().slice(0, 200),
        })
      }
    }
  })
  return found
}

/** Readable failure output — the assertion prints the offending lines. */
function describeReferences(refs: readonly GlobalReference[]): string[] {
  return refs.map((ref) => `${ref.global} @ line ${ref.line}: ${ref.text}`)
}

/**
 * A deliberately dirty entry, used as the negative control. It must produce
 * BOTH classifications, so a green result proves the scanner discriminates
 * rather than simply reporting everything (or nothing).
 */
const DIRTY_GLOBALS_FIXTURE = [
  // The exact shape of the shipped defect: unguarded, load-bearing config read.
  'export const unguardedEnv = process.env.DAWN_FIXTURE_BASE_URL ?? ""',
  "export const unguardedDirname = __dirname",
  'export const guardedEnv = typeof process === "undefined" ? "" : process.env.DAWN_FIXTURE_FLAG',
  'export const guardedBuffer = typeof Buffer === "undefined" ? 0 : Buffer.byteLength("x")',
].join("\n")

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

  it("contains no UNGUARDED Node-only global anywhere in the graph", async () => {
    const code = await bundleWithGlobalSentinels({ entry: "fetch-exports.ts" })
    const refs = findNodeGlobalReferences(code)
    expect(describeReferences(refs.filter((ref) => !ref.guarded))).toEqual([])
    // Non-vacuity: the scan must actually be looking at a real bundle. Third-
    // party code in this graph carries the guarded `typeof process` form, so a
    // zero total would mean the sentinels never landed.
    expect(refs.length).toBeGreaterThan(0)
  }, 120_000)

  it("references no Node-only global AT ALL from Dawn-owned code", async () => {
    // The strict rule, and the one that holds the line. Dawn code has a seam
    // for this — `readRuntimeEnv` from `@dawn-ai/core`, which reads
    // `globalThis.process?.env` (a property access off a global every runtime
    // defines) and falls back to whatever `seedRuntimeEnv` supplied. Because
    // that seam exists, our own sources need no `typeof` guard anywhere, so
    // this assertion does not have to trust the heuristic above at all.
    const code = await bundleWithGlobalSentinels({ dawnOnly: true, entry: "fetch-exports.ts" })
    expect(describeReferences(findNodeGlobalReferences(code))).toEqual([])
    // Non-vacuity: prove the Dawn graph really is in this bundle, and that the
    // sanctioned accessor is what replaced the bare reads.
    expect(code).toContain("globalThis.process")
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

  // Negative control for the GLOBAL gate, in two parts.
  it("detects violations — a dirty fixture is flagged, and guarded reads are not", async () => {
    const code = await bundleWithGlobalSentinels({ stdin: DIRTY_GLOBALS_FIXTURE })
    const refs = findNodeGlobalReferences(code)
    const unguarded = refs.filter((ref) => !ref.guarded).map((ref) => ref.global)
    const guarded = refs.filter((ref) => ref.guarded).map((ref) => ref.global)

    // The class that shipped: an unguarded `process.env` read, plus a second
    // Node-only global to prove the list is not `process`-only.
    expect(unguarded).toContain("process")
    expect(unguarded).toContain("__dirname")

    // …and the other half, which is what keeps this gate from being disabled:
    // genuinely guarded reads are NOT reported as violations.
    expect(guarded).toContain("process")
    expect(guarded).toContain("Buffer")
    expect(unguarded).not.toContain("Buffer")
  }, 120_000)

  it("detects violations — the node ./runtime entry is full of unguarded globals", async () => {
    // The same control against real code rather than a fixture. `node:*` has to
    // be external here (this entry cannot link for the browser at all, which is
    // the assertion two blocks up); the global scan is unaffected by that.
    const code = await bundleWithGlobalSentinels({
      entry: "runtime-exports.ts",
      extraExternals: ["node:*", ...LOADER_EXTERNALS],
    })
    const unguarded = findNodeGlobalReferences(code).filter((ref) => !ref.guarded)
    expect(unguarded.length).toBeGreaterThan(0)
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
