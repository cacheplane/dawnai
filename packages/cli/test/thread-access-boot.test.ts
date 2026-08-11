import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { pathToFileURL } from "node:url"
import type { ThreadAccessPolicy } from "@dawn-ai/sdk"
import { afterEach, describe, expect, it, vi } from "vitest"

import { createRuntimeFetchHandler } from "../src/lib/dev/runtime-fetch-handler.js"
import { loadThreadAccess } from "../src/lib/dev/thread-access-node.js"
import { nodeBootFallbacks } from "../src/lib/runtime/execute-route.js"
import { loadStaticModules } from "../src/lib/runtime/static-modules.js"

const cleanup: Array<() => Promise<void> | void> = []

afterEach(async () => {
  for (const fn of cleanup.splice(0).reverse()) await fn()
})

const TRIVIAL_ROUTE = "export const graph = async () => ({ ok: true })\n"

const VALID_POLICY_FILE = `export default {
  fallback: () => ({ decision: "allow" }),
}
`

async function fixtureApp(files: Readonly<Record<string, string>> = {}): Promise<string> {
  const appRoot = await mkdtemp(join(tmpdir(), "dawn-thread-access-boot-"))
  cleanup.push(() => rm(appRoot, { force: true, recursive: true }))
  const appFiles: Record<string, string> = {
    "dawn.config.ts": "export default {}\n",
    "package.json": '{ "name": "thread-access-boot-fixture", "type": "module" }\n',
    "src/app/hello/index.ts": TRIVIAL_ROUTE,
    ...files,
  }
  for (const [relativePath, source] of Object.entries(appFiles)) {
    const filePath = join(appRoot, relativePath)
    await mkdir(dirname(filePath), { recursive: true })
    await writeFile(filePath, source, "utf8")
  }
  return appRoot
}

const allowAll: ThreadAccessPolicy = { fallback: () => ({ decision: "allow" }) }

async function bootWithLog(
  options: Parameters<typeof createRuntimeFetchHandler>[0],
): Promise<string[]> {
  const log = vi.spyOn(console, "log").mockImplementation(() => undefined)
  try {
    const handler = await createRuntimeFetchHandler(options)
    cleanup.push(() => handler.close())
    return log.mock.calls.map((call) => String(call[0]))
  } finally {
    log.mockRestore()
  }
}

describe("thread-access boot resolution", () => {
  it("logs that there is no policy for an app with no policy file", async () => {
    const appRoot = await fixtureApp()
    const lines = await bootWithLog({ appRoot })
    expect(lines).toContain("Dawn: no thread access policy (all thread endpoints are open)")
  })

  it("binds the app's policy file from disk and says so", async () => {
    const appRoot = await fixtureApp({ "src/thread-access.ts": VALID_POLICY_FILE })
    const lines = await bootWithLog({ appRoot })
    expect(lines).toContain("Dawn: thread access policy bound from src/thread-access.ts")
  })

  it("prefers an injected policy over the disk probe", async () => {
    const appRoot = await fixtureApp({ "src/thread-access.ts": VALID_POLICY_FILE })
    const lines = await bootWithLog({ appRoot, threadAccess: allowAll })
    expect(lines).toContain("Dawn: thread access policy bound from the runtime options")
  })

  it("fails the boot with DAWN_E3003 when the policy file cannot be bound", async () => {
    const appRoot = await fixtureApp({ "src/thread-access.ts": "export default { read: 1 }\n" })
    await expect(createRuntimeFetchHandler({ appRoot })).rejects.toMatchObject({
      code: "DAWN_E3003",
    })
  })

  it("fails the boot instead of reporting no policy when the file is unreachable", async () => {
    // The blocker, at the layer an operator actually sees it: with `existsSync`
    // deciding existence, an EACCES on the policy's directory booted every
    // thread endpoint open AND printed the reassuring "no thread access policy"
    // line. Only the syscall is stubbed — the real loader and the real boot
    // resolution run — because a chmod on `src` would also hide `src/app` from
    // route discovery, which fails earlier and would prove nothing.
    const appRoot = await fixtureApp({ "src/thread-access.ts": VALID_POLICY_FILE })
    const lines: string[] = []
    const log = vi.spyOn(console, "log").mockImplementation((line: unknown) => {
      lines.push(String(line))
    })
    try {
      await expect(
        createRuntimeFetchHandler({
          appRoot,
          bootFallbacks: {
            ...nodeBootFallbacks,
            loadThreadAccess: async (root) =>
              await loadThreadAccess(root, {
                statPath: (path) => {
                  throw Object.assign(new Error(`EACCES: lstat '${path}'`), { code: "EACCES" })
                },
              }),
          },
        }),
      ).rejects.toMatchObject({ code: "DAWN_E3003" })
    } finally {
      log.mockRestore()
    }
    expect(lines).not.toContain("Dawn: no thread access policy (all thread endpoints are open)")
  })
})

describe("loadStaticModules — threadAccess validation", () => {
  async function writeManifest(body: string): Promise<string> {
    const dir = await mkdtemp(join(tmpdir(), "dawn-thread-access-manifest-"))
    cleanup.push(() => rm(dir, { force: true, recursive: true }))
    const manifestPath = join(dir, "modules.mjs")
    await writeFile(manifestPath, body, "utf8")
    return manifestPath
  }

  it("throws the re-run-dawn-build error on a malformed threadAccess entry", async () => {
    const manifestPath = await writeManifest(
      "export default { threadAccess: { read: 1 }, routes: [] }\n",
    )
    await expect(loadStaticModules(pathToFileURL(manifestPath))).rejects.toThrow(
      /threadAccess.*re-run `dawn build`/s,
    )
  })

  it("accepts an explicitly-undefined threadAccess entry", async () => {
    const manifestPath = await writeManifest(
      "export default { threadAccess: undefined, routes: [] }\n",
    )
    const modules = await loadStaticModules(pathToFileURL(manifestPath))
    expect(modules.threadAccess).toBeUndefined()
  })

  it("accepts a well-formed threadAccess entry", async () => {
    const manifestPath = await writeManifest(
      'export default { threadAccess: { fallback: () => ({ decision: "allow" }) }, routes: [] }\n',
    )
    const modules = await loadStaticModules(pathToFileURL(manifestPath))
    expect(typeof modules.threadAccess?.fallback).toBe("function")
  })
})
