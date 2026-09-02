import assert from "node:assert/strict"
import { execFile as execFileCallback } from "node:child_process"
import {
  chmod,
  link,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  symlink,
  writeFile,
} from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import test from "node:test"
import { promisify } from "node:util"

import {
  parseDuplicateDraftRecoveryCliArguments,
  runDuplicateDraftRecoveryCli,
} from "../recover-v0.8.22-duplicate-drafts.mjs"

const execFile = promisify(execFileCallback)
const REVIEWED_COMMIT = "a".repeat(40)
const CAPTURE_PATH = ".dawn/release-recovery/v0.8.22-capture-01.json"
const APPLY_PATH = ".dawn/release-recovery/v0.8.22-apply-01.json"
const ACKNOWLEDGEMENT_FLAG = "--acknowledge-non-atomic-release-edit-freeze"
const UUID = "12345678-1234-1234-9234-123456789abc"

test("parses only the exact capture and apply invocation grammars", () => {
  const capture = parseDuplicateDraftRecoveryCliArguments([
    "capture",
    "--reviewed-commit",
    REVIEWED_COMMIT,
    "--output",
    CAPTURE_PATH,
  ])
  assert.deepEqual(capture, {
    command: "capture",
    reviewedCommit: REVIEWED_COMMIT,
    output: CAPTURE_PATH,
  })
  assert.ok(Object.isFrozen(capture))

  const apply = parseDuplicateDraftRecoveryCliArguments([
    "apply",
    "--evidence",
    CAPTURE_PATH,
    ACKNOWLEDGEMENT_FLAG,
    "--output",
    APPLY_PATH,
  ])
  assert.deepEqual(apply, {
    command: "apply",
    evidence: CAPTURE_PATH,
    output: APPLY_PATH,
  })
  assert.ok(Object.isFrozen(apply))
})

test("rejects missing, duplicate, unknown, joined, reordered, valued, aliased, and unsafe arguments", () => {
  const rejected = [
    [],
    ["unknown"],
    ["capture", "--reviewed-commit", REVIEWED_COMMIT, "--output"],
    ["capture", "--reviewed-commit", REVIEWED_COMMIT, "--reviewed-commit", REVIEWED_COMMIT],
    ["capture", `--reviewed-commit=${REVIEWED_COMMIT}`, "--output", CAPTURE_PATH],
    ["capture", "--output", CAPTURE_PATH, "--reviewed-commit", REVIEWED_COMMIT],
    ["capture", "--reviewed-commit", REVIEWED_COMMIT.toUpperCase(), "--output", CAPTURE_PATH],
    ["capture", "--reviewed-commit", "a".repeat(39), "--output", CAPTURE_PATH],
    ["capture", "--reviewed-commit", REVIEWED_COMMIT, "--unknown", CAPTURE_PATH],
    ["apply", "--evidence", CAPTURE_PATH, "--output", APPLY_PATH],
    ["apply", "--evidence", CAPTURE_PATH, ACKNOWLEDGEMENT_FLAG, "true", "--output", APPLY_PATH],
    ["apply", "--evidence", CAPTURE_PATH, `${ACKNOWLEDGEMENT_FLAG}=true`, "--output", APPLY_PATH],
    ["apply", "--evidence", CAPTURE_PATH, "--acknowledge-edit-freeze", "--output", APPLY_PATH],
    ["apply", ACKNOWLEDGEMENT_FLAG, "--evidence", CAPTURE_PATH, "--output", APPLY_PATH],
    ["apply", "--evidence", CAPTURE_PATH, ACKNOWLEDGEMENT_FLAG, "--evidence", CAPTURE_PATH],
    ["apply", "--evidence", CAPTURE_PATH, ACKNOWLEDGEMENT_FLAG, "--output", CAPTURE_PATH],
    ["capture", "--reviewed-commit", REVIEWED_COMMIT, "--output", `${CAPTURE_PATH}\n`],
    ["capture", "--reviewed-commit", REVIEWED_COMMIT, "--output", `${CAPTURE_PATH}\0x`],
  ]
  for (const argv of rejected) {
    assert.throws(() => parseDuplicateDraftRecoveryCliArguments(argv), /invalid|requires/iu)
  }

  const accessor = ["capture", "--reviewed-commit", REVIEWED_COMMIT, "--output", CAPTURE_PATH]
  Object.defineProperty(accessor, 4, {
    enumerable: true,
    get: () => CAPTURE_PATH,
  })
  assert.throws(() => parseDuplicateDraftRecoveryCliArguments(accessor), /invalid/iu)
})

