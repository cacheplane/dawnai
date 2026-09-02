import assert from "node:assert/strict"
import { mkdir, mkdtemp, realpath, rm, symlink } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { Writable } from "node:stream"
import test from "node:test"

import { runDuplicateDraftConsolidationCli } from "../duplicate-draft-consolidation-cli.mjs"

const COMMAND = [
  "inspect",
  "--version",
  "0.8.22",
  "--commit-sha",
  "2a80deece2ff958fe7fde8fddeb4f99bed70a1c8",
  "--survivor",
  "379991871",
  "--duplicates",
  "379982100,379986168",
  "--output",
  ".dawn/release/duplicate-draft-consolidation.proposed.json",
]
const PROPOSAL_SHA256 = "a".repeat(64)
const CONFIRMATION = `CONSOLIDATE v0.8.22 2a80deece2ff958fe7fde8fddeb4f99bed70a1c8 SURVIVOR 379991871 DELETE 379982100,379986168 PROPOSAL ${PROPOSAL_SHA256}`
const PERFORM_COMMAND = [
  "perform",
  "--proposal",
  ".dawn/release/duplicate-draft-consolidation.proposed.json",
  "--journal",
  ".dawn/release/duplicate-draft-consolidation.journal.json",
  "--receipt",
  "scripts/release/duplicate-draft-consolidation.json",
  "--confirmation",
  CONFIRMATION,
]
const VERIFY_COMMAND = ["verify", "--receipt", "scripts/release/duplicate-draft-consolidation.json"]

test("CLI accepts only the exact read-only verify shape and prints its bounded historical-parity report", async () => {
  const stdout = sink()
  const stderr = sink()
  let received
  const code = await runDuplicateDraftConsolidationCli({
    argv: VERIFY_COMMAND,
    cwd: process.cwd(),
    environment: {},
    stdout,
    stderr,
    dependencies: {
      async createAdapters() {
        return Object.freeze({})
      },
      async verify(input, dependencies) {
        received = { input, dependencies }
        return Object.freeze({
          status: "verified",
          survivor: "379991871",
          deleted: Object.freeze(["379982100", "379986168"]),
          receipt: "scripts/release/duplicate-draft-consolidation.json",
          receiptSha256: "c".repeat(64),
          historicalParity:
            "Historical duplicate payload parity is supported by embedded pre-delete evidence plus the currently reverified survivor; deleted bytes were not independently re-downloaded.",
        })
      },
      now: () => "2026-09-01T12:00:00.000Z",
      async wait() {},
    },
  })
  assert.equal(code, 0)
  assert.equal(stderr.value, "")
  assert.deepEqual(JSON.parse(stdout.value), {
    status: "verified",
    survivor: "379991871",
    deleted: ["379982100", "379986168"],
    receipt: "scripts/release/duplicate-draft-consolidation.json",
    receiptSha256: "c".repeat(64),
    historicalParity:
      "Historical duplicate payload parity is supported by embedded pre-delete evidence plus the currently reverified survivor; deleted bytes were not independently re-downloaded.",
  })
  assert.deepEqual(received.input, {
    receipt: "scripts/release/duplicate-draft-consolidation.json",
  })
  assert.equal(received.dependencies.repositoryRoot, process.cwd())
})

test("CLI verify rejects every override, mutation, alternate path, and malformed shape before composition", async () => {
  for (const argv of [
    [],
    VERIFY_COMMAND.slice(0, -1),
    [...VERIFY_COMMAND, "--force"],
    [...VERIFY_COMMAND, "--override", "main"],
    [...VERIFY_COMMAND, "--delete", "379982100"],
    VERIFY_COMMAND.with(2, ".dawn/release/duplicate-draft-consolidation.json"),
    VERIFY_COMMAND.with(2, "/tmp/receipt.json"),
  ]) {
    let composeCalls = 0
    const stderr = sink()
    assert.equal(
      await runDuplicateDraftConsolidationCli({
        argv,
        cwd: process.cwd(),
        environment: {},
        stdout: sink(),
        stderr,
        dependencies: {
          async createAdapters() {
            composeCalls += 1
            return Object.freeze({})
          },
        },
      }),
      2,
    )
    assert.equal(composeCalls, 0)
    assert.equal(stderr.value, "Invalid duplicate-draft consolidation invocation.\n")
  }
})

