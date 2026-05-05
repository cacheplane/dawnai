import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, beforeEach, describe, expect, test } from "vitest"

import {
  extractDeploymentConfig,
  generateDockerfile,
} from "../src/lib/build/deployment-config.js"

let tempDir: string

beforeEach(() => {
  tempDir = mkdtempSync(join(tmpdir(), "dawn-deploy-"))
})

afterEach(() => {
  rmSync(tempDir, { recursive: true, force: true })
})

describe("extractDeploymentConfig", () => {
  test("extracts dependencies from package.json", () => {
    writeFileSync(
      join(tempDir, "package.json"),
      JSON.stringify({
        dependencies: {
          "@dawn-ai/cli": "0.1.6",
          "@langchain/openai": "0.5.0",
          zod: "^3.24.0",
        },
      }),
    )

    const config = extractDeploymentConfig(tempDir)

    expect(config.dependencies).toContain("@dawn-ai/cli@0.1.6")
    expect(config.dependencies).toContain("@langchain/openai@0.5.0")
    expect(config.dependencies).toContain("zod@^3.24.0")
  })

  test("extracts env vars from .env file", () => {
    writeFileSync(join(tempDir, "package.json"), JSON.stringify({ dependencies: {} }))
    writeFileSync(join(tempDir, ".env"), "OPENAI_API_KEY=sk-test\nLANGSMITH_API_KEY=lsv2_test\n")

    const config = extractDeploymentConfig(tempDir)

    expect(config.env).toContain("OPENAI_API_KEY")
    expect(config.env).toContain("LANGSMITH_API_KEY")
  })

  test("prefers .env.example for env schema", () => {
    writeFileSync(join(tempDir, "package.json"), JSON.stringify({ dependencies: {} }))
    writeFileSync(join(tempDir, ".env"), "OPENAI_API_KEY=real-key\nSECRET=value\n")
    writeFileSync(join(tempDir, ".env.example"), "OPENAI_API_KEY=\nLANGSMITH_API_KEY=\n")

    const config = extractDeploymentConfig(tempDir)

    expect(config.env).toContain("OPENAI_API_KEY")
    expect(config.env).toContain("LANGSMITH_API_KEY")
    // Should NOT include SECRET (only from .env.example)
    expect(config.env).not.toContain("SECRET")
  })

  test("defaults OPENAI_API_KEY when no env file", () => {
    writeFileSync(join(tempDir, "package.json"), JSON.stringify({ dependencies: {} }))

    const config = extractDeploymentConfig(tempDir)

    expect(config.env).toContain("OPENAI_API_KEY")
  })

  test("returns node_version 22", () => {
    writeFileSync(join(tempDir, "package.json"), JSON.stringify({ dependencies: {} }))

    const config = extractDeploymentConfig(tempDir)

    expect(config.node_version).toBe("22")
  })
})

describe("generateDockerfile", () => {
  test("produces a valid Dockerfile", () => {
    const dockerfile = generateDockerfile("22")

    expect(dockerfile).toContain("FROM node:22-slim")
    expect(dockerfile).toContain("WORKDIR /app")
    expect(dockerfile).toContain("COPY package.json")
    expect(dockerfile).toContain("EXPOSE 8000")
    expect(dockerfile).toContain("dawn")
  })
})
