import { existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs"
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

    const result = await checkDependencies({ appRoot: tempDir, providers: ["openai"] })

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

    const result = await checkDependencies({ appRoot, providers: ["openai"] })

    // Dawn's own layer first, then the app's provider packages.
    expect(result.missingPackages).toEqual([
      "@langchain/core",
      "@langchain/langgraph",
      "@langchain/openai",
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

/**
 * Which model package an app needs is a function of the providers its routes
 * use — the same input the env-var check already derives `OPENAI_API_KEY` vs
 * `ANTHROPIC_API_KEY` from.
 *
 * Two defects motivated this, one in each direction. An Anthropic-only app was
 * told to install `@langchain/openai`, which it does not import, and was NOT
 * told about `@langchain/anthropic`, which it does — an optional peer of
 * `@dawn-ai/langchain` that no install step provides, so the app builds green
 * and dies at the first model call with ERR_MODULE_NOT_FOUND. That is precisely
 * the failure `dawn verify` exists to catch, and it was the one provider case
 * the check could not see.
 *
 * `providerPackages` is the same map `dawn build`'s web-runtime target uses to
 * decide which specifiers to bake into an edge bundle, so verify and build now
 * answer "which model package does this app need" from one source.
 */
describe("checkDependencies provider packages", () => {
  /** An app that declares the Dawn-layer packages, so only provider packages can be reported. */
  function writeAppDeclaring(...packages: readonly string[]) {
    writeFileSync(
      join(tempDir, "package.json"),
      JSON.stringify({
        dependencies: Object.fromEntries(packages.map((name) => [name, "1.0.0"])),
      }),
    )
  }

  const DAWN_LAYER = ["@langchain/core", "@langchain/langgraph"] as const

  test("reports the provider package an Anthropic app needs", async () => {
    writeAppDeclaring(...DAWN_LAYER)

    const result = await checkDependencies({ appRoot: tempDir, providers: ["anthropic"] })

    expect(result.missingPackages).toEqual(["@langchain/anthropic"])
  })

  test("does not report @langchain/openai for an app with no OpenAI route", async () => {
    writeAppDeclaring(...DAWN_LAYER)

    const result = await checkDependencies({ appRoot: tempDir, providers: ["groq"] })

    expect(result.missingPackages).not.toContain("@langchain/openai")
  })

  test("reports one package per provider, deduped and ordered", async () => {
    writeAppDeclaring(...DAWN_LAYER)

    const result = await checkDependencies({
      appRoot: tempDir,
      providers: ["openai", "anthropic", "openai"],
    })

    expect(result.missingPackages).toEqual(["@langchain/anthropic", "@langchain/openai"])
  })

  test("passes when the provider package is declared", async () => {
    writeAppDeclaring(...DAWN_LAYER, "@langchain/anthropic")

    const result = await checkDependencies({ appRoot: tempDir, providers: ["anthropic"] })

    expect(result.missingPackages).toEqual([])
  })

  test("requires no provider package for a keyless local provider", async () => {
    // Ollama needs no API key, but it does need its model package — the package
    // check and the env-var check are independent.
    writeAppDeclaring(...DAWN_LAYER)

    const result = await checkDependencies({ appRoot: tempDir, providers: ["ollama"] })

    expect(result.missingPackages).toEqual(["@langchain/ollama"])
  })

  test("checks no provider package when the app has no routes", async () => {
    writeAppDeclaring(...DAWN_LAYER)

    const result = await checkDependencies({ appRoot: tempDir, providers: [] })

    expect(result.missingPackages).toEqual([])
  })

  test("ignores a provider with no known model package", async () => {
    // `providers` comes from route model ids; an id Dawn cannot map must not
    // crash verify or invent a package name.
    writeAppDeclaring(...DAWN_LAYER)

    const result = await checkDependencies({ appRoot: tempDir, providers: ["not-a-provider"] })

    expect(result.missingPackages).toEqual([])
  })
})

/**
 * The Dawn-layer packages are imported by `@dawn-ai/langchain`, not by the
 * user's app — so the question is whether THAT package can resolve them, not
 * whether the app can.
 *
 * Motivating regression: under pnpm's strict layout the flagship example
 * reported all three of `@langchain/core`, `@langchain/openai` and
 * `@langchain/langgraph` missing on every `dawn verify`, telling the user to
 * install packages that were installed and working. pnpm keeps a package's own
 * dependencies inside the store next to it, reachable from the importer and
 * deliberately not from the app — exactly the layout the appRoot-only walk
 * cannot see.
 */
describe("checkDependencies importer resolution", () => {
  /** Lay out `<app>/node_modules/@dawn-ai/langchain` with its own deps beside it. */
  function installLangchainPackage(appRoot: string, ownDeps: readonly string[]) {
    const pkgDir = join(appRoot, "node_modules", "@dawn-ai", "langchain")
    mkdirSync(pkgDir, { recursive: true })
    for (const dep of ownDeps) {
      mkdirSync(join(pkgDir, "node_modules", dep), { recursive: true })
    }
    return pkgDir
  }

  test("finds packages resolvable only from @dawn-ai/langchain", async () => {
    writeFileSync(join(tempDir, "package.json"), JSON.stringify({ dependencies: {} }))
    installLangchainPackage(tempDir, ["@langchain/core", "@langchain/langgraph"])

    const result = await checkDependencies({ appRoot: tempDir })

    expect(result.missingPackages).toEqual([])
  })

  test("follows a symlinked @dawn-ai/langchain to where its real deps live", async () => {
    // pnpm's layout: the app's entry is a symlink into the store, and the
    // package's dependencies sit beside the REAL directory, not the link.
    const store = join(tempDir, "store", "@dawn-ai", "langchain")
    mkdirSync(join(store, "node_modules", "@langchain", "core"), { recursive: true })
    mkdirSync(join(store, "node_modules", "@langchain", "langgraph"), { recursive: true })

    const appRoot = join(tempDir, "app")
    mkdirSync(join(appRoot, "node_modules", "@dawn-ai"), { recursive: true })
    writeFileSync(join(appRoot, "package.json"), JSON.stringify({ dependencies: {} }))
    symlinkSync(store, join(appRoot, "node_modules", "@dawn-ai", "langchain"), "dir")

    const result = await checkDependencies({ appRoot })

    expect(result.missingPackages).toEqual([])
  })

  test("still reports packages neither root can resolve", async () => {
    writeFileSync(join(tempDir, "package.json"), JSON.stringify({ dependencies: {} }))
    installLangchainPackage(tempDir, ["@langchain/core"])

    const result = await checkDependencies({ appRoot: tempDir })

    expect(result.missingPackages).toEqual(["@langchain/langgraph"])
  })

  test("falls back to the appRoot walk when @dawn-ai/langchain is absent", async () => {
    writeFileSync(join(tempDir, "package.json"), JSON.stringify({ dependencies: {} }))
    mkdirSync(join(tempDir, "node_modules", "@langchain", "core"), { recursive: true })
    mkdirSync(join(tempDir, "node_modules", "@langchain", "langgraph"), { recursive: true })

    const result = await checkDependencies({ appRoot: tempDir })

    expect(result.missingPackages).toEqual([])
  })

  test("resolves a provider package from the importer too", async () => {
    // Optional peers are hoisted next to `@dawn-ai/langchain` by npm and kept in
    // the store by pnpm; either way the importer is what has to see them.
    writeFileSync(join(tempDir, "package.json"), JSON.stringify({ dependencies: {} }))
    installLangchainPackage(tempDir, [
      "@langchain/core",
      "@langchain/langgraph",
      "@langchain/anthropic",
    ])

    const result = await checkDependencies({ appRoot: tempDir, providers: ["anthropic"] })

    expect(result.missingPackages).toEqual([])
  })
})
