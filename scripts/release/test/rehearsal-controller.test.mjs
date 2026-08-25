import assert from "node:assert/strict"
import { createHash } from "node:crypto"
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import test from "node:test"

import { runReleaseCli } from "../cli.mjs"
import { CANONICAL_RELEASE_PACKAGE_ORDER, canonicalManifestBytes } from "../manifest.mjs"
import { canonicalBaseAssetSet } from "../metadata.mjs"
import { canonicalNpmEvidenceBytes } from "../npm-evidence.mjs"
import { planRelease } from "../planner.mjs"
import { canonicalReleaseRecordBytes, createReleaseRecord } from "../release-record.mjs"
import { canonicalSmokeResultBytes, REQUIRED_RELEASE_SMOKE_LANES } from "../smoke-result.mjs"
import {
  MANIFEST_SHA256,
  candidate as markerCandidate,
  observationForMarker,
} from "./support/marker-observation.mjs"
import { createOrderedFaultGate, driveRehearsalController } from "./support/release-rehearsal.mjs"
import {
  applyRehearsalAttestationReceipt,
  applyRehearsalSmokeReceipts,
  createRehearsalCliObserver,
  runRehearsalControllerStep,
} from "./support/release-rehearsal-controller.mjs"
import {
  createRehearsalArtifactUploadResult,
  createRehearsalGitHub,
} from "./support/release-rehearsal-github.mjs"

const VERSION = "0.8.22"
const COMMIT_SHA = "a".repeat(40)
const CONTROLLER_MARKER = Object.freeze({
  schemaVersion: 1,
  publishingOwner: "release-controller",
  epoch: "fixed-group-v1",
  npmTrustedPublisherEnvironment: null,
  abandonmentEnvironment: "release-abandonment",
})

test("workflow attestation evidence advances only after verifying the exact prepared artifact", async () => {
  const fixture = preparedFixture()
  const calls = []
  const observation = preparedObservation(fixture)

  const result = await applyRehearsalAttestationReceipt({
    observation,
    candidate: fixture.candidate,
    record: fixture.record,
    artifact: fixture.artifact,
    bundleBytes: multiSubjectBundle(fixture),
    attestations: {
      async verify(input) {
        calls.push(input)
        return { status: "VERIFIED", subjects: input.subjects }
      },
    },
  })

  assert.equal(result.artifacts.status, "attested")
  assert.ok(result.inventory.packages.every((pkg) => pkg.attestationSha256 !== null))
  assert.ok(result.artifacts.attestations.every((entry) => entry.status === "valid"))
  assert.equal(calls.length, 1)
  assert.equal(calls[0].subjects.length, 22)
  assert.deepEqual(
    observation,
    preparedObservation(fixture),
    "the production observation is immutable",
  )
})

test("workflow attestation evidence rejects an incomplete observed package inventory", async () => {
  const fixture = preparedFixture()
  const observation = preparedObservation(fixture)
  observation.inventory.packages.pop()

  await assert.rejects(
    applyRehearsalAttestationReceipt({
      observation,
      candidate: fixture.candidate,
      record: fixture.record,
      artifact: fixture.artifact,
      bundleBytes: multiSubjectBundle(fixture),
      attestations: {
        async verify(input) {
          return { status: "VERIFIED", subjects: input.subjects }
        },
      },
    }),
    /exact.*package|package.*inventory/iu,
  )
})

test("malformed workflow attestation bytes cannot advance prepared evidence", async () => {
  const fixture = preparedFixture()

  await assert.rejects(
    applyRehearsalAttestationReceipt({
      observation: preparedObservation(fixture),
      candidate: fixture.candidate,
      record: fixture.record,
      artifact: fixture.artifact,
      bundleBytes: Buffer.from("not a sigstore bundle\n"),
      attestations: {
        async verify() {
          throw new Error("the external verifier must not receive malformed bundle bytes")
        },
      },
    }),
    /attestation|bundle|json/iu,
  )
})

test("canonical correlated smoke receipts let the real planner select reconciliation", () => {
  const candidate = markerCandidate()
  const observation = smokeObservation()
  const receipts = REQUIRED_RELEASE_SMOKE_LANES.map((lane) =>
    canonicalSmokeResultBytes(smokeReceipt({ lane, candidate })),
  )

  const enriched = applyRehearsalSmokeReceipts({ observation, candidate, receipts })
  const plan = planRelease({ candidate, observation: enriched, mode: "controller" })

  assert.equal(plan.state, "RELEASE_DRAFT_COMPLETE")
  assert.equal(plan.nextTransition, "reconcile-smoke-evidence")
  assert.deepEqual(plan.conflicts, [])
  assert.ok(enriched.smokes.every((smoke) => smoke.status === "passed"))
})

test("workflow smoke evidence cannot replace an incomplete production observation", () => {
  const candidate = markerCandidate()
  const observation = smokeObservation()
  observation.smokes.pop()
  const receipts = REQUIRED_RELEASE_SMOKE_LANES.map((lane) =>
    canonicalSmokeResultBytes(smokeReceipt({ lane, candidate })),
  )

  assert.throws(
    () => applyRehearsalSmokeReceipts({ observation, candidate, receipts }),
    /production.*smoke|smoke.*observation/iu,
  )
})

