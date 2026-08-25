import assert from "node:assert/strict"
import { spawnSync } from "node:child_process"
import { createHash } from "node:crypto"
import { mkdtemp, readFile, rm } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import test from "node:test"
import {
  buildAttestationVerificationArguments,
  extractActionsArtifactZip,
  loadVerifiedReleaseArtifact,
  materializeVerifiedReleaseArtifact,
  parseArtifactStoreArguments,
} from "../artifact-store.mjs"
import { CANONICAL_RELEASE_PACKAGE_ORDER, canonicalManifestBytes } from "../manifest.mjs"
import { canonicalReleaseRecordBytes } from "../release-record.mjs"

const VERSION = "0.8.22"
const SHA = "a".repeat(40)

test("resolves only the exact recorded Actions artifact and verifies metadata, archive, manifest, files, and attestations", async () => {
  const fixture = artifactFixture()

  const artifact = await loadVerifiedReleaseArtifact(fixture.inputs)

  assert.deepEqual(artifact.source, "actions")
  assert.deepEqual(
    artifact.files.map((file) => file.name),
    ["manifest.json", ...fixture.manifest.packageOrder.map((name) => filenameFor(name))],
  )
  assert.deepEqual(fixture.calls, [
    ["metadata", fixture.record.actionsArtifact.id],
    ["download", fixture.record.actionsArtifact.id],
    ["attest", "actions"],
  ])
  assert.ok(Object.isFrozen(artifact))
})

test("rejects wrong service digest, inner manifest corruption, tarball corruption, and missing records", async () => {
  await assert.rejects(
    loadVerifiedReleaseArtifact(artifactFixture({ record: null }).inputs),
    /record/u,
  )
  await assert.rejects(
    loadVerifiedReleaseArtifact(
      artifactFixture({ metadataDigest: `sha256:${"f".repeat(64)}` }).inputs,
    ),
    /service digest/u,
  )
  await assert.rejects(
    loadVerifiedReleaseArtifact(artifactFixture({ corruptManifest: true }).inputs),
    /manifest/u,
  )
  await assert.rejects(
    loadVerifiedReleaseArtifact(artifactFixture({ corruptTarball: true }).inputs),
    /tarball|digest/iu,
  )
})

test("uses valid attested escrow only after exact expired metadata and an explicit download 410", async () => {
  const fixture = artifactFixture({ metadataExpired: true, downloadStatus: "gone" })
  const artifact = await loadVerifiedReleaseArtifact(fixture.inputs)

  assert.equal(artifact.source, "escrow")
  assert.deepEqual(fixture.calls, [
    ["metadata", fixture.record.actionsArtifact.id],
    ["download", fixture.record.actionsArtifact.id],
    ["escrow", fixture.record.tag],
    ["attest", "escrow"],
  ])
})

test("never selects escrow for metadata auth, timeout, 404, malformed, or other failures", async () => {
  for (const result of [
    { status: "ERROR", httpStatus: 401, code: "AUTHORIZATION" },
    { status: "AMBIGUOUS", httpStatus: null, code: "TIMEOUT" },
    { status: "ABSENT", httpStatus: 404, code: "NOT_FOUND" },
    { status: "ERROR", httpStatus: 200, code: "MALFORMED_SCHEMA" },
    { status: "ERROR", httpStatus: 500, code: "SERVER_ERROR" },
    { status: "GONE", httpStatus: 410, code: "OTHER" },
  ]) {
    const fixture = artifactFixture({ actionsResult: result })
    await assert.rejects(loadVerifiedReleaseArtifact(fixture.inputs), /Actions artifact/u)
    assert.ok(fixture.calls.every(([operation]) => operation !== "escrow"))
  }
})

