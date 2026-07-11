import assert from "node:assert/strict"
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { dirname, join, resolve } from "node:path"
import { afterEach, describe, it } from "node:test"
import { fileURLToPath } from "node:url"

import { packages, validatePackManifest } from "./lib/pack-check.mjs"

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..")
const tempRoots = []

afterEach(async () => {
  await Promise.all(tempRoots.splice(0).map((root) => rm(root, { force: true, recursive: true })))
})

describe("pack manifest validation", () => {
  it("covers every public package exactly once with required package files", () => {
    assert.doesNotThrow(() => validatePackManifest(repoRoot, packages))
  })

  it("checks the CLI public subpath exports and metadata", () => {
    const cliPackage = packages.find(({ dir }) => dir === "packages/cli")

    assert.ok(cliPackage, "Pack manifest is missing packages/cli")
    for (const expectedFile of [
      "dist/runtime-exports.js",
      "dist/runtime-exports.d.ts",
      "dist/testing/index.js",
      "dist/testing/index.d.ts",
    ]) {
      assert.ok(cliPackage.expectedFiles.includes(expectedFile), `CLI must expect ${expectedFile}`)
    }
    for (const requiredField of ["bin", "exports", "types"]) {
      assert.ok(
        cliPackage.requiredFields.includes(requiredField),
        `CLI must require ${requiredField}`,
      )
    }
  })

  it("checks the create app executable", () => {
    const createAppPackage = packages.find(({ dir }) => dir === "packages/create-dawn-app")

    assert.ok(createAppPackage, "Pack manifest is missing packages/create-dawn-app")
    assert.ok(
      createAppPackage.expectedFiles.includes("dist/bin.js"),
      "create-dawn-ai-app must expect dist/bin.js",
    )
  })

  it("rejects a missing public package entry", async () => {
    const root = await createRepo(["one", "two"])
    const manifest = [packageEntry("one")]

    assert.throws(
      () => validatePackManifest(root, manifest),
      /Pack manifest is missing public package: packages\/two/,
    )
  })

  it("rejects entries that are not public packages", async () => {
    const root = await createRepo(["one"])
    const privatePackageDir = join(root, "packages", "private")
    await mkdir(privatePackageDir, { recursive: true })
    await writeFile(
      join(privatePackageDir, "package.json"),
      JSON.stringify({ name: "private", private: true }),
    )

    assert.throws(
      () => validatePackManifest(root, [packageEntry("one"), packageEntry("private")]),
      /Pack manifest includes non-public package: packages\/private/,
    )
    assert.throws(
      () => validatePackManifest(root, [packageEntry("one"), packageEntry("missing")]),
      /Pack manifest includes non-public package: packages\/missing/,
    )
  })

  it("ignores directories without a package.json", async () => {
    const root = await createRepo(["one"])
    await mkdir(join(root, "packages", "notes"), { recursive: true })

    assert.doesNotThrow(() => validatePackManifest(root, [packageEntry("one")]))
  })

  it("rejects duplicate package directories", async () => {
    const root = await createRepo(["one"])
    const manifest = [packageEntry("one"), packageEntry("one")]

    assert.throws(
      () => validatePackManifest(root, manifest),
      /Pack manifest contains duplicate directory: packages\/one/,
    )
  })

  it("rejects entries without README.md or package.json expectations", async () => {
    const root = await createRepo(["one"])

    assert.throws(
      () => validatePackManifest(root, [{ ...packageEntry("one"), expectedFiles: ["README.md"] }]),
      /packages\/one must expect package\.json/,
    )
    assert.throws(
      () =>
        validatePackManifest(root, [{ ...packageEntry("one"), expectedFiles: ["package.json"] }]),
      /packages\/one must expect README\.md/,
    )
  })
})

function packageEntry(name) {
  return {
    dir: `packages/${name}`,
    expectedFiles: ["README.md", "package.json"],
    requiredFields: [],
  }
}

async function createRepo(publicPackages) {
  const root = await mkdtemp(join(tmpdir(), "dawn-pack-manifest-test-"))
  tempRoots.push(root)

  await Promise.all(
    publicPackages.map(async (name) => {
      const packageDir = join(root, "packages", name)
      await mkdir(packageDir, { recursive: true })
      await writeFile(join(packageDir, "package.json"), JSON.stringify({ name }))
    }),
  )

  return root
}
