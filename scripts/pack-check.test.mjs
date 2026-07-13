import assert from "node:assert/strict"
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { dirname, join, resolve } from "node:path"
import { afterEach, describe, it } from "node:test"
import { fileURLToPath } from "node:url"

import * as packCheck from "./lib/pack-check.mjs"

const { expectedExportFailures, missingExportTargets, packages, validatePackManifest } = packCheck

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..")
const tempRoots = []
const agUiExpectedExports = {
  ".": {
    types: "./dist/index.d.ts",
    default: "./dist/index.js",
  },
  "./sse": {
    types: "./dist/sse.d.ts",
    default: "./dist/sse.js",
  },
}

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

  it("checks the AG-UI root and SSE entrypoints", () => {
    const agUiPackage = packages.find(({ dir }) => dir === "packages/ag-ui")

    assert.ok(agUiPackage, "Pack manifest is missing packages/ag-ui")
    for (const expectedFile of ["dist/sse.js", "dist/sse.d.ts"]) {
      assert.ok(
        agUiPackage.expectedFiles.includes(expectedFile),
        `AG-UI must expect ${expectedFile}`,
      )
    }
    for (const requiredField of ["exports", "types"]) {
      assert.ok(
        agUiPackage.requiredFields.includes(requiredField),
        `AG-UI must require ${requiredField}`,
      )
    }
    assert.deepEqual(agUiPackage.expectedExports, agUiExpectedExports)
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

describe("expectedExportFailures", () => {
  it("accepts required export keys with exact mappings", () => {
    assert.deepEqual(
      expectedExportFailures(
        { ...agUiExpectedExports, "./extra": "./dist/extra.js" },
        agUiExpectedExports,
      ),
      [],
    )
  })

  it("rejects a deleted required export", () => {
    assert.deepEqual(
      expectedExportFailures({ ".": agUiExpectedExports["."] }, agUiExpectedExports),
      ['missing required export "./sse"'],
    )
  })

  it("rejects a wrong required export mapping", () => {
    assert.deepEqual(
      expectedExportFailures(
        {
          ...agUiExpectedExports,
          "./sse": { ...agUiExpectedExports["./sse"], default: "./dist/index.js" },
        },
        agUiExpectedExports,
      ),
      ['export "./sse" does not match required mapping'],
    )
  })

  it("rejects reordered export conditions", () => {
    const expected = {
      "./conditional": {
        node: "./dist/node.js",
        default: "./dist/default.js",
      },
    }
    const reordered = {
      "./conditional": {
        default: "./dist/default.js",
        node: "./dist/node.js",
      },
    }

    assert.deepEqual(expectedExportFailures(reordered, expected), [
      'export "./conditional" does not match required mapping',
    ])
  })
})

describe("missingExportTargets", () => {
  it("finds missing relative targets in root, subpath, conditional, and array exports", async () => {
    const packedRoot = await createPackedRoot(["dist/index.js", "dist/index.d.ts"])

    assert.deepEqual(
      missingExportTargets(packedRoot, {
        ".": {
          types: "./dist/index.d.ts",
          default: "./dist/index.js",
        },
        "./sse": [
          { types: "./dist/sse.d.ts" },
          { import: "./dist/sse.js", default: "@dawn-ai/fallback" },
        ],
      }),
      ["./dist/sse.d.ts", "./dist/sse.js"],
    )
  })

  it("ignores non-relative and builtin export targets", async () => {
    const packedRoot = await createPackedRoot([])

    assert.deepEqual(
      missingExportTargets(packedRoot, {
        ".": "node:fs",
        "./bare": "some-package",
      }),
      [],
    )
  })

  it("requires relative wildcard targets to match a packed regular file", async () => {
    const emptyRoot = await createPackedRoot([])
    const populatedRoot = await createPackedRoot(["dist/features/one.js"])
    const exportsField = { "./features/*": "./dist/features/*.js" }

    assert.deepEqual(missingExportTargets(emptyRoot, exportsField), ["./dist/features/*.js"])
    assert.deepEqual(missingExportTargets(populatedRoot, exportsField), [])
  })

  it("rejects wildcard targets with an empty subpath capture", async () => {
    const packedRoot = await createPackedRoot(["dist/prepost.js"])
    const exportsField = { "./features/*": "./dist/pre*post.js" }

    assert.deepEqual(missingExportTargets(packedRoot, exportsField), ["./dist/pre*post.js"])
  })

  it("rejects a wildcard capture that creates a dot export segment", async () => {
    const packedRoot = await createPackedRoot(["dist/pre.post.js"])
    const exportsField = { "./features/*": "./dist/pre*post.js" }

    assert.deepEqual(missingExportTargets(packedRoot, exportsField), ["./dist/pre*post.js"])
  })

  it("rejects a conditional wildcard capture that creates a dot-dot export segment", async () => {
    const packedRoot = await createPackedRoot(["dist/pre..post.js"])
    const exportsField = {
      "./features/*": { import: "./dist/pre*post.js" },
    }

    assert.deepEqual(missingExportTargets(packedRoot, exportsField), ["./dist/pre*post.js"])
  })

  it("rejects an array wildcard capture that creates a node_modules export segment", async () => {
    const packedRoot = await createPackedRoot(["dist/preNoDe_MoDuLeSpost.js"])
    const exportsField = {
      "./features/*": [{ import: "./dist/pre*post.js" }],
    }

    assert.deepEqual(missingExportTargets(packedRoot, exportsField), ["./dist/pre*post.js"])
  })

  it("accepts a valid multi-segment wildcard capture", async () => {
    const packedRoot = await createPackedRoot(["dist/prenested/childpost.js"])
    const exportsField = {
      "./features/*": [{ import: "./dist/pre*post.js" }],
    }

    assert.deepEqual(missingExportTargets(packedRoot, exportsField), [])
  })

  it("rejects an embedded wildcard capture equal to dot", async () => {
    const packedRoot = await createPackedRoot(["src/index.ts"])
    const exportsField = { "./features/pre*post": "./src/index*ts" }

    assert.deepEqual(missingExportTargets(packedRoot, exportsField), ["./src/index*ts"])
  })

  it("rejects an embedded wildcard capture equal to dot-dot", async () => {
    const packedRoot = await createPackedRoot(["src/index..ts"])
    const exportsField = { "./features/pre*post": "./src/index*ts" }

    assert.deepEqual(missingExportTargets(packedRoot, exportsField), ["./src/index*ts"])
  })

  it("rejects an embedded wildcard capture equal to node_modules", async () => {
    const packedRoot = await createPackedRoot(["src/indexNoDe_MoDuLeSts"])
    const exportsField = { "./features/pre*post": "./src/index*ts" }

    assert.deepEqual(missingExportTargets(packedRoot, exportsField), ["./src/index*ts"])
  })

  it("accepts a valid embedded wildcard capture", async () => {
    const packedRoot = await createPackedRoot(["src/indexvaluets"])
    const exportsField = { "./features/pre*post": "./src/index*ts" }

    assert.deepEqual(missingExportTargets(packedRoot, exportsField), [])
  })

  it("rejects wildcard targets paired with malformed export key patterns", async () => {
    const packedRoot = await createPackedRoot(["dist/prevaluepost.js"])
    const target = "./dist/pre*post.js"

    assert.deepEqual(missingExportTargets(packedRoot, { "./features": target }), [target])
    assert.deepEqual(missingExportTargets(packedRoot, { "./features/*/*": target }), [target])
  })

  it("rejects a multi-wildcard export key paired with an exact target", async () => {
    const packedRoot = await createPackedRoot(["src/index.js"])
    const target = "./src/index.js"

    assert.deepEqual(missingExportTargets(packedRoot, { "./features/*/*": target }), [target])
  })

  it("accepts a trailing-slash wildcard export key paired with an exact target", async () => {
    const packedRoot = await createPackedRoot(["src/index.js"])

    assert.deepEqual(missingExportTargets(packedRoot, { "./features/*/": "./src/index.js" }), [])
  })

  it("deduplicates failures after validating each export key relationship", async () => {
    const packedRoot = await createPackedRoot(["dist/prevaluepost.js"])
    const target = "./dist/pre*post.js"
    const exportsField = {
      "./features/*": [target, { import: target }],
      "./features": target,
    }

    assert.deepEqual(missingExportTargets(packedRoot, exportsField), [target])
  })

  it("reuses the first wildcard capture for repeated target wildcards", async () => {
    const mismatchedRoot = await createPackedRoot(["dist/a/b.js"])
    const matchedRoot = await createPackedRoot(["dist/a/a.js"])
    const exportsField = { "./features/*": "./dist/*/*.js" }

    assert.deepEqual(missingExportTargets(mismatchedRoot, exportsField), ["./dist/*/*.js"])
    assert.deepEqual(missingExportTargets(matchedRoot, exportsField), [])
  })

  it("disambiguates repeated wildcard captures from adjacent digits", async () => {
    const mismatchedRoot = await createPackedRoot(["dist/a1b2.js"])
    const matchedRoot = await createPackedRoot(["dist/a1a2.js"])
    const exportsField = { "./features/*": "./dist/*1*2.js" }

    assert.deepEqual(missingExportTargets(mismatchedRoot, exportsField), ["./dist/*1*2.js"])
    assert.deepEqual(missingExportTargets(matchedRoot, exportsField), [])
  })

  it("rejects exact targets with literal or encoded dot segments", async () => {
    const packedRoot = await createPackedRoot(["src/index.js", "src/%2e/index.js"])

    for (const target of ["./src/./index.js", "./src/%2e/index.js"]) {
      assert.deepEqual(missingExportTargets(packedRoot, { ".": target }), [target])
    }
  })

  it("rejects exact targets with literal or encoded dot-dot segments", async () => {
    const packedRoot = await createPackedRoot(["src/index.js", "src/%2E%2E/src/index.js"])

    for (const target of ["./src/../src/index.js", "./src/%2E%2E/src/index.js"]) {
      assert.deepEqual(missingExportTargets(packedRoot, { ".": target }), [target])
    }
  })

  it("rejects exact targets with literal or encoded node_modules segments", async () => {
    const packedRoot = await createPackedRoot([
      "src/NoDe_MoDuLeS/index.js",
      "src/%6eode_modules/index.js",
    ])

    for (const target of ["./src/NoDe_MoDuLeS/index.js", "./src/%6eode_modules/index.js"]) {
      assert.deepEqual(missingExportTargets(packedRoot, { ".": target }), [target])
    }
  })

  it("accepts a normal exact relative target", async () => {
    const packedRoot = await createPackedRoot(["src/index.js"])

    assert.deepEqual(missingExportTargets(packedRoot, { ".": "./src/index.js" }), [])
  })

  it("decodes a valid percent-encoded exact target before lookup", async () => {
    const packedRoot = await createPackedRoot(["src/index.ts"])

    assert.deepEqual(missingExportTargets(packedRoot, { ".": "./src/%69ndex.ts" }), [])
  })

  it("decodes static pieces of a wildcard target before matching", async () => {
    const packedRoot = await createPackedRoot(["src/index-one.ts"])

    assert.deepEqual(missingExportTargets(packedRoot, { "./features/*": "./src/%69ndex-*.ts" }), [])
  })

  it("normalizes raw backslashes in exact target paths", async () => {
    const packedRoot = await createPackedRoot(["src/index.ts"])

    assert.deepEqual(missingExportTargets(packedRoot, { ".": "./src\\index.ts" }), [])
  })

  it("normalizes raw backslashes in wildcard target paths", async () => {
    const packedRoot = await createPackedRoot(["src/index-one.ts"])

    assert.deepEqual(missingExportTargets(packedRoot, { "./features/*": "./src\\*.ts" }), [])
  })

  it("rejects percent-encoded backslashes in target paths", async () => {
    const packedRoot = await createPackedRoot(["src/index.ts"])
    const target = "./src%5Cindex.ts"

    assert.deepEqual(missingExportTargets(packedRoot, { ".": target }), [target])
  })

  it("applies URL tab, CR, and LF normalization to exact target paths", async () => {
    const packedRoot = await createPackedRoot(["src/index.ts"])

    for (const target of ["./src/\tindex.ts", "./src/\rindex.ts", "./src/\nindex.ts"]) {
      assert.deepEqual(missingExportTargets(packedRoot, { ".": target }), [])
    }
  })

  it("applies URL trailing space and C0 control normalization to exact targets", async () => {
    const packedRoot = await createPackedRoot(["src/index.ts"])

    for (const target of ["./src/index.ts ", "./src/index.ts\u001f"]) {
      assert.deepEqual(missingExportTargets(packedRoot, { ".": target }), [])
    }
  })

  it("applies URL whitespace normalization to wildcard target static pieces", async () => {
    const packedRoot = await createPackedRoot(["src/index-one.ts"])

    for (const target of ["./src/\tindex-*.ts", "./src/\rindex-*.ts", "./src/\nindex-*.ts"]) {
      assert.deepEqual(missingExportTargets(packedRoot, { "./features/*": target }), [])
    }
  })

  it("does not treat an encoded literal star as a target wildcard", async () => {
    const packedRoot = await createPackedRoot(["src/x-x.ts"])
    const target = "./src/%2A-*.ts"

    assert.deepEqual(missingExportTargets(packedRoot, { "./features/*": target }), [target])
  })

  it("strips raw query and fragment suffixes from exact target paths", async () => {
    const packedRoot = await createPackedRoot(["src/index.ts"])

    for (const target of ["./src/index.ts?variant", "./src/index.ts#variant"]) {
      assert.deepEqual(missingExportTargets(packedRoot, { ".": target }), [])
    }
  })

  it("strips raw query and fragment suffixes from wildcard target paths", async () => {
    const packedRoot = await createPackedRoot(["src/index-one.ts"])

    for (const target of ["./src/index-*.ts?variant", "./src/index-*.ts#variant"]) {
      assert.deepEqual(missingExportTargets(packedRoot, { "./features/*": target }), [])
    }
  })

  it("does not treat stars in a query or fragment as target wildcards", async () => {
    const packedRoot = await createPackedRoot(["src/index.ts"])

    for (const target of ["./src/index.ts?variant=*", "./src/index.ts#*"]) {
      assert.deepEqual(missingExportTargets(packedRoot, { ".": target }), [])
    }
  })

  it("preserves percent-encoded query and fragment delimiters as path characters", async () => {
    const packedRoot = await createPackedRoot(["src/index.ts"])

    for (const target of ["./src/index.ts%3Fvariant", "./src/index.ts%23variant"]) {
      assert.deepEqual(missingExportTargets(packedRoot, { ".": target }), [target])
    }
  })

  it("rejects invalid exact export keys paired with an existing exact target", async () => {
    const packedRoot = await createPackedRoot(["src/index.js"])
    const target = "./src/index.js"

    for (const exportKey of [".invalid", "./foo/", "./features/../index", "./NoDe_MoDuLeS/index"]) {
      assert.deepEqual(missingExportTargets(packedRoot, { [exportKey]: target }), [target])
    }
  })

  it("rejects exact targets outside packedRoot even when they exist", async () => {
    const packedRoot = await createPackedRoot([])
    await writeFile(join(packedRoot, "..", "outside.js"), "", "utf8")

    assert.deepEqual(missingExportTargets(packedRoot, { ".": "./../outside.js" }), [
      "./../outside.js",
    ])
  })

  it("rejects exact targets that are directories", async () => {
    const packedRoot = await createPackedRoot([])
    await mkdir(join(packedRoot, "dist", "index.js"), { recursive: true })

    assert.deepEqual(missingExportTargets(packedRoot, { ".": "./dist/index.js" }), [
      "./dist/index.js",
    ])
  })

  it("rejects wildcard targets that only match directories", async () => {
    const packedRoot = await createPackedRoot([])
    await mkdir(join(packedRoot, "dist", "features", "directory.js"), { recursive: true })

    assert.deepEqual(missingExportTargets(packedRoot, { "./features/*": "./dist/features/*.js" }), [
      "./dist/features/*.js",
    ])
  })

  it("rejects wildcard targets that escape packedRoot", async () => {
    const packedRoot = await createPackedRoot([])
    await writeFile(join(packedRoot, "..", "outside-one.js"), "", "utf8")

    assert.deepEqual(missingExportTargets(packedRoot, { "./outside/*": "./../outside-*.js" }), [
      "./../outside-*.js",
    ])
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

async function createPackedRoot(files) {
  const base = await mkdtemp(join(tmpdir(), "dawn-packed-export-test-"))
  const root = join(base, "package")
  tempRoots.push(base)
  await mkdir(root, { recursive: true })

  await Promise.all(
    files.map(async (relativePath) => {
      const filePath = join(root, relativePath)
      await mkdir(dirname(filePath), { recursive: true })
      await writeFile(filePath, "", "utf8")
    }),
  )

  return root
}
