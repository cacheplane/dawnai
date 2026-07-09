import assert from "node:assert/strict"
import { describe, it } from "node:test"

import {
  assertCleanDependencySpecs,
  expectedFilesForPackage,
  packageSets,
  resolvePackageSet,
  resolveRequestedVersion,
  validatePackageMetadata,
} from "./lib/published-artifacts.mjs"

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
