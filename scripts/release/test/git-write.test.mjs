import assert from "node:assert/strict"
import test from "node:test"

import { createCandidateTagWriter } from "../adapters/git-write.mjs"

const SHA = "0123456789abcdef0123456789abcdef01234567"
const OTHER_SHA = "abcdef0123456789abcdef0123456789abcdef01"
const ROOT = "/tmp/dawn-release-writer-test"

test("candidate tag writer exposes only annotated creation and push", () => {
  const writer = createCandidateTagWriter({ root: ROOT, run: async () => "" })

  assert.deepEqual(Object.keys(writer).sort(), ["createAnnotatedTag", "pushTag"])
})

test("createAnnotatedTag validates exact v<SemVer>, SHA, message, and main ancestry before mutation", async () => {
  for (const input of [
    { tag: "0.8.22", sha: SHA, message: "Dawn v0.8.22 candidate" },
    { tag: "v01.8.22", sha: SHA, message: "Dawn v0.8.22 candidate" },
    { tag: "v0.8.22+build", sha: SHA, message: "Dawn v0.8.22 candidate" },
    { tag: "v0.8.22", sha: "short", message: "Dawn v0.8.22 candidate" },
    { tag: "v0.8.22", sha: SHA, message: "" },
  ]) {
    let calls = 0
    const writer = createCandidateTagWriter({
      root: ROOT,
      run: async () => {
        calls += 1
        return ""
      },
    })
    await assert.rejects(writer.createAnnotatedTag(input), /tag|SemVer|SHA|message/u)
    assert.equal(calls, 0)
  }

  const calls = []
  const writer = createCandidateTagWriter({
    root: ROOT,
    run: async (command, args, options) => {
      calls.push([command, args, options])
      if (args[0] === "merge-base") throw Object.assign(new Error("not ancestor"), { code: 1 })
      return ""
    },
  })
  await assert.rejects(
    writer.createAnnotatedTag({
      tag: "v0.8.22",
      sha: SHA,
      message: "Dawn v0.8.22 candidate",
    }),
    /reachable from main/u,
  )
  assert.equal(calls.length, 1)
  assert.deepEqual(calls[0][1], ["merge-base", "--is-ancestor", SHA, "refs/heads/main"])
})

test("createAnnotatedTag is idempotent only when the existing tag resolves to the exact SHA", async () => {
  for (const existingSha of [SHA, OTHER_SHA]) {
    const calls = []
    const writer = createCandidateTagWriter({
      root: ROOT,
      run: async (command, args, options) => {
        calls.push([command, args, options])
        if (args[0] === "merge-base") return ""
        if (args[0] === "show-ref") return ""
        if (args[0] === "rev-parse") return `${existingSha}\n`
        assert.fail("an existing tag must never be recreated")
      },
    })
    const operation = writer.createAnnotatedTag({
      tag: "v0.8.22",
      sha: SHA,
      message: "Dawn v0.8.22 candidate",
    })

    if (existingSha === SHA) {
      assert.deepEqual(await operation, { status: "present", tag: "v0.8.22", sha: SHA })
    } else {
      await assert.rejects(operation, /another commit/u)
    }
    assert.deepEqual(
      calls.map(([, args]) => args),
      [
        ["merge-base", "--is-ancestor", SHA, "refs/heads/main"],
        ["show-ref", "--verify", "--quiet", "refs/tags/v0.8.22"],
        ["rev-parse", "--verify", "refs/tags/v0.8.22^{commit}"],
      ],
    )
  }
})

test("createAnnotatedTag creates one annotated tag with argument arrays when it is absent", async () => {
  const calls = []
  const writer = createCandidateTagWriter({
    root: ROOT,
    run: async (command, args, options) => {
      calls.push([command, args, options])
      if (args[0] === "merge-base") return ""
      if (args[0] === "show-ref") {
        throw Object.assign(new Error("unknown revision"), { code: 1 })
      }
      if (args[0] === "tag") return ""
      assert.fail(`unexpected Git operation ${args[0]}`)
    },
  })

  const result = await writer.createAnnotatedTag({
    tag: "v0.8.22",
    sha: SHA,
    message: "Dawn v0.8.22 candidate",
  })

  assert.deepEqual(result, { status: "created", tag: "v0.8.22", sha: SHA })
  assert.deepEqual(calls.at(-1)[1], [
    "tag",
    "--annotate",
    "v0.8.22",
    "--message",
    "Dawn v0.8.22 candidate",
    SHA,
  ])
  assert.ok(calls.every(([, , options]) => options.cwd === ROOT && options.shell === false))
  assert.ok(calls.every(([, args]) => !args.includes("--force") && !args.includes("-f")))
})

