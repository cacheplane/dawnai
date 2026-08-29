import { readFileSync } from "node:fs"
import { describe, expect, it } from "vitest"
import nextConfig from "../next.config"

interface TypeScriptConfig {
  readonly extends?: string
  readonly include?: readonly string[]
  readonly exclude?: readonly string[]
}

function readConfig(relativePath: string): TypeScriptConfig {
  return JSON.parse(
    readFileSync(new URL(relativePath, import.meta.url), "utf8"),
  ) as TypeScriptConfig
}

describe("production web build boundary", () => {
  it("keeps test files in the normal web typecheck", () => {
    const config = readConfig("../tsconfig.json")

    expect(config.include).toContain("**/*.ts")
    expect(config.exclude).not.toContain("**/*.test.ts")
  })

  it("uses a production-only TypeScript config that excludes test modules", () => {
    const config = readConfig("../tsconfig.build.json")

    expect(config.extends).toBe("./tsconfig.json")
    expect(config.exclude).toEqual(
      expect.arrayContaining([
        "node_modules",
        "**/*.test.ts",
        "**/*.test.tsx",
        "**/*.spec.ts",
        "**/*.spec.tsx",
      ]),
    )
    expect(nextConfig.typescript?.tsconfigPath).toBe("./tsconfig.build.json")
  })
})
