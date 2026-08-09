import assert from "node:assert/strict"
import { createHash } from "node:crypto"
import { access, readFile } from "node:fs/promises"
import { createServer } from "node:http"
import test from "node:test"
import { fileURLToPath } from "node:url"

import { createGitReader } from "../adapters/git.mjs"
import { createNpmReader } from "../adapters/npm.mjs"
import { planRelease } from "../planner.mjs"
import { orderReleasePackages } from "../topology.mjs"
import { createFaultHarness } from "./support/fault-harness.mjs"
import { startFaultProxy } from "./support/fault-proxy.mjs"
import { createGitFixture } from "./support/git-fixture.mjs"
import { startVerdaccio } from "./support/verdaccio.mjs"

const FIXTURE_DIRECTORY = fileURLToPath(new URL("./fixtures/fault-workspace", import.meta.url))
const VERSION = "1.2.3"
const NEXT_VERSION = "1.2.4"
const PACKAGE_NAMES = ["@fault/base", "@fault/middle", "fault-gate"]

test("Verdaccio uses disposable loopback storage and releases its random port on failure cleanup", async () => {
  let registry
  try {
    registry = await startVerdaccio()
    assert.match(registry.url, /^http:\/\/127\.0\.0\.1:\d+\/$/u)
    assert.equal((await fetch(registry.url)).status, 200)
    await access(registry.directory)
    throw new Error("synthetic test failure")
  } catch (error) {
    assert.equal(error.message, "synthetic test failure")
  } finally {
    await registry?.close()
  }

  await assert.rejects(access(registry.directory), { code: "ENOENT" })
  const port = new URL(registry.url).port
  const probe = createServer()
  await new Promise((resolve, reject) => {
    probe.once("error", reject)
    probe.listen(Number(port), "127.0.0.1", resolve)
  })
  await new Promise((resolve, reject) =>
    probe.close((error) => (error === undefined ? resolve() : reject(error))),
  )
  await registry.close()
})

test("the harness derives dependency order, publishes only locally, and preserves exact tarball bytes", async (t) => {
  const harness = await createFaultHarness({ fixtureDirectory: FIXTURE_DIRECTORY })
  t.after(() => harness.close())
  const manifests = await readFixtureManifests(FIXTURE_DIRECTORY)
  const expectedOrder = orderReleasePackages(manifests, { gateOrder: ["fault-gate"] }).map(
    ({ name }) => name,
  )

  const publication = await harness.packAndPublish()
  assert.deepEqual(
    publication.map(({ name }) => name),
    expectedOrder,
  )
  assert.deepEqual(expectedOrder, PACKAGE_NAMES)
  assert.ok(publication.every(({ registryUrl }) => registryUrl === harness.registry.url))

  const reader = createNpmReader({
    registryUrl: harness.registry.url,
    trustedRegistryOrigins: [new URL(harness.registry.url).origin],
  })
  for (const packed of publication) {
    const observed = await reader.observePackageVersion({ name: packed.name, version: VERSION })
    assert.equal(observed.status, "PRESENT")
    const downloaded = Buffer.from(await (await fetch(observed.package.tarballUrl)).arrayBuffer())
    assert.equal(sha256(downloaded), packed.sha256)
    assert.equal(sha256(await readFile(packed.tarballPath)), packed.sha256)
  }

  const thirdObservation = await Promise.all(
    publication.map(({ name }) => reader.observePackageVersion({ name, version: VERSION })),
  )
  assert.ok(thirdObservation.every(({ status }) => status === "PRESENT"))

  const disposableDirectories = [
    harness.runtimeDirectory,
    harness.registry.directory,
    harness.git.directory,
  ]
  const proxyUrl = harness.proxy.url
  await harness.close()
  for (const directory of disposableDirectories) {
    await assert.rejects(access(directory), { code: "ENOENT" })
  }
  await assert.rejects(fetch(proxyUrl, { signal: AbortSignal.timeout(500) }))
})

