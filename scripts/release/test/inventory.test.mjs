import assert from "node:assert/strict"
import { spawnSync } from "node:child_process"
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { dirname, resolve } from "node:path"
import test from "node:test"
import { fileURLToPath } from "node:url"

import {
  assertValidReleaseInventory,
  ReleaseInventoryError,
  readFixedGroup,
  readReleaseInventory,
  validateReleaseInventory,
} from "../inventory.mjs"

test("readFixedGroup requires exactly one Changesets fixed group", () => {
  assert.deepEqual(readFixedGroup({ fixed: [["package-a", "package-b"]] }), [
    "package-a",
    "package-b",
  ])
  assert.throws(() => readFixedGroup({ fixed: [] }), /exactly one fixed group/u)
  assert.throws(
    () => readFixedGroup({ fixed: [["package-a"], ["package-b"]] }),
    /exactly one fixed group/u,
  )
  assert.throws(() => readFixedGroup({ fixed: [null] }), /fixed group must be an array/u)
})

test("validateReleaseInventory categorizes exact-set differences in stable order", () => {
  const result = validateReleaseInventory({
    fixedGroups: [["package-z", "package-a", "package-a", "private-package", "unknown-package"]],
    workspacePackages: [
      { name: "package-z", version: "1.2.3" },
      { name: "package-b", version: "1.2.3" },
      { name: "package-a", version: "1.2.3" },
      { name: "private-package", private: true },
    ],
  })

  assert.deepEqual(result.duplicates, ["package-a"])
  assert.deepEqual(result.extra, ["private-package", "unknown-package"])
  assert.deepEqual(result.missing, ["package-b"])
  assert.deepEqual(result.privateMembers, ["private-package"])
  assert.deepEqual(result.unknownMembers, ["unknown-package"])
  assert.deepEqual(result.versionMismatches, [])
  assert.deepEqual(result.structuralErrors, [])
})

test("validateReleaseInventory reports packages that do not share the canonical version", () => {
  const result = validateReleaseInventory({
    fixedGroups: [["package-b", "package-a", "package-c"]],
    workspacePackages: [
      { name: "package-c", version: "2.0.0" },
      { name: "package-a", version: "1.0.0" },
      { name: "package-b", version: "1.0.0" },
    ],
  })

  assert.equal(result.version, undefined)
  assert.deepEqual(result.versionMismatches, ["package-c"])
})

test("validateReleaseInventory accepts a private manifest without release identity", () => {
  const inventory = {
    fixedGroups: [["package-a"]],
    workspacePackages: [
      { name: "package-a", version: "1.0.0", path: "packages/a/package.json" },
      { private: true, path: "fixtures/private/package.json" },
    ],
  }

  const result = assertValidReleaseInventory(inventory)

  assert.deepEqual(result.structuralErrors, [])
  assert.deepEqual(result.packages, ["package-a"])
  assert.equal(result.version, "1.0.0")
})

test("validateReleaseInventory reports empty fixed and public inventories structurally", () => {
  const result = validateReleaseInventory({ fixedGroups: [[]], workspacePackages: [] })

  assert.deepEqual(result.structuralErrors, [
    "fixed group must contain at least one package",
    "public workspace inventory must contain at least one package",
  ])
  assert.throws(
    () => assertValidReleaseInventory({ fixedGroups: [[]], workspacePackages: [] }),
    (error) => {
      assert.deepEqual(error.details.structuralErrors, result.structuralErrors)
      return true
    },
  )
})

test("validateReleaseInventory reports missing, null, and empty fixed members", () => {
  const result = validateReleaseInventory({
    fixedGroups: [[undefined, null, ""]],
    workspacePackages: [{ name: "package-a", version: "1.0.0", path: "packages/a/package.json" }],
  })

  assert.deepEqual(result.structuralErrors, [
    "fixed member at index 0 must be a non-empty string",
    "fixed member at index 1 must be a non-empty string",
    "fixed member at index 2 must be a non-empty string",
  ])
})

test("validateReleaseInventory reports missing, null, and empty package names and versions", () => {
  const result = validateReleaseInventory({
    fixedGroups: [["package-a"]],
    workspacePackages: [
      { version: "1.0.0", path: "packages/missing-name/package.json" },
      { name: null, version: "1.0.0", path: "packages/null-name/package.json" },
      { name: "", version: "1.0.0", path: "packages/empty-name/package.json" },
      { name: "package-a", path: "packages/missing-version/package.json" },
      { name: "package-b", version: null, path: "packages/null-version/package.json" },
      { name: "package-c", version: "", path: "packages/empty-version/package.json" },
    ],
  })

  assert.deepEqual(result.structuralErrors, [
    "packages/empty-name/package.json: package name must be a non-empty string",
    "packages/empty-version/package.json: package version must be a non-empty string",
    "packages/missing-name/package.json: package name must be a non-empty string",
    "packages/missing-version/package.json: package version must be a non-empty string",
    "packages/null-name/package.json: package name must be a non-empty string",
    "packages/null-version/package.json: package version must be a non-empty string",
  ])
  assert.equal(result.version, undefined)
})