test("rejects every path outside the exact private recovery descendant", () => {
  const rejected = [
    ".dawn/release-recovery",
    ".dawn/release-recovery/",
    ".dawn/elsewhere/evidence.json",
    "nested/.dawn/release-recovery/evidence.json",
    ".dawn/release-recovery/../evidence.json",
    ".dawn/release-recovery/./evidence.json",
    "./.dawn/release-recovery/evidence.json",
    "/tmp/evidence.json",
    "../.dawn/release-recovery/evidence.json",
    ".dawn//release-recovery/evidence.json",
  ]
  for (const output of rejected) {
    assert.throws(
      () =>
        parseDuplicateDraftRecoveryCliArguments([
          "capture",
          "--reviewed-commit",
          REVIEWED_COMMIT,
          "--output",
          output,
        ]),
      /path|invalid/iu,
    )
  }
})

test("capture constructs production dependencies only after validation and durably writes canonical evidence", async (t) => {
  const root = await createPrivateRepository(t)
  const calls = []
  const stdout = sink()
  const stderr = sink()
  const evidence = Object.freeze({ schemaVersion: 1, capturedAt: "now" })
  const canonicalBytes = Buffer.from('{"capturedAt":"now","schemaVersion":1}\n', "utf8")
  const result = await runDuplicateDraftRecoveryCli({
    argv: ["capture", "--reviewed-commit", REVIEWED_COMMIT, "--output", CAPTURE_PATH],
    cwd: root,
    environment: { GITHUB_TOKEN: "capture-token" },
    stdout,
    stderr,
    dependencies: {
      randomUUID: () => UUID,
      createDuplicateDraftRecoveryReader(input) {
        calls.push(["reader", input.root, input.token])
        return Object.freeze({ kind: "reader" })
      },
      async captureDuplicateDraftRecoveryEvidence(input) {
        calls.push(["capture", input.reviewedCommit, input.reader.kind])
        return evidence
      },
      canonicalDuplicateDraftEvidence(value) {
        calls.push(["canonical", value])
        return canonicalBytes
      },
    },
  })

  assert.equal(result, 0)
  assert.equal(stdout.text, "Duplicate draft recovery evidence captured.\n")
  assert.equal(stderr.text, "")
  assert.deepEqual(calls, [
    ["reader", root, "capture-token"],
    ["capture", REVIEWED_COMMIT, "reader"],
    ["canonical", evidence],
  ])
  const output = path.join(root, CAPTURE_PATH)
  assert.deepEqual(await readFile(output), canonicalBytes)
  assert.equal((await lstat(output)).mode & 0o777, 0o600)
  assert.deepEqual(await temporaryFiles(root), [])
})

test("apply parses canonical evidence before constructing dependencies and passes the exact frozen acknowledgement", async (t) => {
  const root = await createPrivateRepository(t)
  const evidenceBytes = Buffer.from('{"schemaVersion":1}\n', "utf8")
  await writePrivateEvidence(root, evidenceBytes)
  const parsedEvidence = Object.freeze({ schemaVersion: 1 })
  const receipt = finalReceipt()
  const events = []
  const stdout = sink()
  const stderr = sink()
  const result = await runDuplicateDraftRecoveryCli({
    argv: ["apply", "--evidence", CAPTURE_PATH, ACKNOWLEDGEMENT_FLAG, "--output", APPLY_PATH],
    cwd: root,
    environment: { GITHUB_TOKEN: "apply-token" },
    stdout,
    stderr,
    dependencies: {
      randomUUID: () => UUID,
      parseDuplicateDraftEvidence(bytes) {
        events.push(["parse", Buffer.from(bytes).toString("utf8")])
        return parsedEvidence
      },
      createDuplicateDraftRecoveryReader(input) {
        events.push(["reader", input.token])
        return Object.freeze({ kind: "reader" })
      },
      createProductionRecoveryObserver(input) {
        events.push(["observer", input.token, input.reader.kind])
        return async () => ({})
      },
      createDuplicateDraftRecoveryWriter(input) {
        events.push(["writer", input.token])
        return Object.freeze({ kind: "writer" })
      },
      async applyDuplicateDraftRecovery(input) {
        events.push(["apply", input.evidence])
        assert.deepEqual(input.concurrencyAcknowledgement, {
          acknowledged: true,
          atomic: false,
          mode: "operator-freeze-compare-before-write-v1",
          releaseIds: [379982100, 379986168],
        })
        assert.ok(Object.isFrozen(input.concurrencyAcknowledgement))
        assert.ok(Object.isFrozen(input.concurrencyAcknowledgement.releaseIds))
        assert.deepEqual(await input.createWriter(), { kind: "writer" })
        return receipt
      },
    },
  })

  assert.equal(result, 0)
  assert.equal(stdout.text, "Duplicate draft recovery authorization recorded.\n")
  assert.equal(stderr.text, "")
  assert.deepEqual(events, [
    ["parse", evidenceBytes.toString("utf8")],
    ["reader", "apply-token"],
    ["observer", "apply-token", "reader"],
    ["apply", parsedEvidence],
    ["writer", "apply-token"],
  ])
  assert.equal(
    await readFile(path.join(root, APPLY_PATH), "utf8"),
    `${JSON.stringify(canonicalize(receipt))}\n`,
  )
  assert.deepEqual(await temporaryFiles(root), [])
})