test("CLI accepts only the exact perform shape and prints a bounded completion summary", async () => {
  const stdout = sink()
  const stderr = sink()
  let received
  const code = await runDuplicateDraftConsolidationCli({
    argv: PERFORM_COMMAND,
    cwd: process.cwd(),
    environment: {},
    stdout,
    stderr,
    dependencies: {
      async createAdapters() {
        return Object.freeze({})
      },
      async perform(input, dependencies) {
        received = { input, dependencies }
        return Object.freeze({
          status: "complete",
          survivor: "379991871",
          deleted: Object.freeze(["379982100", "379986168"]),
          receipt: "scripts/release/duplicate-draft-consolidation.json",
          receiptSha256: "b".repeat(64),
        })
      },
      now: () => "2026-09-01T12:00:00.000Z",
      async wait() {},
    },
  })
  assert.equal(code, 0)
  assert.equal(stderr.value, "")
  assert.deepEqual(JSON.parse(stdout.value), {
    status: "complete",
    survivor: "379991871",
    deleted: ["379982100", "379986168"],
    receipt: "scripts/release/duplicate-draft-consolidation.json",
    receiptSha256: "b".repeat(64),
  })
  assert.deepEqual(received.input, {
    proposal: ".dawn/release/duplicate-draft-consolidation.proposed.json",
    proposalSha256: PROPOSAL_SHA256,
    journal: ".dawn/release/duplicate-draft-consolidation.journal.json",
    receipt: "scripts/release/duplicate-draft-consolidation.json",
    confirmation: CONFIRMATION,
  })
  assert.equal(received.dependencies.repositoryRoot, process.cwd())
})

test("CLI threads each exact convergence request budget into production adapter composition", async () => {
  const controller = new AbortController()
  const requestBudget = Object.freeze({
    operation: "release",
    timeoutMs: 12_345,
    signal: controller.signal,
  })
  let adapterOptions
  const code = await runDuplicateDraftConsolidationCli({
    argv: PERFORM_COMMAND,
    cwd: process.cwd(),
    environment: {},
    stdout: sink(),
    stderr: sink(),
    dependencies: {
      async createAdapters(options) {
        adapterOptions = options
        return Object.freeze({})
      },
      async perform(_input, dependencies) {
        await dependencies.createAdapters(requestBudget)
        return Object.freeze({
          status: "complete",
          survivor: "379991871",
          deleted: Object.freeze(["379982100", "379986168"]),
          receipt: "scripts/release/duplicate-draft-consolidation.json",
          receiptSha256: "b".repeat(64),
        })
      },
      now: () => "2026-09-01T12:00:00.000Z",
      async wait() {},
    },
  })

  assert.equal(code, 0)
  assert.equal(adapterOptions.requestBudget, requestBudget)
})

test("CLI perform rejects digest, confirmation, path, force, survivor, and reordered-ID variants", async () => {
  for (const argv of [
    PERFORM_COMMAND.with(8, CONFIRMATION.replace(PROPOSAL_SHA256, "A".repeat(64))),
    PERFORM_COMMAND.with(8, `${CONFIRMATION} `),
    PERFORM_COMMAND.with(2, "/tmp/proposal.json"),
    [...PERFORM_COMMAND, "--force"],
    [...PERFORM_COMMAND, "--survivor", "379982100"],
    PERFORM_COMMAND.with(8, CONFIRMATION.replace("379982100,379986168", "379986168,379982100")),
  ]) {
    const stderr = sink()
    assert.equal(
      await runDuplicateDraftConsolidationCli({
        argv,
        cwd: process.cwd(),
        environment: {},
        stdout: sink(),
        stderr,
      }),
      2,
    )
    assert.equal(stderr.value, "Invalid duplicate-draft consolidation invocation.\n")
  }
})

test("CLI accepts only the exact ordered invocation and prints a bounded safe summary", async () => {
  const stdout = sink()
  const stderr = sink()
  let received
  const code = await runDuplicateDraftConsolidationCli({
    argv: COMMAND,
    cwd: process.cwd(),
    environment: {},
    stdout,
    stderr,
    dependencies: {
      async createAdapters() {
        return Object.freeze({})
      },
      async inspect(input, dependencies) {
        received = { input, dependencies }
        return Object.freeze({
          proposalSha256: "a".repeat(64),
          version: input.version,
          commitSha: input.commitSha,
          survivor: input.survivor,
          duplicates: Object.freeze([...input.duplicates]),
          output: input.output,
        })
      },
      now: () => "2026-09-01T12:00:00.000Z",
      async wait() {},
    },
  })

  assert.equal(code, 0)
  assert.equal(stderr.value, "")
  assert.deepEqual(JSON.parse(stdout.value), {
    proposalSha256: "a".repeat(64),
    version: "0.8.22",
    commitSha: "2a80deece2ff958fe7fde8fddeb4f99bed70a1c8",
    survivor: "379991871",
    duplicates: ["379982100", "379986168"],
    output: ".dawn/release/duplicate-draft-consolidation.proposed.json",
  })
  assert.deepEqual(received.input, {
    version: "0.8.22",
    commitSha: "2a80deece2ff958fe7fde8fddeb4f99bed70a1c8",
    survivor: "379991871",
    duplicates: ["379982100", "379986168"],
    output: ".dawn/release/duplicate-draft-consolidation.proposed.json",
  })
  assert.equal(received.dependencies.repositoryRoot, process.cwd())
  assert.equal(typeof received.dependencies.repositoryRootIdentity, "object")
})