test("validateReleaseInventory reports same-version duplicate workspace names with manifests", () => {
  const inventory = {
    fixedGroups: [["package-a"]],
    workspacePackages: [
      { name: "package-a", version: "1.0.0", path: "packages/a/package.json" },
      { name: "package-a", version: "1.0.0", path: "plugins/a/package.json" },
    ],
  }

  const result = validateReleaseInventory(inventory)

  assert.deepEqual(result.workspaceDuplicates, [
    {
      name: "package-a",
      manifests: ["packages/a/package.json", "plugins/a/package.json"],
    },
  ])
  assert.throws(() => assertValidReleaseInventory(inventory))
})

test("validateReleaseInventory reports public and private workspace name collisions", () => {
  const result = validateReleaseInventory({
    fixedGroups: [["package-a"]],
    workspacePackages: [
      { name: "package-a", version: "1.0.0", path: "packages/a/package.json" },
      {
        name: "package-a",
        version: "1.0.0",
        private: true,
        path: "fixtures/a/package.json",
      },
    ],
  })

  assert.deepEqual(result.workspaceDuplicates, [
    {
      name: "package-a",
      manifests: ["fixtures/a/package.json", "packages/a/package.json"],
    },
  ])
  assert.deepEqual(result.extra, [])
  assert.deepEqual(result.privateMembers, [])
})

test("readReleaseInventory follows positive and negative workspace patterns at the requested ref", async () => {
  const files = new Map([
    [".changeset/config.json", JSON.stringify({ fixed: [["package-a", "plugin-b"]] })],
    ["pnpm-workspace.yaml", "packages:\n  - packages/*\n  - plugins/*\n  - '!plugins/excluded'\n"],
    ["packages/a/package.json", JSON.stringify({ name: "package-a", version: "1.0.0" })],
    ["plugins/b/package.json", JSON.stringify({ name: "plugin-b", version: "1.0.0" })],
    [
      "plugins/excluded/package.json",
      JSON.stringify({ name: "excluded-plugin", version: "1.0.0" }),
    ],
  ])
  const calls = []
  const git = {
    async showFile({ ref, path }) {
      calls.push({ operation: "showFile", ref, path })
      return files.get(path)
    },
    async listTree({ ref }) {
      calls.push({ operation: "listTree", ref })
      return [...files.keys()].join("\n")
    },
  }

  const inventory = await readReleaseInventory({ root: "/unused", ref: "release-ref", git })

  assert.deepEqual(
    inventory.workspacePackages.map((pkg) => pkg.name),
    ["package-a", "plugin-b"],
  )
  assert.ok(calls.every((call) => call.ref === "release-ref"))
})

