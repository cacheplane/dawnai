import assert from "node:assert/strict"
import { spawnSync } from "node:child_process"
import { createHash } from "node:crypto"
import { mkdtemp, readFile, rm } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import test from "node:test"
import {
  ARTIFACT_STORE_SPARSE_FILES,
  buildAttestationVerificationArguments,
  createArtifactStoreGitHubRuntime,
  createCliAttestationVerifier,
  extractActionsArtifactZip,
  loadVerifiedReleaseArtifact,
  materializeVerifiedReleaseArtifact,
  parseArtifactStoreArguments,
  runArtifactStoreCli,
} from "../artifact-store.mjs"
import { RELEASE_PAYLOAD_LIMITS } from "../limits.mjs"
import { CANONICAL_RELEASE_PACKAGE_ORDER, canonicalManifestBytes } from "../manifest.mjs"
import { canonicalReleaseBody } from "../metadata.mjs"
import { canonicalReleaseRecordBytes } from "../release-record.mjs"
import { observationForMarker } from "./support/marker-observation.mjs"

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

test("production recovery binds the recorded immutable run attempt even after a later rerun", async () => {
  const fixture = artifactFixture()
  const readerCalls = []
  const runtime = createArtifactStoreGitHubRuntime({
    metadataReader: {
      async getActionsArtifact({ artifactId }) {
        readerCalls.push(["artifact", artifactId])
        return {
          status: "PRESENT",
          value: {
            id: artifactId,
            name: fixture.record.actionsArtifact.name,
            digest: fixture.record.actionsArtifact.serviceDigest,
            expired: true,
            workflow_run: {
              id: Number(fixture.record.actionsArtifact.prepareRunId),
              head_sha: SHA,
            },
          },
        }
      },
      async getActionsRun({ runId }) {
        readerCalls.push(["latest-run", runId])
        return {
          status: "PRESENT",
          value: { id: Number(runId), run_attempt: 9, head_sha: SHA },
        }
      },
      async getActionsRunAttempt({ runId, attempt }) {
        readerCalls.push(["run-attempt", runId, attempt])
        return {
          status: "PRESENT",
          value: { id: Number(runId), run_attempt: attempt, head_sha: SHA },
        }
      },
    },
    binaryReader: {
      async downloadActionsArtifact({ artifactId }) {
        readerCalls.push(["download", artifactId])
        return { status: "GONE", httpStatus: 410, code: "HTTP_410" }
      },
    },
  })

  const artifact = await loadVerifiedReleaseArtifact({
    ...fixture.inputs,
    actionsReader: runtime.actionsReader,
  })

  assert.equal(artifact.source, "escrow")
  assert.deepEqual(readerCalls, [
    ["artifact", fixture.record.actionsArtifact.id],
    [
      "run-attempt",
      fixture.record.actionsArtifact.prepareRunId,
      fixture.record.actionsArtifact.prepareRunAttempt,
    ],
    ["download", fixture.record.actionsArtifact.id],
  ])
})

test("production recovery rejects mismatched immutable run-attempt evidence", async () => {
  const fixture = artifactFixture()
  for (const run of [
    { id: 201, run_attempt: 1, head_sha: SHA },
    { id: 200, run_attempt: 2, head_sha: SHA },
    { id: 200, run_attempt: 1, head_sha: "b".repeat(40) },
  ]) {
    const runtime = createArtifactStoreGitHubRuntime({
      metadataReader: {
        async getActionsArtifact() {
          return {
            status: "PRESENT",
            value: {
              id: fixture.record.actionsArtifact.id,
              name: fixture.record.actionsArtifact.name,
              digest: fixture.record.actionsArtifact.serviceDigest,
              expired: false,
              workflow_run: { id: 200, head_sha: SHA },
            },
          }
        },
        async getActionsRunAttempt() {
          return { status: "PRESENT", value: run }
        },
      },
      binaryReader: {},
    })

    const result = await runtime.actionsReader.getArtifactMetadata({
      artifactId: fixture.record.actionsArtifact.id,
      prepareRunId: fixture.record.actionsArtifact.prepareRunId,
      prepareRunAttempt: fixture.record.actionsArtifact.prepareRunAttempt,
    })
    assert.deepEqual(result, {
      status: "ERROR",
      httpStatus: 200,
      code: "MALFORMED_SCHEMA",
    })
  }
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
  assert.throws(
    () =>
      extractActionsArtifactZip(
        storedZip([
          { name: "one", bytes: Buffer.alloc(6) },
          { name: "two", bytes: Buffer.alloc(6) },
        ]),
        { maxOutputBytes: 10 },
      ),
    /output limit|size/u,
  )
})

