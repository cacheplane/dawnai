import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import type { RouteManifest } from "@dawn-ai/core"
import { afterEach, describe, expect, it } from "vitest"

import { buildTargets } from "../src/lib/build/targets/index.js"
import { assertNoThreadAccessPolicy } from "../src/lib/build/targets/thread-access-probe.js"

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
  it("fails the hono build", async () => {
    const appRoot = await fixtureApp({ "src/thread-access.ts": POLICY_FILE })
    await expect(buildTargets.hono?.emit(emitContext(appRoot))).rejects.toMatchObject({
      code: "DAWN_E1005",
    })
  })

  it("fails the langsmith build", async () => {
    const appRoot = await fixtureApp({ "src/thread-access.ts": POLICY_FILE })
    await expect(buildTargets.langsmith?.emit(emitContext(appRoot))).rejects.toMatchObject({
      code: "DAWN_E1005",
    })
  })

  // `vercel` landed on main while this branch was open. It shares `hono`'s
  // bundled web runtime and so shares its inability to probe a policy file at
  // boot — but the guard was enumerated per target, so it inherited nothing.
  // The probe now sits in `emitWebRuntimeArtifacts`; this is the test that
  // would have caught the gap, and that a third web target gets for free.
  it("fails the vercel build", async () => {
    const appRoot = await fixtureApp({ "src/thread-access.ts": POLICY_FILE })
    await expect(buildTargets.vercel?.emit(emitContext(appRoot))).rejects.toMatchObject({
      code: "DAWN_E1005",
    })
  })

  it("names the target that refused, not the shared emitter", async () => {
    const appRoot = await fixtureApp({ "src/thread-access.ts": POLICY_FILE })
    await expect(buildTargets.vercel?.emit(emitContext(appRoot))).rejects.toThrow(/vercel/)
  })
})