test("the production npm reader distinguishes exact absence and every deterministic proxy fault", async (t) => {
  const harness = await createFaultHarness({ fixtureDirectory: FIXTURE_DIRECTORY })
  t.after(() => harness.close())
  await harness.packAndPublish()
  const reader = createNpmReader({
    registryUrl: harness.proxy.url,
    trustedRegistryOrigins: [new URL(harness.proxy.url).origin],
    timeoutMs: 100,
  })

  harness.proxy.setMode("delayed-visibility", { misses: 1 })
  const delayedMissing = await reader.observePackageVersion({
    name: PACKAGE_NAMES[0],
    version: VERSION,
  })
  assert.equal(delayedMissing.status, "ABSENT")
  assert.equal(
    (await reader.observePackageVersion({ name: PACKAGE_NAMES[0], version: VERSION })).status,
    "PRESENT",
  )
  const visibleLatest = await reader.observePackageMetadata({ name: PACKAGE_NAMES[0] })
  assertPlannerDisposition({
    exact: delayedMissing,
    latest: visibleLatest,
    blocked: false,
    candidateVersion: VERSION,
  })

  harness.proxy.setMode("exact-version-e404")
  const exactMissing = await reader.observePackageVersion({
    name: PACKAGE_NAMES[0],
    version: NEXT_VERSION,
  })
  assert.deepEqual(pickClassification(exactMissing), {
    status: "ABSENT",
    operation: "package-version",
    httpStatus: 404,
    code: "E404",
  })
  const latest = await reader.observePackageMetadata({ name: PACKAGE_NAMES[0] })
  assert.equal(latest.status, "PRESENT")
  assert.equal(latest.metadata.latest, VERSION)
  assertPlannerDisposition({ exact: exactMissing, latest, blocked: false })

  harness.proxy.setMode("package-e404")
  const missingPackage = await reader.observePackageMetadata({ name: PACKAGE_NAMES[0] })
  assert.deepEqual(pickClassification(missingPackage), {
    status: "AMBIGUOUS",
    operation: "package-metadata",
    httpStatus: 404,
    code: "E404",
  })
  const exactUnderPackageFault = await reader.observePackageVersion({
    name: PACKAGE_NAMES[0],
    version: NEXT_VERSION,
  })
  assertPlannerDisposition({ exact: exactUnderPackageFault, latest: missingPackage, blocked: true })

  const rows = [
    ["unauthorized", "AMBIGUOUS", 401],
    ["forbidden", "AMBIGUOUS", 403],
    ["rate-limited", "AMBIGUOUS", 429],
    ["malformed-json", "ERROR", 200],
    ["server-error", "AMBIGUOUS", 500],
    ["unavailable", "AMBIGUOUS", 503],
    ["stall", "AMBIGUOUS", null],
  ]
  for (const [mode, status, httpStatus] of rows) {
    harness.proxy.setMode(mode)
    const stalledClient = mode === "stall" ? harness.proxy.waitForNextAbort() : null
    const observed = await reader.observePackageVersion({
      name: PACKAGE_NAMES[0],
      version: NEXT_VERSION,
    })
    assert.equal(observed.status, status, mode)
    assert.equal(observed.httpStatus, httpStatus, mode)
    assertPlannerDisposition({ exact: observed, latest: null, blocked: true })
    await stalledClient
  }
  assert.ok(harness.proxy.snapshot().abortedRequests >= 1)
})

test("the fault proxy is loopback-only, has no network control endpoint, and resets in process", async (t) => {
  const registry = await startVerdaccio()
  const proxy = await startFaultProxy({ upstreamUrl: registry.url })
  t.after(async () => {
    await proxy.close()
    await registry.close()
  })
  assert.match(proxy.url, /^http:\/\/127\.0\.0\.1:\d+\/$/u)
  proxy.setMode("unauthorized")
  assert.equal((await fetch(new URL("-/fault-control", proxy.url))).status, 401)
  proxy.reset()
  assert.notEqual((await fetch(new URL("-/fault-control", proxy.url))).status, 200)
  assert.throws(() => proxy.setMode("arbitrary"), /fault mode/u)
})

test("the temporary Git fixture keeps identity local and production reads the advanced annotated tag", async (t) => {
  const inheritedGitDirectory = Reflect.get(process.env, "GIT_DIR")
  Reflect.set(process.env, "GIT_DIR", "/dev/null")
  let fixture
  try {
    fixture = await createGitFixture({ sourceDirectory: FIXTURE_DIRECTORY })
  } finally {
    if (inheritedGitDirectory === undefined) Reflect.deleteProperty(process.env, "GIT_DIR")
    else Reflect.set(process.env, "GIT_DIR", inheritedGitDirectory)
  }
  t.after(() => fixture.close())
  const reader = createGitReader({ root: fixture.workingDirectory })

  assert.equal(await reader.resolveTag({ tag: `v${VERSION}` }), fixture.oldCommitSha)
  assert.equal(
    await reader.isAncestor({ ancestor: fixture.oldCommitSha, descendant: fixture.mainCommitSha }),
    true,
  )
  assert.deepEqual(await reader.listFirstParentHistory({ ref: "main", maxCount: 2 }), [
    fixture.mainCommitSha,
    fixture.oldCommitSha,
  ])
  assert.equal(
    (await reader.listFirstParentHistory({ ref: "origin/main", maxCount: 1 }))[0],
    fixture.mainCommitSha,
  )
  assert.equal(
    (
      await readFile(new URL("config", `file://${fixture.workingDirectory}/.git/`), "utf8")
    ).includes(fixture.bareRemoteDirectory),
    true,
  )
  const localConfig = await readFile(
    new URL("config", `file://${fixture.workingDirectory}/.git/`),
    "utf8",
  )
  assert.match(localConfig, /name = Release Fault Fixture/u)
  assert.match(localConfig, /email = fault@example\.invalid/u)

  const repeated = await createGitFixture({ sourceDirectory: FIXTURE_DIRECTORY })
  t.after(() => repeated.close())
  assert.equal(repeated.oldCommitSha, fixture.oldCommitSha)
  assert.equal(repeated.mainCommitSha, fixture.mainCommitSha)
})

