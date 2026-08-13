import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import type { RouteManifest } from "@dawn-ai/core"
import { afterEach, describe, expect, it } from "vitest"

import { buildTargets } from "../src/lib/build/targets/index.js"
import { assertNoThreadAccessPolicy } from "../src/lib/build/targets/thread-access-probe.js"
import { emitWebRuntimeArtifacts } from "../src/lib/build/targets/web-runtime.js"
import { findThreadAccessFile } from "../src/lib/dev/thread-access-node.js"

const tempDirs: string[] = []

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { force: true, recursive: true })))
})

const POLICY_FILE = 'export default { fallback: () => ({ decision: "allow" }) }\n'

async function fixtureApp(files: Readonly<Record<string, string>> = {}): Promise<string> {
  const appRoot = await mkdtemp(join(tmpdir(), "dawn-thread-access-build-"))
  tempDirs.push(appRoot)
  const appFiles: Record<string, string> = {
    "dawn.config.ts": "export default {}\n",
    "package.json": '{ "name": "build-probe-fixture", "type": "module" }\n',
    ...files,
  }
  for (const [relativePath, source] of Object.entries(appFiles)) {
    const filePath = join(appRoot, relativePath)
    await mkdir(dirname(filePath), { recursive: true })
    await writeFile(filePath, source, "utf8")
  }
  return appRoot
}

function emitContext(appRoot: string) {
  return {
    appRoot,
    buildDir: join(appRoot, ".dawn/build"),
    manifest: { appRoot, routes: [] } as unknown as RouteManifest,
  }
}

describe("assertNoThreadAccessPolicy", () => {
  it("does nothing when the app has no policy file", async () => {
    const appRoot = await fixtureApp()
    expect(() => assertNoThreadAccessPolicy(appRoot, "hono")).not.toThrow()
  })

  it("throws DAWN_E1005 naming the target and the file", async () => {
    const appRoot = await fixtureApp({ "src/thread-access.ts": POLICY_FILE })
    expect(() => assertNoThreadAccessPolicy(appRoot, "hono")).toThrow(/src\/thread-access\.ts/)
    try {
      assertNoThreadAccessPolicy(appRoot, "hono")
      expect.unreachable("expected a CliError")
    } catch (error) {
      expect(error).toMatchObject({ code: "DAWN_E1005" })
      expect(String(error)).toContain("hono")
    }
  })

  it("probes every candidate path, not just src/", async () => {
    const appRoot = await fixtureApp({ "thread-access.js": POLICY_FILE })
    expect(() => assertNoThreadAccessPolicy(appRoot, "langsmith")).toThrow(/thread-access\.js/)
  })
})

describe("build targets that cannot carry a policy", () => {
  it("fails the langsmith build", async () => {
    const appRoot = await fixtureApp({ "src/thread-access.ts": POLICY_FILE })
    await expect(buildTargets.langsmith?.emit(emitContext(appRoot))).rejects.toMatchObject({
      code: "DAWN_E1005",
    })
  })

  it("names the target that refused", async () => {
    const appRoot = await fixtureApp({ "src/thread-access.ts": POLICY_FILE })
    await expect(buildTargets.langsmith?.emit(emitContext(appRoot))).rejects.toThrow(/langsmith/)
  })
})

// ---------------------------------------------------------------------------
// The web targets CAN carry a policy now: the manifest binds it through a
// static import, and the entry point stamps what the build saw so a manifest
// that predates the policy cannot boot silently ungated.
//
// `vercel` is covered alongside `hono` because there is one shared emitter, not
// because the plan asked for it: the two targets differ only in the handful of
// lines `edgeFlavor` changes, so a hono-only assertion would prove nothing
// about the code path vercel actually runs — and refusing vercel would now be a
// false refusal for a runtime that carries the policy perfectly well.
// ---------------------------------------------------------------------------

describe("web targets carry the policy", () => {
  it("emits the thread-access entry into the hono manifest", async () => {
    const appRoot = await fixtureApp({ "src/thread-access.ts": POLICY_FILE })
    await buildTargets.hono?.emit(emitContext(appRoot))

    const modules = await readFile(join(appRoot, ".dawn/build/modules.edge.mjs"), "utf8")
    expect(modules).toContain(
      'import { buildStaticRouteModule, normalizeThreadAccessModule } from "@dawn-ai/cli/fetch"',
    )
    expect(modules).toContain('import * as threadAccessModule from "../../src/thread-access.ts"')
    expect(modules).toContain("  threadAccess: normalizeThreadAccessModule(threadAccessModule),")
  })

  it("stamps what the build saw into the hono entry point", async () => {
    const appRoot = await fixtureApp({ "src/thread-access.ts": POLICY_FILE })
    await buildTargets.hono?.emit(emitContext(appRoot))

    const entry = await readFile(join(appRoot, ".dawn/build/app.mjs"), "utf8")
    expect(entry).toContain("threadAccessExpected: true,")
  })

  it("emits neither for an app with no policy file", async () => {
    const appRoot = await fixtureApp()
    await buildTargets.hono?.emit(emitContext(appRoot))

    const modules = await readFile(join(appRoot, ".dawn/build/modules.edge.mjs"), "utf8")
    const entry = await readFile(join(appRoot, ".dawn/build/app.mjs"), "utf8")
    expect(modules).not.toContain("normalizeThreadAccessModule")
    expect(modules).not.toContain("threadAccessModule")
    expect(entry).not.toContain("threadAccessExpected")
  })

  it("carries it through the shared web emitter for vercel too", async () => {
    const appRoot = await fixtureApp({ "src/thread-access.ts": POLICY_FILE })
    const outputDir = join(appRoot, ".vercel/.dawn-vercel-test/runtime")
    const runtime = await emitWebRuntimeArtifacts(emitContext(appRoot), {
      outputDir,
      targetName: "vercel",
    })

    const modules = await readFile(runtime.modulesPath, "utf8")
    const entry = await readFile(runtime.appPath, "utf8")
    expect(modules).toContain("Generated by dawn build (vercel target)")
    expect(modules).toContain("  threadAccess: normalizeThreadAccessModule(threadAccessModule),")
    expect(entry).toContain("threadAccessExpected: true,")
  })

  it("probes the policy file the way the loader does, not with existsSync", async () => {
    // `existsSync` answers false for EVERY error, so an EACCES on the policy
    // file would drop it out of the manifest and ship a bundle with every
    // thread endpoint open — the fail-open moved into the build rather than
    // fixed. Only the syscall is stubbed; the real candidate list runs.
    const appRoot = await fixtureApp({ "src/thread-access.ts": POLICY_FILE })
    expect(() =>
      findThreadAccessFile(appRoot, (path) => {
        throw Object.assign(new Error(`EACCES: lstat '${path}'`), { code: "EACCES" })
      }),
    ).toThrow(/EACCES|could not be probed/)
  })

  it("finds the first existing candidate, and nothing when there is none", async () => {
    const appRoot = await fixtureApp({ "thread-access.js": POLICY_FILE })
    expect(findThreadAccessFile(appRoot)).toBe(`${appRoot}/thread-access.js`)
    expect(findThreadAccessFile(await fixtureApp())).toBeUndefined()
  })
})
