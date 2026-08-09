import assert from "node:assert/strict"
import test from "node:test"

import { createGitReader } from "../adapters/git.mjs"

test("createGitReader exposes only allowlisted read operations with exact arguments", async () => {
  const calls = []
  const run = async (...args) => {
    calls.push(args)
    return "result\n"
  }
  const git = createGitReader({ root: "/repo", run })

  assert.deepEqual(Object.keys(git).sort(), ["firstParent", "listTree", "showFile"])
  assert.equal(
    await git.showFile({ ref: "release/v1", path: "packages/sdk/package.json" }),
    "result\n",
  )
  assert.equal(await git.listTree({ ref: "HEAD" }), "result\n")
  assert.equal(await git.firstParent("abc123"), "result")
  assert.deepEqual(calls, [
    ["git", ["show", "release/v1:packages/sdk/package.json"], { cwd: "/repo" }],
    ["git", ["ls-tree", "-r", "--name-only", "HEAD"], { cwd: "/repo" }],
    ["git", ["rev-parse", "--verify", "abc123^1"], { cwd: "/repo" }],
  ])
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
