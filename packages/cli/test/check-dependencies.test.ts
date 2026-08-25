import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest"

import { checkDependencies } from "../src/lib/verify/check-dependencies.js"

// Real fs throughout — existsSync is only wrapped so a test can assert that the
// declared-dependency gate short-circuits BEFORE any filesystem probe runs.
vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>()
  return { ...actual, default: actual, existsSync: vi.fn(actual.existsSync) }
})

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

/**
 * The probe must resolve packages the way Node does — walking `node_modules` up
 * from appRoot — not by looking only in `appRoot/node_modules`.
 *
 * Motivating regression: the generated research app became an npm workspace, so
 * `dawn.config.ts` (and therefore appRoot) moved to `<app>/server` while npm
 * hoisted every dependency to `<app>/node_modules`. The flat probe reported the
 * three `@langchain/*` packages missing on every `npm run verify` even though
 * they were installed one directory up.
 */
describe("checkDependencies package resolution", () => {
  const REQUIRED = ["@langchain/core", "@langchain/openai", "@langchain/langgraph"] as const

  /** Materialize `<dir>/node_modules/<pkg>` for each package, as an installer would. */
  function installInto(dir: string, packages: readonly string[] = REQUIRED) {
    for (const pkg of packages) {
      mkdirSync(join(dir, "node_modules", pkg), { recursive: true })
    }
  }

  test("finds packages installed in appRoot/node_modules", async () => {
    // The pre-workspace layout: a single-package app with its own node_modules.
    writeFileSync(join(tempDir, "package.json"), JSON.stringify({ dependencies: {} }))
    installInto(tempDir)

    const result = await checkDependencies({ appRoot: tempDir })

    expect(result.missingPackages).toEqual([])
  })

  test("finds packages hoisted to a PARENT node_modules", async () => {
    // The workspace layout: appRoot is <app>/server, deps hoist to <app>.
    const appRoot = join(tempDir, "server")
    mkdirSync(appRoot, { recursive: true })
    writeFileSync(join(appRoot, "package.json"), JSON.stringify({ dependencies: {} }))
    // The member has a node_modules of its own — it just does not hold these
    // packages. The walk must continue past it rather than stop at the first
    // node_modules it finds.
    mkdirSync(join(appRoot, "node_modules", "some-other-package"), { recursive: true })
    installInto(tempDir)

    const result = await checkDependencies({ appRoot })

    expect(result.missingPackages).toEqual([])
  })

  test("finds packages hoisted more than one level above appRoot", async () => {
    const appRoot = join(tempDir, "packages", "apps", "server")
    mkdirSync(appRoot, { recursive: true })
    writeFileSync(join(appRoot, "package.json"), JSON.stringify({ dependencies: {} }))
    installInto(tempDir)

    const result = await checkDependencies({ appRoot })

    expect(result.missingPackages).toEqual([])
  })

  test("still reports packages absent from every node_modules on the walk", async () => {
    const appRoot = join(tempDir, "server")
    mkdirSync(appRoot, { recursive: true })
    writeFileSync(join(appRoot, "package.json"), JSON.stringify({ dependencies: {} }))
    // Both node_modules directories exist and neither holds the packages.
    mkdirSync(join(appRoot, "node_modules"), { recursive: true })
    installInto(tempDir, ["some-other-package"])

    const result = await checkDependencies({ appRoot })

    expect(result.missingPackages).toEqual([
      "@langchain/core",
      "@langchain/openai",
      "@langchain/langgraph",
    ])
  })

  test("reports only the packages the walk cannot find", async () => {
    const appRoot = join(tempDir, "server")
    mkdirSync(appRoot, { recursive: true })
    writeFileSync(join(appRoot, "package.json"), JSON.stringify({ dependencies: {} }))
    installInto(appRoot, ["@langchain/core"])
    installInto(tempDir, ["@langchain/openai"])

    const result = await checkDependencies({ appRoot })

    expect(result.missingPackages).toEqual(["@langchain/langgraph"])
  })

  test("a declared dependency short-circuits before any filesystem probe", async () => {
    writeFileSync(
      join(tempDir, "package.json"),
      JSON.stringify({
        dependencies: {
          "@langchain/core": "0.3.62",
          "@langchain/langgraph": "0.2.0",
          "@langchain/openai": "0.5.0",
        },
      }),
    )

    vi.mocked(existsSync).mockClear()
    const result = await checkDependencies({ appRoot: tempDir })

    expect(result.missingPackages).toEqual([])
    // Nothing walked: no probe touched a node_modules path. (Other existsSync
    // calls — the env-file lookup, config loading — are not the walk.)
    const probed = vi
      .mocked(existsSync)
      .mock.calls.map(([path]) => String(path))
      .filter((path) => path.includes("node_modules"))
    expect(probed).toEqual([])
  })
})
