import { dirname, join, resolve } from "node:path"
import { build, type Metafile } from "esbuild"
import { describe, expect, it } from "vitest"

const pkgRoot = resolve(dirname(new URL(import.meta.url).pathname), "..")

/**
 * Bundle an entry the way an edge target would: `platform: "neutral"`, so
 * nothing node-shaped can be resolved implicitly. `node:*` is external only so
 * the bundle completes — the assertions below are what decide whether a `node:`
 * import is acceptable.
 */
async function bundle(entry: string): Promise<Metafile> {
  const result = await build({
    absWorkingDir: pkgRoot,
    bundle: true,
    conditions: ["import"],
    entryPoints: [join(pkgRoot, "src", entry)],
    external: ["node:*"],
    format: "esm",
    logLevel: "silent",
    mainFields: ["module", "main"],
    metafile: true,
    outfile: join(pkgRoot, "entry-purity.bundle.mjs"),
    platform: "neutral",
    write: false,
  })
  if (!result.metafile) throw new Error("esbuild produced no metafile")
  return result.metafile
}

/** Every `node:` import in the graph, as `spec <- file`. */
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

describe("@dawn-ai/permissions entry purity", () => {
  it("reaches no node: import from the '.' barrel", async () => {
    expect(nodeImportEdges(await bundle("index.ts"))).toEqual([])
  }, 60_000)

  // Negative control: the node-only subpath MUST fail the same check, proving
  // the detector matches rather than passing on an empty metafile.
  it("detects violations — the './node' subpath is full of node: imports", async () => {
    expect(nodeImportEdges(await bundle("node.ts")).length).toBeGreaterThan(0)
  }, 60_000)
})
