import assert from "node:assert/strict"
import test from "node:test"

import {
  createGitReader,
  DEFAULT_GIT_MAX_OUTPUT_BYTES,
  DEFAULT_GIT_TIMEOUT_MS,
  GitReadError,
} from "../adapters/git.mjs"

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
  const options = {
    cwd: "/repo",
    shell: false,
    timeout: DEFAULT_GIT_TIMEOUT_MS,
    maxBuffer: DEFAULT_GIT_MAX_OUTPUT_BYTES,
    encoding: "utf8",
    windowsHide: true,
  }

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
    ["git", ["show", "release/v1:packages/sdk/package.json"], options],
    ["git", ["ls-tree", "-r", "--name-only", "HEAD"], options],
    ["git", ["rev-parse", "--verify", "abc123^1"], options],
    ["git", ["merge-base", "--is-ancestor", "abc123", "HEAD"], options],
    ["git", ["rev-list", "--first-parent", "--max-count=25", "main"], options],
    ["git", ["rev-parse", "--verify", "refs/tags/v0.8.21^{commit}"], options],
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
    (error) =>
      error instanceof GitReadError &&
      error.code === "EXIT_NONZERO" &&
      !error.message.includes("repository unavailable"),
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
  await assert.rejects(
    git.resolveTag({ tag: "v0.8.22" }),
    (error) => error instanceof GitReadError && error.code === "MALFORMED_OUTPUT",
  )
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

test("createGitReader validates bounded timeout and output constructor options", () => {
  for (const options of [
    { timeoutMs: 0 },
    { timeoutMs: 1.5 },
    { timeoutMs: 300_001 },
    { maxOutputBytes: 0 },
    { maxOutputBytes: 1.5 },
    { maxOutputBytes: 64 * 1024 * 1024 + 1 },
  ]) {
    assert.throws(() => createGitReader({ root: "/repo", run: assert.fail, ...options }), /Git/u)
  }
})

test("createGitReader normalizes timeout and output overflow errors without raw stderr", async () => {
  const failures = [
    Object.assign(new Error("timed out"), {
      killed: true,
      signal: "SIGTERM",
      stderr: "Authorization: Bearer git_secret\nforged-log-line",
    }),
    Object.assign(new Error("stdout maxBuffer length exceeded"), {
      code: "ERR_CHILD_PROCESS_STDIO_MAXBUFFER",
      stderr: "token=git_secret\rforged",
    }),
  ]
  const git = createGitReader({
    root: "/repo",
    run: async () => {
      throw failures.shift()
    },
  })

  for (const expectedCode of ["TIMEOUT", "OUTPUT_TOO_LARGE"]) {
    await assert.rejects(git.listTree({ ref: "HEAD" }), (error) => {
      assert.ok(error instanceof GitReadError)
      assert.equal(error.code, expectedCode)
      assert.doesNotMatch(error.message, /git_secret|forged-log-line|forged/iu)
      assert.doesNotMatch(error.diagnostic ?? "", /git_secret|authorization|bearer|[\r\n]/iu)
      assert.ok((error.diagnostic ?? "").length <= 256)
      return true
    })
  }
})

test("createGitReader rejects oversized injected output with a stable typed error", async () => {
  const git = createGitReader({ root: "/repo", maxOutputBytes: 4, run: async () => "12345" })
  await assert.rejects(
    git.listTree({ ref: "HEAD" }),
    (error) => error instanceof GitReadError && error.code === "OUTPUT_TOO_LARGE",
  )
})

test("createGitReader rejects control characters in roots, refs, tags, and repository paths", () => {
  assert.throws(
    () => createGitReader({ root: "/repo\nforged", run: assert.fail }),
    stableInputError,
  )
  const git = createGitReader({ root: "/repo", run: assert.fail })
  for (const ref of ["HEAD\nforged", "HEAD\0forged", "HEAD\u007fforged"]) {
    assert.throws(() => git.listTree({ ref }), stableInputError)
  }
  assert.throws(() => git.resolveTag({ tag: "v1\nforged" }), stableInputError)
  for (const path of ["package\n.json", "package\0.json", "package\u007f.json"]) {
    assert.throws(() => git.showFile({ ref: "HEAD", path }), stableInputError)
  }
})

test("createGitReader rejects oversized roots, refs, tags, and paths before parsing or running", () => {
  assert.throws(
    () => createGitReader({ root: `/${"r".repeat(5_000)}`, run: assert.fail }),
    inputTooLong,
  )
  const git = createGitReader({ root: "/repo", run: assert.fail })
  assert.throws(() => git.listTree({ ref: `r${"a".repeat(2_000)}` }), inputTooLong)
  assert.throws(() => git.resolveTag({ tag: `v${"a".repeat(2_000)}` }), inputTooLong)
  assert.throws(
    () => git.showFile({ ref: "HEAD", path: `packages/${"a".repeat(5_000)}` }),
    inputTooLong,
  )
})

function inputTooLong(error) {
  return (
    error instanceof GitReadError &&
    error.code === "INPUT_TOO_LONG" &&
    !error.message.includes("a".repeat(100)) &&
    !error.message.includes("r".repeat(100))
  )
}

function stableInputError(error) {
  return (
    error instanceof GitReadError &&
    error.code === "INVALID_INPUT" &&
    ![...error.message].some((character) => {
      const codePoint = character.codePointAt(0)
      return codePoint <= 31 || codePoint === 127
    })
  )
}
