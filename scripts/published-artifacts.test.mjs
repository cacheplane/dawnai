import assert from "node:assert/strict"
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { describe, it } from "node:test"

import {
  assertCleanDependencySpecs,
  expectedFilesForPackage,
  packageSets,
  run,
  resolvePackageSet,
  resolveRequestedVersion,
  validatePackageMetadata,
} from "./lib/published-artifacts.mjs"
import {
  assertNoNativeInstallOutput,
  assertNoNativeLifecycleScripts,
  pgvectorDatabaseUrl,
  parseDockerMappedHostPort,
  readInstalledPackageManifests,
  runCommand,
  shouldRunOpenAiSmoke,
} from "./published-artifact-smoke.mjs"

describe("resolvePackageSet", () => {
  it("resolves the memory-pgvector-core package set", () => {
    assert.deepEqual(resolvePackageSet("memory-pgvector-core"), [
      "@dawn-ai/memory-pgvector",
      "@dawn-ai/memory",
      "@dawn-ai/langchain",
    ])
  })

  it("rejects unknown package sets", () => {
    assert.throws(() => resolvePackageSet("unknown"), /Unknown package set/)
  })
})

describe("packageSets", () => {
  it("includes the public package set placeholder", () => {
    assert.equal(packageSets.public, null)
  })
})

describe("expectedFilesForPackage", () => {
  it("returns memory-pgvector tarball expectations", () => {
    assert.deepEqual(expectedFilesForPackage("@dawn-ai/memory-pgvector"), [
      "dist/index.js",
      "dist/index.d.ts",
      "README.md",
      "package.json",
    ])
  })

  it("returns package-specific runtime expectations", () => {
    assert.deepEqual(expectedFilesForPackage("@dawn-ai/memory"), [
      "dist/index.js",
      "dist/index.d.ts",
      "README.md",
      "package.json",
    ])
    assert.deepEqual(expectedFilesForPackage("@dawn-ai/langchain"), [
      "dist/index.js",
      "dist/index.d.ts",
      "README.md",
      "package.json",
    ])
  })

  it("defaults to metadata and README expectations", () => {
    assert.deepEqual(expectedFilesForPackage("@dawn-ai/unknown"), ["README.md", "package.json"])
  })
})

describe("resolveRequestedVersion", () => {
  it("resolves latest through dist-tags", () => {
    assert.equal(resolveRequestedVersion({ requested: "latest", tags: { latest: "1.2.3" } }), "1.2.3")
  })

  it("resolves arbitrary dist-tags through dist-tags", () => {
    assert.equal(
      resolveRequestedVersion({ requested: "next", tags: { latest: "1.0.0", next: "1.1.0-beta.1" } }),
      "1.1.0-beta.1",
    )
  })

  it("passes explicit versions through", () => {
    assert.equal(resolveRequestedVersion({ requested: "0.8.11", tags: { latest: "0.8.12" } }), "0.8.11")
  })
})

describe("assertCleanDependencySpecs", () => {
  it("rejects workspace and file dependency specs", () => {
    assert.throws(
      () =>
        assertCleanDependencySpecs("@dawn-ai/demo", {
          dependencies: { "@dawn-ai/core": "workspace:*", local: "file:../local" },
        }),
      /workspace:\*|file:/,
    )
  })
})

describe("validatePackageMetadata", () => {
  it("requires standard public package fields", () => {
    const failures = validatePackageMetadata("@dawn-ai/demo", {
      name: "@dawn-ai/demo",
      version: "1.0.0",
      license: "MIT",
      repository: { type: "git", url: "git+https://github.com/cacheplane/dawnai.git" },
      homepage: "https://github.com/cacheplane/dawnai/tree/main/packages/demo#readme",
      bugs: { url: "https://github.com/cacheplane/dawnai/issues" },
      engines: { node: ">=22.13.0" },
      publishConfig: { access: "public" },
      exports: { ".": "./dist/index.js" },
      types: "./dist/index.d.ts",
    })

    assert.deepEqual(failures, [])
  })

  it("rejects package metadata with mismatched name or version", () => {
    const failures = validatePackageMetadata(
      "@dawn-ai/demo",
      {
        name: "@dawn-ai/other",
        version: "1.0.1",
        license: "MIT",
        repository: { type: "git", url: "git+https://github.com/cacheplane/dawnai.git" },
        homepage: "https://github.com/cacheplane/dawnai/tree/main/packages/demo#readme",
        bugs: { url: "https://github.com/cacheplane/dawnai/issues" },
        engines: { node: ">=22.13.0" },
        publishConfig: { access: "public" },
        exports: { ".": "./dist/index.js" },
        types: "./dist/index.d.ts",
      },
      "1.0.0",
    )

    assert.deepEqual(failures, [
      "@dawn-ai/demo: package.json name is @dawn-ai/other",
      "@dawn-ai/demo: package.json version is 1.0.1, expected 1.0.0",
    ])
  })

  it("accepts config packages with JSON exports and no top-level types", () => {
    const failures = validatePackageMetadata("@dawn-ai/config-biome", {
      name: "@dawn-ai/config-biome",
      version: "1.0.0",
      license: "MIT",
      repository: { type: "git", url: "git+https://github.com/cacheplane/dawnai.git" },
      homepage: "https://github.com/cacheplane/dawnai/tree/main/packages/config-biome#readme",
      bugs: { url: "https://github.com/cacheplane/dawnai/issues" },
      engines: { node: ">=22.13.0" },
      publishConfig: { access: "public" },
      exports: {
        ".": "./biome.json",
        "./biome": "./biome.json",
      },
    })

    assert.deepEqual(failures, [])
  })
})

