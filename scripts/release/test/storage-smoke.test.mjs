import assert from "node:assert/strict"
import test from "node:test"
import { runStorageSmoke, startDisposableDatabase } from "../smoke/storage.mjs"
import { parseSmokeResult } from "../smoke-result.mjs"

const options = Object.freeze({
  version: "0.8.22",
  commitSha: "a".repeat(40),
  manifestSha256: "b".repeat(64),
  result: "/results/storage.json",
})

test("runs exact pgvector and Postgres packages against separate disposable databases", async () => {
  const events = []
  let receipt
  await runStorageSmoke(options, {
    env: releaseEnv("601", "1"),
    now: clock(),
    async makeTempDir() {
      return "/tmp/storage-consumer"
    },
    async removeDir() {
      events.push("remove-project")
    },
    strictRunner: fakeStrictRunner(async (command, args) => {
      events.push({ command, args })
      return { stdout: "", stderr: "" }
    }),
    async startDatabase({ kind, containerName }) {
      events.push(`start:${kind}:${containerName}`)
      return `postgres://postgres:postgres@127.0.0.1/${kind}`
    },
    async stopContainer(name) {
      events.push(`stop:${name}`)
    },
    async runPgvectorProbe(_root, databaseUrl) {
      events.push(`probe:pgvector:${databaseUrl}`)
    },
    async runPostgresProbe(_root, databaseUrl) {
      events.push(`probe:postgres:${databaseUrl}`)
    },
    async writeFile(_path, bytes) {
      receipt = parseSmokeResult(bytes)
    },
    async mkdir() {},
  })

  const install = events.find((event) => typeof event === "object" && event.args[0] === "install")
  assert.deepEqual(
    install.args.filter((arg) => arg.startsWith("@dawn-ai/")),
    [
      "@dawn-ai/memory-pgvector@0.8.22",
      "@dawn-ai/langchain@0.8.22",
      "@dawn-ai/postgres-storage@0.8.22",
    ],
  )
  assert.equal(
    events.some((event) => String(event).startsWith("probe:pgvector:")),
    true,
  )
  assert.equal(
    events.some((event) => String(event).startsWith("probe:postgres:")),
    true,
  )
  assert.deepEqual(
    events.slice(-3).map(String),
    [
      events.findLast((event) => String(event).startsWith("stop:dawn-storage-postgres-")),
      events.findLast((event) => String(event).startsWith("stop:dawn-storage-pgvector-")),
      "remove-project",
    ].map(String),
  )
  assert.equal(receipt.conclusion, "success")
  assert.equal(receipt.lane, "storage")
  assert.equal(receipt.checks[0].name, "containment")
})

test("records probe failure and removes each started container and project", async () => {
  const events = []
  let receipt
  await assert.rejects(
    runStorageSmoke(options, {
      env: releaseEnv("602", "2"),
      now: clock(),
      async makeTempDir() {
        return "/tmp/storage-failure"
      },
      async removeDir() {
        events.push("remove-project")
      },
      strictRunner: fakeStrictRunner(async () => ({ stdout: "", stderr: "" })),
      async startDatabase({ kind }) {
        events.push(`start:${kind}`)
        return `postgres:///${kind}`
      },
      async stopContainer(name) {
        events.push(`stop:${name}`)
      },
      async runPgvectorProbe() {
        throw new Error("pgvector probe failed")
      },
      async runPostgresProbe() {
        throw new Error("must not run")
      },
      async writeFile(_path, bytes) {
        events.push("receipt")
        receipt = parseSmokeResult(bytes)
      },
      async mkdir() {},
    }),
    /pgvector probe failed/,
  )

  assert.equal(
    events.some((event) => event === "start:postgres"),
    false,
  )
  assert.equal(
    events.some((event) => String(event).startsWith("stop:dawn-storage-pgvector-")),
    true,
  )
  assert.deepEqual(events.slice(-2), ["remove-project", "receipt"])
  assert.equal(receipt.conclusion, "failure")
})

test("self-cleans a container when readiness fails before lane cleanup registration", async () => {
  const calls = []
  await assert.rejects(
    startDisposableDatabase(
      { containerName: "dawn-startup-failure", image: "postgres:16" },
      {
        attempts: 1,
        async runCommand(_command, args) {
          calls.push(args)
          if (args[0] === "exec") throw new Error("not ready")
          return { stdout: "", stderr: "" }
        },
        async sleep() {},
      },
    ),
    /did not become ready/i,
  )
  assert.deepEqual(
    calls.map((args) => args[0]),
    ["run", "exec", "rm"],
  )
  assert.deepEqual(calls.at(-1), ["rm", "-f", "dawn-startup-failure"])
})

function clock() {
  const values = [new Date("2026-08-25T12:00:00.000Z"), new Date("2026-08-25T12:00:01.000Z")]
  return () => values.shift() ?? new Date("2026-08-25T12:00:01.000Z")
}

function fakeStrictRunner(runCommand) {
  return {
    async probe() {
      return { adapter: "systemd-cgroup-v2", imageOS: "ubuntu24", imageVersion: "test" }
    },
    runCommand,
  }
}

function releaseEnv(runId, attempt) {
  return {
    GITHUB_RUN_ID: runId,
    GITHUB_RUN_ATTEMPT: attempt,
    ImageOS: "ubuntu24",
    ImageVersion: "test",
  }
}
