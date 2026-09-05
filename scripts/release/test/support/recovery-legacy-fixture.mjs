import assert from "node:assert/strict"
import { execFileSync } from "node:child_process"
import { createHash } from "node:crypto"
import { mkdtemp, readFile, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { dirname, join, resolve } from "node:path"
import { fileURLToPath, pathToFileURL } from "node:url"
import { gunzipSync } from "node:zlib"

export const LEGACY_REVISION = "88c01c4afd59866fc0ea4c8f3b8444439a01c8ea"
export const VERSION = "0.8.24"
export const COMMIT_SHA = LEGACY_REVISION
export const TAG = `v${VERSION}`
export const CANDIDATE = Object.freeze({
  version: VERSION,
  commitSha: COMMIT_SHA,
  ciWorkflow: "CI",
  ciCheck: "validate",
  publisherWorkflow: ".github/workflows/release.yml",
})
const REPOSITORY = "cacheplane/dawnai"
const TAG_SHA = "abcdef0123456789abcdef0123456789abcdef01"
export const API_BASE = `https://api.github.com/repos/${REPOSITORY}`
const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../../../..")

// Generated from the exact candidate Git tree. Production scripts are included
// reachable from both original writer workflows; imports stay unchanged.
// Rebuild: start with release.yml and published-artifact-verify.yml; recursively
// collect referenced scripts/*.mjs and relative .mjs imports; git archive --format=tar REV PATHS;
// gzip.compress(tarBytes, mtime=0). Verify each member with git show REV:path.
// Archive membership deliberately exceeds the executed module closure so that
// workflow entry points and their original imports remain available for review.
export const ARCHIVE_SHA256 = "0d248ff546dd1937d25d15ca6ad0849a9b45f7ccc05fa1519998f0c61de2ba66"

export async function loadLegacyFixture() {
  const directory = await mkdtemp(join(tmpdir(), "dawn-recovery-legacy-"))
  const archive = join(
    REPO_ROOT,
    "scripts/release/test/fixtures/recovery-legacy/candidate-88c01c4a.tar.gz",
  )
  try {
    const compressed = await readFile(archive)
    assert.equal(sha256(compressed), ARCHIVE_SHA256)
    // git archive embeds the source commit in its leading PAX global header.
    const tarBytes = gunzipSync(compressed)
    assert.equal(tarBytes.subarray(0, 17).toString("utf8"), "pax_global_header")
    assert.equal(tarBytes.subarray(512, 564).toString("utf8"), `52 comment=${LEGACY_REVISION}\n`)
    const members = execFileSync("tar", ["-tzf", archive], { encoding: "utf8" }).trim().split("\n")
    assert.ok(members.every((path) => !path.startsWith("/") && !path.split("/").includes("..")))
    execFileSync("tar", ["-xzf", archive, "-C", directory])
    const files = new Map()
    for (const path of members.filter((path) => !path.endsWith("/"))) {
      files.set(path, { sha256: sha256(await readFile(join(directory, path))) })
    }
    const modules = {}
    for (const [name, path] of Object.entries({
      metadata: "metadata.mjs",
      audit: "audit.mjs",
      manifest: "manifest.mjs",
      record: "release-record.mjs",
      smoke: "smoke-result.mjs",
      terminal: "terminal-records.mjs",
      reader: "adapters/github.mjs",
      writer: "adapters/github-write.mjs",
    }))
      modules[name] = await import(pathToFileURL(join(directory, "scripts/release", path)).href)
    return {
      directory,
      files,
      modules,
      cleanup: () => rm(directory, { recursive: true, force: true }),
    }
  } catch (error) {
    await rm(directory, { recursive: true, force: true })
    throw new Error(`Frozen candidate fixture unavailable or invalid: ${LEGACY_REVISION}`, {
      cause: error,
    })
  }
}

// Synthetic package bytes and receipts use the affected v0.8.24 identity. They
// exercise the exact frozen executor; they are not observed release evidence.
export function candidateFixture(legacy) {
  const { canonicalBaseAssetSet, canonicalReleaseBody } = legacy.modules.metadata
  const { CANONICAL_RELEASE_PACKAGE_ORDER, canonicalManifestBytes } = legacy.modules.manifest
  const { createReleaseRecord, releaseRecordSha256 } = legacy.modules.record
  function releaseFixture({
    bundleText = "multi-subject-bundle",
    attestationRunId = 100,
    attestationRunAttempt = 2,
  } = {}) {
    const fileBytes = new Map()
    const packages = CANONICAL_RELEASE_PACKAGE_ORDER.map((name) => {
      const filename = packageFilename(name)
      const bytes = Buffer.from(`package:${name}:${VERSION}`, "utf8")
      fileBytes.set(filename, bytes)
      const sha512 = createHash("sha512").update(bytes).digest("hex")
      return {
        name,
        version: VERSION,
        filename,
        size: bytes.length,
        sha256: sha256(bytes),
        sha512,
        npmIntegrity: `sha512-${Buffer.from(sha512, "hex").toString("base64")}`,
        access: "public",
      }
    })
    const manifest = {
      schemaVersion: 1,
      version: VERSION,
      commitSha: COMMIT_SHA,
      ci: { workflow: "CI", runId: 10, runAttempt: 1 },
      artifact: {
        name: `release-v${VERSION}-${COMMIT_SHA.slice(0, 12)}`,
        prepareRunId: 11,
        prepareRunAttempt: 1,
      },
      packageOrder: [...CANONICAL_RELEASE_PACKAGE_ORDER],
      packages,
    }
    const manifestBytes = canonicalManifestBytes(manifest)
    fileBytes.set("manifest.json", manifestBytes)
    const record = createReleaseRecord({
      candidate: CANDIDATE,
      manifestSha256: sha256(manifestBytes),
      artifact: { name: manifest.artifact.name },
      artifactUpload: { id: "12", digest: `sha256:${"a".repeat(64)}` },
      prepareRun: { id: 11, attempt: 1 },
    })
    const subjectFiles = [
      { name: "manifest.json", bytes: manifestBytes },
      ...packages.map((pkg) => ({ name: pkg.filename, bytes: fileBytes.get(pkg.filename) })),
    ]
    const bundleBytes = attestationBundleBytes(subjectFiles, {
      runId: attestationRunId,
      runAttempt: attestationRunAttempt,
      signature: bundleText,
    })
    const bundles = subjectFiles.map(({ name }) => ({
      name: `${name}.intoto.jsonl`,
      bytes: Buffer.from(bundleBytes),
    }))
    const attestationSet = {
      repository: REPOSITORY,
      workflow: ".github/workflows/release.yml",
      sourceRef: `refs/tags/v${VERSION}`,
      commitSha: COMMIT_SHA,
      workflowRunId: attestationRunId,
      runAttempt: attestationRunAttempt,
      subjects: subjectFiles.map((file, index) => ({
        subjectName: file.name,
        subjectSha256: sha256(file.bytes),
        bundleName: bundles[index].name,
        bundleSha256: sha256(bundles[index].bytes),
      })),
    }
    return {
      manifest,
      record,
      attestationSet,
      bundles,
      artifact: { manifest, files: subjectFiles },
    }
  }

  function attestationBundleBytes(subjectFiles, { runId, runAttempt, signature }) {
    const statement = {
      _type: "https://in-toto.io/Statement/v1",
      subject: subjectFiles.map((file) => ({
        name: file.name,
        digest: { sha256: sha256(file.bytes) },
      })),
      predicateType: "https://slsa.dev/provenance/v1",
      predicate: {
        runDetails: {
          metadata: {
            invocationId: `https://github.com/cacheplane/dawnai/actions/runs/${runId}/attempts/${runAttempt}`,
          },
        },
      },
    }
    return Buffer.from(
      JSON.stringify({
        mediaType: "application/vnd.dev.sigstore.bundle.v0.3+json",
        dsseEnvelope: {
          payloadType: "application/vnd.in-toto+json",
          payload: Buffer.from(JSON.stringify(statement), "utf8").toString("base64"),
          signatures: [{ sig: Buffer.from(signature, "utf8").toString("base64") }],
        },
        verificationMaterial: {},
      }),
      "utf8",
    )
  }

  function escrowMarker(fixture) {
    const base = canonicalBaseAssetSet({
      record: fixture.record,
      artifact: fixture.artifact,
      attestationSet: fixture.attestationSet,
      bundles: fixture.bundles,
    })
    return {
      schemaVersion: 1,
      epoch: "fixed-group-v1",
      revision: 2,
      phase: "ESCROWED",
      version: VERSION,
      commitSha: COMMIT_SHA,
      tag: `v${VERSION}`,
      manifestSha256: sha256(canonicalManifestBytes(fixture.manifest)),
      releaseRecordSha256: releaseRecordSha256(fixture.record),
      baseAssetSetSha256: base.sha256,
      attestationSet: fixture.attestationSet,
      npmEvidenceSha256: null,
      smoke: null,
      audit: null,
      abandonmentSha256: null,
    }
  }

  function attachingMarker(fixture) {
    const marker = escrowMarker(fixture)
    return {
      ...marker,
      revision: 1,
      phase: "ATTACHING",
      baseAssetSetSha256: null,
      attestationSet: null,
    }
  }

  function publicationState(
    fixture,
    {
      runs = [
        {
          runId: fixture.attestationSet.workflowRunId,
          runAttempt: fixture.attestationSet.runAttempt,
        },
      ],
    } = {},
  ) {
    return {
      schemaVersion: 1,
      version: VERSION,
      commitSha: COMMIT_SHA,
      tag: `v${VERSION}`,
      observedAt: "2026-08-24T00:00:00Z",
      candidateRuns: runs.map(({ runId, runAttempt }) => ({
        runId,
        runAttempt,
        headSha: COMMIT_SHA,
        headBranch: `v${VERSION}`,
        workflowPath: ".github/workflows/release.yml",
        event: "workflow_dispatch",
        jobs: Array.from({ length: runAttempt }, (_unused, index) => index + 1).flatMap(
          (attempt) => {
            const publisher = {
              id: attempt * 3 - 1,
              runAttempt: attempt,
              name: "publish-npm",
              status: "queued",
              conclusion: null,
              startedAt: null,
              completedAt: null,
            }
            if (attempt !== runAttempt) return [publisher]
            return [
              {
                id: attempt * 3 - 2,
                runAttempt: attempt,
                name: "prepare",
                status: "completed",
                conclusion: "success",
                startedAt: "2026-08-24T00:01:00Z",
                completedAt: "2026-08-24T00:02:00Z",
              },
              publisher,
            ]
          },
        ),
      })),
      registryMutationReceipts: [],
      packages: fixture.manifest.packages.map(({ name }) => ({
        name,
        version: VERSION,
        status: "ABSENT",
        httpStatus: 404,
        observedAt: "2026-08-24T00:00:00Z",
      })),
    }
  }

  function packageFilename(name) {
    return `${name.replace(/^@/u, "").replace("/", "-")}-${VERSION}.tgz`
  }

  function verifiedAttestations(fixture) {
    return Object.freeze({
      async verify({ source, record, subjects, files, bundles }) {
        assert.equal(source, "escrow")
        assert.deepEqual(record, fixture.record)
        assert.equal(files.length, 22)
        assert.equal(bundles.length, 22)
        assert.deepEqual(
          subjects,
          fixture.attestationSet.subjects.map(({ subjectName, subjectSha256 }) => ({
            name: subjectName,
            sha256: subjectSha256,
          })),
        )
        assert.deepEqual(files, fixture.artifact.files)
        assert.deepEqual(bundles, fixture.bundles)
        return { status: "VERIFIED", subjects }
      },
    })
  }

  function completeNpmEvidence(fixture) {
    return {
      schemaVersion: 1,
      version: VERSION,
      commitSha: COMMIT_SHA,
      manifestSha256: fixture.record.manifestSha256,
      complete: true,
      status: "NPM_COMPLETE",
      packages: fixture.manifest.packages.map((pkg) => ({
        name: pkg.name,
        version: VERSION,
        status: "present",
        size: pkg.size,
        tarballSha256: pkg.sha256,
        tarballSha512: pkg.sha512,
        integrity: pkg.npmIntegrity,
        latest: { status: "present", version: VERSION },
        signature: {
          status: "valid",
          verifier: "npm-audit-signatures@11.17.0",
        },
        provenance: {
          predicateType: "https://slsa.dev/provenance/v1",
          workflow: ".github/workflows/release.yml",
          commitSha: COMMIT_SHA,
          repository: "https://github.com/cacheplane/dawnai",
          ref: `refs/tags/v${VERSION}`,
        },
      })),
    }
  }

  const fixture = releaseFixture()
  const marker = escrowMarker(fixture)
  const body = canonicalReleaseBody({ marker, manifest: fixture.manifest })
  const initialBody = canonicalReleaseBody({
    marker: attachingMarker(fixture),
    manifest: fixture.manifest,
  })
  const base = canonicalBaseAssetSet(fixture)
  return {
    ...fixture,
    marker,
    body,
    initialBody,
    base,
    npmEvidence: completeNpmEvidence(fixture),
    publicationState: publicationState(fixture),
    // The trust prerequisite is isolated explicitly: this validates shape and
    // membership, not Sigstore signatures. No gh process or network is invoked.
    attestations: verifiedAttestations(fixture),
  }
}

export function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex")
}