test("invalid paths and malformed evidence fail before token access or dependency construction", async (t) => {
  const root = await createPrivateRepository(t)
  await writePrivateEvidence(root, Buffer.from("not canonical", "utf8"))
  let tokenReads = 0
  const environment = {}
  Object.defineProperty(environment, "GITHUB_TOKEN", {
    enumerable: true,
    get() {
      tokenReads += 1
      return "secret"
    },
  })
  let constructions = 0
  const dependencies = {
    parseDuplicateDraftEvidence() {
      throw new Error("malformed canonical evidence")
    },
    createDuplicateDraftRecoveryReader() {
      constructions += 1
    },
  }
  const malformed = await runDuplicateDraftRecoveryCli({
    argv: ["apply", "--evidence", CAPTURE_PATH, ACKNOWLEDGEMENT_FLAG, "--output", APPLY_PATH],
    cwd: root,
    environment,
    stdout: sink(),
    stderr: sink(),
    dependencies,
  })
  assert.equal(malformed, 1)
  assert.equal(tokenReads, 0)
  assert.equal(constructions, 0)

  const invalid = await runDuplicateDraftRecoveryCli({
    argv: ["capture", "--reviewed-commit", REVIEWED_COMMIT, "--output", "outside.json"],
    cwd: root,
    environment,
    stdout: sink(),
    stderr: sink(),
    dependencies,
  })
  assert.equal(invalid, 2)
  assert.equal(tokenReads, 0)
  assert.equal(constructions, 0)
})

test("rejects a recovery boundary or target that is not gitignored", async (t) => {
  const root = await createPrivateRepository(t, { ignored: false })
  let constructions = 0
  const stderr = sink()
  const result = await runDuplicateDraftRecoveryCli({
    argv: ["capture", "--reviewed-commit", REVIEWED_COMMIT, "--output", CAPTURE_PATH],
    cwd: root,
    environment: { GITHUB_TOKEN: "secret" },
    stdout: sink(),
    stderr,
    dependencies: {
      createDuplicateDraftRecoveryReader() {
        constructions += 1
      },
    },
  })
  assert.equal(result, 1)
  assert.equal(constructions, 0)
  assert.equal(stderr.text, "Duplicate draft recovery failed.\n")
})

test("bounded private evidence reads reject symlinks, hardlinks, unsafe modes, empty files, oversized files, and invalid UTF-8", async (t) => {
  const cases = [
    async (root) => symlink("real.json", path.join(root, CAPTURE_PATH)),
    async (root) => {
      const source = path.join(root, ".dawn/release-recovery/real.json")
      await writeFile(source, "{}\n", { mode: 0o600 })
      await link(source, path.join(root, CAPTURE_PATH))
    },
    async (root) =>
      writeFile(path.join(root, CAPTURE_PATH), Buffer.alloc(0), {
        mode: 0o600,
      }),
    async (root) => writeFile(path.join(root, CAPTURE_PATH), "{}\n", { mode: 0o644 }),
    async (root) =>
      writeFile(path.join(root, CAPTURE_PATH), Buffer.alloc(512 * 1024 + 1, 0x61), {
        mode: 0o600,
      }),
    async (root) =>
      writeFile(path.join(root, CAPTURE_PATH), Buffer.from([0xc3, 0x28]), {
        mode: 0o600,
      }),
  ]
  for (const [index, arrange] of cases.entries()) {
    const root = await createPrivateRepository(t)
    await arrange(root)
    let parsed = false
    const result = await runDuplicateDraftRecoveryCli({
      argv: ["apply", "--evidence", CAPTURE_PATH, ACKNOWLEDGEMENT_FLAG, "--output", APPLY_PATH],
      cwd: root,
      environment: { GITHUB_TOKEN: "secret" },
      stdout: sink(),
      stderr: sink(),
      dependencies: {
        parseDuplicateDraftEvidence() {
          parsed = true
          return {}
        },
      },
    })
    assert.equal(result, 1)
    assert.equal(parsed, false, `case ${index} reached the canonical parser`)
  }
})