test("missing or mismatched workflow smoke receipts cannot advance", () => {
  const candidate = markerCandidate()
  const observation = smokeObservation()
  const exact = REQUIRED_RELEASE_SMOKE_LANES.map((lane) =>
    canonicalSmokeResultBytes(smokeReceipt({ lane, candidate })),
  )
  const mismatched = [...exact]
  mismatched[0] = canonicalSmokeResultBytes({
    ...smokeReceipt({ lane: REQUIRED_RELEASE_SMOKE_LANES[0], candidate }),
    commitSha: "f".repeat(40),
  })

  assert.throws(
    () => applyRehearsalSmokeReceipts({ observation, candidate, receipts: exact.slice(1) }),
    /every canonical lane|exact pending production smoke/iu,
  )
  assert.throws(
    () => applyRehearsalSmokeReceipts({ observation, candidate, receipts: mismatched }),
    /commit|correlat|candidate|identity/iu,
  )
})

test("the rehearsal observer obtains every snapshot through the exact production observe CLI route", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "dawn-rehearsal-observer-test-"))
  t.after(() => rm(directory, { recursive: true, force: true }))
  const candidate = markerCandidate()
  const productionObservation = observationForMarker({ phase: "ESCROWED" })
  const calls = []
  const dependencies = { githubReader: Object.freeze({}) }
  const productionReport = {
    schemaVersion: 1,
    candidate,
    before: {
      observation: productionObservation,
      plan: planRelease({ candidate, observation: productionObservation, mode: "controller" }),
    },
    transition: {
      name: "publish-npm-packages",
      status: "dry-run",
      result: null,
      error: null,
    },
    after: null,
    recovery: null,
    diagnostics: [
      {
        source: "github",
        operation: "releases",
        status: "AMBIGUOUS",
        httpStatus: null,
        code: "RELEASE_CONTENT_INVALID",
      },
    ],
  }
  const observer = createRehearsalCliObserver({
    candidate,
    directory,
    dependencies,
    async runCli(argv, dependencies) {
      calls.push({ argv, dependencies })
      const reportPath = argv[argv.indexOf("--report") + 1]
      await writeFile(reportPath, `${JSON.stringify(productionReport)}\n`)
      return productionReport
    },
  })

  const observed = await observer.observe({ candidate })

  assert.deepEqual(observed, productionObservation)
  assert.equal(calls.length, 1)
  assert.equal(calls[0].argv[0], "observe")
  assert.deepEqual(
    calls[0].argv.filter((_value, index) => index % 2 === 1),
    ["--event", "--report", "--github-output"],
  )
  assert.equal(calls[0].dependencies.githubReader, dependencies.githubReader)
  assert.deepEqual(
    JSON.parse(await readFile(observer.latestProductionReportPath(), "utf8")),
    productionReport,
  )
  assert.deepEqual(observer.latestDiagnostics(), [
    {
      source: "github",
      operation: "releases",
      status: "AMBIGUOUS",
      httpStatus: null,
      code: "RELEASE_CONTENT_INVALID",
    },
  ])
})

test("candidate-discovery ambiguity retains the direct production resolution cause", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "dawn-rehearsal-discovery-diagnostic-test-"))
  t.after(() => rm(directory, { recursive: true, force: true }))
  const candidate = markerCandidate()
  const observer = createRehearsalCliObserver({
    candidate,
    directory,
    dependencies: {
      git: {},
      inventory: {},
      githubReader: {},
      npm: {},
      npmAuditFactory: {},
      attestations: {},
      controllerMarker: CONTROLLER_MARKER,
    },
    async resolveCandidate() {
      throw new Error("managed release audit asset is invalid")
    },
    async runCli() {
      return {
        candidate: null,
        before: {
          observation: { status: "ambiguous", code: "CANDIDATE_DISCOVERY_AMBIGUOUS" },
          plan: {
            state: "NO_CANDIDATE",
            disposition: "blocked",
            nextTransition: null,
            reasons: [],
            conflicts: ["candidate-discovery-ambiguous"],
            proposedMutations: [],
          },
        },
        diagnostics: [{ code: "CANDIDATE_DISCOVERY_AMBIGUOUS" }],
      }
    },
  })

  await assert.rejects(
    observer.observe({ candidate }),
    /CANDIDATE_DISCOVERY_AMBIGUOUS.*managed release audit asset is invalid/iu,
  )
})

test("durable post-reconcile production observations discard workflow receipt overlays", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "dawn-rehearsal-durable-observer-test-"))
  t.after(() => rm(directory, { recursive: true, force: true }))
  const candidate = markerCandidate()
  const productionObservation = observationForMarker({ phase: "SMOKES_COMPLETE" })
  const observer = createRehearsalCliObserver({
    candidate,
    directory,
    dependencies: {},
    receipts: {
      async readAttestation() {
        throw new Error("durable observation must not read the attestation overlay")
      },
      async readSmokes() {
        throw new Error("durable observation must not read the smoke overlay")
      },
    },
    async runCli() {
      return {
        candidate,
        before: { observation: productionObservation },
      }
    },
  })

  assert.deepEqual(await observer.observe({ candidate }), productionObservation)
})