describe("shouldRunOpenAiSmoke", () => {
  it("skips when disabled", () => {
    assert.equal(shouldRunOpenAiSmoke({ enabled: false, env: {} }).status, "skip")
  })

  it("fails when enabled without OPENAI_API_KEY", () => {
    assert.throws(() => shouldRunOpenAiSmoke({ enabled: true, env: {} }), /OPENAI_API_KEY/)
  })
})

describe("parseDockerMappedHostPort", () => {
  it("extracts the dynamic localhost host and port from docker port output", () => {
    assert.deepEqual(parseDockerMappedHostPort("127.0.0.1:49157\n"), {
      host: "127.0.0.1",
      port: 49157,
    })
  })

  it("normalizes wildcard Docker hosts for client connections", () => {
    assert.deepEqual(parseDockerMappedHostPort("0.0.0.0:49157\n"), {
      host: "127.0.0.1",
      port: 49157,
    })
    assert.deepEqual(parseDockerMappedHostPort("[::]:49158\n"), {
      host: "127.0.0.1",
      port: 49158,
    })
  })
})

describe("pgvectorDatabaseUrl", () => {
  it("uses the mapped host and port", () => {
    assert.equal(
      pgvectorDatabaseUrl({ host: "127.0.0.1", port: 49157 }),
      "postgres://postgres:postgres@127.0.0.1:49157/postgres",
    )
  })
})

describe("runCommand", () => {
  it("removes OPENAI_API_KEY from child process environments by default", async () => {
    const previousOpenAiApiKey = process.env.OPENAI_API_KEY
    process.env.OPENAI_API_KEY = "sk-test-secret"

    try {
      const result = await runCommand(process.execPath, [
        "-e",
        "process.stdout.write(process.env.OPENAI_API_KEY ?? '')",
      ])

      assert.equal(result.stdout, "")
    } finally {
      if (previousOpenAiApiKey === undefined) {
        delete process.env.OPENAI_API_KEY
      } else {
        process.env.OPENAI_API_KEY = previousOpenAiApiKey
      }
    }
  })

  it("passes OPENAI_API_KEY only when explicitly allowed", async () => {
    const result = await runCommand(
      process.execPath,
      ["-e", "process.stdout.write(process.env.OPENAI_API_KEY ?? '')"],
      {
        env: { OPENAI_API_KEY: "sk-test-secret" },
        includeOpenAi: true,
      },
    )

    assert.equal(result.stdout, "sk-test-secret")
  })
})

describe("run", () => {
  it("removes OPENAI_API_KEY from child process environments by default", async () => {
    const previousOpenAiApiKey = process.env.OPENAI_API_KEY
    process.env.OPENAI_API_KEY = "sk-test-secret"

    try {
      const output = await run(
        process.execPath,
        ["-e", "process.stdout.write(process.env.OPENAI_API_KEY ?? '')"],
        { stdio: "pipe" },
      )

      assert.equal(output, "")
    } finally {
      if (previousOpenAiApiKey === undefined) {
        delete process.env.OPENAI_API_KEY
      } else {
        process.env.OPENAI_API_KEY = previousOpenAiApiKey
      }
    }
  })
})

describe("assertNoNativeLifecycleScripts", () => {
  it("rejects native lifecycle scripts", () => {
    assert.throws(
      () =>
        assertNoNativeLifecycleScripts([
          {
            manifest: {
              name: "native-addon",
              version: "1.0.0",
              scripts: { install: "node-gyp rebuild" },
            },
          },
        ]),
      /native-addon@1\.0\.0.*install.*node-gyp rebuild/,
    )
  })

  it("rejects bare prebuild lifecycle scripts", () => {
    assert.throws(
      () =>
        assertNoNativeLifecycleScripts([
          {
            manifest: {
              name: "native-addon",
              version: "1.0.0",
              scripts: { install: "prebuild --install" },
            },
          },
        ]),
      /native-addon@1\.0\.0.*install.*prebuild --install/,
    )
  })

  it("accepts ordinary JavaScript package scripts", () => {
    assert.doesNotThrow(() =>
      assertNoNativeLifecycleScripts([
        {
          manifest: {
            name: "plain-js",
            version: "1.0.0",
            scripts: {
              build: "tsc -p tsconfig.json",
              test: "node --test",
              postinstall: "node ./scripts/setup.js",
            },
          },
        },
      ]),
    )
  })

  it("rejects packages with binding.gyp even without lifecycle scripts", async () => {
    const tempDir = await mkdtemp(join(tmpdir(), "dawn-native-indicator-test-"))
    try {
      const packageDir = join(tempDir, "node_modules", "native-addon")
      await mkdir(packageDir, { recursive: true })
      await writeFile(
        join(packageDir, "package.json"),
        JSON.stringify({ name: "native-addon", version: "1.0.0" }),
        "utf8",
      )
      await writeFile(join(packageDir, "binding.gyp"), "{}", "utf8")

      const manifests = await readInstalledPackageManifests(join(tempDir, "node_modules"))
      assert.throws(
        () => assertNoNativeLifecycleScripts(manifests),
        /native-addon@1\.0\.0.*binding\.gyp/,
      )
    } finally {
      await rm(tempDir, { recursive: true, force: true })
    }
  })
})

describe("assertNoNativeInstallOutput", () => {
  it("rejects native install output markers beyond node-gyp", () => {
    for (const marker of ["prebuild", "node-pre-gyp", "cmake-js", "node-gyp-build", "prebuildify"]) {
      assert.throws(
        () => assertNoNativeInstallOutput(`> native-addon install\n${marker} install\n`),
        /native build indicators/,
      )
    }
  })

  it("accepts ordinary npm install output", () => {
    assert.doesNotThrow(() =>
      assertNoNativeInstallOutput("added 42 packages, and audited 42 packages in 1s\nfound 0 vulnerabilities\n"),
    )
  })
})
