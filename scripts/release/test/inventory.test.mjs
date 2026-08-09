import assert from "node:assert/strict"
import { spawnSync } from "node:child_process"
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { dirname, resolve } from "node:path"
import test from "node:test"
import { fileURLToPath } from "node:url"

import { readFixedGroup, readReleaseInventory, validateReleaseInventory } from "../inventory.mjs"

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
      { name: "private-package", version: "1.2.3", private: true },
    ],
  })

  assert.deepEqual(result.duplicates, ["package-a"])
  assert.deepEqual(result.extra, ["private-package", "unknown-package"])
  assert.deepEqual(result.missing, ["package-b"])
  assert.deepEqual(result.privateMembers, ["private-package"])
  assert.deepEqual(result.unknownMembers, ["unknown-package"])
  assert.deepEqual(result.versionMismatches, [])
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

test("the repository release inventory is an exact, uniformly versioned set", async () => {
  const inventory = await readReleaseInventory({ root: process.cwd(), ref: "HEAD" })
  const result = validateReleaseInventory(inventory)

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

function runGit(root, args) {
  const result = spawnSync(
    "git",
    ["-c", "user.name=Test", "-c", "user.email=test@example.com", ...args],
    { cwd: root, encoding: "utf8" },
  )
  assert.equal(result.status, 0, result.stderr)
}