test("pre-escrow observe CLI output is enriched only through the verified workflow receipt", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "dawn-rehearsal-attestation-observer-test-"))
  t.after(() => rm(directory, { recursive: true, force: true }))
  const fixture = preparedFixture()
  const observation = {
    ...preparedObservation(fixture),
    release: { status: "absent" },
  }
  const observer = createRehearsalCliObserver({
    candidate: fixture.candidate,
    directory,
    dependencies: {
      attestations: {
        async verify(input) {
          return { status: "VERIFIED", subjects: input.subjects }
        },
      },
    },
    receipts: {
      async readAttestation() {
        return {
          record: fixture.record,
          artifact: fixture.artifact,
          bundleBytes: multiSubjectBundle(fixture),
        }
      },
      async readSmokes() {
        return null
      },
    },
    async runCli() {
      return { candidate: fixture.candidate, before: { observation } }
    },
  })

  const enriched = await observer.observe({ candidate: fixture.candidate })
  assert.equal(enriched.artifacts.status, "attested")
  assert.equal(observation.artifacts.status, "prepared")
})

test("the real planner and one-transition controller select the rehearsal route", async () => {
  const candidate = markerCandidate()
  const observations = [
    observationForMarker({ phase: "ESCROWED" }),
    observationForMarker({ phase: "ESCROWED" }),
  ]
  const routed = []
  const reports = []

  const result = await runRehearsalControllerStep({
    candidate,
    observer: {
      async observe() {
        return observations.shift()
      },
    },
    effects: {
      async "publish-npm-packages"(context) {
        routed.push(context.plan.nextTransition)
        return { published: 1 }
      },
    },
    reporter: {
      async write(report) {
        reports.push(report)
      },
    },
  })

  assert.deepEqual(routed, ["publish-npm-packages"])
  assert.equal(result.transition.name, "publish-npm-packages")
  assert.equal(result.transition.status, "completed")
  assert.equal(reports.length, 1)
})

test("a missing controller-selected rehearsal route fails closed", async () => {
  const candidate = markerCandidate()

  await assert.rejects(
    runRehearsalControllerStep({
      candidate,
      observer: {
        async observe() {
          return observationForMarker({ phase: "ESCROWED" })
        },
      },
      effects: {},
      reporter: { async write() {} },
    }),
    (error) => error?.code === "RELEASE_EFFECT_UNAVAILABLE",
  )
})

test("the rehearsal reports the selected production route and nested failure cause", async () => {
  const candidate = markerCandidate()

  await assert.rejects(
    driveRehearsalController({
      candidate,
      observer: {
        async observe() {
          return observationForMarker({ phase: "ESCROWED" })
        },
      },
      effects: {
        async "publish-npm-packages"() {
          throw new Error("nested executor failure")
        },
      },
      reporter: { async write() {} },
      maximumAttempts: 1,
    }),
    /publish-npm-packages.*RELEASE_TRANSITION_FAILED.*nested executor failure/iu,
  )
})

test("the rehearsal resumes a controller-selected accepted transition and terminates from observation", async () => {
  const candidate = markerCandidate()
  const gate = createOrderedFaultGate(["after-release-publication"])
  let observation = observationForMarker({ phase: "AUDIT_VERIFIED" })
  const reports = []

  const result = await driveRehearsalController({
    candidate,
    observer: {
      async observe() {
        return observation
      },
    },
    effects: {
      async "publish-github-release"() {
        return gate.around("release-publication", async () => {
          observation = observationForMarker({
            phase: "AUDIT_VERIFIED",
            releaseStatus: "published",
          })
          return { immutable: true }
        })
      },
    },
    reporter: {
      async write(report) {
        reports.push(report)
      },
    },
    maximumAttempts: 3,
  })

  assert.equal(result.state, "AUDIT_COMPLETE")
  assert.deepEqual(result.recoveredFaults, ["after-release-publication"])
  assert.equal(result.terminalReport.before.plan.disposition, "noop")
  assert.equal(reports.length, 2)
})