async function readFixtureManifests(root) {
  return Promise.all(
    ["base", "middle", "gate"].map(async (directory) =>
      JSON.parse(await readFile(`${root}/packages/${directory}/package.json`, "utf8")),
    ),
  )
}

function assertPlannerDisposition({ exact, latest, blocked, candidateVersion = NEXT_VERSION }) {
  const candidate = {
    version: candidateVersion,
    commitSha: "0123456789abcdef0123456789abcdef01234567",
    ciWorkflow: "CI",
    ciCheck: "validate",
    publisherWorkflow: ".github/workflows/release.yml",
  }
  const packages = PACKAGE_NAMES.map((name, index) =>
    packageIdentity(name, index, candidateVersion),
  )
  const observation = plannerObservation(candidate, packages)
  if (exact.status !== "ABSENT") {
    observation.registry.packages[0] = ambiguousRegistryPackage(PACKAGE_NAMES[0])
  } else {
    observation.registry.packages[0].latest = {
      status: latest?.status === "PRESENT" ? "present" : "ambiguous",
      version: latest?.status === "PRESENT" ? latest.metadata.latest : null,
    }
  }
  const plan = planRelease({ candidate, observation, mode: "shadow" })
  assert.equal(plan.disposition, blocked ? "blocked" : "would-transition")
  assert.deepEqual(plan.proposedMutations.length, blocked ? 0 : 1)
}

function plannerObservation(candidate, packages) {
  const pendingAttestations = [
    ...packages.map((pkg) => ({
      name: pkg.attestationFilename,
      status: "pending",
      sha256: null,
      subjectName: pkg.filename,
      subjectSha256: pkg.tarballSha256,
    })),
    {
      name: "manifest.json.intoto.jsonl",
      status: "pending",
      sha256: null,
      subjectName: "manifest.json",
      subjectSha256: "a".repeat(64),
    },
  ]
  return {
    inventory: { status: "valid", packages },
    ci: {
      status: "success",
      workflow: candidate.ciWorkflow,
      check: candidate.ciCheck,
      commitSha: candidate.commitSha,
    },
    otherCandidates: [],
    tag: { status: "absent", commitSha: null },
    artifacts: {
      status: "absent",
      manifestVersion: null,
      manifestCommitSha: null,
      manifestSha256: null,
      files: packages.map((pkg) => ({
        name: pkg.name,
        status: "pending",
        assetName: pkg.filename,
        sha256: null,
        integrity: null,
      })),
      manifestAsset: { name: "manifest.json", sha256: null },
      releaseRecordAsset: { name: "release-record.json", sha256: null },
      manifestAttestationAsset: { name: "manifest.json.intoto.jsonl", sha256: null },
      attestations: pendingAttestations,
    },
    escrow: { status: "absent", manifestSha256: null, assets: [] },
    registry: {
      publishJobStarted: false,
      mutationStarted: false,
      packages: packages.map(({ name }) => absentRegistryPackage(name)),
    },
    release: {
      status: "absent",
      tag: null,
      commitSha: null,
      metadataReconciled: false,
      assets: [],
    },
    requiredSmokeLanes: ["install"],
    smokes: [
      {
        name: "install",
        status: "pending",
        version: candidate.version,
        commitSha: candidate.commitSha,
        manifestSha256: null,
        workflowRunId: 1,
        runAttempt: 1,
      },
    ],
    audit: {
      status: "none",
      version: null,
      commitSha: null,
      manifestSha256: null,
      workflowRunId: null,
      runAttempt: null,
      conclusion: null,
    },
    abandonment: { requested: false, recorded: false },
  }
}

function packageIdentity(name, index, version) {
  const stem = name.startsWith("@") ? name.slice(1).replace("/", "-") : name
  return {
    name,
    version,
    filename: `${stem}-${version}.tgz`,
    tarballSha256: String(index + 1).repeat(64),
    attestationFilename: `${stem}-${version}.tgz.intoto.jsonl`,
    attestationSha256: String(index + 4).repeat(64),
    integrity: `sha512-${Buffer.alloc(64, index + 1).toString("base64")}`,
  }
}

function absentRegistryPackage(name) {
  return {
    name,
    status: "e404",
    version: null,
    tarballSha256: null,
    integrity: null,
    latest: { status: "e404", version: null },
    signature: { status: "missing" },
    provenance: null,
  }
}

function ambiguousRegistryPackage(name) {
  return {
    name,
    status: "ambiguous",
    version: null,
    tarballSha256: null,
    integrity: null,
    latest: { status: "ambiguous", version: null },
    signature: { status: "ambiguous" },
    provenance: null,
  }
}

function pickClassification(value) {
  return {
    status: value.status,
    operation: value.operation,
    httpStatus: value.httpStatus,
    code: value.code,
  }
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex")
}
