import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
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
  test("reports missing packages not in package.json or node_modules", async () => {
    writeFileSync(
      join(tempDir, "package.json"),
      JSON.stringify({
        dependencies: { "@dawn-ai/cli": "0.1.6", "@dawn-ai/sdk": "0.1.6" },
      }),
    )

    const result = await checkDependencies({ appRoot: tempDir })

    expect(result.missingPackages).toContain("@langchain/core")
    expect(result.missingPackages).toContain("@langchain/openai")
    expect(result.missingPackages).toContain("@langchain/langgraph")
  })

  test("passes when packages are declared in dependencies", async () => {
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

    const result = await checkDependencies({ appRoot: tempDir })

    expect(result.missingPackages).toEqual([])
  })

  test("passes when packages are in devDependencies", async () => {
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

    const result = await checkDependencies({ appRoot: tempDir })

    expect(result.missingPackages).toEqual([])
  })

  test("reports the OpenAI key for an OpenAI app when not in process.env or .env file", async () => {
    saveEnv("OPENAI_API_KEY")
    delete process.env.OPENAI_API_KEY

    writeFileSync(join(tempDir, "package.json"), JSON.stringify({ dependencies: {} }))

    const result = await checkDependencies({ appRoot: tempDir, providers: ["openai"] })

    expect(result.missingEnvVars).toContain("OPENAI_API_KEY")
  })

  test("reports the Anthropic key (not OPENAI_API_KEY) for an Anthropic-only app", async () => {
    saveEnv("ANTHROPIC_API_KEY", "OPENAI_API_KEY")
    delete process.env.ANTHROPIC_API_KEY
    delete process.env.OPENAI_API_KEY

    writeFileSync(join(tempDir, "package.json"), JSON.stringify({ dependencies: {} }))

    const result = await checkDependencies({ appRoot: tempDir, providers: ["anthropic"] })

    expect(result.missingEnvVars).toContain("ANTHROPIC_API_KEY")
    expect(result.missingEnvVars).not.toContain("OPENAI_API_KEY")
  })

  test("reports the union of keys for a multi-provider app", async () => {
    saveEnv("ANTHROPIC_API_KEY", "OPENAI_API_KEY")
    delete process.env.ANTHROPIC_API_KEY
    delete process.env.OPENAI_API_KEY

    writeFileSync(join(tempDir, "package.json"), JSON.stringify({ dependencies: {} }))

    const result = await checkDependencies({
      appRoot: tempDir,
      providers: ["openai", "anthropic"],
    })

    expect(result.missingEnvVars).toContain("OPENAI_API_KEY")
    expect(result.missingEnvVars).toContain("ANTHROPIC_API_KEY")
  })

  test("requires no key for an ollama-only app", async () => {
    writeFileSync(join(tempDir, "package.json"), JSON.stringify({ dependencies: {} }))

    const result = await checkDependencies({ appRoot: tempDir, providers: ["ollama"] })

    expect(result.missingEnvVars).toEqual([])
  })

  test("requires no key when the app uses no providers", async () => {
    writeFileSync(join(tempDir, "package.json"), JSON.stringify({ dependencies: {} }))

    const result = await checkDependencies({ appRoot: tempDir, providers: [] })

    expect(result.missingEnvVars).toEqual([])
  })

  test("passes env check when var is in process.env", async () => {
    saveEnv("OPENAI_API_KEY")
    process.env.OPENAI_API_KEY = "sk-test"

    writeFileSync(join(tempDir, "package.json"), JSON.stringify({ dependencies: {} }))

    const result = await checkDependencies({ appRoot: tempDir, providers: ["openai"] })

    expect(result.missingEnvVars).not.toContain("OPENAI_API_KEY")
  })

  test("passes env check when var is in .env file", async () => {
    saveEnv("OPENAI_API_KEY")
    delete process.env.OPENAI_API_KEY

    writeFileSync(join(tempDir, "package.json"), JSON.stringify({ dependencies: {} }))
    writeFileSync(join(tempDir, ".env"), "OPENAI_API_KEY=sk-test-key\n")

    const result = await checkDependencies({ appRoot: tempDir, providers: ["openai"] })

    expect(result.missingEnvVars).not.toContain("OPENAI_API_KEY")
  })

  test("returns empty results when package.json is missing", async () => {
    const result = await checkDependencies({ appRoot: tempDir, providers: ["openai"] })

    expect(result.missingPackages).toEqual([])
    expect(result.missingEnvVars).toEqual([])
  })

  test("passes env check when var is in a file pointed to by envFile", async () => {
    saveEnv("OPENAI_API_KEY")
    delete process.env.OPENAI_API_KEY

    writeFileSync(join(tempDir, "package.json"), JSON.stringify({ dependencies: {} }))
    // Required var is absent from <appRoot>/.env but present in custom.env.
    writeFileSync(join(tempDir, ".env"), "SOMETHING_ELSE=1\n")
    writeFileSync(join(tempDir, "custom.env"), "OPENAI_API_KEY=sk-from-custom\n")

    const result = await checkDependencies({
      appRoot: tempDir,
      providers: ["openai"],
      envFile: "custom.env",
    })

    expect(result.missingEnvVars).not.toContain("OPENAI_API_KEY")
  })
})
