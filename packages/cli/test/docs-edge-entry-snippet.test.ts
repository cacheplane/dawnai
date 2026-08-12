import { existsSync } from "node:fs"
import { readFile, writeFile } from "node:fs/promises"
import { join } from "node:path"

import { build, type Metafile } from "esbuild"
import { afterEach, describe, expect, test } from "vitest"

import {
  buildFixture,
  createFixtureApp,
  removeFixtureApp,
  repoRoot,
} from "./helpers/hono-edge-fixture.js"

// ---------------------------------------------------------------------------
// THE CANONICAL EDGE GUIDE'S COMPOSITION SKELETON, BUNDLED.
//
// `edge-bundle-purity.test.ts` bundles the emitted `app.mjs` and proves the
// GENERATED entry links clean. This one covers the canonical Edge guide's
// hand-wired lifecycle/composition skeleton, which a reader adapts when the
// generated `app.mjs` cannot be used as the deployment entry unchanged.
//
// It exists because that snippet was wrong. It named `./.dawn/build/modules.mjs`
// — the NODE target's manifest, which imports `node:path`, `node:url` and
// `@dawn-ai/cli/runtime` (tsx, esbuild). Bundled as wrangler bundles, it pulled
// in fourteen unresolved builtins, bare `fs` and `child_process` among them, so
// not even `nodejs_compat` would have rescued it. And it sat directly beneath
// the callout claiming a bundle from this entry links ZERO `node:` specifiers.
//
// Prose cannot be type-checked, so the fix is not to correct the prose and hope.
// This test READS THE SNIPPET OUT OF THE MDX, takes its import statements
// verbatim, and bundles them the way `wrangler deploy` would. If someone edits
// that fence back to `modules.mjs` — or points it at anything else that drags a
// builtin in — this goes red naming the import and the file that pulled it.
//
// Cheap and ungated on purpose: one fixture build, esbuild, no Docker, no
// workerd, no network. It runs on every CI run.
// ---------------------------------------------------------------------------

const EDGE_DEPLOYMENT_DOC = join(
  repoRoot,
  "apps",
  "web",
  "content",
  "docs",
  "deployment",
  "edge.mdx",
)

/** The heading whose first JavaScript fence is the skeleton under test. */
const SECTION_HEADING = "## Compose through `@dawn-ai/cli/fetch`"
const ROUTER_HEADING = "## Compose the Hono router"

/** Where the docs tell the reader the build artifacts live. */
const BUILD_DIR_PREFIX = "./.dawn/build/"

/**
 * The first ```js fence after {@link SECTION_HEADING}.
 *
 * Deliberately brittle about finding the heading: a silent "no snippet, nothing
 * to check" is exactly how a docs test rots into a no-op.
 */
async function readCompositionSkeleton(): Promise<string> {
  const source = await readFile(EDGE_DEPLOYMENT_DOC, "utf8")
  const headingAt = source.indexOf(SECTION_HEADING)
  if (headingAt === -1) {
    throw new Error(
      `${EDGE_DEPLOYMENT_DOC} no longer contains the heading ${JSON.stringify(SECTION_HEADING)}. ` +
        "This test pins the canonical skeleton under that heading — repoint it rather than deleting it.",
    )
  }
  const fence = /```js(?:\s+[^\n]*)?\n([\s\S]*?)```/.exec(source.slice(headingAt))
  if (fence?.[1] === undefined) {
    throw new Error(
      `no \`\`\`js fence follows ${JSON.stringify(SECTION_HEADING)} in ${EDGE_DEPLOYMENT_DOC}.`,
    )
  }
  return fence[1]
}

/** The declaration-free JavaScript host example that composes the Dawn router. */
async function readHostRouterExample(): Promise<string> {
  const source = await readFile(EDGE_DEPLOYMENT_DOC, "utf8")
  const headingAt = source.indexOf(ROUTER_HEADING)
  if (headingAt === -1) {
    throw new Error(
      `${EDGE_DEPLOYMENT_DOC} no longer contains the heading ${JSON.stringify(ROUTER_HEADING)}.`,
    )
  }
  const fence = /```js title="host\.mjs"\n([\s\S]*?)```/.exec(source.slice(headingAt))
  if (fence?.[1] === undefined) {
    throw new Error(
      `no declaration-free \`\`\`js title="host.mjs" fence follows ${JSON.stringify(ROUTER_HEADING)} in ${EDGE_DEPLOYMENT_DOC}.`,
    )
  }
  return fence[1]
}

/** The snippet's `import` lines, verbatim. */
function importLines(snippet: string): string[] {
  return snippet.split("\n").filter((line) => line.startsWith("import "))
}

/** The module specifier an `import` line names. */
function specifierOf(line: string): string {
  const quoted = /from\s+"([^"]+)"/.exec(line)
  if (quoted?.[1] === undefined) throw new Error(`cannot read a specifier from: ${line}`)
  return quoted[1]
}