test("bounded rehearsal adapters classify the untouched candidate through the real observe CLI", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "dawn-rehearsal-production-cli-test-"))
  t.after(() => rm(directory, { recursive: true, force: true }))
  const candidate = markerCandidate()
  const parentSha = "e".repeat(40)
  const remote = createRehearsalGitHub({
    candidate,
    gate: createOrderedFaultGate([]),
    async tagResolver() {
      return null
    },
  })
  const observer = createRehearsalCliObserver({
    candidate,
    directory,
    dependencies: {
      cwd: directory,
      git: {
        async listFirstParentHistory() {
          return [candidate.commitSha]
        },
        async firstParent() {
          return parentSha
        },
        async isAncestor() {
          return true
        },
        async listTree() {
          return "scripts/release/controller-schema.json\n"
        },
        async showFile() {
          return `${JSON.stringify(CONTROLLER_MARKER)}\n`
        },
        async resolveTag() {
          throw Object.assign(new Error("tag absent"), { code: "TAG_ABSENT" })
        },
      },
      inventory: {
        async read({ ref }) {
          const version = ref === parentSha ? "0.8.21" : candidate.version
          return {
            status: "valid",
            packages: [...CANONICAL_RELEASE_PACKAGE_ORDER]
              .sort()
              .map((name) => ({ name, version })),
          }
        },
      },
      githubReader: remote.releaseGitHub.reader,
      npm: absentNpmReader(),
      attestations: { async verify() {} },
      controllerMarker: CONTROLLER_MARKER,
    },
  })

  const observation = await observer.observe({ candidate })
  const plan = planRelease({ candidate, observation, mode: "controller" })

  assert.equal(plan.state, "CANDIDATE_VALIDATED")
  assert.equal(plan.nextTransition, "create-candidate-tag")
})

test("the real observe CLI proves preparation from exact Actions payload and handoff bytes", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "dawn-rehearsal-prepared-cli-test-"))
  t.after(() => rm(directory, { recursive: true, force: true }))
  const fixture = preparedFixture()
  const remote = createRehearsalGitHub({
    candidate: fixture.candidate,
    gate: createOrderedFaultGate([]),
  })
  remote.recordPreparedArtifact({ record: fixture.record, artifact: fixture.artifact })
  const observer = productionCliObserver({
    directory,
    candidate: fixture.candidate,
    remote,
  })

  const observation = await observer.observe({ candidate: fixture.candidate })
  const plan = planRelease({
    candidate: fixture.candidate,
    observation,
    mode: "controller",
  })

  assert.equal(observation.artifacts.status, "prepared")
  assert.equal(plan.state, "ARTIFACTS_PREPARED")
  assert.equal(plan.nextTransition, "attest-artifacts")
})

test("the verified attestation receipt lets the real CLI observation and planner select escrow", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "dawn-rehearsal-attested-cli-test-"))
  t.after(() => rm(directory, { recursive: true, force: true }))
  const fixture = preparedFixture()
  const remote = createRehearsalGitHub({
    candidate: fixture.candidate,
    gate: createOrderedFaultGate([]),
  })
  remote.recordPreparedArtifact({ record: fixture.record, artifact: fixture.artifact })
  const observer = productionCliObserver({
    directory,
    candidate: fixture.candidate,
    remote,
    receipts: {
      async readAttestation() {
        return {
          record: fixture.record,
          artifact: fixture.artifact,
          bundleBytes: multiSubjectBundle(fixture),
        }
      },
      async readSmokes() {
        return null
      },
    },
  })

  const observation = await observer.observe({ candidate: fixture.candidate })
  const plan = planRelease({
    candidate: fixture.candidate,
    observation,
    mode: "controller",
  })

  assert.equal(observation.artifacts.status, "attested")
  assert.equal(plan.state, "ARTIFACTS_ATTESTED")
  assert.equal(plan.nextTransition, "escrow-candidate")
})

test("the real escrow CLI produces durable evidence that the production observer classifies", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "dawn-rehearsal-escrow-cli-test-"))
  t.after(() => rm(directory, { recursive: true, force: true }))
  const fixture = preparedFixture()
  const attestation = attestationFixture(fixture)
  const base = canonicalBaseAssetSet({
    record: fixture.record,
    artifact: fixture.artifact,
    attestationSet: attestation.set,
    bundles: attestation.bundles,
  })
  const remote = createRehearsalGitHub({
    candidate: fixture.candidate,
    gate: createOrderedFaultGate([]),
    baseAssetNames: base.assets.map(({ name }) => name),
  })
  remote.recordPreparedArtifact({ record: fixture.record, artifact: fixture.artifact })
  const paths = await writeEscrowInputs({
    directory,
    fixture,
    bundleBytes: attestation.bundleBytes,
  })

  for (let attempt = 0; attempt < 2; attempt += 1) {
    await runReleaseCli(
      [
        "attestation-output",
        "--record",
        paths.record,
        "--artifact-dir",
        paths.artifact,
        "--bundle",
        paths.bundle,
        "--attestation-set",
        paths.attestationSet,
        "--attestation-bundles-dir",
        paths.attestationBundles,
      ],
      {
        cwd: directory,
        attestations: {
          async verify({ subjects }) {
            return { status: "VERIFIED", subjects }
          },
        },
      },
    )
  }

  await runReleaseCli(
    [
      "escrow",
      "--candidate",
      paths.candidate,
      "--record",
      paths.record,
      "--artifact-dir",
      paths.artifact,
      "--attestation-set",
      paths.attestationSet,
      "--attestation-bundles-dir",
      paths.attestationBundles,
    ],
    {
      cwd: directory,
      github: remote.releaseGitHub,
      npm: absentNpmReader(),
      attestations: {
        async verify({ subjects }) {
          return { status: "VERIFIED", subjects }
        },
      },
      environment: releaseEnvironment(fixture.candidate),
      now: () => Date.parse("2026-08-25T00:05:00.000Z"),
    },
  )
  const observer = productionCliObserver({
    directory,
    candidate: fixture.candidate,
    remote,
  })

  const observation = await observer.observe({ candidate: fixture.candidate })
  const plan = planRelease({
    candidate: fixture.candidate,
    observation,
    mode: "controller",
  })

  assert.equal(observation.escrow.status, "present")
  assert.equal(observation.release.marker.phase, "ESCROWED")
  assert.equal(plan.state, "CANDIDATE_ESCROWED")
  assert.equal(plan.nextTransition, "publish-npm-packages")
})