test("write-once output refuses regular, symlink, and hardlink conflicts without overwriting or leaving a temp", async (t) => {
  const arrangers = [
    async (root) => writeFile(path.join(root, APPLY_PATH), "existing", { mode: 0o600 }),
    async (root) => symlink("existing.json", path.join(root, APPLY_PATH)),
    async (root) => {
      const source = path.join(root, ".dawn/release-recovery/existing.json")
      await writeFile(source, "existing", { mode: 0o600 })
      await link(source, path.join(root, APPLY_PATH))
    },
  ]
  for (const arrange of arrangers) {
    const root = await createPrivateRepository(t)
    await writePrivateEvidence(root, Buffer.from("{}\n", "utf8"))
    await arrange(root)
    const before = await lstat(path.join(root, APPLY_PATH))
    const result = await successfulApply(root)
    assert.equal(result.code, 1)
    const after = await lstat(path.join(root, APPLY_PATH))
    assert.equal(after.ino, before.ino)
    assert.deepEqual(await temporaryFiles(root), [])
  }
})

test("sanitizes all failures and never prints credentials, remote bodies, signed URLs, or stacks", async (t) => {
  const root = await createPrivateRepository(t)
  await writePrivateEvidence(root, Buffer.from("{}\n", "utf8"))
  const stdout = sink()
  const stderr = sink()
  const token = "ghp_super-secret"
  const result = await runDuplicateDraftRecoveryCli({
    argv: ["apply", "--evidence", CAPTURE_PATH, ACKNOWLEDGEMENT_FLAG, "--output", APPLY_PATH],
    cwd: root,
    environment: { GITHUB_TOKEN: token },
    stdout,
    stderr,
    dependencies: {
      parseDuplicateDraftEvidence() {
        throw new Error(
          `${token} remote-body https://objects.githubusercontent.com/file?sig=secret\n    at unsafe`,
        )
      },
    },
  })
  assert.equal(result, 1)
  assert.equal(stdout.text, "")
  assert.equal(stderr.text, "Duplicate draft recovery failed.\n")
  assert.doesNotMatch(stderr.text, /secret|remote-body|https:|\bat\b/iu)
})

test("refuses to serialize a malformed core receipt or invent missing fence history", async (t) => {
  const root = await createPrivateRepository(t)
  await writePrivateEvidence(root, Buffer.from("{}\n", "utf8"))
  const stdout = sink()
  const stderr = sink()
  const code = await runDuplicateDraftRecoveryCli({
    argv: ["apply", "--evidence", CAPTURE_PATH, ACKNOWLEDGEMENT_FLAG, "--output", APPLY_PATH],
    cwd: root,
    environment: { GITHUB_TOKEN: "secret" },
    stdout,
    stderr,
    dependencies: {
      randomUUID: () => UUID,
      parseDuplicateDraftEvidence: () => Object.freeze({}),
      createDuplicateDraftRecoveryReader: () => Object.freeze({}),
      createProductionRecoveryObserver: () => async () => ({}),
      createDuplicateDraftRecoveryWriter: () => Object.freeze({}),
      applyDuplicateDraftRecovery: async () =>
        deepFreeze({
          ...structuredClone(finalReceipt()),
          duplicates: [
            {
              releaseId: 379982100,
              outcome: "preexisting-quarantined",
              priorFenceObservations: { invented: true },
              verifiedAt: "2026-09-01T00:02:00.000Z",
              projectionSha256: "c".repeat(64),
            },
            structuredClone(finalReceipt().duplicates[1]),
          ],
        }),
    },
  })
  assert.equal(code, 1)
  assert.equal(stdout.text, "")
  assert.equal(stderr.text, "Duplicate draft recovery failed.\n")
  await assert.rejects(lstat(path.join(root, APPLY_PATH)), { code: "ENOENT" })
  assert.deepEqual(await temporaryFiles(root), [])
})