test("CLI rejects unknown, duplicate, missing, reordered, positional, equals, control, and numeric-coercion arguments", async () => {
  const variants = [
    [],
    ["perform", ...COMMAND.slice(1)],
    COMMAND.slice(0, -2),
    [...COMMAND, "extra"],
    [...COMMAND.slice(0, 3), "--version", "0.8.22", ...COMMAND.slice(3)],
    [
      COMMAND[0],
      COMMAND[1],
      COMMAND[2],
      COMMAND[5],
      COMMAND[6],
      COMMAND[3],
      COMMAND[4],
      ...COMMAND.slice(7),
    ],
    ["inspect", "--version=0.8.22", ...COMMAND.slice(3)],
    COMMAND.with(2, "0.8.22\n"),
    COMMAND.with(6, "379991871.0"),
  ]
  for (const argv of variants) {
    const stdout = sink()
    const stderr = sink()
    assert.equal(
      await runDuplicateDraftConsolidationCli({
        argv,
        cwd: "/repo",
        environment: {},
        stdout,
        stderr,
      }),
      2,
    )
    assert.equal(stdout.value, "")
    assert.equal(stderr.value, "Invalid duplicate-draft consolidation invocation.\n")
  }
})

test("CLI rejects an explicit unknown flag before composing production dependencies", async () => {
  const stdout = sink()
  const stderr = sink()
  let composeCalls = 0
  const code = await runDuplicateDraftConsolidationCli({
    argv: [...COMMAND, "--unknown"],
    cwd: "/repo",
    environment: {},
    stdout,
    stderr,
    dependencies: {
      async createAdapters() {
        composeCalls += 1
        throw new Error("must not compose")
      },
    },
  })
  assert.equal(code, 2)
  assert.equal(stdout.value, "")
  assert.equal(stderr.value, "Invalid duplicate-draft consolidation invocation.\n")
  assert.equal(stderr.value.split("\n").filter(Boolean).length, 1)
  assert.equal(composeCalls, 0)
})

test("CLI maps evidence failures to one redacted line and exit code 1", async () => {
  const stdout = sink()
  const stderr = sink()
  const code = await runDuplicateDraftConsolidationCli({
    argv: COMMAND,
    cwd: process.cwd(),
    environment: { GH_TOKEN: "ghp_secret" },
    stdout,
    stderr,
    dependencies: {
      async createAdapters() {
        throw new Error("ghp_secret remote response body bytes")
      },
    },
  })
  assert.equal(code, 1)
  assert.equal(stdout.value, "")
  assert.equal(stderr.value, "Duplicate-draft inspection failed.\n")
  assert.doesNotMatch(stderr.value, /secret|body|bytes|stack/iu)
})

test("CLI contains synchronous and asynchronous stdout failures without leaking diagnostics", async () => {
  for (const stdout of [
    throwingSink("stdout ghp_sync_secret body"),
    rejectingSink("stdout ghp_async_secret body"),
  ]) {
    const stderr = sink()
    const code = await runDuplicateDraftConsolidationCli({
      argv: COMMAND,
      cwd: process.cwd(),
      environment: {},
      stdout,
      stderr,
      dependencies: successfulDependencies(),
    })
    assert.equal(code, 1)
    assert.equal(stderr.value, "Duplicate-draft inspection failed.\n")
    assert.doesNotMatch(stderr.value, /secret|body|stack/iu)
  }
})

test("CLI preserves invocation and evidence classifications when stderr rejects", async () => {
  for (const stderr of [
    throwingSink("stderr ghp_sync_secret body"),
    rejectingSink("stderr ghp_async_secret body"),
  ]) {
    assert.equal(
      await runDuplicateDraftConsolidationCli({
        argv: [],
        cwd: process.cwd(),
        environment: {},
        stdout: sink(),
        stderr,
      }),
      2,
    )
    assert.equal(
      await runDuplicateDraftConsolidationCli({
        argv: COMMAND,
        cwd: process.cwd(),
        environment: {},
        stdout: sink(),
        stderr,
        dependencies: {
          async createAdapters() {
            throw new Error("remote ghp_secret response body")
          },
        },
      }),
      1,
    )
  }
})