test("trusted ZIP extraction enforces the shared entry and basename limits", () => {
  assert.throws(
    () =>
      extractActionsArtifactZip(
        storedZip(
          Array.from({ length: RELEASE_PAYLOAD_LIMITS.zipEntries + 1 }, (_value, index) => ({
            name: `file-${index}`,
            bytes: Buffer.from("x"),
          })),
        ),
      ),
    /directory.*invalid|entry.*limit/iu,
  )
  assert.throws(
    () =>
      extractActionsArtifactZip(
        storedZip([
          {
            name: "x".repeat(RELEASE_PAYLOAD_LIMITS.archiveFilenameBytes + 1),
            bytes: Buffer.from("x"),
          },
        ]),
      ),
    /name.*byte|basename.*limit/iu,
  )
})

test("the documented four-argument resolver defaults to its built-in ZIP extractor", async () => {
  const fixture = artifactFixture({ useZipArchive: true })
  delete fixture.inputs.extractArchive

  const artifact = await loadVerifiedReleaseArtifact(fixture.inputs)

  assert.equal(artifact.source, "actions")
  assert.equal(artifact.files.length, 22)
})

test("the sparse executable dependency allowlist covers its exact local import closure", () => {
  assert.deepEqual(ARTIFACT_STORE_SPARSE_FILES, [
    "scripts/release/adapter-normalize.mjs",
    "scripts/release/adapters/github.mjs",
    "scripts/release/adapters/http.mjs",
    "scripts/release/artifact-store.mjs",
    "scripts/release/limits.mjs",
    "scripts/release/manifest.mjs",
    "scripts/release/metadata.mjs",
    "scripts/release/npm-evidence.mjs",
    "scripts/release/release-record.mjs",
    "scripts/release/semver.mjs",
    "scripts/release/smoke-result.mjs",
    "scripts/release/terminal-records.mjs",
    "scripts/release/topology.mjs",
  ])
})

test("the sparse allowlist equals the executable's transitive local import graph", async () => {
  const releaseRoot = path.resolve(import.meta.dirname, "..")
  const discovered = new Set()
  const visit = async (absolutePath) => {
    const repositoryPath = path.relative(path.resolve(releaseRoot, "../.."), absolutePath)
    if (discovered.has(repositoryPath)) return
    discovered.add(repositoryPath)
    const source = await readFile(absolutePath, "utf8")
    for (const match of source.matchAll(/from\s+["'](\.{1,2}\/[^"']+)["']/gu)) {
      await visit(path.resolve(path.dirname(absolutePath), match[1]))
    }
  }
  await visit(path.join(releaseRoot, "artifact-store.mjs"))
  assert.deepEqual([...discovered].sort(), ARTIFACT_STORE_SPARSE_FILES)
})

test("retention fallback refuses a published Release during npm publication", async () => {
  const fixture = artifactFixture({ downloadStatus: "gone", escrowDraft: false })
  await assert.rejects(loadVerifiedReleaseArtifact(fixture.inputs), /draft.*Release|escrow/iu)
})

