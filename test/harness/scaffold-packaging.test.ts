import { mkdtemp, readFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { describe, expect, it } from "vitest"

import { registryLatestSpecifiers, writeRegistryNpmrc } from "./scaffold-packaging.js"

describe("writeRegistryNpmrc", () => {
  it("includes registry specifiers for scaffold dependencies", () => {
    expect(registryLatestSpecifiers()).toMatchObject({
      dawnSandbox: "latest",
    })
  })

  it("writes a registry-pinned .npmrc with an auth token line", async () => {
    const dir = await mkdtemp(join(tmpdir(), "npmrc-"))
    await writeRegistryNpmrc(dir, "http://127.0.0.1:4873/")
    const npmrc = await readFile(join(dir, ".npmrc"), "utf8")
    expect(npmrc).toContain("registry=http://127.0.0.1:4873/")
    expect(npmrc).toContain('//127.0.0.1:4873/:_authToken="fake"')
    await expect(readFile(join(dir, "pnpm-workspace.yaml"), "utf8")).resolves.toContain(
      "allowBuilds:",
    )
  })
})
