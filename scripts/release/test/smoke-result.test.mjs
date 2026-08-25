import assert from "node:assert/strict"
import { mkdtemp, readdir, rm, symlink, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import test from "node:test"

import {
  aggregateSmokeResults,
  canonicalAggregateSmokeResultBytes,
  canonicalSmokeResultBytes,
  correlateSmokeResults,
  executeSmokeLane,
  parseSmokeLaneArgs,
  parseSmokeResult,
  writeCanonicalSmokeResult,
} from "../smoke-result.mjs"

const identity = Object.freeze({
  version: "0.8.22",
  commitSha: "a".repeat(40),
  manifestSha256: "b".repeat(64),
})
const trustedRun = Object.freeze({ workflowRunId: 123, runAttempt: 2 })

function result(lane, overrides = {}) {
  return {
    schemaVersion: 1,
    lane,
    ...identity,
    workflowRunId: 123,
    runAttempt: 2,
    startedAt: "2026-08-25T12:00:00.000Z",
    finishedAt: "2026-08-25T12:00:01.000Z",
    checks: [
      {
        name: "exact-install",
        conclusion: "success",
        detail: "installed 0.8.22",
      },
    ],
    conclusion: "success",
    ...overrides,
  }
}

test("parses, snapshots, and deeply freezes an exact smoke result", () => {
  const input = result("scaffold")
  const parsed = parseSmokeResult(input)

  input.checks[0].detail = "mutated"
  assert.equal(parsed.checks[0].detail, "installed 0.8.22")
  assert.equal(Object.isFrozen(parsed), true)
  assert.equal(Object.isFrozen(parsed.checks), true)
  assert.equal(Object.isFrozen(parsed.checks[0]), true)
})

test("emits stable canonical bytes independent of input key order", () => {
  const first = result("metadata")
  const second = Object.fromEntries(Object.entries(first).reverse())

  assert.deepEqual(canonicalSmokeResultBytes(first), canonicalSmokeResultBytes(second))
  assert.equal(canonicalSmokeResultBytes(first).at(-1), 0x0a)
  assert.throws(() => parseSmokeResult(JSON.stringify(first)), /bytes must be canonical/i)
})

test("rejects malformed identities, timestamps, checks, and extra keys", () => {
  const cases = [
    [result("bad lane!"), /lane/],
    [result("metadata", { version: "latest" }), /version/],
    [result("metadata", { commitSha: "A".repeat(40) }), /commitSha/],
    [result("metadata", { manifestSha256: "b".repeat(63) }), /manifestSha256/],
    [result("metadata", { workflowRunId: 0 }), /workflowRunId/],
    [result("metadata", { runAttempt: 1.5 }), /runAttempt/],
    [result("metadata", { startedAt: "yesterday" }), /startedAt/],
    [
      result("metadata", {
        startedAt: "2026-08-25T12:00:02.000Z",
        finishedAt: "2026-08-25T12:00:01.000Z",
      }),
      /finishedAt/,
    ],
    [result("metadata", { checks: [] }), /checks/],
    [
      result("metadata", {
        checks: [{ name: "check", conclusion: "skip", detail: "not run" }],
      }),
      /checks\[0\]\.conclusion/,
    ],
    [{ ...result("metadata"), unexpected: true }, /unexpected/],
  ]

  for (const [value, expected] of cases) {
    assert.throws(() => parseSmokeResult(value), expected)
  }
})

test("bounds check counts, check text, and encoded receipt bytes", () => {
  assert.throws(
    () =>
      parseSmokeResult(
        result("metadata", {
          checks: Array.from({ length: 129 }, (_, index) => ({
            name: `check-${index}`,
            conclusion: "success",
            detail: "ok",
          })),
        }),
      ),
    /checks.*at most 128/i,
  )
  assert.throws(
    () =>
      parseSmokeResult(
        result("metadata", {
          checks: [{ name: "x".repeat(129), conclusion: "success", detail: "ok" }],
        }),
      ),
    /name.*bounded/i,
  )
  assert.throws(
    () =>
      parseSmokeResult(
        result("metadata", {
          checks: [
            {
              name: "oversized",
              conclusion: "success",
              detail: "x".repeat(8_193),
            },
          ],
        }),
      ),
    /detail.*bounded/i,
  )
  assert.throws(() => parseSmokeResult(Buffer.alloc(256 * 1024 + 1, 0x20)), /byte limit/i)
})

test("rejects duplicate checks and descriptor-unsafe or non-plain inputs", () => {
  assert.throws(
    () =>
      parseSmokeResult(
        result("metadata", {
          checks: [
            { name: "same", conclusion: "success", detail: "one" },
            { name: "same", conclusion: "success", detail: "two" },
          ],
        }),
      ),
    /duplicate check same/i,
  )

  const accessor = result("metadata")
  Object.defineProperty(accessor, "lane", {
    enumerable: true,
    get: () => "metadata",
  })
  assert.throws(() => parseSmokeResult(accessor), /descriptor-safe/i)

  const nonPlain = Object.assign(Object.create({ inherited: true }), result("metadata"))
  assert.throws(() => parseSmokeResult(nonPlain), /descriptor-safe/i)

  const unsafeKey = result("metadata")
  Object.defineProperty(unsafeKey, "__proto__", {
    enumerable: true,
    configurable: true,
    writable: true,
    value: { polluted: true },
  })
  assert.throws(() => parseSmokeResult(unsafeKey), /unexpected.*__proto__/i)
  assert.equal({}.polluted, undefined)
})

test("rejects a lane success that hides a failed check", () => {
  assert.throws(
    () =>
      parseSmokeResult(
        result("metadata", {
          checks: [
            {
              name: "provenance",
              conclusion: "failure",
              detail: "wrong workflow",
            },
          ],
          conclusion: "success",
        }),
      ),
    /conclusion.*failed check/i,
  )
})

test("correlates required lanes in stable order", () => {
  const correlated = correlateSmokeResults([result("storage"), result("metadata")], {
    ...identity,
    ...trustedRun,
    requiredLanes: ["metadata", "storage"],
  })

  assert.deepEqual(
    correlated.map(({ lane }) => lane),
    ["metadata", "storage"],
  )
  assert.equal(Object.isFrozen(correlated), true)
})

test("correlation rejects duplicate, missing, unexpected, or mismatched lanes", () => {
  assert.throws(
    () =>
      correlateSmokeResults([result("metadata"), result("metadata")], {
        ...identity,
        ...trustedRun,
        requiredLanes: ["metadata"],
      }),
    /duplicate.*metadata/i,
  )
  assert.throws(
    () =>
      correlateSmokeResults([result("metadata")], {
        ...identity,
        ...trustedRun,
        requiredLanes: ["metadata", "storage"],
      }),
    /missing.*storage/i,
  )
  assert.throws(
    () =>
      correlateSmokeResults([result("metadata"), result("other")], {
        ...identity,
        ...trustedRun,
        requiredLanes: ["metadata"],
      }),
    /unexpected.*other/i,
  )
  assert.throws(
    () =>
      correlateSmokeResults([result("metadata", { commitSha: "c".repeat(40) })], {
        ...identity,
        ...trustedRun,
        requiredLanes: ["metadata"],
      }),
    /identity.*metadata/i,
  )
  assert.throws(
    () =>
      correlateSmokeResults([result("metadata", { workflowRunId: 124 })], {
        ...identity,
        ...trustedRun,
        requiredLanes: ["metadata"],
      }),
    /workflow run.*metadata/i,
  )
  assert.throws(
    () =>
      correlateSmokeResults([result("metadata", { runAttempt: 3 })], {
        ...identity,
        ...trustedRun,
        requiredLanes: ["metadata"],
      }),
    /run attempt.*metadata/i,
  )
})

test("aggregates one trusted run identity and derives every check and conclusion", () => {
  const aggregate = aggregateSmokeResults(
    [
      result("storage", {
        checks: [
          {
            name: "postgres",
            conclusion: "failure",
            detail: "connection refused",
          },
        ],
        conclusion: "failure",
      }),
      result("metadata"),
    ],
    { ...identity, ...trustedRun, requiredLanes: ["metadata", "storage"] },
  )

  assert.deepEqual(
    aggregate.lanes.map(({ lane, workflowRunId, runAttempt }) => ({
      lane,
      workflowRunId,
      runAttempt,
    })),
    [
      { lane: "metadata", workflowRunId: 123, runAttempt: 2 },
      { lane: "storage", workflowRunId: 123, runAttempt: 2 },
    ],
  )
  assert.deepEqual(
    aggregate.checks.map(({ name, conclusion }) => ({ name, conclusion })),
    [
      { name: "metadata:exact-install", conclusion: "success" },
      { name: "storage:postgres", conclusion: "failure" },
    ],
  )
  assert.equal(aggregate.conclusion, "failure")
  assert.equal(Object.isFrozen(aggregate.lanes[0].checks[0]), true)
  assert.deepEqual(aggregate.lanes[1].checks, [
    { name: "postgres", conclusion: "failure", detail: "connection refused" },
  ])
  const first = aggregateSmokeResults([result("metadata")], {
    ...identity,
    ...trustedRun,
    requiredLanes: ["metadata"],
  })
  const reordered = Object.fromEntries(Object.entries(first).reverse())
  const firstBytes = canonicalAggregateSmokeResultBytes(first)
  assert.deepEqual(firstBytes, canonicalAggregateSmokeResultBytes(reordered))
  assert.equal(firstBytes.at(-1), 0x0a)
})

test("parses the common exact-version lane arguments", () => {
  assert.deepEqual(
    parseSmokeLaneArgs([
      "--version=0.8.22",
      `--commit-sha=${"a".repeat(40)}`,
      `--manifest-sha256=${"b".repeat(64)}`,
      "--manifest=/tmp/manifest.json",
      "--result=/tmp/result.json",
    ]),
    {
      version: "0.8.22",
      commitSha: "a".repeat(40),
      manifestSha256: "b".repeat(64),
      manifest: "/tmp/manifest.json",
      result: "/tmp/result.json",
    },
  )
  assert.throws(
    () =>
      parseSmokeLaneArgs([
        "--version=latest",
        `--commit-sha=${"a".repeat(40)}`,
        `--manifest-sha256=${"b".repeat(64)}`,
        "--result=/tmp/result.json",
      ]),
    /exact SemVer/i,
  )
})

test("executes recorded checks, always cleans, and writes a failure receipt before rejecting", async () => {
  const events = []
  let written
  await assert.rejects(
    executeSmokeLane(
      { lane: "scaffold", ...identity, result: "/tmp/result.json" },
      async ({ check, deferCleanup }) => {
        deferCleanup("cleanup", "temporary project removed", async () => {
          events.push("cleanup")
        })
        await check("install", "exact package installed", async () => {
          events.push("install")
          throw new Error("registry unavailable")
        })
      },
      {
        env: { GITHUB_RUN_ID: "44", GITHUB_RUN_ATTEMPT: "3" },
        now: sequenceClock("2026-08-25T12:00:00.000Z", "2026-08-25T12:00:01.000Z"),
        async mkdir() {},
        async writeFile(_path, bytes) {
          events.push("receipt")
          written = parseSmokeResult(bytes)
        },
      },
    ),
    /registry unavailable/,
  )

  assert.deepEqual(events, ["install", "cleanup", "receipt"])
  assert.equal(written.conclusion, "failure")
  assert.deepEqual(
    written.checks.map(({ name, conclusion }) => ({ name, conclusion })),
    [
      { name: "install", conclusion: "failure" },
      { name: "cleanup", conclusion: "success" },
    ],
  )
})

test("atomically creates canonical results, permits identical replay, and rejects conflicts or symlinks", async () => {
  const root = await mkdtemp(join(tmpdir(), "dawn-smoke-result-write-"))
  try {
    const path = join(root, "result.json")
    const value = result("metadata")
    await writeCanonicalSmokeResult(path, value)
    await writeCanonicalSmokeResult(path, value)
    await assert.rejects(
      writeCanonicalSmokeResult(path, result("storage")),
      /conflicts with canonical bytes/i,
    )
    assert.deepEqual(await readdir(root), ["result.json"])

    const target = join(root, "target.json")
    const linked = join(root, "linked.json")
    await writeFile(target, canonicalSmokeResultBytes(value))
    await symlink(target, linked)
    await assert.rejects(
      writeCanonicalSmokeResult(linked, value),
      /symbolic link|ELOOP|regular file/i,
    )
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test("bounds and redacts multibyte failure details so the receipt is always writable", async () => {
  let receipt
  const secret = "npm_super_secret_token"
  await assert.rejects(
    executeSmokeLane(
      { lane: "metadata", ...identity, result: "/tmp/result.json" },
      async ({ check }) => {
        await check("failure", "unused", async () => {
          throw new Error(`${secret} ${"💥".repeat(10_000)}`)
        })
      },
      {
        env: { GITHUB_RUN_ID: "45", GITHUB_RUN_ATTEMPT: "1" },
        now: sequenceClock("2026-08-25T12:00:00.000Z", "2026-08-25T12:00:01.000Z"),
        async mkdir() {},
        async writeFile(_path, bytes) {
          receipt = parseSmokeResult(bytes)
        },
      },
    ),
  )
  assert.ok(receipt)
  assert.equal(receipt.conclusion, "failure")
  assert.equal(Buffer.byteLength(receipt.checks[0].detail, "utf8") <= 4_096, true)
  assert.doesNotMatch(receipt.checks[0].detail, /super_secret/u)
})

function sequenceClock(...timestamps) {
  let index = 0
  return () => new Date(timestamps[Math.min(index++, timestamps.length - 1)])
}