test("real registry observations drive partial, complete, and reconciled npm planner states", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "dawn-rehearsal-npm-observe-test-"))
  t.after(() => rm(directory, { recursive: true, force: true }))
  const fixture = preparedFixture()
  const { remote, paths } = await escrowedFixture({ directory, fixture })
  remote.recordPublisherStarted()
  const partialDirectory = join(directory, "partial-observe")
  const completeDirectory = join(directory, "complete-observe")
  await Promise.all([mkdir(partialDirectory), mkdir(completeDirectory)])

  const partialObserver = productionCliObserver({
    directory: partialDirectory,
    candidate: fixture.candidate,
    remote,
    npm: presentNpmReader(fixture, 1),
  })
  const partial = await partialObserver.observe({ candidate: fixture.candidate })
  const partialPlan = planRelease({
    candidate: fixture.candidate,
    observation: partial,
    mode: "controller",
  })
  assert.equal(partialPlan.state, "NPM_PARTIAL")
  assert.equal(partialPlan.nextTransition, "resume-npm-publish")

  const npmEvidence = npmEvidenceFixture(fixture)
  const npmEvidencePath = join(directory, "npm-evidence.json")
  await writeFile(
    npmEvidencePath,
    canonicalNpmEvidenceBytes(npmEvidence, {
      candidate: fixture.candidate,
      manifest: fixture.artifact.manifest,
      manifestSha256: fixture.record.manifestSha256,
    }),
  )
  const completeObserver = productionCliObserver({
    directory: completeDirectory,
    candidate: fixture.candidate,
    remote,
    npm: presentNpmReader(fixture, 21),
  })
  const complete = await completeObserver.observe({ candidate: fixture.candidate })
  const completePlan = planRelease({
    candidate: fixture.candidate,
    observation: complete,
    mode: "controller",
  })
  assert.equal(completePlan.state, "NPM_COMPLETE")
  assert.equal(completePlan.nextTransition, "reconcile-npm-evidence")

  await runReleaseCli(
    [
      "reconcile-npm",
      "--candidate",
      paths.candidate,
      "--record",
      paths.record,
      "--manifest",
      join(paths.artifact, "manifest.json"),
      "--npm-evidence",
      npmEvidencePath,
    ],
    { cwd: directory, github: remote.releaseGitHub },
  )
  const reconciled = await completeObserver.observe({ candidate: fixture.candidate })
  const reconciledPlan = planRelease({
    candidate: fixture.candidate,
    observation: reconciled,
    mode: "controller",
  })
  assert.equal(reconciled.release.marker.phase, "NPM_COMPLETE")
  assert.equal(reconciledPlan.state, "RELEASE_DRAFT_COMPLETE")
  assert.equal(reconciledPlan.nextTransition, "run-release-smokes")
})

function smokeObservation() {
  const observation = observationForMarker({ phase: "NPM_COMPLETE" })
  observation.requiredSmokeLanes = [...REQUIRED_RELEASE_SMOKE_LANES]
  observation.smokes = REQUIRED_RELEASE_SMOKE_LANES.map((name) => ({
    name,
    status: "pending",
    version: observation.release.marker.version,
    commitSha: observation.release.marker.commitSha,
    manifestSha256: observation.release.marker.manifestSha256,
    workflowRunId: null,
    runAttempt: null,
  }))
  return observation
}

function smokeReceipt({ lane, candidate }) {
  return {
    schemaVersion: 1,
    lane,
    version: candidate.version,
    commitSha: candidate.commitSha,
    manifestSha256: MANIFEST_SHA256,
    workflowRunId: 400,
    runAttempt: 1,
    startedAt: "2026-08-25T00:10:00.000Z",
    finishedAt: "2026-08-25T00:11:00.000Z",
    checks: [{ name: "exact-local-registry", conclusion: "success", detail: "verified" }],
    conclusion: "success",
  }
}