test("a local tag lookup failure is never reclassified as exact absence", async () => {
  let mutated = false
  const writer = createCandidateTagWriter({
    root: ROOT,
    run: async (_command, args) => {
      if (args[0] === "merge-base" || args[0] === "show-ref") return ""
      if (args[0] === "rev-parse") {
        throw Object.assign(new Error("local object database failed"), { code: 128 })
      }
      if (args[0] === "tag") {
        mutated = true
        return ""
      }
      assert.fail(`unexpected Git operation ${args[0]}`)
    },
  })

  await assert.rejects(
    writer.createAnnotatedTag({
      tag: "v0.8.22",
      sha: SHA,
      message: "Dawn v0.8.22 candidate",
    }),
    /local object database failed/u,
  )
  assert.equal(mutated, false)
})

test("pushTag validates local and remote identity, then uses one non-force exact refspec", async () => {
  const calls = []
  const writer = createCandidateTagWriter({
    root: ROOT,
    run: async (command, args, options) => {
      calls.push([command, args, options])
      if (args[0] === "show-ref") return ""
      if (args[0] === "rev-parse") return `${SHA}\n`
      if (args[0] === "merge-base") return ""
      if (args[0] === "ls-remote") return ""
      if (args[0] === "push") return ""
      assert.fail(`unexpected Git operation ${args[0]}`)
    },
  })

  const result = await writer.pushTag({ tag: "v0.8.22" })

  assert.deepEqual(result, { status: "pushed", tag: "v0.8.22", sha: SHA })
  assert.deepEqual(
    calls.map(([, args]) => args),
    [
      ["show-ref", "--verify", "--quiet", "refs/tags/v0.8.22"],
      ["rev-parse", "--verify", "refs/tags/v0.8.22^{commit}"],
      ["merge-base", "--is-ancestor", SHA, "refs/heads/main"],
      ["ls-remote", "--tags", "origin", "refs/tags/v0.8.22", "refs/tags/v0.8.22^{}"],
      ["push", "origin", "refs/tags/v0.8.22:refs/tags/v0.8.22"],
    ],
  )
  assert.ok(calls.every(([, args]) => !args.includes("--force") && !args.includes("-f")))
})

test("pushTag is a no-op for exact remote identity and conflicts for another commit", async () => {
  for (const remoteSha of [SHA, OTHER_SHA]) {
    const calls = []
    const writer = createCandidateTagWriter({
      root: ROOT,
      run: async (_command, args) => {
        calls.push(args)
        if (args[0] === "show-ref") return ""
        if (args[0] === "rev-parse") return `${SHA}\n`
        if (args[0] === "merge-base") return ""
        if (args[0] === "ls-remote") {
          return `${"b".repeat(40)}\trefs/tags/v0.8.22\n${remoteSha}\trefs/tags/v0.8.22^{}\n`
        }
        assert.fail("an existing remote tag must never be pushed over")
      },
    })
    const operation = writer.pushTag({ tag: "v0.8.22" })

    if (remoteSha === SHA) {
      assert.deepEqual(await operation, { status: "present", tag: "v0.8.22", sha: SHA })
    } else {
      await assert.rejects(operation, /another commit/u)
    }
    assert.equal(
      calls.some((args) => args[0] === "push"),
      false,
    )
  }
})

test("candidate tag writer rejects unsafe roots before invoking Git", () => {
  let calls = 0
  assert.throws(
    () =>
      createCandidateTagWriter({
        root: "relative/path",
        run: async () => {
          calls += 1
          return ""
        },
      }),
    /absolute path/u,
  )
  assert.equal(calls, 0)
})