// A representative incompatible v2 marker, not a proposed production v2 schema.
export function incompatibleV2Body(body) {
  assert.ok(body.includes('"schemaVersion":1'))
  return body.replace('"schemaVersion":1', '"schemaVersion":2')
}

export function recordingGitHub(
  legacy,
  fixture,
  {
    body = fixture.body,
    tag = "untagged-opaque",
    rejectCreate = true,
    adoptBodyAfterFirstReleaseRead = null,
  } = {},
) {
  const release = {
    id: 7,
    tag_name: tag,
    target_commitish: "main",
    prerelease: false,
    name: `Dawn ${TAG}`,
    body,
    draft: true,
    immutable: false,
  }
  const assets = fixture.base.assets.map((asset, index) => ({
    id: index + 100,
    name: asset.name,
    size: Buffer.from(asset.contentBase64, "base64").length,
    bytes: Buffer.from(asset.contentBase64, "base64"),
  }))
  const calls = []
  const adoptions = []
  const patchObservations = []
  const json = (value, status = 200) =>
    new Response(JSON.stringify(value), { status, headers: { "content-type": "application/json" } })
  const fetchImpl = async (url, init = {}) => {
    const method = init.method ?? "GET"
    const href = String(url)
    assert.equal(new Headers(init.headers).has("authorization"), false)
    const requestBody = init.body === undefined ? null : Buffer.from(init.body)
    calls.push({
      method,
      url: href,
      body: requestBody === null ? null : requestBody.toString("utf8"),
    })
    const endpoint = href.replace(API_BASE, "")
    if (method !== "GET") {
      if (method === "POST" && endpoint === "/releases" && rejectCreate) {
        return json(
          {
            message: "Validation Failed",
            errors: [{ resource: "Release", code: "already_exists", field: "tag_name" }],
          },
          422,
        )
      }
      if (
        method === "POST" &&
        endpoint ===
          `/actions/workflows/${encodeURIComponent(".github/workflows/published-artifact-verify.yml")}/dispatches`
      ) {
        return json(
          {
            workflow_run_id: 501,
            run_url: `${API_BASE}/actions/runs/501`,
            html_url: "https://github.com/cacheplane/dawnai/actions/runs/501",
          },
          200,
        )
      }
      if (method === "PATCH" && endpoint === "/releases/7") {
        patchObservations.push({
          bodyBefore: release.body,
          ifMatch: new Headers(init.headers).get("if-match"),
        })
        Object.assign(release, JSON.parse(requestBody.toString("utf8")))
        return json(release)
      }
      const upload = new URL(href)
      if (
        method === "POST" &&
        upload.origin === "https://uploads.github.com" &&
        upload.pathname === "/repos/cacheplane/dawnai/releases/7/assets"
      ) {
        const asset = {
          id: 1000,
          name: upload.searchParams.get("name"),
          size: requestBody.length,
          bytes: requestBody,
        }
        assets.push(asset)
        return json({ id: asset.id, name: asset.name, size: asset.size }, 201)
      }
      throw new Error(`Unexpected recorded mutation: ${method} ${href}`)
    }
    if (endpoint === `/git/ref/${encodeURIComponent(`tags/${TAG}`)}`)
      return json({ ref: `refs/tags/${TAG}`, object: { type: "tag", sha: TAG_SHA } })
    if (endpoint === `/git/tags/${TAG_SHA}`)
      return json({ tag: TAG, sha: TAG_SHA, object: { type: "commit", sha: COMMIT_SHA } })
    if (endpoint === "/releases?per_page=100") return json([release])
    if (endpoint === "/releases/7") {
      // Serialize the old read before simulating another writer's adoption. The
      // frozen client receives v1, but its later PATCH encounters v2 remotely.
      const response = json(release)
      if (adoptBodyAfterFirstReleaseRead !== null && adoptions.length === 0) {
        adoptions.push({ before: release.body, after: adoptBodyAfterFirstReleaseRead })
        release.body = adoptBodyAfterFirstReleaseRead
      }
      return response
    }
    if (endpoint === "/releases/7/assets?per_page=100")
      return json(assets.map(({ bytes: _bytes, ...asset }) => asset))
    const asset = assets.find(({ id }) => endpoint === `/releases/assets/${id}`)
    if (asset)
      return new Response(asset.bytes, {
        status: 200,
        headers: { "content-type": "application/octet-stream" },
      })
    throw new Error(`Unexpected recording transport read: ${method} ${href}`)
  }
  const reader = legacy.modules.reader.createGitHubReader({
    owner: "cacheplane",
    repo: "dawnai",
    fetchImpl,
  })
  const writer = legacy.modules.writer.createGitHubWriter({
    owner: "cacheplane",
    repo: "dawnai",
    reader,
    fetchImpl,
  })
  return {
    release,
    calls,
    adoptions,
    patchObservations,
    github: legacy.modules.writer.composeGitHubEffects({ reader, writer }),
    mutations: () => calls.filter(({ method }) => method !== "GET"),
  }
}