function preparedFixture() {
  const candidate = {
    version: VERSION,
    commitSha: COMMIT_SHA,
    ciWorkflow: "CI",
    ciCheck: "validate",
    publisherWorkflow: ".github/workflows/release.yml",
  }
  const files = []
  const packages = CANONICAL_RELEASE_PACKAGE_ORDER.map((name) => {
    const bytes = Buffer.from(`packed:${name}`)
    const sha512 = hash("sha512", bytes)
    const filename = `${name.replace(/^@/u, "").replace("/", "-")}-${VERSION}.tgz`
    files.push({ name: filename, bytes })
    return {
      name,
      version: VERSION,
      filename,
      size: bytes.byteLength,
      sha256: hash("sha256", bytes),
      sha512,
      npmIntegrity: `sha512-${Buffer.from(sha512, "hex").toString("base64")}`,
      access: "public",
    }
  })
  const manifest = {
    schemaVersion: 1,
    version: VERSION,
    commitSha: COMMIT_SHA,
    ci: { workflow: "CI", runId: 100, runAttempt: 1 },
    artifact: {
      name: `release-v${VERSION}-${COMMIT_SHA.slice(0, 12)}`,
      prepareRunId: 300,
      prepareRunAttempt: 1,
    },
    packageOrder: [...CANONICAL_RELEASE_PACKAGE_ORDER],
    packages,
  }
  files.unshift({ name: "manifest.json", bytes: canonicalManifestBytes(manifest) })
  const artifact = { manifest, files }
  const upload = createRehearsalArtifactUploadResult({ candidate, artifact })
  const record = createReleaseRecord({
    candidate,
    manifestSha256: hash("sha256", canonicalManifestBytes(manifest)),
    artifact: { name: manifest.artifact.name },
    artifactUpload: { id: upload.artifactId, digest: `sha256:${upload.artifactDigest}` },
    prepareRun: { id: 300, attempt: 1 },
  })
  return { candidate, record, artifact }
}

function preparedObservation(fixture) {
  const packages = fixture.artifact.manifest.packages.map((pkg) => ({
    name: pkg.name,
    version: pkg.version,
    filename: pkg.filename,
    tarballSha256: pkg.sha256,
    attestationFilename: `${pkg.filename}.intoto.jsonl`,
    attestationSha256: null,
    integrity: pkg.npmIntegrity,
  }))
  return {
    inventory: { status: "valid", packages },
    artifacts: {
      status: "prepared",
      manifestVersion: VERSION,
      manifestCommitSha: COMMIT_SHA,
      manifestSha256: fixture.record.manifestSha256,
      files: packages.map((pkg) => ({
        name: pkg.name,
        status: "valid",
        assetName: pkg.filename,
        sha256: pkg.tarballSha256,
        integrity: pkg.integrity,
      })),
      manifestAsset: { name: "manifest.json", sha256: fixture.record.manifestSha256 },
      releaseRecordAsset: {
        name: "release-record.json",
        sha256: hash("sha256", Buffer.from(JSON.stringify(fixture.record))),
      },
      manifestAttestationAsset: { name: "manifest.json.intoto.jsonl", sha256: null },
      attestations: [
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
          subjectSha256: fixture.record.manifestSha256,
        },
      ],
    },
  }
}

function multiSubjectBundle(fixture) {
  const repository = "https://github.com/cacheplane/dawnai"
  const ref = `refs/tags/v${VERSION}`
  const statement = {
    _type: "https://in-toto.io/Statement/v1",
    subject: fixture.artifact.files.map(({ name, bytes }) => ({
      name,
      digest: { sha256: hash("sha256", bytes) },
    })),
    predicateType: "https://slsa.dev/provenance/v1",
    predicate: {
      buildDefinition: {
        buildType: "https://slsa-framework.github.io/github-actions-buildtypes/workflow/v1",
        externalParameters: {
          workflow: { ref, repository, path: ".github/workflows/release.yml" },
        },
        internalParameters: { github: { event_name: "workflow_dispatch" } },
        resolvedDependencies: [
          { uri: `git+${repository}@${ref}`, digest: { gitCommit: COMMIT_SHA } },
        ],
      },
      runDetails: {
        builder: { id: "https://github.com/actions/runner/github-hosted" },
        metadata: {
          invocationId: "https://github.com/cacheplane/dawnai/actions/runs/300/attempts/1",
        },
      },
    },
  }
  return Buffer.from(
    `${JSON.stringify({
      mediaType: "application/vnd.dev.sigstore.bundle.v0.3+json",
      verificationMaterial: {
        certificate: { rawBytes: "fixture" },
        tlogEntries: [{}],
        timestampVerificationData: { rfc3161Timestamps: [] },
      },
      dsseEnvelope: {
        payload: Buffer.from(JSON.stringify(statement)).toString("base64"),
        payloadType: "application/vnd.in-toto+json",
        signatures: [{ sig: "verified-by-github", keyid: "" }],
      },
    })}\n`,
  )
}

function hash(algorithm, bytes) {
  return createHash(algorithm).update(bytes).digest("hex")
}

function absentNpmReader() {
  return {
    async observePackageMetadata() {
      return {
        status: "ABSENT",
        operation: "package-metadata",
        httpStatus: 404,
        code: "E404",
      }
    },
    async observePackageVersion() {
      return {
        status: "ABSENT",
        operation: "package-version",
        httpStatus: 404,
        code: "E404",
      }
    },
    async downloadRegistryTarball() {
      throw new Error("an absent registry package has no tarball")
    },
  }
}