test("production escrow accepts GitHub's main target only after exact annotated-tag peel and partitions later receipts", async () => {
  const fixture = artifactFixture()
  const manifestBytes = canonicalManifestBytes(fixture.manifest)
  const contents = new Map([
    ["release-record.json", canonicalReleaseRecordBytes(fixture.record)],
    ["manifest.json", manifestBytes],
  ])
  for (const pkg of fixture.manifest.packages) {
    contents.set(pkg.filename, Buffer.from(`packed:${pkg.name}`))
  }
  for (const name of ["manifest.json", ...fixture.manifest.packages.map((pkg) => pkg.filename)]) {
    contents.set(`${name}.intoto.jsonl`, Buffer.from("one-multi-subject-bundle"))
  }
  const laterReceipts = [
    "smoke-result-metadata-901-2.json",
    "audit-attempt-902-1.json",
    "audit-result.json",
  ]
  for (const name of laterReceipts) contents.set(name, Buffer.from(`later:${name}`))
  const assets = [...contents].map(([name, bytes], index) => ({
    id: index + 1,
    name,
    size: bytes.length,
  }))
  const byId = new Map(assets.map((asset) => [asset.id, contents.get(asset.name)]))
  const draftBody = canonicalReleaseBody({
    marker: observationForMarker({ phase: "ESCROWED" }).release.marker,
    manifest: null,
  })
  const calls = []
  const runtime = createArtifactStoreGitHubRuntime({
    metadataReader: {
      async listReleases() {
        return {
          status: "PRESENT",
          value: [
            {
              id: 44,
              tag_name: "untagged-opaque",
              target_commitish: "main",
              draft: true,
              immutable: false,
              prerelease: false,
              body: draftBody,
            },
            {
              id: 45,
              tag_name: "untagged-unrelated",
              target_commitish: "main",
              draft: true,
              immutable: false,
              prerelease: false,
              body: `${draftBody}${draftBody}`,
            },
          ],
        }
      },
      async getRef({ ref }) {
        calls.push(["ref", ref])
        return {
          status: "PRESENT",
          value: { ref: `refs/${ref}`, object: { type: "tag", sha: "b".repeat(40) } },
        }
      },
      async getGitTag({ tagSha }) {
        calls.push(["tag", tagSha])
        return {
          status: "PRESENT",
          value: {
            tag: fixture.record.tag,
            object: { type: "commit", sha: fixture.record.commitSha },
          },
        }
      },
      async listReleaseAssets({ releaseId }) {
        assert.equal(releaseId, 44)
        return { status: "PRESENT", value: assets }
      },
    },
    binaryReader: {
      async downloadReleaseAsset({ assetId }) {
        const bytes = byId.get(assetId)
        assert.ok(bytes)
        return { status: "PRESENT", contentBase64: bytes.toString("base64") }
      },
    },
  })

  const escrow = await runtime.releaseReader.loadEscrow({
    tag: fixture.record.tag,
    record: fixture.record,
  })

  assert.equal(escrow.status, "PRESENT")
  assert.equal(escrow.files.length, 22)
  assert.equal(escrow.bundles.length, 22)
  assert.deepEqual(calls, [
    ["ref", `tags/${fixture.record.tag}`],
    ["tag", "b".repeat(40)],
  ])
})

test("production escrow rejects noncanonical targets, lightweight tags, and wrong annotated peels", async () => {
  const fixture = artifactFixture()
  for (const variation of [
    {
      target: fixture.record.commitSha,
      refType: "tag",
      peeledSha: fixture.record.commitSha,
      code: "RELEASE_IDENTITY_CONFLICT",
    },
    {
      target: "main",
      refType: "commit",
      peeledSha: fixture.record.commitSha,
      code: "TAG_IDENTITY_CONFLICT",
    },
    {
      target: "main",
      refType: "tag",
      peeledSha: "c".repeat(40),
      code: "TAG_IDENTITY_CONFLICT",
    },
  ]) {
    const runtime = createArtifactStoreGitHubRuntime({
      metadataReader: {
        async listReleases() {
          return {
            status: "PRESENT",
            value: [
              {
                id: 44,
                tag_name: fixture.record.tag,
                target_commitish: variation.target,
                draft: true,
                immutable: false,
                prerelease: false,
              },
            ],
          }
        },
        async getRef({ ref }) {
          return {
            status: "PRESENT",
            value: {
              ref: `refs/${ref}`,
              object: { type: variation.refType, sha: "b".repeat(40) },
            },
          }
        },
        async getGitTag() {
          return {
            status: "PRESENT",
            value: {
              tag: fixture.record.tag,
              object: { type: "commit", sha: variation.peeledSha },
            },
          }
        },
      },
      binaryReader: {},
    })

    assert.deepEqual(
      await runtime.releaseReader.loadEscrow({ tag: fixture.record.tag, record: fixture.record }),
      { status: "ERROR", httpStatus: 200, code: variation.code },
    )
  }
})

