import assert from "node:assert/strict"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import test from "node:test"
import {
  cleanupStorageContainer,
  runStorageSmoke,
  startDisposableDatabase,
  storageDockerIdentities,
} from "../smoke/storage.mjs"
import {
  assertStrictSmokeCommandOptions,
  STRICT_SMOKE_COMMAND_OPTION_FIELDS,
} from "../smoke-process-runner.mjs"
import { parseSmokeResult } from "../smoke-result.mjs"

const options = Object.freeze({
  version: "0.8.22",
  commitSha: "a".repeat(40),
  manifestSha256: "b".repeat(64),
  result: "/results/storage.json",
})

test("storage Docker identities use one validated UUID without cross-lane collisions", () => {
  const first = storageDockerIdentities(() => "123e4567-e89b-42d3-a456-426614174000")
  const second = storageDockerIdentities(() => "123e4567-e89b-42d3-b456-426614174001")
  assert.deepEqual(first, {
    pgvector: "dawn-storage-pgvector-123e4567e89b42d3a456426614174000",
    postgres: "dawn-storage-postgres-123e4567e89b42d3a456426614174000",
  })
  assert.notEqual(first.pgvector, first.postgres)
  assert.notEqual(first.pgvector, second.pgvector)
  assert.notEqual(first.postgres, second.postgres)
  for (const invalid of [
    "123E4567-E89B-42D3-A456-426614174000",
    "123e4567-e89b-12d3-a456-426614174000",
    "not-a-uuid",
  ]) {
    assert.throws(() => storageDockerIdentities(() => invalid), /UUID/u)
  }
})

test("storage cleanup accepts only exact missing errors and verifies absence by inspect", async () => {
  const name = "dawn-storage-postgres-123e4567e89b42d3a456426614174000"
  const calls = []
  await cleanupStorageContainer(name, {
    async runCommand(_command, args, options = {}) {
      calls.push(args)
      const error = missingContainerError(name, args[0] === "inspect")
      if (options.acceptedExitCodes?.includes(1)) return { stdout: "", stderr: error.stderr }
      throw error
    },
  })
  assert.deepEqual(calls, [
    ["rm", "-f", name],
    ["inspect", name],
  ])
})

test("storage cleanup propagates non-missing removal and inspect failures", async () => {
  const name = "dawn-storage-postgres-123e4567e89b42d3a456426614174000"
  for (const failingOperation of ["rm", "inspect"]) {
    await assert.rejects(
      cleanupStorageContainer(name, {
        async runCommand(_command, args, options = {}) {
          if (args[0] === failingOperation) {
            if (options.acceptedExitCodes?.includes(1)) {
              return { stdout: "", stderr: "permission denied" }
            }
            throw dockerCommandError("permission denied")
          }
          return { stdout: "", stderr: "" }
        },
      }),
      /permission denied/u,
    )
  }
})

test("runs exact pgvector and Postgres packages against separate disposable databases", async () => {
  const events = []
  let receipt
  await runStorageSmoke(options, {
    env: releaseEnv("601", "1"),
    now: clock(),
    randomUUID: () => "123e4567-e89b-42d3-a456-426614174000",
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
      randomUUID: () => "123e4567-e89b-42d3-a456-426614174000",
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
          if (args[0] === "inspect") {
            throw missingContainerError("dawn-startup-failure", true)
          }
          return { stdout: "", stderr: "" }
        },
        async sleep() {},
      },
    ),
    /did not become ready/i,
  )
  assert.deepEqual(
    calls.map((args) => args[0]),
    ["run", "exec", "rm", "inspect"],
  )
  assert.deepEqual(calls.at(-2), ["rm", "-f", "dawn-startup-failure"])
  assert.deepEqual(calls.at(-1), ["inspect", "dawn-startup-failure"])
})