test("readReleaseInventory rejects unsupported brace, character-class, question-mark, and backslash globs", async () => {
  for (const pattern of [
    "packages/{a,b}",
    "packages/[ab]",
    "packages/pkg-?",
    "packages\\pkg-a",
    " ",
  ]) {
    await assert.rejects(
      readFixtureInventory({
        workspaceSource: `packages:\n  - '${pattern}'\n`,
        manifests: {
          "packages/a/package.json": { name: "package-a", version: "1.0.0" },
        },
      }),
      (error) => {
        assert.ok(error instanceof ReleaseInventoryError)
        assert.match(error.message, /Unsupported workspace pattern/u)
        assert.match(
          error.message,
          new RegExp(pattern.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&"), "u"),
        )
        return true
      },
    )
  }
})

test("readReleaseInventory supports zero-depth and nested globstars with exclusions", async () => {
  const inventory = await readFixtureInventory({
    fixed: ["plugin-a", "plugin-b"],
    workspaceSource:
      "packages:\n  - 'plugins/**/nested/**'\n  - '!plugins/**/nested/**/excluded'\n",
    manifests: {
      "plugins/nested/a/package.json": { name: "plugin-a", version: "1.0.0" },
      "plugins/group/nested/deep/b/package.json": { name: "plugin-b", version: "1.0.0" },
      "plugins/group/nested/deep/excluded/package.json": {
        name: "excluded-plugin",
        version: "1.0.0",
      },
    },
  })

  assert.deepEqual(
    inventory.workspacePackages.map((pkg) => pkg.name),
    ["plugin-b", "plugin-a"],
  )
})

test("readReleaseInventory rejects malformed workspace package lists", async () => {
  for (const workspaceSource of [
    "packages: packages/*\n",
    "packages:\n  - packages/*\n  - 42\n",
    "null\n",
  ]) {
    await assert.rejects(
      readFixtureInventory({
        workspaceSource,
        manifests: {
          "packages/a/package.json": { name: "package-a", version: "1.0.0" },
        },
      }),
      (error) => {
        assert.ok(error instanceof ReleaseInventoryError)
        assert.match(error.message, /pnpm-workspace\.yaml packages must be an array of strings/u)
        return true
      },
    )
  }
})

test("the repository release inventory is an exact, uniformly versioned set", async () => {
  const inventory = await readReleaseInventory({ root: process.cwd(), ref: "HEAD" })
  const result = validateReleaseInventory(inventory)

  assert.deepEqual(result.structuralErrors, [])
  assert.deepEqual(result.workspaceDuplicates, [])
  assert.deepEqual(result.duplicates, [])
  assert.deepEqual(result.extra, [])
  assert.deepEqual(result.missing, [])
  assert.deepEqual(result.privateMembers, [])
  assert.deepEqual(result.unknownMembers, [])
  assert.deepEqual(result.versionMismatches, [])
})

test("check-inventory prints JSON success and categorized ref-specific failures", async () => {
  const root = await mkdtemp(resolve(tmpdir(), "dawn-release-inventory-"))
  const script = resolve(dirname(fileURLToPath(import.meta.url)), "../check-inventory.mjs")
  try {
    await mkdir(resolve(root, ".changeset"), { recursive: true })
    await mkdir(resolve(root, "packages/a"), { recursive: true })
    await mkdir(resolve(root, "plugins/b"), { recursive: true })
    await writeFile(
      resolve(root, "pnpm-workspace.yaml"),
      "packages:\n  - packages/*\n  - plugins/*\n",
    )
    await writeFile(
      resolve(root, "packages/a/package.json"),
      JSON.stringify({ name: "package-a", version: "1.0.0" }),
    )
    await writeFile(
      resolve(root, "plugins/b/package.json"),
      JSON.stringify({ name: "plugin-b", version: "1.0.0" }),
    )
    await writeFile(
      resolve(root, ".changeset/config.json"),
      JSON.stringify({ fixed: [["package-a"]] }),
    )
    runGit(root, ["init", "-q"])
    runGit(root, ["add", "."])
    runGit(root, ["commit", "-qm", "fixture with missing member"])

    await writeFile(
      resolve(root, ".changeset/config.json"),
      JSON.stringify({ fixed: [["package-a", "plugin-b"]] }),
    )
    runGit(root, ["add", ".changeset/config.json"])
    runGit(root, ["commit", "-qm", "complete fixture inventory"])

    await writeFile(
      resolve(root, ".changeset/config.json"),
      JSON.stringify({ fixed: [["working-tree-only"]] }),
    )
    const success = spawnSync(process.execPath, [script, "--ref", "HEAD", "--json"], {
      cwd: root,
      encoding: "utf8",
    })
    assert.equal(success.status, 0, success.stderr)
    assert.deepEqual(JSON.parse(success.stdout), {
      packages: ["package-a", "plugin-b"],
      version: "1.0.0",
    })

    const failure = spawnSync(process.execPath, [script, "--ref", "HEAD^"], {
      cwd: root,
      encoding: "utf8",
    })
    assert.equal(failure.status, 1)
    assert.match(failure.stderr, /missing: plugin-b/u)
    assert.doesNotMatch(failure.stderr, /\n\s+at /u)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test("check-inventory formats expected Git and config failures in text and JSON modes", async () => {
  const root = await mkdtemp(resolve(tmpdir(), "dawn-release-errors-"))
  const script = resolve(dirname(fileURLToPath(import.meta.url)), "../check-inventory.mjs")
  try {
    await mkdir(resolve(root, ".changeset"), { recursive: true })
    await mkdir(resolve(root, "packages/a"), { recursive: true })
    await writeFile(resolve(root, "pnpm-workspace.yaml"), "packages:\n  - packages/*\n")
    await writeFile(
      resolve(root, "packages/a/package.json"),
      JSON.stringify({ name: "package-a", version: "1.0.0" }),
    )
    await writeFile(
      resolve(root, ".changeset/config.json"),
      JSON.stringify({ fixed: [["package-a"]] }),
    )
    runGit(root, ["init", "-q"])
    runGit(root, ["add", "."])
    runGit(root, ["commit", "-qm", "valid fixture"])

    await writeFile(resolve(root, ".changeset/config.json"), "{\n")
    runGit(root, ["add", ".changeset/config.json"])
    runGit(root, ["commit", "-qm", "malformed json"])
    const malformedJsonRef = runGit(root, ["rev-parse", "HEAD"]).trim()

    await writeFile(resolve(root, ".changeset/config.json"), "null\n")
    runGit(root, ["add", ".changeset/config.json"])
    runGit(root, ["commit", "-qm", "invalid json shape"])
    const invalidJsonShapeRef = runGit(root, ["rev-parse", "HEAD"]).trim()

    await writeFile(
      resolve(root, ".changeset/config.json"),
      JSON.stringify({ fixed: [["package-a"]] }),
    )
    await writeFile(resolve(root, "pnpm-workspace.yaml"), "packages: [unterminated\n")
    runGit(root, ["add", ".changeset/config.json", "pnpm-workspace.yaml"])
    runGit(root, ["commit", "-qm", "malformed yaml"])
    const malformedYamlRef = runGit(root, ["rev-parse", "HEAD"]).trim()

    await writeFile(resolve(root, "pnpm-workspace.yaml"), "packages:\n  - packages/*\n")
    await writeFile(resolve(root, ".changeset/config.json"), JSON.stringify({ fixed: [[]] }))
    runGit(root, ["add", ".changeset/config.json", "pnpm-workspace.yaml"])
    runGit(root, ["commit", "-qm", "structurally invalid inventory"])
    const structuralErrorRef = runGit(root, ["rev-parse", "HEAD"]).trim()

    for (const scenario of [
      {
        args: ["--ref", "--help"],
        type: "GitInputError",
        message: /^Invalid Git ref\n?$/u,
      },
      {
        args: ["--ref", "does-not-exist"],
        type: "GitReadError",
        message: /Git read failed/u,
      },
      {
        args: ["--ref", malformedJsonRef],
        type: "ReleaseInventoryConfigError",
        message: /Invalid \.changeset\/config\.json/u,
      },
      {
        args: ["--ref", invalidJsonShapeRef],
        type: "ReleaseInventoryConfigError",
        message: /Invalid \.changeset\/config\.json/u,
      },
      {
        args: ["--ref", malformedYamlRef],
        type: "ReleaseInventoryConfigError",
        message: /Invalid pnpm-workspace\.yaml/u,
      },
      {
        args: ["--ref", structuralErrorRef],
        type: "ReleaseInventoryError",
        message: /Release inventory is invalid/u,
        detail: /structuralErrors: fixed group must contain at least one package/u,
      },
    ]) {
      const textResult = spawnSync(process.execPath, [script, ...scenario.args], {
        cwd: root,
        encoding: "utf8",
      })
      assert.equal(textResult.status, 1)
      assert.match(textResult.stderr, scenario.message)
      assert.doesNotMatch(textResult.stderr, /\n\s+at /u)
      if (scenario.detail !== undefined) {
        assert.match(textResult.stderr, scenario.detail)
      }

      const jsonResult = spawnSync(process.execPath, [script, ...scenario.args, "--json"], {
        cwd: root,
        encoding: "utf8",
      })
      assert.equal(jsonResult.status, 1)
      const payload = JSON.parse(jsonResult.stderr)
      assert.equal(payload.type, scenario.type)
      assert.match(payload.error, scenario.message)
      assert.equal(payload.stack, undefined)
      if (scenario.detail !== undefined) {
        assert.deepEqual(payload.differences.structuralErrors, [
          "fixed group must contain at least one package",
        ])
      }
    }
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

function runGit(root, args) {
  const result = spawnSync(
    "git",
    ["-c", "user.name=Test", "-c", "user.email=test@example.com", ...args],
    { cwd: root, encoding: "utf8" },
  )
  assert.equal(result.status, 0, result.stderr)
  return result.stdout
}

async function readFixtureInventory({
  workspaceSource,
  manifests,
  fixed = Object.values(manifests).map((manifest) => manifest.name),
}) {
  const files = new Map([
    [".changeset/config.json", JSON.stringify({ fixed: [fixed] })],
    ["pnpm-workspace.yaml", workspaceSource],
    ...Object.entries(manifests).map(([path, manifest]) => [path, JSON.stringify(manifest)]),
  ])
  return readReleaseInventory({
    root: "/unused",
    ref: "fixture-ref",
    git: {
      async showFile({ path }) {
        return files.get(path)
      },
      async listTree() {
        return [...files.keys()].join("\n")
      },
    },
  })
}