test("production escrow downloads share one bounded byte budget", async () => {
  const fixture = artifactFixture()
  const runtime = createArtifactStoreGitHubRuntime({
    maxEscrowBytes: 10,
    metadataReader: {
      async listReleases() {
        return {
          status: "PRESENT",
          value: [
            {
              id: 1,
              tag_name: fixture.record.tag,
              target_commitish: "main",
              draft: true,
              immutable: false,
              prerelease: false,
            },
          ],
        }
      },
      ...annotatedTagMetadata(fixture),
      async listReleaseAssets() {
        return {
          status: "PRESENT",
          value: [
            {
              id: 2,
              name: "release-record.json",
              size: canonicalReleaseRecordBytes(fixture.record).length,
            },
          ],
        }
      },
    },
    binaryReader: {
      async downloadReleaseAsset() {
        return {
          status: "PRESENT",
          contentBase64: canonicalReleaseRecordBytes(fixture.record).toString("base64"),
        }
      },
    },
  })

  await assert.rejects(
    runtime.releaseReader.loadEscrow({ tag: fixture.record.tag, record: fixture.record }),
    /escrow.*byte|download.*budget/iu,
  )
})

test("escrow rejects an oversized asset from metadata before downloading it", async () => {
  const fixture = artifactFixture()
  let downloads = 0
  const runtime = createArtifactStoreGitHubRuntime({
    metadataReader: {
      async listReleases() {
        return {
          status: "PRESENT",
          value: [
            {
              id: 1,
              tag_name: fixture.record.tag,
              target_commitish: "main",
              draft: true,
              immutable: false,
              prerelease: false,
            },
          ],
        }
      },
      ...annotatedTagMetadata(fixture),
      async listReleaseAssets() {
        return {
          status: "PRESENT",
          value: [
            {
              id: 2,
              name: "release-record.json",
              size: RELEASE_PAYLOAD_LIMITS.releaseRecordBytes + 1,
            },
          ],
        }
      },
    },
    binaryReader: {
      async downloadReleaseAsset() {
        downloads += 1
        throw new Error("must not download")
      },
    },
  })

  await assert.rejects(
    runtime.releaseReader.loadEscrow({ tag: fixture.record.tag, record: fixture.record }),
    /release-record.*size|byte limit/iu,
  )
  assert.equal(downloads, 0)
})