test("CLI contains a real Writable asynchronous stdout error without process-level leakage", async () => {
  const stderr = sink()
  const code = await runDuplicateDraftConsolidationCli({
    argv: COMMAND,
    cwd: process.cwd(),
    environment: {},
    stdout: failingWritable("stdout ghp_writable_secret response body"),
    stderr,
    dependencies: successfulDependencies(),
  })
  await immediate()
  assert.equal(code, 1)
  assert.equal(stderr.value, "Duplicate-draft inspection failed.\n")
  assert.doesNotMatch(stderr.value, /secret|body|stack/iu)
})

test("CLI preserves invocation classification when a real stderr Writable fails asynchronously", async () => {
  const code = await runDuplicateDraftConsolidationCli({
    argv: [],
    cwd: process.cwd(),
    environment: {},
    stdout: sink(),
    stderr: failingWritable("stderr ghp_writable_secret response body"),
  })
  await immediate()
  assert.equal(code, 2)
})

test("CLI rejects a symlinked root before production adapter composition", async (t) => {
  const parent = await realpath(await mkdtemp(path.join(os.tmpdir(), "dawn-cli-root-")))
  t.after(() => rm(parent, { recursive: true, force: true }))
  const physical = path.join(parent, "physical")
  const linked = path.join(parent, "linked")
  await mkdir(physical)
  await symlink(physical, linked, "dir")
  let composeCalls = 0
  const stderr = sink()
  assert.equal(
    await runDuplicateDraftConsolidationCli({
      argv: COMMAND,
      cwd: linked,
      environment: {},
      stdout: sink(),
      stderr,
      dependencies: {
        async createAdapters() {
          composeCalls += 1
          return Object.freeze({})
        },
      },
    }),
    1,
  )
  assert.equal(composeCalls, 0)
  assert.equal(stderr.value, "Duplicate-draft inspection failed.\n")
})

test("CLI rejects unsafe injected dependency descriptors as invocation errors", async () => {
  const dependencies = {}
  Object.defineProperty(dependencies, "inspect", {
    enumerable: true,
    get() {
      throw new Error("token from accessor")
    },
  })
  const stderr = sink()
  assert.equal(
    await runDuplicateDraftConsolidationCli({
      argv: COMMAND,
      cwd: "/repo",
      environment: {},
      stdout: sink(),
      stderr,
      dependencies,
    }),
    2,
  )
  assert.equal(stderr.value, "Invalid duplicate-draft consolidation invocation.\n")
  assert.doesNotMatch(stderr.value, /token|accessor/iu)
})

test("CLI never invokes an accessor-backed stderr method while reporting invocation failure", async () => {
  const unsafeStderr = {}
  let accessorCalls = 0
  Object.defineProperty(unsafeStderr, "write", {
    get() {
      accessorCalls += 1
      throw new Error("ghp_secret accessor body")
    },
  })
  const processStderr = sink()
  const originalWrite = process.stderr.write
  process.stderr.write = processStderr.write
  try {
    assert.equal(
      await runDuplicateDraftConsolidationCli({
        argv: [],
        cwd: "/repo",
        environment: {},
        stdout: sink(),
        stderr: unsafeStderr,
      }),
      2,
    )
  } finally {
    process.stderr.write = originalWrite
  }
  assert.equal(accessorCalls, 0)
  assert.equal(processStderr.value, "Invalid duplicate-draft consolidation invocation.\n")
})

test("importing the CLI has no executable side effects", async () => {
  const stdout = sink()
  const original = process.stdout.write
  process.stdout.write = stdout.write
  try {
    await import(`../duplicate-draft-consolidation-cli.mjs?side-effect=${Date.now()}`)
  } finally {
    process.stdout.write = original
  }
  assert.equal(stdout.value, "")
})

function sink() {
  const output = {
    value: "",
    write(chunk) {
      output.value += String(chunk)
      return true
    },
  }
  return output
}

function throwingSink(message) {
  return {
    write() {
      throw new Error(message)
    },
  }
}

function rejectingSink(message) {
  return {
    write() {
      return Promise.reject(new Error(message))
    },
  }
}

function successfulDependencies() {
  return {
    async createAdapters() {
      return Object.freeze({})
    },
    async inspect(input) {
      return Object.freeze({
        proposalSha256: "a".repeat(64),
        version: input.version,
        commitSha: input.commitSha,
        survivor: input.survivor,
        duplicates: Object.freeze([...input.duplicates]),
        output: input.output,
      })
    },
  }
}

function failingWritable(message) {
  return new Writable({
    write(_chunk, _encoding, callback) {
      setImmediate(() => callback(new Error(message)))
    },
  })
}

function immediate() {
  return new Promise((resolve) => setImmediate(resolve))
}
