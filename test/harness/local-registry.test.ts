import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { afterAll, beforeAll, describe, expect, test } from "vitest"

import { type LocalRegistry, publishWorkspace, startLocalRegistry } from "./local-registry.ts"
import { runPackagedCommand } from "./packaged-app.ts"
import { writePnpmWorkspaceBuildPolicy } from "./scaffold-packaging.ts"

describe("local-registry", () => {
  let registry: LocalRegistry

  beforeAll(async () => {
    registry = await startLocalRegistry()
    await publishWorkspace(registry.url)
  }, 180_000)

  afterAll(async () => {
    await registry?.stop()
  })

  test("serves a published @dawn-ai package that a real install resolves", async () => {
    const dir = await mkdtemp(join(tmpdir(), "dawn-reg-probe-"))
    try {
      await writeFile(
        join(dir, "package.json"),
        `${JSON.stringify({ name: "probe", private: true, dependencies: { "@dawn-ai/core": "latest" } }, null, 2)}\n`,
        "utf8",
      )
      await writeFile(join(dir, ".npmrc"), `registry=${registry.url}\n`, "utf8")
      await writePnpmWorkspaceBuildPolicy(dir)

      await runPackagedCommand({
        args: ["install", "--no-frozen-lockfile"],
        command: "pnpm",
        cwd: dir,
        // Pin the install onto this registry via npm_config_registry (highest
        // precedence). The .npmrc alone leaks transitive @dawn-ai/* resolution
        // to npmjs, which fails mid-release when the candidate is partially
        // published there.
        env: { npm_config_registry: registry.url },
      })

      const lockfile = await readFile(join(dir, "pnpm-lock.yaml"), "utf8")
      expect(lockfile).toContain("@dawn-ai/core")
      expect(lockfile).not.toContain("registry.npmjs.org/@dawn-ai")
    } finally {
      await rm(dir, { force: true, recursive: true })
    }
  }, 180_000)

  test("404s for an @dawn-ai package that was never published (fail-closed)", async () => {
    const dir = await mkdtemp(join(tmpdir(), "dawn-reg-neg-"))
    try {
      await writeFile(
        join(dir, "package.json"),
        `${JSON.stringify({ name: "neg", private: true, dependencies: { "@dawn-ai/does-not-exist": "latest" } }, null, 2)}\n`,
        "utf8",
      )
      await writeFile(join(dir, ".npmrc"), `registry=${registry.url}\n`, "utf8")

      await expect(
        runPackagedCommand({
          args: ["install", "--no-frozen-lockfile"],
          command: "pnpm",
          cwd: dir,
          env: { npm_config_registry: registry.url },
        }),
      ).rejects.toThrow()
    } finally {
      await rm(dir, { force: true, recursive: true })
    }
  }, 120_000)
})