function productionCliObserver({
  directory,
  candidate,
  remote,
  npm = absentNpmReader(),
  receipts,
}) {
  const parentSha = "e".repeat(40)
  return createRehearsalCliObserver({
    candidate,
    directory,
    ...(receipts === undefined ? {} : { receipts }),
    dependencies: {
      cwd: directory,
      git: {
        async listFirstParentHistory() {
          return [candidate.commitSha]
        },
        async firstParent() {
          return parentSha
        },
        async isAncestor() {
          return true
        },
        async listTree() {
          return "scripts/release/controller-schema.json\n"
        },
        async showFile() {
          return `${JSON.stringify(CONTROLLER_MARKER)}\n`
        },
        async resolveTag() {
          return candidate.commitSha
        },
      },
      inventory: {
        async read({ ref }) {
          const version = ref === parentSha ? "0.8.21" : candidate.version
          return {
            status: "valid",
            packages: [...CANONICAL_RELEASE_PACKAGE_ORDER]
              .sort()
              .map((name) => ({ name, version })),
          }
        },
      },
      githubReader: remote.releaseGitHub.reader,
      npm,
      npmAuditFactory: {
        async create() {
          return {
            async verifyPackage({ entry }) {
              return verifiedAudit(candidate, entry)
            },
            async dispose() {},
          }
        },
      },
      attestations: {
        async verify({ subjects }) {
          return { status: "VERIFIED", subjects }
        },
      },
      controllerMarker: CONTROLLER_MARKER,
    },
  })
}

function verifiedAudit(candidate, entry) {
  return {
    status: "verified",
    signature: { status: "valid", verifier: "npm-audit-signatures@11.17.0" },
    provenance: {
      status: "valid",
      predicateType: "https://slsa.dev/provenance/v1",
      workflow: candidate.publisherWorkflow,
      commitSha: candidate.commitSha,
      repository: "https://github.com/cacheplane/dawnai",
      ref: `refs/tags/v${candidate.version}`,
      subject: { name: entry.name, version: entry.version },
    },
  }
}

function attestationFixture(fixture) {
  const bundleBytes = multiSubjectBundle(fixture)
  const bundleSha256 = hash("sha256", bundleBytes)
  const subjects = fixture.artifact.files.map(({ name, bytes }) => ({
    subjectName: name,
    subjectSha256: hash("sha256", bytes),
    bundleName: `${name}.intoto.jsonl`,
    bundleSha256,
  }))
  return {
    bundleBytes,
    set: {
      repository: "cacheplane/dawnai",
      workflow: fixture.candidate.publisherWorkflow,
      sourceRef: `refs/tags/v${fixture.candidate.version}`,
      commitSha: fixture.candidate.commitSha,
      workflowRunId: 300,
      runAttempt: 1,
      subjects,
    },
    bundles: subjects.map(({ bundleName }) => ({ name: bundleName, bytes: bundleBytes })),
  }
}

async function writeEscrowInputs({ directory, fixture, bundleBytes }) {
  const artifact = join(directory, "artifact")
  const attestationBundles = join(directory, "attestation-bundles")
  await Promise.all([mkdir(artifact), mkdir(attestationBundles)])
  const paths = {
    candidate: join(directory, "candidate.json"),
    record: join(directory, "release-record.json"),
    artifact,
    bundle: join(directory, "attestation.intoto.jsonl"),
    attestationSet: join(directory, "attestation-set.json"),
    attestationBundles,
  }
  await Promise.all([
    writeFile(paths.candidate, `${JSON.stringify(fixture.candidate)}\n`),
    writeFile(paths.record, canonicalReleaseRecordBytes(fixture.record)),
    writeFile(paths.bundle, bundleBytes),
    ...fixture.artifact.files.map((file) => writeFile(join(artifact, file.name), file.bytes)),
  ])
  return paths
}

function releaseEnvironment(candidate) {
  return {
    GITHUB_REPOSITORY: "cacheplane/dawnai",
    GITHUB_WORKFLOW_REF: `cacheplane/dawnai/${candidate.publisherWorkflow}@refs/tags/v${candidate.version}`,
    GITHUB_REF: `refs/tags/v${candidate.version}`,
    GITHUB_SHA: candidate.commitSha,
    GITHUB_RUN_ID: "300",
    GITHUB_RUN_ATTEMPT: "1",
  }
}

