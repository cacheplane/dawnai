import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, beforeEach, describe, expect, test } from "vitest"

import { loadEnvFile } from "../src/lib/dev/load-env.js"

let tempDir: string
const originalEnv: Record<string, string | undefined> = {}

beforeEach(() => {
  tempDir = mkdtempSync(join(tmpdir(), "dawn-env-"))
})

afterEach(() => {
  rmSync(tempDir, { recursive: true, force: true })
  // Restore any env vars we modified
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

describe("loadEnvFile", () => {
  test("loads variables from .env file", () => {
    saveEnv("TEST_DAWN_FOO", "TEST_DAWN_BAR")
    delete process.env.TEST_DAWN_FOO
    delete process.env.TEST_DAWN_BAR

    writeFileSync(join(tempDir, ".env"), "TEST_DAWN_FOO=hello\nTEST_DAWN_BAR=world\n")

    const count = loadEnvFile(tempDir)

    expect(count).toBe(2)
    expect(process.env.TEST_DAWN_FOO).toBe("hello")
    expect(process.env.TEST_DAWN_BAR).toBe("world")
  })

  test("does not override existing env vars", () => {
    saveEnv("TEST_DAWN_EXISTING")
    process.env.TEST_DAWN_EXISTING = "original"

    writeFileSync(join(tempDir, ".env"), "TEST_DAWN_EXISTING=overridden\n")

    const count = loadEnvFile(tempDir)

    expect(count).toBe(0)
    expect(process.env.TEST_DAWN_EXISTING).toBe("original")
  })

  test("skips comments and blank lines", () => {
    saveEnv("TEST_DAWN_ONLY")
    delete process.env.TEST_DAWN_ONLY

    writeFileSync(
      join(tempDir, ".env"),
      "# This is a comment\n\nTEST_DAWN_ONLY=value\n\n# Another comment\n",
    )

    const count = loadEnvFile(tempDir)

    expect(count).toBe(1)
    expect(process.env.TEST_DAWN_ONLY).toBe("value")
  })

  test("strips surrounding quotes", () => {
    saveEnv("TEST_DAWN_DOUBLE", "TEST_DAWN_SINGLE")
    delete process.env.TEST_DAWN_DOUBLE
    delete process.env.TEST_DAWN_SINGLE

    writeFileSync(
      join(tempDir, ".env"),
      "TEST_DAWN_DOUBLE=\"quoted value\"\nTEST_DAWN_SINGLE='single quoted'\n",
    )

    const count = loadEnvFile(tempDir)

    expect(count).toBe(2)
    expect(process.env.TEST_DAWN_DOUBLE).toBe("quoted value")
    expect(process.env.TEST_DAWN_SINGLE).toBe("single quoted")
  })

  test("returns 0 when no .env file exists", () => {
    const count = loadEnvFile(tempDir)
    expect(count).toBe(0)
  })

  test("auto-enables LANGCHAIN_TRACING_V2 when LANGSMITH_API_KEY is present", () => {
    saveEnv("LANGSMITH_API_KEY", "LANGCHAIN_TRACING_V2")
    delete process.env.LANGSMITH_API_KEY
    delete process.env.LANGCHAIN_TRACING_V2

    writeFileSync(join(tempDir, ".env"), "LANGSMITH_API_KEY=lsv2_test_key\n")

    const count = loadEnvFile(tempDir)

    expect(count).toBe(2) // key + auto-set tracing
    expect(process.env.LANGSMITH_API_KEY).toBe("lsv2_test_key")
    expect(process.env.LANGCHAIN_TRACING_V2).toBe("true")
  })

  test("does not override explicit LANGCHAIN_TRACING_V2=false", () => {
    saveEnv("LANGSMITH_API_KEY", "LANGCHAIN_TRACING_V2")
    delete process.env.LANGSMITH_API_KEY
    delete process.env.LANGCHAIN_TRACING_V2

    writeFileSync(
      join(tempDir, ".env"),
      "LANGSMITH_API_KEY=lsv2_test_key\nLANGCHAIN_TRACING_V2=false\n",
    )

    const _count = loadEnvFile(tempDir)

    expect(process.env.LANGCHAIN_TRACING_V2).toBe("false")
  })
})