export function escrowInput(fixture, github) {
  return {
    candidate: CANDIDATE,
    record: fixture.record,
    artifact: fixture.artifact,
    attestationSet: fixture.attestationSet,
    bundles: fixture.bundles,
    publicationState: fixture.publicationState,
    attestations: fixture.attestations,
    github,
  }
}

// This is a local observation report, never a production fencing authority. A
// missing mutation is deliberately not classified as a safe fence. Input/setup
// failures cannot become success merely because they prevented an HTTP request.
export async function observeLegacyAttempt(remote, operation, invoke) {
  let error = null
  let result = null
  try {
    result = await invoke()
  } catch (failure) {
    error = failure.message
  }
  const mutations = remote.mutations()
  const reachedReleaseObservation = remote.calls.some(
    ({ method, url }) =>
      method === "GET" &&
      [`${API_BASE}/releases?per_page=100`, `${API_BASE}/releases/7`].includes(url),
  )
  return {
    operation,
    disposition:
      mutations.length > 0
        ? "legacy-fence-required"
        : reachedReleaseObservation
          ? "no-mutation-observed"
          : "inconclusive",
    reachedReleaseObservation,
    mutations,
    error,
    result,
  }
}

export function auditFixture(fixture) {
  const dispatch = {
    workflow: ".github/workflows/published-artifact-verify.yml",
    workflowRunId: 501,
    runUrl: `${API_BASE}/actions/runs/501`,
    htmlUrl: "https://github.com/cacheplane/dawnai/actions/runs/501",
  }
  const result = {
    schemaVersion: 1,
    version: VERSION,
    commitSha: COMMIT_SHA,
    manifestSha256: fixture.record.manifestSha256,
    workflowRunId: 501,
    runAttempt: 1,
    startedAt: "2026-08-24T01:00:00Z",
    finishedAt: "2026-08-24T01:01:00Z",
    checks: [{ name: "published-artifacts", conclusion: "success", detail: "verified" }],
    conclusion: "success",
  }
  return { dispatch, result }
}

export function smokeFixture(legacy, fixture) {
  return legacy.modules.smoke.REQUIRED_RELEASE_SMOKE_LANES.map((lane) =>
    legacy.modules.smoke.canonicalSmokeResultBytes({
      schemaVersion: 1,
      lane,
      version: VERSION,
      commitSha: COMMIT_SHA,
      manifestSha256: fixture.record.manifestSha256,
      workflowRunId: 200,
      runAttempt: 1,
      startedAt: "2026-08-24T00:10:00.000Z",
      finishedAt: "2026-08-24T00:11:00.000Z",
      checks: [{ name: "exact-install", conclusion: "success", detail: "verified" }],
      conclusion: "success",
    }),
  )
}
