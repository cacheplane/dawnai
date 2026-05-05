import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, beforeEach, describe, expect, test } from "vitest"

import { checkDependencies } from "../src/lib/verify/check-dependencies.js"

let tempDir: string
const originalEnv: Record<string, string | undefined> = {}

beforeEach(() => {
  tempDir = mkdtempSync(join(tmpdir(), "dawn-deps-"))
})

afterEach(() => {
  rmSync(tempDir, { recursive: true, force: true })
  for (const [key, value] of Object.entries(originalEnv)) {
    if (value === undefined) {
      delete process.env[key]
    } else {
      process.env[key] = value
    }
  }
})

function saveEnv(...keys: string[]) {
  for (const key of keys) {
    originalEnv[key] = process.env[key]
  }
}

describe("checkDependencies", () => {
  test("reports missing packages not in package.json or node_modules", () => {
    writeFileSync(
      join(tempDir, "package.json"),
      JSON.stringify({
        dependencies: { "@dawn-ai/cli": "0.1.6", "@dawn-ai/sdk": "0.1.6" },
      }),
    )

    const result = checkDependencies(tempDir)

    expect(result.missingPackages).toContain("@langchain/core")
    expect(result.missingPackages).toContain("@langchain/openai")
    expect(result.missingPackages).toContain("@langchain/langgraph")
  })

  test("passes when packages are declared in dependencies", () => {
    writeFileSync(
      join(tempDir, "package.json"),
      JSON.stringify({
        dependencies: {
          "@langchain/core": "0.3.62",
          "@langchain/openai": "0.5.0",
          "@langchain/langgraph": "0.2.0",
        },
      }),
    )

    const result = checkDependencies(tempDir)

    expect(result.missingPackages).toEqual([])
  })

  test("passes when packages are in devDependencies", () => {
    writeFileSync(
      join(tempDir, "package.json"),
      JSON.stringify({
        devDependencies: {
          "@langchain/core": "0.3.62",
          "@langchain/openai": "0.5.0",
          "@langchain/langgraph": "0.2.0",
        },
      }),
    )

    const result = checkDependencies(tempDir)

    expect(result.missingPackages).toEqual([])
  })

  test("reports missing env var when not in process.env or .env file", () => {
    saveEnv("OPENAI_API_KEY")
    delete process.env.OPENAI_API_KEY

    writeFileSync(join(tempDir, "package.json"), JSON.stringify({ dependencies: {} }))

    const result = checkDependencies(tempDir)

    expect(result.missingEnvVars).toContain("OPENAI_API_KEY")
  })

  test("passes env check when var is in process.env", () => {
    saveEnv("OPENAI_API_KEY")
    process.env.OPENAI_API_KEY = "sk-test"

    writeFileSync(join(tempDir, "package.json"), JSON.stringify({ dependencies: {} }))

    const result = checkDependencies(tempDir)

    expect(result.missingEnvVars).not.toContain("OPENAI_API_KEY")
  })

  test("passes env check when var is in .env file", () => {
    saveEnv("OPENAI_API_KEY")
    delete process.env.OPENAI_API_KEY

    writeFileSync(join(tempDir, "package.json"), JSON.stringify({ dependencies: {} }))
    writeFileSync(join(tempDir, ".env"), "OPENAI_API_KEY=sk-test-key\n")

    const result = checkDependencies(tempDir)

    expect(result.missingEnvVars).not.toContain("OPENAI_API_KEY")
  })

  test("returns empty results when package.json is missing", () => {
    const result = checkDependencies(tempDir)

    expect(result.missingPackages).toEqual([])
    expect(result.missingEnvVars).toEqual([])
  })
})