test("never selects escrow for non-retention download failures", async () => {
  for (const result of [
    { status: "ERROR", httpStatus: 401, code: "AUTHORIZATION" },
    { status: "AMBIGUOUS", httpStatus: null, code: "TIMEOUT" },
    { status: "ABSENT", httpStatus: 404, code: "NOT_FOUND" },
    { status: "ERROR", httpStatus: 200, code: "MALFORMED_SCHEMA" },
    { status: "ERROR", httpStatus: 500, code: "SERVER_ERROR" },
    { status: "GONE", httpStatus: 410, code: "OTHER" },
  ]) {
    const fixture = artifactFixture({ downloadResult: result })
    await assert.rejects(loadVerifiedReleaseArtifact(fixture.inputs), /Actions artifact/u)
    assert.ok(fixture.calls.every(([operation]) => operation !== "escrow"))
  }
})

test("rejects retention expiry when escrow is missing, invalid, or unattested", async () => {
  for (const override of [
    {
      downloadStatus: "gone",
      escrowResult: { status: "ABSENT", httpStatus: 404, code: "NOT_FOUND" },
    },
    { downloadStatus: "gone", corruptEscrow: true },
    { downloadStatus: "gone", attested: false },
    { downloadStatus: "gone", corruptEscrowRecord: true },
    { downloadStatus: "gone", missingEscrowBundle: true },
  ]) {
    await assert.rejects(
      loadVerifiedReleaseArtifact(artifactFixture(override).inputs),
      /escrow|attestation|tarball/iu,
    )
  }
})

test("resolves durable artifact state for partial publication resume without a rebuild path", async () => {
  const fixture = artifactFixture()
  const artifact = await loadVerifiedReleaseArtifact(fixture.inputs)
  assert.equal(artifact.source, "actions")
  assert.equal(Object.hasOwn(fixture.inputs, "rebuild"), false)
})

test("trusted ZIP extraction binds the archive bytes to exact basename entries", () => {
  const archive = storedZip([
    { name: "manifest.json", bytes: Buffer.from("manifest") },
    { name: "package.tgz", bytes: Buffer.from("tarball") },
  ])

  assert.deepEqual(extractActionsArtifactZip(archive), [
    { name: "manifest.json", bytes: Buffer.from("manifest") },
    { name: "package.tgz", bytes: Buffer.from("tarball") },
  ])
  assert.throws(
    () => extractActionsArtifactZip(storedZip([{ name: "../escape", bytes: Buffer.from("x") }])),
    /basename|path/u,
  )
})

test("materialization writes only after verification into a fresh destination", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "dawn-artifact-materialize-"))
  t.after(() => rm(root, { recursive: true, force: true }))
  const fixture = artifactFixture()
  const artifact = await loadVerifiedReleaseArtifact(fixture.inputs)
  const outputDir = path.join(root, "output")
  const verifiedManifestBytes = Buffer.from(artifact.files[0].bytes)
  artifact.files[0].bytes[0] ^= 0xff

  await materializeVerifiedReleaseArtifact({ artifact, outputDir })

  assert.deepEqual(await readFile(path.join(outputDir, "manifest.json")), verifiedManifestBytes)
  await assert.rejects(materializeVerifiedReleaseArtifact({ artifact, outputDir }), /fresh|exists/u)
  await assert.rejects(
    materializeVerifiedReleaseArtifact({
      artifact: { source: "actions", files: artifact.files },
      outputDir: path.join(root, "forged"),
    }),
    /verified|provenance/u,
  )
})

test("the executable accepts only the narrow resolve command contract", () => {
  assert.deepEqual(
    parseArtifactStoreArguments([
      "resolve",
      "--record",
      "/tmp/release-record.json",
      "--output-dir",
      "/tmp/materialized",
    ]),
    { command: "resolve", recordPath: "/tmp/release-record.json", outputDir: "/tmp/materialized" },
  )
  for (const args of [
    [],
    ["rebuild"],
    ["resolve", "--record", "record.json"],
    ["resolve", "--record", "a", "--output-dir", "b", "--name", "inferred"],
  ]) {
    assert.throws(() => parseArtifactStoreArguments(args), /usage|resolve|argument/iu)
  }

  const invocation = spawnSync(
    process.execPath,
    [path.resolve(import.meta.dirname, "../artifact-store.mjs")],
    {
      encoding: "utf8",
    },
  )
  assert.equal(invocation.status, 1)
  assert.match(invocation.stderr, /Usage:.*artifact-store\.mjs resolve/u)
})

