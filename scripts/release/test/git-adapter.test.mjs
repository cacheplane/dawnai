import assert from "node:assert/strict"
import test from "node:test"

import { createGitReader, GitReadError } from "../adapters/git.mjs"

test("createGitReader exposes only allowlisted read operations with exact arguments", async () => {
  const calls = []
  const run = async (...args) => {
    calls.push(args)
    if (args[1][0] === "rev-list" || args[1][1] === "--verify") {
      return "0123456789abcdef0123456789abcdef01234567\n"
    }
    return "result\n"
  }
  const git = createGitReader({ root: "/repo", run })

  assert.deepEqual(Object.keys(git).sort(), [
    "firstParent",
    "isAncestor",
    "listFirstParentHistory",
    "listTree",
    "resolveTag",
    "showFile",
  ])
  assert.equal(
    await git.showFile({ ref: "release/v1", path: "packages/sdk/package.json" }),
    "result\n",
  )
  assert.equal(await git.listTree({ ref: "HEAD" }), "result\n")
  assert.equal(await git.firstParent("abc123"), "0123456789abcdef0123456789abcdef01234567")
  assert.equal(await git.isAncestor({ ancestor: "abc123", descendant: "HEAD" }), true)
  assert.deepEqual(await git.listFirstParentHistory({ ref: "main", maxCount: 25 }), [
    "0123456789abcdef0123456789abcdef01234567",
  ])
  assert.equal(await git.resolveTag({ tag: "v0.8.21" }), "0123456789abcdef0123456789abcdef01234567")
  assert.deepEqual(calls, [
    ["git", ["show", "release/v1:packages/sdk/package.json"], { cwd: "/repo", shell: false }],
    ["git", ["ls-tree", "-r", "--name-only", "HEAD"], { cwd: "/repo", shell: false }],
    ["git", ["rev-parse", "--verify", "abc123^1"], { cwd: "/repo", shell: false }],
    ["git", ["merge-base", "--is-ancestor", "abc123", "HEAD"], { cwd: "/repo", shell: false }],
    [
      "git",
      ["rev-list", "--first-parent", "--max-count=25", "main"],
      { cwd: "/repo", shell: false },
    ],
    [
      "git",
      ["rev-parse", "--verify", "refs/tags/v0.8.21^{commit}"],
      { cwd: "/repo", shell: false },
    ],
  ])
})

test("createGitReader normalizes ancestry misses without hiding Git failures", async () => {
  const run = async (_command, args) => {
    if (args.includes("missing")) {
      throw new GitReadError("not an ancestor", { exitCode: 1 })
    }
    if (args.includes("broken")) {
      throw new GitReadError("repository unavailable", { exitCode: 128 })
    }
    return ""
  }
  const git = createGitReader({ root: "/repo", run })

  assert.equal(await git.isAncestor({ ancestor: "missing", descendant: "HEAD" }), false)
  await assert.rejects(
    git.isAncestor({ ancestor: "broken", descendant: "HEAD" }),
    /repository unavailable/u,
  )
})

test("createGitReader requires exact commit identity and deterministic history output", async () => {
  const outputs = [
    "0123456789abcdef0123456789abcdef01234567\nabcdef0123456789abcdef0123456789abcdef01\n\n",
    "0123456789abcdef0123456789abcdef01234567\n",
    "not-a-commit\n",
  ]
  const git = createGitReader({ root: "/repo", run: async () => outputs.shift() })

  assert.deepEqual(await git.listFirstParentHistory({ ref: "main" }), [
    "0123456789abcdef0123456789abcdef01234567",
    "abcdef0123456789abcdef0123456789abcdef01",
  ])
  assert.equal(await git.resolveTag({ tag: "v0.8.21" }), "0123456789abcdef0123456789abcdef01234567")
  await assert.rejects(git.resolveTag({ tag: "v0.8.22" }), /exact commit identity/u)
})

test("createGitReader rejects unsafe refs before invoking Git", () => {
  const run = () => {
    assert.fail("Git must not run for invalid input")
  }
  const git = createGitReader({ root: "/repo", run })

  for (const ref of [
    "",
    "--help",
    "HEAD:package.json",
    "HEAD package.json",
    "HEAD\\package.json",
  ]) {
    assert.throws(() => git.listTree({ ref }), /Invalid Git ref/u)
    assert.throws(() => git.firstParent(ref), /Invalid Git ref/u)
    assert.throws(() => git.isAncestor({ ancestor: ref, descendant: "HEAD" }), /Invalid Git ref/u)
    assert.throws(() => git.listFirstParentHistory({ ref }), /Invalid Git ref/u)
  }
  for (const tag of ["", "--help", "refs/tags/v1", "v1^{commit}", "v1..v2"]) {
    assert.throws(() => git.resolveTag({ tag }), /Invalid Git tag/u)
  }
  for (const maxCount of [0, -1, 1.5, Number.MAX_SAFE_INTEGER]) {
    assert.throws(
      () => git.listFirstParentHistory({ ref: "HEAD", maxCount }),
      /Invalid history limit/u,
    )
  }
})

test("createGitReader rejects unsafe repository paths before invoking Git", () => {
  const run = () => {
    assert.fail("Git must not run for invalid input")
  }
  const git = createGitReader({ root: "/repo", run })

  for (const path of ["", "/package.json", "../package.json", "packages/../package.json", "a\\b"]) {
    assert.throws(() => git.showFile({ ref: "HEAD", path }), /Invalid repository path/u)
  }
})

test("createGitReader rejects non-absolute roots before invoking Git", () => {
  assert.throws(() => createGitReader({ root: "repo", run: assert.fail }), /absolute path/u)
})