test("pre-registers both exact container cleanups before the first Docker start", async () => {
  const events = []
  await assert.rejects(
    runStorageSmoke(options, {
      env: releaseEnv("603", "1"),
      now: clock(),
      randomUUID: () => "123e4567-e89b-42d3-a456-426614174000",
      async makeTempDir() {
        return "/tmp/storage-start-failure"
      },
      async removeDir() {
        events.push("remove-project")
      },
      strictRunner: fakeStrictRunner(async () => ({ stdout: "", stderr: "" })),
      async startDatabase({ kind }) {
        events.push(`start:${kind}`)
        throw new Error("Docker start lost its response")
      },
      async stopContainer(name) {
        events.push(`stop:${name}`)
      },
      async writeFile() {
        events.push("receipt")
      },
      async mkdir() {},
    }),
    /Docker start lost its response/,
  )
  assert.deepEqual(
    events.slice(0, 3).map((event) => event.split(":")[0]),
    ["start", "stop", "stop"],
  )
  assert.match(events[1], /^stop:dawn-storage-postgres-/u)
  assert.match(events[2], /^stop:dawn-storage-pgvector-/u)
  assert.deepEqual(events.slice(3), ["remove-project", "receipt"])
})

test("database startup attempts cleanup even when docker run loses its response", async () => {
  const calls = []
  await assert.rejects(
    startDisposableDatabase(
      { containerName: "dawn-run-response-lost", image: "postgres:16" },
      {
        async runCommand(_command, args) {
          calls.push(args)
          if (args[0] === "run") throw new Error("response lost")
          if (args[0] === "inspect") {
            throw missingContainerError("dawn-run-response-lost", true)
          }
          return { stdout: "", stderr: "" }
        },
      },
    ),
    /response lost/,
  )
  assert.deepEqual(
    calls.map((args) => args[0]),
    ["run", "rm", "inspect"],
  )
})

function clock() {
  const values = [new Date("2026-08-25T12:00:00.000Z"), new Date("2026-08-25T12:00:01.000Z")]
  return () => values.shift() ?? new Date("2026-08-25T12:00:01.000Z")
}

test("storage runtime probes reach the strict runner with only contract option fields", async (t) => {
  const seen = []
  let receipt
  const probeRoot = await mkdtemp(join(tmpdir(), "dawn-storage-smoke-"))
  t.after(async () => {
    await rm(probeRoot, { recursive: true, force: true })
  })
  await runStorageSmoke(options, {
    env: releaseEnv("602", "1"),
    now: clock(),
    randomUUID: () => "123e4567-e89b-42d3-a456-426614174000",
    async makeTempDir() {
      return probeRoot
    },
    async removeDir() {},
    strictRunner: fakeStrictRunner(async (command, args, runOptions) => {
      seen.push({ command, args, fields: Object.keys(runOptions).sort() })
      return { stdout: "", stderr: "" }
    }),
    async startDatabase({ kind }) {
      return `postgres://postgres:postgres@127.0.0.1/${kind}`
    },
    async stopContainer() {},
    async writeFile(_path, bytes) {
      receipt = parseSmokeResult(bytes)
    },
    async mkdir() {},
  })

  assert.equal(receipt.conclusion, "success")
  const probes = seen.filter((entry) => entry.command === "node")
  assert.ok(probes.length >= 2, "both storage runtime probes must run through the strict runner")
  for (const probe of probes) {
    assert.deepEqual(
      probe.fields.filter((field) => !STRICT_SMOKE_COMMAND_OPTION_FIELDS.includes(field)),
      [],
    )
  }
})

function fakeStrictRunner(runCommand) {
  return {
    async probe() {
      return { adapter: "systemd-cgroup-v2", imageOS: "ubuntu24", imageVersion: "test" }
    },
    async runCommand(command, args, options = {}) {
      assertStrictSmokeCommandOptions(options)
      return await runCommand(command, args, options)
    },
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

function dockerCommandError(stderr) {
  return Object.assign(new Error(stderr), { exitCode: 1, stderr })
}

function missingContainerError(name, inspect) {
  return dockerCommandError(
    inspect
      ? `Error: No such object: ${name}`
      : `Error response from daemon: No such container: ${name}`,
  )
}
