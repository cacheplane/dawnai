import { join } from "node:path"
import { fileURLToPath } from "node:url"
import { build } from "esbuild"
import { describe, expect, it } from "vitest"

const pkgRoot = fileURLToPath(new URL("..", import.meta.url))

/**
 * platform: "browser" with node builtins NOT externalized — any surviving
 * `node:`/`net`/`tls` import is an unresolvable specifier and the build throws.
 * This is what the spike's 17 link errors looked like before pg went type-only.
 */
async function linkForEdge(entry: string): Promise<void> {
  await build({
    absWorkingDir: pkgRoot,
    bundle: true,
    conditions: ["import"],
    entryPoints: [join(pkgRoot, "src", entry)],
    external: ["@langchain/*", "@dawn-ai/permissions"],
    format: "esm",
    logLevel: "silent",
    mainFields: ["module", "main"],
    platform: "browser",
    write: false,
  })
}

describe("edge linkability", () => {
  it("links the main entry with no node builtins", async () => {
    await expect(linkForEdge("index.ts")).resolves.toBeUndefined()
  }, 120_000)

  it("negative control: the node entry does NOT link", async () => {
    await expect(linkForEdge("node.ts")).rejects.toThrow(/Could not resolve/)
  }, 120_000)
})