async function successfulApply(root) {
  const stdout = sink()
  const stderr = sink()
  const code = await runDuplicateDraftRecoveryCli({
    argv: ["apply", "--evidence", CAPTURE_PATH, ACKNOWLEDGEMENT_FLAG, "--output", APPLY_PATH],
    cwd: root,
    environment: { GITHUB_TOKEN: "secret" },
    stdout,
    stderr,
    dependencies: {
      randomUUID: () => UUID,
      parseDuplicateDraftEvidence: () => Object.freeze({}),
      createDuplicateDraftRecoveryReader: () => Object.freeze({}),
      createProductionRecoveryObserver: () => async () => ({}),
      createDuplicateDraftRecoveryWriter: () => Object.freeze({}),
      applyDuplicateDraftRecovery: async () => finalReceipt(),
    },
  })
  return { code, stdout: stdout.text, stderr: stderr.text }
}

async function createPrivateRepository(t, { ignored = true } = {}) {
  const created = await mkdtemp(path.join(os.tmpdir(), "dawn-recovery-cli-"))
  const root = await realpath(created)
  t.after(async () => {
    const { rm } = await import("node:fs/promises")
    await rm(root, { recursive: true, force: true })
  })
  await execFile("git", ["init", "--quiet", root])
  await writeFile(path.join(root, ".gitignore"), ignored ? ".dawn/\n" : "elsewhere/\n")
  await mkdir(path.join(root, ".dawn/release-recovery"), {
    recursive: true,
    mode: 0o700,
  })
  return root
}

async function writePrivateEvidence(root, bytes) {
  const target = path.join(root, CAPTURE_PATH)
  await writeFile(target, bytes, { flag: "wx", mode: 0o600 })
  await chmod(target, 0o600)
}

async function temporaryFiles(root) {
  const { readdir } = await import("node:fs/promises")
  return (await readdir(path.join(root, ".dawn/release-recovery"))).filter((name) =>
    name.endsWith(".tmp"),
  )
}

function sink() {
  return {
    text: "",
    write(value) {
      this.text += value
      return true
    },
  }
}

function finalReceipt() {
  return deepFreeze({
    schemaVersion: 1,
    atomic: false,
    concurrencyAcknowledgement: {
      acknowledged: true,
      atomic: false,
      mode: "operator-freeze-compare-before-write-v1",
      releaseIds: [379982100, 379986168],
    },
    freezeScope: {
      mode: "operator-freeze-compare-before-write-v1",
      releaseIds: [379982100, 379986168],
    },
    evidenceCapturedAt: "2026-09-01T00:00:00.000Z",
    appliedAt: "2026-09-01T00:03:00.000Z",
    candidate: {
      version: "0.8.22",
      commitSha: "2a80deece2ff958fe7fde8fddeb4f99bed70a1c8",
      releaseId: 379991871,
    },
    duplicates: [
      {
        releaseId: 379982100,
        outcome: "performed",
        preWriteFence: {
          observedAt: "2026-09-01T00:01:00.000Z",
          projectionSha256: "a".repeat(64),
          tagObjectSha: "b".repeat(40),
        },
        postWriteFence: {
          observedAt: "2026-09-01T00:01:01.000Z",
          projectionSha256: "b".repeat(64),
          tagObjectSha: "b".repeat(40),
        },
      },
      {
        releaseId: 379986168,
        outcome: "preexisting-quarantined",
        priorFenceObservations: null,
        verifiedAt: "2026-09-01T00:02:00.000Z",
        projectionSha256: "c".repeat(64),
      },
    ],
    finalAuthorization: {
      state: "CANDIDATE_ESCROWED",
      disposition: "would-transition",
      nextTransition: "publish-npm-packages",
      conflicts: [],
      diagnostics: [],
      releaseId: 379991871,
    },
  })
}

function deepFreeze(value) {
  if (value !== null && typeof value === "object" && !Object.isFrozen(value)) {
    for (const child of Object.values(value)) deepFreeze(child)
    Object.freeze(value)
  }
  return value
}

function canonicalize(value) {
  if (Array.isArray(value)) return value.map(canonicalize)
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .map((key) => [key, canonicalize(value[key])]),
    )
  }
  return value
}