async function escrowedFixture({ directory, fixture }) {
  const attestation = attestationFixture(fixture)
  const base = canonicalBaseAssetSet({
    record: fixture.record,
    artifact: fixture.artifact,
    attestationSet: attestation.set,
    bundles: attestation.bundles,
  })
  const remote = createRehearsalGitHub({
    candidate: fixture.candidate,
    gate: createOrderedFaultGate([]),
    baseAssetNames: base.assets.map(({ name }) => name),
  })
  remote.recordPreparedArtifact({ record: fixture.record, artifact: fixture.artifact })
  const paths = await writeEscrowInputs({
    directory,
    fixture,
    bundleBytes: attestation.bundleBytes,
  })
  await runReleaseCli(
    [
      "attestation-output",
      "--record",
      paths.record,
      "--artifact-dir",
      paths.artifact,
      "--bundle",
      paths.bundle,
      "--attestation-set",
      paths.attestationSet,
      "--attestation-bundles-dir",
      paths.attestationBundles,
    ],
    {
      cwd: directory,
      attestations: {
        async verify({ subjects }) {
          return { status: "VERIFIED", subjects }
        },
      },
    },
  )
  await runReleaseCli(
    [
      "escrow",
      "--candidate",
      paths.candidate,
      "--record",
      paths.record,
      "--artifact-dir",
      paths.artifact,
      "--attestation-set",
      paths.attestationSet,
      "--attestation-bundles-dir",
      paths.attestationBundles,
    ],
    {
      cwd: directory,
      github: remote.releaseGitHub,
      npm: absentNpmReader(),
      attestations: {
        async verify({ subjects }) {
          return { status: "VERIFIED", subjects }
        },
      },
      environment: releaseEnvironment(fixture.candidate),
      now: () => Date.parse("2026-08-25T00:05:00.000Z"),
    },
  )
  return { remote, paths }
}

function presentNpmReader(fixture, presentCount) {
  const entries = new Map(fixture.artifact.manifest.packages.map((entry) => [entry.name, entry]))
  const presentNames = new Set(fixture.artifact.manifest.packageOrder.slice(0, presentCount))
  return {
    async observePackageMetadata({ name }) {
      if (!presentNames.has(name)) {
        return {
          status: "ABSENT",
          operation: "package-metadata",
          httpStatus: 404,
          code: "E404",
        }
      }
      return {
        status: "PRESENT",
        operation: "package-metadata",
        httpStatus: 200,
        code: null,
        metadata: { latest: fixture.candidate.version },
      }
    },
    async observePackageVersion({ name, version }) {
      const entry = entries.get(name)
      if (!presentNames.has(name)) {
        return {
          status: "ABSENT",
          operation: "package-version",
          httpStatus: 404,
          code: "E404",
        }
      }
      const bytes = fixture.artifact.files.find((file) => file.name === entry.filename).bytes
      const unscoped = name.includes("/") ? name.slice(name.lastIndexOf("/") + 1) : name
      return {
        status: "PRESENT",
        operation: "package-version",
        httpStatus: 200,
        code: null,
        package: {
          name,
          version,
          integrity: entry.npmIntegrity,
          shasum: hash("sha1", bytes),
          tarballUrl: `https://registry.npmjs.org/${name}/-/${unscoped}-${version}.tgz`,
          distTags: { latest: version },
          latest: version,
        },
      }
    },
    async downloadRegistryTarball({ tarballUrl }) {
      const entry = fixture.artifact.manifest.packages.find((candidate) => {
        const unscoped = candidate.name.includes("/")
          ? candidate.name.slice(candidate.name.lastIndexOf("/") + 1)
          : candidate.name
        return tarballUrl.endsWith(`/${unscoped}-${candidate.version}.tgz`)
      })
      if (entry === undefined || !presentNames.has(entry.name)) {
        return {
          status: "ABSENT",
          operation: "package-tarball",
          httpStatus: 404,
          code: "E404",
        }
      }
      const bytes = fixture.artifact.files.find((file) => file.name === entry.filename).bytes
      return {
        status: "PRESENT",
        operation: "package-tarball",
        httpStatus: 200,
        code: null,
        tarball: {
          url: tarballUrl,
          size: bytes.byteLength,
          sha1: hash("sha1", bytes),
          sha256: entry.sha256,
          sha512: entry.sha512,
          contentBase64: bytes.toString("base64"),
        },
      }
    },
  }
}

function npmEvidenceFixture(fixture) {
  return {
    schemaVersion: 1,
    version: fixture.candidate.version,
    commitSha: fixture.candidate.commitSha,
    manifestSha256: fixture.record.manifestSha256,
    complete: true,
    status: "NPM_COMPLETE",
    packages: fixture.artifact.manifest.packageOrder.map((name) => {
      const entry = fixture.artifact.manifest.packages.find((pkg) => pkg.name === name)
      return {
        name,
        version: entry.version,
        status: "present",
        size: entry.size,
        tarballSha256: entry.sha256,
        tarballSha512: entry.sha512,
        integrity: entry.npmIntegrity,
        latest: { status: "present", version: entry.version },
        signature: { status: "valid", verifier: "npm-audit-signatures@11.17.0" },
        provenance: {
          predicateType: "https://slsa.dev/provenance/v1",
          workflow: fixture.candidate.publisherWorkflow,
          commitSha: fixture.candidate.commitSha,
          repository: "https://github.com/cacheplane/dawnai",
          ref: `refs/tags/v${fixture.candidate.version}`,
        },
      }
    }),
  }
}