test("attestation verification binds the signer, tag, commit, repository, predicate, and escrow bundle", () => {
  const record = artifactFixture().record
  const common = [
    "attestation",
    "verify",
    "/tmp/manifest.json",
    "--repo",
    "cacheplane/dawnai",
    "--digest-alg",
    "sha256",
    "--signer-workflow",
    "cacheplane/dawnai/.github/workflows/release.yml",
    "--source-digest",
    SHA,
    "--source-ref",
    `refs/tags/v${VERSION}`,
    "--predicate-type",
    "https://slsa.dev/provenance/v1",
  ]
  assert.deepEqual(
    buildAttestationVerificationArguments({
      source: "actions",
      target: "/tmp/manifest.json",
      repository: "cacheplane/dawnai",
      record,
    }),
    common,
  )
  assert.deepEqual(
    buildAttestationVerificationArguments({
      source: "escrow",
      target: "/tmp/manifest.json",
      repository: "cacheplane/dawnai",
      record,
      bundlePath: "/tmp/manifest.json.intoto.jsonl",
    }),
    [...common, "--bundle", "/tmp/manifest.json.intoto.jsonl"],
  )
})

function artifactFixture(overrides = {}) {
  const manifest = releaseManifest()
  let manifestBytes = canonicalManifestBytes(manifest)
  if (overrides.corruptManifest) manifestBytes = Buffer.from(`${manifestBytes} `)
  const files = [
    { name: "manifest.json", bytes: manifestBytes },
    ...manifest.packages.map((entry, index) => ({
      name: entry.filename,
      bytes:
        overrides.corruptTarball && index === 0
          ? Buffer.from("corrupt")
          : Buffer.from(`packed:${entry.name}`),
    })),
  ]
  const archiveBytes = Buffer.from("exact-actions-archive")
  const serviceDigest = `sha256:${createHash("sha256").update(archiveBytes).digest("hex")}`
  const fixtureRecord = releaseRecord(manifest, serviceDigest)
  const record = overrides.record === null ? null : fixtureRecord
  const calls = []
  const actionsResult = overrides.actionsResult ?? {
    status: "PRESENT",
    value: {
      id: fixtureRecord.actionsArtifact.id,
      name: fixtureRecord.actionsArtifact.name,
      serviceDigest: overrides.metadataDigest ?? serviceDigest,
      expired: overrides.metadataExpired ?? false,
      prepareRunId: fixtureRecord.actionsArtifact.prepareRunId,
      prepareRunAttempt: fixtureRecord.actionsArtifact.prepareRunAttempt,
      headSha: SHA,
    },
  }
  const downloadResult =
    overrides.downloadResult ??
    (overrides.downloadStatus === "gone"
      ? { status: "GONE", httpStatus: 410, code: "RETENTION_EXPIRED" }
      : { status: "PRESENT", archiveBytes })
  const escrowFiles = files.map((file, index) => ({
    name: file.name,
    bytes:
      overrides.corruptEscrow && index === 1 ? Buffer.from("bad escrow") : Buffer.from(file.bytes),
  }))
  const escrowBundles = files.map((file) => ({
    name: `${file.name}.intoto.jsonl`,
    bytes: Buffer.from(`bundle:${file.name}`),
  }))
  return {
    manifest,
    record,
    calls,
    inputs: {
      record,
      actionsReader: {
        async getArtifactMetadata({ artifactId }) {
          calls.push(["metadata", artifactId])
          return actionsResult
        },
        async downloadArtifactById({ artifactId }) {
          calls.push(["download", artifactId])
          return downloadResult
        },
      },
      async extractArchive(bytes) {
        assert.deepEqual(bytes, archiveBytes)
        return files
      },
      releaseReader: {
        async loadEscrow({ tag }) {
          calls.push(["escrow", tag])
          return (
            overrides.escrowResult ?? {
              status: "PRESENT",
              files: escrowFiles,
              releaseRecordBytes: overrides.corruptEscrowRecord
                ? Buffer.from("wrong record")
                : canonicalReleaseRecordBytes(fixtureRecord),
              bundles: overrides.missingEscrowBundle ? escrowBundles.slice(1) : escrowBundles,
            }
          )
        },
      },
      attestations: {
        async verify({ source, subjects, bundles }) {
          calls.push(["attest", source])
          if (source === "escrow") assert.equal(bundles.length, subjects.length)
          return {
            status: overrides.attested === false ? "INVALID" : "VERIFIED",
            subjects: subjects.map(({ name, sha256 }) => ({ name, sha256 })),
          }
        },
      },
    },
  }
}