test("the executable rejects an oversized release record before readFile", async () => {
  let reads = 0
  await assert.rejects(
    runArtifactStoreCli(
      ["resolve", "--record", "/tmp/record.json", "--output-dir", "/tmp/output"],
      {
        environment: {},
        fileSystem: {
          async lstat() {
            return {
              isFile: () => true,
              isSymbolicLink: () => false,
              size: RELEASE_PAYLOAD_LIMITS.releaseRecordBytes + 1,
            }
          },
          async readFile() {
            reads += 1
            throw new Error("must not read")
          },
        },
      },
    ),
    /release record.*byte limit|record.*too large/iu,
  )
  assert.equal(reads, 0)
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
    "--deny-self-hosted-runners",
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

test("the CLI attestation verifier keeps the Actions path online per file with the larger budget", async () => {
  const calls = []
  const verifier = createCliAttestationVerifier({
    repository: "cacheplane/dawnai",
    token: "token",
    async runGh(args, options) {
      calls.push({ args, options })
    },
  })
  const subjects = [
    { name: "manifest.json", sha256: "b".repeat(64) },
    { name: "dawn-ai-core-0.8.22.tgz", sha256: "c".repeat(64) },
  ]
  const result = await verifier.verify({
    source: "actions",
    record: artifactFixture().record,
    subjects,
    files: subjects.map((subject) => ({ name: subject.name, bytes: Buffer.from(subject.name) })),
    bundles: [],
  })

  assert.deepEqual(result, { status: "VERIFIED", subjects })
  assert.equal(calls.length, 2)
  for (const call of calls) {
    assert.ok(
      Object.entries(process.env).every(
        ([key, value]) => key === "GH_TOKEN" || call.options.env[key] === value,
      ),
    )
    assert.equal(call.options.env.GH_TOKEN, "token")
    assert.equal(call.options.timeout, 180_000)
    assert.equal(call.options.killSignal, "SIGKILL")
    assert.equal(call.args.includes("--bundle"), false)
  }
})

test("attestation verifier snapshots explicit environment without ambient inheritance", async () => {
  const environment = { PATH: "/reviewed/bin", HOME: "/reviewed/home", GH_TOKEN: "wrong" }
  const calls = []
  const verifier = createCliAttestationVerifier({
    repository: "cacheplane/dawnai",
    token: "attestation-token",
    environment,
    async runGh(_args, options) {
      calls.push({ ...options.env })
      options.env.INJECTED = "must not persist"
    },
  })
  environment.DAWN_RECOVERY_POLICY_TOKEN = "added after construction"
  environment.PATH = "/changed/bin"
  const subjects = [{ name: "manifest.json", sha256: "b".repeat(64) }]
  for (let i = 0; i < 2; i++) {
    const result = await verifier.verify({
      source: "actions",
      record: artifactFixture().record,
      subjects,
      files: [{ name: "manifest.json", bytes: Buffer.from("manifest") }],
      bundles: [],
    })
    assert.equal(result.status, "VERIFIED")
  }
  assert.ok(
    calls.every((env) => Object.keys(env).sort().join(",") === "GH_TOKEN,HOME,PATH"),
    "child environment contains only explicit keys",
  )
  assert.deepEqual(
    calls,
    Array(2).fill({
      PATH: "/reviewed/bin",
      HOME: "/reviewed/home",
      GH_TOKEN: "attestation-token",
    }),
  )
})

test("escrow verification runs gh once for the anchor and proves the other 21 subjects locally", async () => {
  const escrow = escrowVerificationFixture()
  const calls = []
  const verifier = createCliAttestationVerifier({
    repository: "cacheplane/dawnai",
    token: "token",
    async runGh(args, options) {
      calls.push({ args, options })
    },
  })

  const result = await verifier.verify({ source: "escrow", ...escrow.input })

  assert.deepEqual(result, { status: "VERIFIED", subjects: escrow.input.subjects })
  assert.equal(escrow.input.files.length, 22)
  assert.equal(calls.length, 1)
  assert.equal(calls[0].options.timeout, 180_000)
  assert.equal(calls[0].options.killSignal, "SIGKILL")
  assert.equal(path.basename(calls[0].args[2]), "manifest.json")
  assert.equal(path.basename(calls[0].args.at(-1)), "manifest.json.intoto.jsonl")
  assert.equal(calls[0].options.env.GH_TOKEN, "token")
})

test("escrow verification rejects a file whose digest is absent from the anchor's subjects", async () => {
  const escrow = escrowVerificationFixture()
  const files = escrow.input.files.map((file, index) =>
    index === 7 ? { name: file.name, bytes: Buffer.from("tampered tarball") } : file,
  )
  const subjects = files.map((file) => ({
    name: file.name,
    sha256: createHash("sha256").update(file.bytes).digest("hex"),
  }))
  const verifier = createCliAttestationVerifier({
    repository: "cacheplane/dawnai",
    token: "token",
    async runGh() {},
  })

  const result = await verifier.verify({ source: "escrow", ...escrow.input, files, subjects })

  assert.equal(result.status, "INVALID")
  assert.deepEqual(result.subjects, [])
  assert.match(result.reason, /not attested/u)
  assert.ok(result.reason.includes(files[7].name))

  const inconsistent = await verifier.verify({ source: "escrow", ...escrow.input, files })
  assert.equal(inconsistent.status, "INVALID")
  assert.match(inconsistent.reason, /subject 7 does not describe file/u)
})

test("escrow verification rejects an anchor whose subject count differs from the input", async () => {
  const escrow = escrowVerificationFixture({ statementSubjectCount: 23 })
  const verifier = createCliAttestationVerifier({
    repository: "cacheplane/dawnai",
    token: "token",
    async runGh() {},
  })

  const result = await verifier.verify({ source: "escrow", ...escrow.input })

  assert.equal(result.status, "INVALID")
  assert.deepEqual(result.subjects, [])
  assert.match(result.reason, /23 subjects .*22/u)
})

test("escrow verification rejects an anchor subject whose name does not match the file", async () => {
  const escrow = escrowVerificationFixture({ renameStatementSubject: 3 })
  const verifier = createCliAttestationVerifier({
    repository: "cacheplane/dawnai",
    token: "token",
    async runGh() {},
  })

  const result = await verifier.verify({ source: "escrow", ...escrow.input })

  assert.equal(result.status, "INVALID")
  assert.deepEqual(result.subjects, [])
  assert.match(result.reason, /not attested/u)
})

test("escrow verification stays INVALID when gh rejects a tampered anchor bundle", async () => {
  const escrow = escrowVerificationFixture()
  const tamperedStatement = JSON.parse(
    Buffer.from(
      JSON.parse(escrow.input.bundles[0].bytes.toString("utf8")).dsseEnvelope.payload,
      "base64",
    ).toString("utf8"),
  )
  tamperedStatement.predicate.runDetails.metadata.invocationId = "https://example.invalid/run"
  const tamperedBundle = multiSubjectBundleBytes(escrow.input.files, {
    statement: tamperedStatement,
  })
  const bundles = escrow.input.bundles.map(({ name }) => ({
    name,
    bytes: Buffer.from(tamperedBundle),
  }))
  let invoked = 0
  const verifier = createCliAttestationVerifier({
    repository: "cacheplane/dawnai",
    token: "token",
    async runGh() {
      invoked += 1
      throw Object.assign(new Error("Command failed: gh attestation verify"), {
        code: 1,
        signal: null,
        stderr: "✗ Sigstore verification failed: signature does not match payload\n",
      })
    },
  })

  const result = await verifier.verify({ source: "escrow", ...escrow.input, bundles })

  assert.equal(invoked, 1)
  assert.equal(result.status, "INVALID")
  assert.deepEqual(result.subjects, [])
  assert.match(result.reason, /exit code 1/u)
  assert.match(result.reason, /signature does not match payload/u)
})

test("escrow verification rejects a bundle that is not byte-identical to the anchor", async () => {
  const escrow = escrowVerificationFixture()
  const bundles = escrow.input.bundles.map((bundle, index) =>
    index === 5 ? { name: bundle.name, bytes: Buffer.from("different bundle") } : bundle,
  )
  const verifier = createCliAttestationVerifier({
    repository: "cacheplane/dawnai",
    token: "token",
    async runGh() {},
  })

  const result = await verifier.verify({ source: "escrow", ...escrow.input, bundles })

  assert.equal(result.status, "INVALID")
  assert.match(result.reason, /anchor/u)
})

test("attestation verification failures report the exit code, signal, and redacted stderr", async () => {
  const escrow = escrowVerificationFixture()
  const leaked = `ghp_${"A".repeat(30)}`
  const timedOut = createCliAttestationVerifier({
    repository: "cacheplane/dawnai",
    token: leaked,
    async runGh() {
      throw Object.assign(new Error("spawnSync gh SIGKILL"), {
        killed: true,
        code: null,
        signal: "SIGKILL",
        stdout: "",
        stderr: `Loading trusted root from Sigstore TUF repository... token ${leaked}\n`,
      })
    },
  })
  const timeoutResult = await timedOut.verify({ source: "escrow", ...escrow.input })
  assert.equal(timeoutResult.status, "INVALID")
  assert.deepEqual(timeoutResult.subjects, [])
  assert.match(timeoutResult.reason, /signal SIGKILL/u)
  assert.match(timeoutResult.reason, /timed out after 180000ms/u)
  assert.match(timeoutResult.reason, /\[redacted\]/u)
  assert.equal(timeoutResult.reason.includes(leaked), false)
  assert.equal(timeoutResult.reason.includes("ghp_"), false)

  const jwt =
    "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIiwibmFtZSI6IkpvaG4ifQ.SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV_adQssw5c"
  const dotted = createCliAttestationVerifier({
    repository: "cacheplane/dawnai",
    token: "token",
    async runGh() {
      throw Object.assign(new Error("Command failed"), {
        code: 1,
        signal: null,
        stderr: `bundle rejected: v1.${jwt} via registry.npmjs.org`,
      })
    },
  })
  const dottedResult = await dotted.verify({ source: "escrow", ...escrow.input })
  assert.equal(dottedResult.status, "INVALID")
  assert.equal(
    dottedResult.reason.includes("eyJzdWIiOiIxMjM0NTY3ODkwIiwibmFtZSI6IkpvaG4ifQ"),
    false,
  )
  assert.match(dottedResult.reason, /v1\.\[redacted\] via registry\.npmjs\.org/u)

  const failed = createCliAttestationVerifier({
    repository: "cacheplane/dawnai",
    token: "token",
    async runGh() {
      throw Object.assign(new Error("Command failed"), {
        code: 2,
        signal: null,
        stderr: `${"x".repeat(5_000)}\u0007Bearer secret-value`,
      })
    },
  })
  const failedResult = await failed.verify({ source: "actions", ...escrow.input, bundles: [] })
  assert.equal(failedResult.status, "INVALID")
  assert.match(failedResult.reason, /exit code 2/u)
  assert.ok(failedResult.reason.length <= 2_048 + 128)
  assert.equal(failedResult.reason.includes("\u0007"), false)
  assert.equal(failedResult.reason.includes("secret-value"), false)
})

test("artifact metadata and extracted files reject accessors without invoking them", async () => {
  for (const target of ["metadata", "files"]) {
    const fixture = artifactFixture()
    let reads = 0
    if (target === "metadata") {
      Object.defineProperty(fixture.inputs.actionsReader, "getArtifactMetadata", {
        value: async () => {
          const value = { ...artifactFixture().inputs.actionsReader }
          const metadata = {
            id: fixture.record.actionsArtifact.id,
            name: fixture.record.actionsArtifact.name,
            expired: false,
            prepareRunId: fixture.record.actionsArtifact.prepareRunId,
            prepareRunAttempt: fixture.record.actionsArtifact.prepareRunAttempt,
            headSha: SHA,
          }
          Object.defineProperty(metadata, "serviceDigest", {
            enumerable: true,
            get() {
              reads += 1
              return fixture.record.actionsArtifact.serviceDigest
            },
          })
          return { status: "PRESENT", value, ...{ value: metadata } }
        },
      })
    } else {
      fixture.inputs.extractArchive = async () => {
        const files = artifactFixture().inputs.extractArchive
        const materialized = await files(Buffer.from("exact-actions-archive"))
        Object.defineProperty(materialized[0], "name", {
          enumerable: true,
          get() {
            reads += 1
            return "manifest.json"
          },
        })
        return materialized
      }
    }
    await assert.rejects(
      loadVerifiedReleaseArtifact(fixture.inputs),
      /accessor|snapshot|malformed/u,
    )
    assert.equal(reads, 0)
  }
})

test("artifact metadata rejects an own __proto__ key without prototype mutation", async () => {
  const fixture = artifactFixture()
  const metadata = {
    id: fixture.record.actionsArtifact.id,
    name: fixture.record.actionsArtifact.name,
    serviceDigest: fixture.record.actionsArtifact.serviceDigest,
    expired: false,
    prepareRunId: fixture.record.actionsArtifact.prepareRunId,
    prepareRunAttempt: fixture.record.actionsArtifact.prepareRunAttempt,
    headSha: SHA,
  }
  Object.defineProperty(metadata, "__proto__", {
    enumerable: true,
    value: { polluted: true },
  })
  fixture.inputs.actionsReader.getArtifactMetadata = async () => ({
    status: "PRESENT",
    value: metadata,
  })

  await assert.rejects(loadVerifiedReleaseArtifact(fixture.inputs), /unknown field __proto__/u)
  assert.equal(Object.prototype.polluted, undefined)
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
  const archiveBytes = overrides.useZipArchive
    ? storedZip(files)
    : Buffer.from("exact-actions-archive")
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
              draft: overrides.escrowDraft ?? true,
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

function annotatedTagMetadata(fixture) {
  const tagSha = "b".repeat(40)
  return {
    async getRef({ ref }) {
      assert.equal(ref, `tags/${fixture.record.tag}`)
      return {
        status: "PRESENT",
        value: { ref: `refs/${ref}`, object: { type: "tag", sha: tagSha } },
      }
    },
    async getGitTag({ tagSha: requestedSha }) {
      assert.equal(requestedSha, tagSha)
      return {
        status: "PRESENT",
        value: {
          tag: fixture.record.tag,
          object: { type: "commit", sha: fixture.record.commitSha },
        },
      }
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

function escrowVerificationFixture({ statementSubjectCount, renameStatementSubject } = {}) {
  const names = [
    "manifest.json",
    ...CANONICAL_RELEASE_PACKAGE_ORDER.map((name) => filenameFor(name)),
  ]
  const files = names.map((name) => ({ name, bytes: Buffer.from(`escrow-bytes:${name}`) }))
  const subjects = files.map((file) => ({
    name: file.name,
    sha256: createHash("sha256").update(file.bytes).digest("hex"),
  }))
  let statementSubjects = subjects.map((subject) => ({
    name: subject.name,
    digest: { sha256: subject.sha256 },
  }))
  if (statementSubjectCount !== undefined) {
    statementSubjects = Array.from({ length: statementSubjectCount }, (_, index) =>
      index < statementSubjects.length
        ? statementSubjects[index]
        : { name: `extra-${index}.tgz`, digest: { sha256: "d".repeat(64) } },
    )
  }
  if (renameStatementSubject !== undefined) {
    statementSubjects = statementSubjects.map((subject, index) =>
      index === renameStatementSubject ? { ...subject, name: "renamed.tgz" } : subject,
    )
  }
  const bundleBytes = multiSubjectBundleBytes(files, { subjects: statementSubjects })
  const bundles = files.map((file) => ({
    name: `${file.name}.intoto.jsonl`,
    bytes: Buffer.from(bundleBytes),
  }))
  return { input: { record: artifactFixture().record, subjects, files, bundles } }
}

function multiSubjectBundleBytes(files, { subjects, statement } = {}) {
  const resolvedStatement = statement ?? {
    _type: "https://in-toto.io/Statement/v1",
    subject:
      subjects ??
      files.map((file) => ({
        name: file.name,
        digest: { sha256: createHash("sha256").update(file.bytes).digest("hex") },
      })),
    predicateType: "https://slsa.dev/provenance/v1",
    predicate: {
      runDetails: {
        metadata: {
          invocationId: "https://github.com/cacheplane/dawnai/actions/runs/1/attempts/1",
        },
      },
    },
  }
  return Buffer.from(
    `${JSON.stringify({
      mediaType: "application/vnd.dev.sigstore.bundle.v0.3+json",
      dsseEnvelope: {
        payloadType: "application/vnd.in-toto+json",
        payload: Buffer.from(JSON.stringify(resolvedStatement), "utf8").toString("base64"),
        signatures: [{ sig: Buffer.from("signature", "utf8").toString("base64") }],
      },
      verificationMaterial: {},
    })}\n`,
    "utf8",
  )
}
