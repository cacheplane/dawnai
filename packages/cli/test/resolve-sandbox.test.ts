import { mkdtemp, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { describe, expect, test } from "vitest"
import { resolveSandboxManager } from "../src/lib/runtime/resolve-sandbox.js"

describe("resolveSandboxManager", () => {
  test("returns undefined when no dawn.config.ts", async () => {
    const appRoot = await mkdtemp(join(tmpdir(), "dawn-sbx-cfg-"))
    expect(await resolveSandboxManager(appRoot)).toBeUndefined()
  })

  test("builds a manager from config.sandbox.provider", async () => {
    const appRoot = await mkdtemp(join(tmpdir(), "dawn-sbx-cfg-"))
    await writeFile(
      join(appRoot, "dawn.config.ts"),
      [
        `import { fakeSandbox } from "@dawn-ai/sandbox/testing"`,
        `export default { sandbox: { provider: fakeSandbox(), network: { mode: "deny" } } }`,
      ].join("\n"),
      "utf8",
    )
    const mgr = await resolveSandboxManager(appRoot)
    expect(mgr).toBeDefined()
  })
})