function releaseManifest() {
  return {
    schemaVersion: 1,
    version: VERSION,
    commitSha: SHA,
    ci: { workflow: "CI", runId: 100, runAttempt: 1 },
    artifact: {
      name: `release-v${VERSION}-${SHA.slice(0, 12)}`,
      prepareRunId: 200,
      prepareRunAttempt: 1,
    },
    packageOrder: [...CANONICAL_RELEASE_PACKAGE_ORDER],
    packages: CANONICAL_RELEASE_PACKAGE_ORDER.map((name) => packageEntry(name)),
  }
}

function packageEntry(name) {
  const bytes = Buffer.from(`packed:${name}`)
  const sha512 = createHash("sha512").update(bytes).digest("hex")
  return {
    name,
    version: VERSION,
    filename: filenameFor(name),
    size: bytes.length,
    sha256: createHash("sha256").update(bytes).digest("hex"),
    sha512,
    npmIntegrity: `sha512-${Buffer.from(sha512, "hex").toString("base64")}`,
    access: "public",
  }
}

function releaseRecord(manifest, serviceDigest) {
  const manifestSha256 = createHash("sha256").update(canonicalManifestBytes(manifest)).digest("hex")
  return JSON.parse(
    canonicalReleaseRecordBytes({
      schemaVersion: 1,
      version: VERSION,
      commitSha: SHA,
      tag: `v${VERSION}`,
      manifestSha256,
      actionsArtifact: {
        id: "12345678901234567890",
        name: `release-v${VERSION}-${SHA.slice(0, 12)}`,
        serviceDigest,
        prepareRunId: "200",
        prepareRunAttempt: 1,
      },
    }),
  )
}

function filenameFor(name) {
  const stem = name.startsWith("@") ? name.slice(1).replaceAll("/", "-") : name
  return `${stem}-${VERSION}.tgz`
}

function storedZip(files) {
  const locals = []
  const centrals = []
  let offset = 0
  for (const file of files) {
    const name = Buffer.from(file.name)
    const bytes = Buffer.from(file.bytes)
    const local = Buffer.alloc(30 + name.length + bytes.length)
    local.writeUInt32LE(0x04034b50, 0)
    local.writeUInt16LE(20, 4)
    local.writeUInt16LE(0, 6)
    local.writeUInt16LE(0, 8)
    local.writeUInt32LE(bytes.length, 18)
    local.writeUInt32LE(bytes.length, 22)
    local.writeUInt16LE(name.length, 26)
    name.copy(local, 30)
    bytes.copy(local, 30 + name.length)
    locals.push(local)

    const central = Buffer.alloc(46 + name.length)
    central.writeUInt32LE(0x02014b50, 0)
    central.writeUInt16LE(20, 4)
    central.writeUInt16LE(20, 6)
    central.writeUInt16LE(0, 8)
    central.writeUInt16LE(0, 10)
    central.writeUInt32LE(bytes.length, 20)
    central.writeUInt32LE(bytes.length, 24)
    central.writeUInt16LE(name.length, 28)
    central.writeUInt32LE(offset, 42)
    name.copy(central, 46)
    centrals.push(central)
    offset += local.length
  }
  const centralOffset = offset
  const centralSize = centrals.reduce((total, entry) => total + entry.length, 0)
  const end = Buffer.alloc(22)
  end.writeUInt32LE(0x06054b50, 0)
  end.writeUInt16LE(files.length, 8)
  end.writeUInt16LE(files.length, 10)
  end.writeUInt32LE(centralSize, 12)
  end.writeUInt32LE(centralOffset, 16)
  return Buffer.concat([...locals, ...centrals, end])
}
