import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, beforeEach, describe, expect, test } from "vitest"

import { extractDeploymentConfig } from "../src/lib/build/deployment-config.js"

let tempDir: string

beforeEach(() => {
  tempDir = mkdtempSync(join(tmpdir(), "dawn-deploy-"))
})

afterEach(() => {
  rmSync(tempDir, { recursive: true, force: true })
})

describe("extractDeploymentConfig", () => {
  test("returns dependencies as ['.'] (project root path)", () => {
    writeFileSync(
      join(tempDir, "package.json"),
      JSON.stringify({
        dependencies: {
          "@dawn-ai/cli": "0.1.6",
          "@langchain/openai": "0.5.0",
        },
      }),
    )

    const config = extractDeploymentConfig(tempDir)

    expect(config.dependencies).toEqual(["."])
  })

  test("returns env as path to .env file when .env exists", () => {
    writeFileSync(join(tempDir, "package.json"), JSON.stringify({ dependencies: {} }))
    writeFileSync(join(tempDir, ".env"), "OPENAI_API_KEY=sk-test\n")

    const config = extractDeploymentConfig(tempDir)

    expect(config.env).toBe(".env")
  })

  test("returns env as path to .env.example when it exists", () => {
    writeFileSync(join(tempDir, "package.json"), JSON.stringify({ dependencies: {} }))
    writeFileSync(join(tempDir, ".env.example"), "OPENAI_API_KEY=\n")

    const config = extractDeploymentConfig(tempDir)

    expect(config.env).toBe(".env.example")
  })

  test("prefers .env.example over .env", () => {
    writeFileSync(join(tempDir, "package.json"), JSON.stringify({ dependencies: {} }))
    writeFileSync(join(tempDir, ".env"), "OPENAI_API_KEY=real-key\nSECRET=value\n")
    writeFileSync(join(tempDir, ".env.example"), "OPENAI_API_KEY=\n")

    const config = extractDeploymentConfig(tempDir)

    expect(config.env).toBe(".env.example")
  })

  test("returns env as .env when no env files exist (will be created)", () => {
    writeFileSync(join(tempDir, "package.json"), JSON.stringify({ dependencies: {} }))

    const config = extractDeploymentConfig(tempDir)

    expect(config.env).toBe(".env")
  })

  test("returns node_version 22", () => {
    writeFileSync(join(tempDir, "package.json"), JSON.stringify({ dependencies: {} }))

    const config = extractDeploymentConfig(tempDir)

    expect(config.node_version).toBe("22")
  })
})
