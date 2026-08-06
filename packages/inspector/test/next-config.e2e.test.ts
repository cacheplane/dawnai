import { readFileSync } from "node:fs"
import { resolve } from "node:path"
import { describe, expect, test } from "vitest"

type PackageManifest = {
  dependencies?: Record<string, string>
}

const repoRoot = resolve(import.meta.dirname, "../../..")
const nextApps = [
  ["apps/web", "next.config.ts"],
  ["packages/inspector", "next.config.ts"],
  ["examples/chat/web", "next.config.mjs"],
  ["examples/research/web", "next.config.mjs"],
] as const

function readManifest(appDir: string): PackageManifest {
  return JSON.parse(
    readFileSync(resolve(repoRoot, appDir, "package.json"), "utf8"),
  ) as PackageManifest
}

describe("Next TypeScript CLI configuration", () => {
  test("pins every Next application to Next 16.3.0", () => {
    for (const [appDir] of nextApps) {
      expect.soft(readManifest(appDir).dependencies?.next, appDir).toBe("16.3.0")
    }
  })

  test("pins the docs MDX integration to Next 16.3.0", () => {
    expect(readManifest("apps/web").dependencies?.["@next/mdx"]).toBe("16.3.0")
  })

  test("enables the TypeScript CLI in every Next application", () => {
    for (const [appDir, configFile] of nextApps) {
      const config = readFileSync(resolve(repoRoot, appDir, configFile), "utf8")
      expect.soft(config, appDir).toMatch(/experimental\s*:\s*{\s*useTypeScriptCli\s*:\s*true\s*}/)
    }
  })
})