/**
 * Wrangler's resolution, as closely as esbuild can reproduce it — identical to
 * `edge-bundle-purity.test.ts`'s, and identical for the same reason: `node:*`
 * is external ONLY so the bundle completes and the metafile can be read, never
 * because such an import would be acceptable.
 */
async function bundleAsWrangler(entryPoint: string, outfile: string): Promise<Metafile> {
  const result = await build({
    bundle: true,
    conditions: ["workerd", "worker", "browser", "import"],
    entryPoints: [entryPoint],
    external: ["node:*"],
    format: "esm",
    logLevel: "silent",
    mainFields: ["module", "main"],
    metafile: true,
    outfile,
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
  return [...new Set(found)].sort()
}

/**
 * An entry that imports exactly what the snippet imports, and re-exports the
 * bindings so nothing is tree-shaken away before the graph is recorded.
 *
 * `manifest` overrides the manifest the snippet names — that is the whole
 * mechanism of the negative control below.
 */
function entrySource(lines: readonly string[], manifest?: string): string {
  const rewritten = lines.map((line) => {
    const specifier = specifierOf(line)
    if (!specifier.startsWith(BUILD_DIR_PREFIX)) return line
    // The snippet is written from the app root; this entry is written INSIDE
    // `.dawn/build`, so the same file is one directory-free hop away.
    const target = manifest ?? `./${specifier.slice(BUILD_DIR_PREFIX.length)}`
    return line.replace(`"${specifier}"`, `"${target}"`)
  })
  const names = rewritten.map((line) => {
    const braced = /import\s+\{([^}]*)\}/.exec(line)
    if (braced?.[1] !== undefined) {
      return braced[1]
        .split(",")
        .map((name) => name.trim())
        .filter((name) => name.length > 0)
    }
    const bare = /import\s+([A-Za-z_$][\w$]*)\s+from/.exec(line)
    if (bare?.[1] === undefined) throw new Error(`cannot read bindings from: ${line}`)
    return [bare[1]]
  })
  return `${rewritten.join("\n")}\n\nexport default { ${names.flat().join(", ")} }\n`
}

const created: string[] = []

afterEach(async () => {
  await Promise.all(created.splice(0).map(removeFixtureApp))
})

describe("the canonical Edge guide's composition skeleton, bundled as wrangler bundles", () => {
  test("presents the Hono host boundary as declaration-free JavaScript in host.mjs", async () => {
    const example = await readHostRouterExample()
    expect(example).toContain('import { dawnApp } from "./dawn-edge.mjs"')
    expect(example).toContain('app.route("/", dawnApp)')
    expect(example).not.toMatch(/^\s*(?:interface|type)\s/m)
  })

  test("links with zero node: specifiers — and names the edge manifest, not the node one", async () => {
    const lines = importLines(await readCompositionSkeleton())
    expect(lines.length).toBeGreaterThan(0)

    // Both targets in one build dir so `modules.mjs` and `modules.edge.mjs` sit
    // side by side: whichever one the docs name, it resolves, and the answer is
    // about the manifest's CONTENTS rather than about a missing file.
    const appRoot = await createFixtureApp("dawn-docs-edge-snippet-", ["node", "hono"])
    created.push(appRoot)
    const buildDir = await buildFixture(appRoot)
    expect(existsSync(join(buildDir, "modules.mjs"))).toBe(true)
    expect(existsSync(join(buildDir, "modules.edge.mjs"))).toBe(true)

    const entry = join(buildDir, "docs-snippet.entry.mjs")
    await writeFile(entry, entrySource(lines), "utf8")

    const found = nodeImports(await bundleAsWrangler(entry, join(buildDir, "docs-snippet.mjs")))

    // Named, not counted: "which import, from where" is the only useful failure.
    expect(found).toEqual([])
  }, 180_000)

  test("negative control: the node target's modules.mjs drags builtins in, so this can fail", async () => {
    const lines = importLines(await readCompositionSkeleton())

    const appRoot = await createFixtureApp("dawn-docs-edge-snippet-control-", ["node", "hono"])
    created.push(appRoot)
    const buildDir = await buildFixture(appRoot)

    const entry = join(buildDir, "control.entry.mjs")
    await writeFile(entry, entrySource(lines, "./modules.mjs"), "utf8")

    // The exact defect the docs shipped, and it does not even reach the
    // metafile: `external: ["node:*"]` covers `node:fs`, not BARE `fs`, so the
    // node manifest's graph leaves esbuild with builtins it cannot resolve and
    // the build throws. (`nodejs_compat` would not have helped either — it maps
    // `node:`-prefixed specifiers.)
    const outcome = await bundleAsWrangler(entry, join(buildDir, "control.mjs")).then(
      (metafile) => ({ error: undefined, found: nodeImports(metafile) }),
      (error: unknown) => ({ error: error as Error, found: [] as string[] }),
    )

    const clean = outcome.error === undefined && outcome.found.length === 0
    expect(
      clean,
      "the node target's modules.mjs bundled clean under Workers conditions — if that is " +
        "genuinely now true, this control has stopped controlling for anything and the docs " +
        "test above proves less than its name claims.",
    ).toBe(false)
  }, 180_000)
})
