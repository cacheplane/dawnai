import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { __clearDawnConfigCacheForTests, loadDawnConfig } from "@dawn-ai/core"
import { afterEach, beforeEach, describe, expect, it } from "vitest"

import { createRuntimeFetchHandler } from "../src/lib/dev/runtime-fetch-handler.js"

const cleanup: Array<() => Promise<void> | void> = []

// The config memo is process-global and shared with every other test in this
// worker — always clear what we seed, on both sides, so a leaked entry can
// never poison (or be poisoned by) another suite.
beforeEach(() => __clearDawnConfigCacheForTests())

afterEach(async () => {
  for (const fn of cleanup.splice(0).reverse()) await fn()
  __clearDawnConfigCacheForTests()
})

async function fixtureApp(): Promise<string> {
  const appRoot = await mkdtemp(join(tmpdir(), "dawn-config-seam-"))
  cleanup.push(() => rm(appRoot, { force: true, maxRetries: 5, recursive: true, retryDelay: 100 }))
  const files: Record<string, string> = {
    "dawn.config.ts": 'export default { permissions: { mode: "bypass" } }\n',
    "package.json": '{ "name": "config-seam-fixture", "type": "module" }\n',
    "src/app/probe/index.ts": "export const workflow = async (_input: unknown) => ({ ok: true })\n",
  }
  for (const [rel, body] of Object.entries(files)) {
    const filePath = join(appRoot, rel)
    await mkdir(join(filePath, ".."), { recursive: true })
    await writeFile(filePath, body, "utf8")
  }
  return appRoot
}

describe("createRuntimeFetchHandler — config seam", () => {
  it("a supplied config is seeded before boot and beats the dawn.config.ts on disk", async () => {
    const appRoot = await fixtureApp()

    const handler = await createRuntimeFetchHandler({
      appRoot,
      config: { permissions: { mode: "non-interactive" } },
    })
    cleanup.push(() => handler.close())

    // The memo is process-global — a seeded entry resolving here IS the
    // seam's contract: every resolver that ran during boot saw this object,
    // and the on-disk `permissions.mode: "bypass"` was never read.
    const loaded = await loadDawnConfig({ appRoot })
    expect(loaded.configPath).toBe("<seeded>")
    expect(loaded.config.permissions?.mode).toBe("non-interactive")
  })

  it("without a config option, boot loads dawn.config.ts from disk (control)", async () => {
    const appRoot = await fixtureApp()

    const handler = await createRuntimeFetchHandler({ appRoot })
    cleanup.push(() => handler.close())

    const loaded = await loadDawnConfig({ appRoot })
    expect(loaded.configPath).toBe(join(appRoot, "dawn.config.ts"))
    expect(loaded.config.permissions?.mode).toBe("bypass")
  })
})
