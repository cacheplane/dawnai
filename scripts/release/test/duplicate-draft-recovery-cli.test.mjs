import assert from "node:assert/strict"
import { execFile as execFileCallback } from "node:child_process"
import { EventEmitter } from "node:events"
import { constants as fsConstants } from "node:fs"
import * as fileSystem from "node:fs/promises"
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
import * as recoveryCliModule from "../recover-v0.8.22-duplicate-drafts.mjs"
import {
  parseDuplicateDraftRecoveryCliArguments,
  readCandidateControllerMarker,
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
    argv: ["capture", "--reviewed-commit", reviewedCommit(root), "--output", CAPTURE_PATH],
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
    ["capture", reviewedCommit(root), "reader"],
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
  const parsedEvidence = Object.freeze({
    schemaVersion: 1,
    reviewedAuthority: Object.freeze({ mergeCommitSha: reviewedCommit(root) }),
  })
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
    argv: ["capture", "--reviewed-commit", reviewedCommit(root), "--output", CAPTURE_PATH],
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
      parseDuplicateDraftEvidence: () =>
        Object.freeze({
          reviewedAuthority: Object.freeze({ mergeCommitSha: reviewedCommit(root) }),
        }),
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

test("scrubs credentials and inherited Git controls from every Git child", async (t) => {
  const root = await createPrivateRepository(t)
  const environments = []
  const runGit = async (command, args, options) => {
    environments.push(structuredClone(options.env))
    const result = await execFile(command, args, options)
    return result.stdout
  }
  const result = await runDuplicateDraftRecoveryCli({
    argv: ["capture", "--reviewed-commit", reviewedCommit(root), "--output", CAPTURE_PATH],
    cwd: root,
    environment: {
      GITHUB_TOKEN: "never-in-git",
      GIT_DIR: "/tmp/hostile",
      GIT_WORK_TREE: "/tmp/hostile-tree",
      GIT_CONFIG_GLOBAL: "/tmp/hostile-config",
      GIT_OBJECT_DIRECTORY: "/tmp/hostile-objects",
      GIT_ALTERNATE_OBJECT_DIRECTORIES: "/tmp/hostile-alternates",
    },
    stdout: sink(),
    stderr: sink(),
    dependencies: {
      randomUUID: () => UUID,
      runGit,
      createDuplicateDraftRecoveryReader({ root: readerRoot, token, run }) {
        assert.equal(readerRoot, root)
        assert.equal(token, "never-in-git")
        return Object.freeze({ run })
      },
      async captureDuplicateDraftRecoveryEvidence({ reader }) {
        await reader.run("git", ["rev-parse", "--show-toplevel"], { cwd: root })
        return Object.freeze({})
      },
      canonicalDuplicateDraftEvidence: () => Buffer.from("{}\n"),
    },
  })
  assert.equal(result, 0)
  assert.ok(environments.length >= 4)
  for (const environment of environments) {
    assert.equal(environment.GITHUB_TOKEN, undefined)
    assert.deepEqual(
      Object.keys(environment).filter((name) => name.startsWith("GIT_")),
      [],
    )
    assert.equal(typeof environment.PATH, "string")
    assert.equal(environment.LC_ALL, "C")
  }
})

test("global or info excludes cannot substitute for the reviewed repository gitignore rule", async (t) => {
  const root = await createPrivateRepository(t, { ignored: false })
  const globalIgnore = path.join(root, "global-ignore")
  await writeFile(globalIgnore, ".dawn/\n")
  await execFile("git", ["-C", root, "config", "core.excludesFile", globalIgnore])
  await writeFile(path.join(root, ".git/info/exclude"), ".dawn/\n")
  let constructed = false
  const result = await runDuplicateDraftRecoveryCli({
    argv: ["capture", "--reviewed-commit", reviewedCommit(root), "--output", CAPTURE_PATH],
    cwd: root,
    environment: { GITHUB_TOKEN: "secret" },
    stdout: sink(),
    stderr: sink(),
    dependencies: {
      createDuplicateDraftRecoveryReader() {
        constructed = true
      },
    },
  })
  assert.equal(result, 1)
  assert.equal(constructed, false)
})

test("preflights directory fsync before apply mutation and rolls back a published target on later failure", async (t) => {
  for (const { fault, expectedMutations } of [
    { fault: { failSyncAt: 1 }, expectedMutations: 0 },
    { fault: { failSyncAt: 2 }, expectedMutations: 1 },
    { fault: { failLink: true }, expectedMutations: 1 },
    { fault: { failLinkAfterPublication: true }, expectedMutations: 1 },
    { fault: { failSyncAt: 3 }, expectedMutations: 1 },
    { fault: { failTempUnlinkOnce: true }, expectedMutations: 1 },
    { fault: { failSyncAt: 4 }, expectedMutations: 1 },
  ]) {
    const root = await createPrivateRepository(t)
    await writePrivateEvidence(root, Buffer.from("{}\n"))
    let mutations = 0
    const result = await successfulApply(root, {
      fileSystem: faultingFileSystem(fault),
      onApply: () => {
        mutations += 1
      },
    })
    assert.equal(result.code, 1)
    assert.equal(mutations, expectedMutations)
    await assert.rejects(lstat(path.join(root, APPLY_PATH)), { code: "ENOENT" })
    assert.deepEqual(await temporaryFiles(root), [])
  }
})

test("preflights directory fsync before capture credential or reader construction", async (t) => {
  const root = await createPrivateRepository(t)
  let credentialRead = false
  let readerConstructed = false
  const environment = new Proxy(
    { GITHUB_TOKEN: "secret" },
    {
      getOwnPropertyDescriptor(target, property) {
        if (property === "GITHUB_TOKEN") credentialRead = true
        return Reflect.getOwnPropertyDescriptor(target, property)
      },
    },
  )
  const result = await runDuplicateDraftRecoveryCli({
    argv: ["capture", "--reviewed-commit", reviewedCommit(root), "--output", CAPTURE_PATH],
    cwd: root,
    environment,
    stdout: sink(),
    stderr: sink(),
    dependencies: {
      fileSystem: faultingFileSystem({ failSyncAt: 1 }),
      randomUUID: () => UUID,
      createDuplicateDraftRecoveryReader() {
        readerConstructed = true
      },
    },
  })
  assert.equal(result, 1)
  assert.equal(credentialRead, false)
  assert.equal(readerConstructed, false)
})

test("classifies reservation setup cleanup after an ambiguously created temporary file", async (t) => {
  for (const { fault, expectedCode, expectedTemporaryFiles } of [
    {
      fault: { failTempOpenAfterCreate: true, failTempUnlinkOnce: true },
      expectedCode: 1,
      expectedTemporaryFiles: 0,
    },
    {
      fault: { failTempOpenAfterCreate: true, failTempUnlink: true },
      expectedCode: 3,
      expectedTemporaryFiles: 1,
    },
  ]) {
    const root = await createPrivateRepository(t)
    const stderr = sink()
    const result = await runDuplicateDraftRecoveryCli({
      argv: ["capture", "--reviewed-commit", reviewedCommit(root), "--output", CAPTURE_PATH],
      cwd: root,
      environment: { GITHUB_TOKEN: "secret" },
      stdout: sink(),
      stderr,
      dependencies: {
        fileSystem: faultingFileSystem(fault),
        randomUUID: () => UUID,
      },
    })
    assert.equal(result, expectedCode)
    assert.equal(
      stderr.text,
      expectedCode === 3
        ? "Duplicate draft recovery output cleanup uncertain.\n"
        : "Duplicate draft recovery failed.\n",
    )
    assert.equal((await temporaryFiles(root)).length, expectedTemporaryFiles)
    await assert.rejects(lstat(path.join(root, CAPTURE_PATH)), { code: "ENOENT" })
  }
})

test("never removes a preexisting randomized temporary-path collision", async (t) => {
  const root = await createPrivateRepository(t)
  const temporary = path.join(
    root,
    ".dawn/release-recovery/.v0.8.22-capture-01.json.12345678-1234-1234-9234-123456789abc.tmp",
  )
  await writeFile(temporary, Buffer.alloc(0), { flag: "wx", mode: 0o600 })
  const stderr = sink()
  const result = await runDuplicateDraftRecoveryCli({
    argv: ["capture", "--reviewed-commit", reviewedCommit(root), "--output", CAPTURE_PATH],
    cwd: root,
    environment: { GITHUB_TOKEN: "secret" },
    stdout: sink(),
    stderr,
    dependencies: { randomUUID: () => UUID },
  })
  assert.equal(result, 3)
  assert.equal(stderr.text, "Duplicate draft recovery output cleanup uncertain.\n")
  assert.equal((await lstat(temporary)).isFile(), true)
})

test("retries directory close independently without misclassifying clean output state", async (t) => {
  for (const phase of ["setup", "abort"]) {
    for (const failDirectoryCloseTimes of [1, 99]) {
      const root = await createPrivateRepository(t)
      await writePrivateEvidence(root, Buffer.from("{}\n"))
      let directoryCloseCalls = 0
      const result = await successfulApply(root, {
        fileSystem: faultingFileSystem({
          failSyncAt: phase === "setup" ? 1 : 2,
          failDirectoryCloseTimes,
          onDirectoryClose: () => {
            directoryCloseCalls += 1
          },
        }),
      })
      assert.equal(result.code, 1)
      assert.equal(result.stderr, "Duplicate draft recovery failed.\n")
      assert.equal(directoryCloseCalls, 2)
      await assert.rejects(lstat(path.join(root, APPLY_PATH)), { code: "ENOENT" })
      assert.deepEqual(await temporaryFiles(root), [])
    }
  }
})

test("reports a distinct terminal state if output rollback cannot restore a clean directory", async (t) => {
  const root = await createPrivateRepository(t)
  await writePrivateEvidence(root, Buffer.from("{}\n"))
  const result = await successfulApply(root, {
    fileSystem: faultingFileSystem({
      failSyncAt: 3,
      failTargetUnlink: path.join(root, APPLY_PATH),
    }),
  })
  assert.equal(result.code, 3)
  assert.equal(result.stderr, "Duplicate draft recovery output cleanup uncertain.\n")
  assert.equal((await lstat(path.join(root, APPLY_PATH))).isFile(), true)
})

test("a broken stdout never changes durable success into failure", async (t) => {
  for (const stdout of [
    {
      write: () => {
        throw Object.assign(new Error("broken pipe"), { code: "EPIPE" })
      },
    },
    Object.assign(new EventEmitter(), {
      write() {
        queueMicrotask(() =>
          this.emit("error", Object.assign(new Error("broken pipe"), { code: "EPIPE" })),
        )
        return false
      },
    }),
  ]) {
    const root = await createPrivateRepository(t)
    await writePrivateEvidence(root, Buffer.from("{}\n"))
    const result = await successfulApply(root, { stdout })
    await new Promise((resolve) => setImmediate(resolve))
    assert.equal(result.code, 0)
    assert.equal((await lstat(path.join(root, APPLY_PATH))).isFile(), true)
  }
})

test("success output listeners are scoped across repeated imported runner calls", async (t) => {
  const root = await createPrivateRepository(t)
  await writePrivateEvidence(root, Buffer.from("{}\n"))
  const stdout = Object.assign(new EventEmitter(), {
    write(_value, callback) {
      queueMicrotask(() => callback?.())
      return true
    },
  })
  for (const output of [APPLY_PATH, ".dawn/release-recovery/v0.8.22-apply-02.json"]) {
    const result = await successfulApply(root, { output, stdout })
    assert.equal(result.code, 0)
    await new Promise((resolve) => setImmediate(resolve))
    assert.equal(stdout.listenerCount("error"), 0)
  }
  assert.throws(() => stdout.emit("error", new Error("unrelated later error")), /unrelated/u)
})

test("uses fixed POSIX Git isolation and fails closed on Windows", () => {
  for (const platform of ["darwin", "linux"]) {
    assert.deepEqual(recoveryCliModule.recoveryGitExecutionPolicy(platform), {
      executable: "/usr/bin/git",
      nullDevice: "/dev/null",
    })
  }
  assert.throws(() => recoveryCliModule.recoveryGitExecutionPolicy("win32"), /unavailable/iu)
})

test("rechecks the reviewed gitignore immediately before publication and rolls back on race", async (t) => {
  const root = await createPrivateRepository(t)
  await writePrivateEvidence(root, Buffer.from("{}\n"))
  let shows = 0
  let mutations = 0
  const runGit = async (command, args, options) => {
    const result = await execFile(command, args, options)
    if (args.includes("show")) {
      shows += 1
      if (shows === 3) await writeFile(path.join(root, ".gitignore"), "elsewhere/\n")
    }
    return result.stdout
  }
  const result = await successfulApply(root, {
    runGit,
    onApply: () => {
      mutations += 1
    },
  })
  assert.equal(result.code, 1)
  assert.equal(mutations, 1)
  await assert.rejects(lstat(path.join(root, APPLY_PATH)), { code: "ENOENT" })
  assert.deepEqual(await temporaryFiles(root), [])
})

test("reads the controller schema only from the immutable candidate commit", async () => {
  const candidate = { commitSha: "d".repeat(40) }
  const source = await readFile("scripts/release/controller-schema.json", "utf8")
  const calls = []
  const marker = await readCandidateControllerMarker({
    candidate,
    git: {
      async showFile(input) {
        calls.push(input)
        return source
      },
    },
  })
  assert.deepEqual(calls, [
    {
      ref: candidate.commitSha,
      path: "scripts/release/controller-schema.json",
    },
  ])
  assert.deepEqual(marker, JSON.parse(source))
})

test("requires owned non-writable directory parents and exact recovery mode 0700", async (t) => {
  for (const [target, mode] of [
    [".dawn", 0o777],
    [".dawn/release-recovery", 0o755],
  ]) {
    const root = await createPrivateRepository(t)
    await chmod(path.join(root, target), mode)
    let constructed = false
    const result = await runDuplicateDraftRecoveryCli({
      argv: ["capture", "--reviewed-commit", reviewedCommit(root), "--output", CAPTURE_PATH],
      cwd: root,
      environment: { GITHUB_TOKEN: "secret" },
      stdout: sink(),
      stderr: sink(),
      dependencies: {
        createDuplicateDraftRecoveryReader() {
          constructed = true
        },
      },
    })
    assert.equal(result, 1)
    assert.equal(constructed, false)
  }
})

test("production recovery observer derives the canonical numeric Release ID from bracketed recovery reads", async () => {
  assert.equal(typeof recoveryCliModule.createProductionRecoveryObserver, "function")
  const calls = []
  const reader = productionObserverReader({ calls })
  const normalResult = {
    state: "CANDIDATE_ESCROWED",
    disposition: "would-transition",
    nextTransition: "publish-npm-packages",
    conflicts: [],
    diagnostics: [],
  }
  const observer = recoveryCliModule.createProductionRecoveryObserver(
    productionObserverInput(reader),
    {
      normalObserver: async (input) => {
        calls.push(["normal", input])
        return normalResult
      },
    },
  )

  assert.deepEqual(
    await observer({
      candidate: {
        version: "0.8.22",
        commitSha: "2a80deece2ff958fe7fde8fddeb4f99bed70a1c8",
      },
    }),
    { ...normalResult, releaseId: 379991871 },
  )
  assert.deepEqual(
    calls.map(([kind]) => kind),
    ["list", "snapshot", "normal", "list", "snapshot"],
  )
})

test("production recovery observer rejects an alternate sole Release ID and a fourth candidate", async () => {
  assert.equal(typeof recoveryCliModule.createProductionRecoveryObserver, "function")
  const alternate = observerCandidate(400000000, {
    tagName: "untagged-alternate",
    marker: observerMarker(),
  })
  for (const inventory of [[alternate], [...observerInventory(), alternate]]) {
    let normalCalls = 0
    const observer = recoveryCliModule.createProductionRecoveryObserver(
      productionObserverInput(productionObserverReader({ inventories: [inventory] })),
      {
        normalObserver: async () => {
          normalCalls += 1
          return {
            state: "CANDIDATE_ESCROWED",
            disposition: "would-transition",
            nextTransition: "publish-npm-packages",
            conflicts: [],
            diagnostics: [],
          }
        },
      },
    )
    await assert.rejects(
      observer({
        candidate: {
          version: "0.8.22",
          commitSha: "2a80deece2ff958fe7fde8fddeb4f99bed70a1c8",
        },
      }),
      /candidate|inventory|Release|identity/iu,
    )
    assert.equal(normalCalls, 0)
  }
})

test("production recovery observer rejects bracket drift around normal classification", async () => {
  assert.equal(typeof recoveryCliModule.createProductionRecoveryObserver, "function")
  const reader = productionObserverReader({
    snapshots: [
      observerCanonicalSnapshot(),
      { ...observerCanonicalSnapshot(), title: "Dawn v0.8.22 changed" },
    ],
  })
  const observer = recoveryCliModule.createProductionRecoveryObserver(
    productionObserverInput(reader),
    {
      normalObserver: async () => ({
        state: "CANDIDATE_ESCROWED",
        disposition: "would-transition",
        nextTransition: "publish-npm-packages",
        conflicts: [],
        diagnostics: [],
      }),
    },
  )

  await assert.rejects(
    observer({
      candidate: {
        version: "0.8.22",
        commitSha: "2a80deece2ff958fe7fde8fddeb4f99bed70a1c8",
      },
    }),
    /drift|Release|identity|exact/iu,
  )
})

async function successfulApply(
  root,
  { fileSystem: injectedFileSystem, onApply, output = APPLY_PATH, runGit, stdout = sink() } = {},
) {
  const stderr = sink()
  const code = await runDuplicateDraftRecoveryCli({
    argv: ["apply", "--evidence", CAPTURE_PATH, ACKNOWLEDGEMENT_FLAG, "--output", output],
    cwd: root,
    environment: { GITHUB_TOKEN: "secret" },
    stdout,
    stderr,
    dependencies: {
      randomUUID: () => UUID,
      ...(injectedFileSystem === undefined ? {} : { fileSystem: injectedFileSystem }),
      ...(runGit === undefined ? {} : { runGit }),
      parseDuplicateDraftEvidence: () =>
        Object.freeze({
          reviewedAuthority: Object.freeze({ mergeCommitSha: reviewedCommit(root) }),
        }),
      createDuplicateDraftRecoveryReader: () => Object.freeze({}),
      createProductionRecoveryObserver: () => async () => ({}),
      createDuplicateDraftRecoveryWriter: () => Object.freeze({}),
      applyDuplicateDraftRecovery: async () => {
        onApply?.()
        return finalReceipt()
      },
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
  await execFile("git", ["-C", root, "add", ".gitignore"])
  await execFile("git", [
    "-C",
    root,
    "-c",
    "user.name=Recovery Test",
    "-c",
    "user.email=recovery@example.invalid",
    "commit",
    "--quiet",
    "-m",
    "fixture",
  ])
  const { stdout } = await execFile("git", ["-C", root, "rev-parse", "HEAD"])
  REVIEWED_COMMITS.set(root, stdout.trim())
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

function productionObserverInput(reader) {
  return {
    root: "/workspace",
    token: "test-token",
    reader,
    environment: {},
    fileSystem: {},
    runGit: async () => "",
  }
}

function observerMarker() {
  return {
    version: "0.8.22",
    commitSha: "2a80deece2ff958fe7fde8fddeb4f99bed70a1c8",
    tag: "v0.8.22",
  }
}

function observerCandidate(
  releaseId,
  { tagName = "untagged-be0ff4bee4ba43b521a9", marker = null } = {},
) {
  return {
    releaseId,
    tagName,
    title: "Dawn v0.8.22",
    draft: true,
    prerelease: false,
    immutable: false,
    targetCommitish: "main",
    marker,
  }
}

function observerInventory() {
  return [
    observerCandidate(379982100, { tagName: "untagged-a13939767dd2419ade01" }),
    observerCandidate(379986168, { tagName: "untagged-20706099efa3c38335a8" }),
    observerCandidate(379991871, { marker: observerMarker() }),
  ]
}

function observerCanonicalSnapshot() {
  return {
    ...observerCandidate(379991871, { marker: observerMarker() }),
    body: "canonical body\n",
    assets: [{ id: 1, name: "base.tgz", sha256: "a".repeat(64), size: 4 }],
  }
}

function productionObserverReader({ calls = [], inventories, snapshots } = {}) {
  let inventoryRead = 0
  let snapshotRead = 0
  const methods = {
    async readReviewedMergeAuthority() {},
    async readRepositoryState() {},
    async readCandidateTag() {},
    async readWorkflowState() {},
    async readImmutableReleases() {},
    async readReleaseRuns() {},
    async readCandidatePublishJobs() {},
    async readNpmAbsence() {},
    async readReleaseSnapshot(releaseId) {
      calls.push(["snapshot", releaseId])
      const snapshot = snapshots?.[snapshotRead] ?? observerCanonicalSnapshot()
      snapshotRead += 1
      return snapshot
    },
    async listCandidateReleases() {
      calls.push(["list"])
      const inventory = inventories?.[inventoryRead] ?? observerInventory()
      inventoryRead += 1
      return inventory
    },
  }
  return Object.freeze(methods)
}

const REVIEWED_COMMITS = new Map()

function reviewedCommit(root) {
  const commit = REVIEWED_COMMITS.get(root)
  assert.match(commit, /^[0-9a-f]{40}$/u)
  return commit
}

function faultingFileSystem({
  failDirectoryCloseTimes = 0,
  failLink,
  failLinkAfterPublication,
  failSyncAt,
  failTargetUnlink,
  failTempOpenAfterCreate,
  failTempUnlink,
  failTempUnlinkOnce,
  onDirectoryClose,
} = {}) {
  let syncCount = 0
  let tempUnlinkFailed = false
  return Object.freeze({
    link: async (...args) => {
      if (failLink) throw Object.assign(new Error("link fault"), { code: "EIO" })
      const result = await fileSystem.link(...args)
      if (failLinkAfterPublication) {
        throw Object.assign(new Error("ambiguous link fault"), { code: "EIO" })
      }
      return result
    },
    lstat: fileSystem.lstat.bind(fileSystem),
    unlink: async (target) => {
      if (target === failTargetUnlink) {
        throw Object.assign(new Error("unlink fault"), { code: "EIO" })
      }
      if (failTempUnlink && target.endsWith(".tmp")) {
        throw Object.assign(new Error("temp unlink fault"), { code: "EIO" })
      }
      if (failTempUnlinkOnce && target.endsWith(".tmp") && !tempUnlinkFailed) {
        tempUnlinkFailed = true
        throw Object.assign(new Error("temp unlink fault"), { code: "EIO" })
      }
      return fileSystem.unlink(target)
    },
    open: async (...args) => {
      const handle = await fileSystem.open(...args)
      const isDirectory = (args[1] & fsConstants.O_DIRECTORY) !== 0
      if (failTempOpenAfterCreate && String(args[0]).endsWith(".tmp")) {
        await handle.close()
        throw Object.assign(new Error("ambiguous temp open fault"), { code: "EIO" })
      }
      let directoryCloseAttempts = 0
      return Object.freeze({
        read: handle.read.bind(handle),
        writeFile: handle.writeFile.bind(handle),
        stat: handle.stat.bind(handle),
        async close() {
          if (isDirectory) {
            directoryCloseAttempts += 1
            onDirectoryClose?.()
            if (directoryCloseAttempts <= failDirectoryCloseTimes) {
              await handle.close()
              throw Object.assign(new Error("directory close fault"), { code: "EIO" })
            }
          }
          return handle.close()
        },
        async sync() {
          syncCount += 1
          if (syncCount === failSyncAt) {
            throw Object.assign(new Error("sync fault"), { code: "EIO" })
          }
          return handle.sync()
        },
      })
    },
  })
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
