import assert from "node:assert/strict"
import { createHash } from "node:crypto"
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import test from "node:test"

import {
  CANONICAL_RELEASE_PACKAGE_ORDER,
  canonicalManifestBytes,
  manifestSha256,
} from "../manifest.mjs"
import { canonicalNpmEvidenceBytes } from "../npm-evidence.mjs"
import { canonicalReleaseRecordBytes, releaseRecordSha256 } from "../release-record.mjs"

const VERSION = "0.8.22"
const COMMIT_SHA = "0123456789abcdef0123456789abcdef01234567"
const CANDIDATE = Object.freeze({
  version: VERSION,
  commitSha: COMMIT_SHA,
  ciWorkflow: "CI",
  ciCheck: "validate",
  publisherWorkflow: ".github/workflows/release.yml",
})

test("materializes canonical prepared recovery inputs for a later release run", async () => {
  const module = await import("../workflow-recovery.mjs")
  const report = recoveryReport({
    state: "ARTIFACTS_PREPARED",
    transition: "attest-artifacts",
  })
  const recovered = module.parseWorkflowRecovery(report)

  assert.deepEqual(recovered.candidate, CANDIDATE)
  assert.equal(recovered.nextTransition, "attest-artifacts")
  assert.equal(recovered.npmEvidence, null)
  assert.equal(recovered.auditDispatch, null)
  assert.equal(recovered.auditResult, null)

  const directory = await mkdtemp(path.join(os.tmpdir(), "dawn-workflow-recovery-"))
  const output = path.join(directory, "recovered")
  try {
    await module.writeWorkflowRecovery({ report, outputDir: output })
    assert.deepEqual(await readFile(path.join(output, "candidate.json")), canonicalJson(CANDIDATE))
    assert.deepEqual(
      await readFile(path.join(output, "manifest.json")),
      canonicalManifestBytes(report.recovery.manifest),
    )
    assert.deepEqual(
      await readFile(path.join(output, "release-record.json")),
      canonicalReleaseRecordBytes(report.recovery.releaseRecord),
    )
    await assert.rejects(readFile(path.join(output, "npm-evidence.json")), {
      code: "ENOENT",
    })
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

test("requires and writes exact npm evidence at and after npm reconciliation", async () => {
  const module = await import("../workflow-recovery.mjs")
  const report = recoveryReport({
    state: "NPM_COMPLETE",
    transition: "reconcile-npm-evidence",
    npm: true,
  })
  const directory = await mkdtemp(path.join(os.tmpdir(), "dawn-workflow-recovery-npm-"))
  const output = path.join(directory, "recovered")
  try {
    const recovered = await module.writeWorkflowRecovery({
      report,
      outputDir: output,
    })
    assert.equal(recovered.npmEvidence.status, "NPM_COMPLETE")
    assert.deepEqual(
      await readFile(path.join(output, "npm-evidence.json")),
      canonicalNpmEvidenceBytes(report.recovery.npmEvidence, {
        candidate: CANDIDATE,
        manifest: report.recovery.manifest,
        manifestSha256: manifestSha256(report.recovery.manifest),
      }),
    )
  } finally {
    await rm(directory, { recursive: true, force: true })
  }

  const missing = structuredClone(report)
  missing.recovery.npmEvidence = null
  assert.throws(() => module.parseWorkflowRecovery(missing), /npm evidence/iu)
})

test("requires the exact recorded dispatch and successful audit result before publication", async () => {
  const module = await import("../workflow-recovery.mjs")
  const report = recoveryReport({
    state: "AUDIT_VERIFIED",
    transition: "publish-github-release",
    npm: true,
    audit: true,
  })
  const recovered = module.parseWorkflowRecovery(report)
  assert.equal(recovered.auditDispatch.workflowRunId, 500)
  assert.equal(recovered.auditResult.conclusion, "success")

  for (const mutate of [
    (value) => (value.recovery.auditDispatch.workflowRunId = 501),
    (value) => (value.recovery.auditResult.conclusion = "failure"),
    (value) => (value.recovery.auditResult = null),
  ]) {
    const invalid = structuredClone(report)
    mutate(invalid)
    assert.throws(() => module.parseWorkflowRecovery(invalid))
  }
})

test("rejects diagnostics, state-transition drift, candidate drift, and extra recovery fields", async () => {
  const module = await import("../workflow-recovery.mjs")
  const cases = [
    (value) => value.diagnostics.push({ code: "AMBIGUOUS" }),
    (value) => (value.transition.name = "publish-npm-packages"),
    (value) => (value.before.plan.nextTransition = "publish-npm-packages"),
    (value) => (value.recovery.candidate.commitSha = "f".repeat(40)),
    (value) => (value.recovery.releaseRecord.manifestSha256 = "f".repeat(64)),
    (value) => (value.recovery.extra = true),
  ]
  for (const mutate of cases) {
    const report = recoveryReport({
      state: "ARTIFACTS_PREPARED",
      transition: "attest-artifacts",
    })
    mutate(report)
    assert.throws(() => module.parseWorkflowRecovery(report))
  }
})

test("the executable accepts only one report and one new output directory", async () => {
  const module = await import("../workflow-recovery.mjs")
  const directory = await mkdtemp(path.join(os.tmpdir(), "dawn-workflow-recovery-cli-"))
  const reportPath = path.join(directory, "report.json")
  const output = path.join(directory, "recovered")
  const report = recoveryReport({
    state: "ARTIFACTS_PREPARED",
    transition: "attest-artifacts",
  })
  try {
    await writeFile(reportPath, canonicalJson(report))
    await module.runWorkflowRecoveryCli(["--report", reportPath, "--output-dir", output])
    assert.deepEqual(
      JSON.parse(await readFile(path.join(output, "candidate.json"), "utf8")),
      CANDIDATE,
    )
    await assert.rejects(
      module.runWorkflowRecoveryCli(["--report", reportPath, "--output-dir", output]),
    )
    await assert.rejects(
      module.runWorkflowRecoveryCli([
        "--report",
        reportPath,
        "--output-dir",
        `${output}-2`,
        "--extra",
        "x",
      ]),
    )
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

function recoveryReport({ state, transition, npm = false, audit = false }) {
  const manifest = releaseManifest()
  const releaseRecord = recordFor(manifest)
  const npmEvidence = npm ? npmEvidenceFor(manifest) : null
  const auditDispatch = audit
    ? {
        workflow: ".github/workflows/published-artifact-verify.yml",
        workflowRunId: 500,
        runUrl: "https://api.github.com/repos/cacheplane/dawnai/actions/runs/500",
        htmlUrl: "https://github.com/cacheplane/dawnai/actions/runs/500",
      }
    : null
  const auditResult = audit
    ? {
        schemaVersion: 1,
        version: VERSION,
        commitSha: COMMIT_SHA,
        manifestSha256: manifestSha256(manifest),
        workflowRunId: 500,
        runAttempt: 1,
        startedAt: "2026-08-25T10:00:00.000Z",
        finishedAt: "2026-08-25T10:10:00.000Z",
        conclusion: "success",
        checks: [{ name: "release", conclusion: "success", detail: "verified" }],
      }
    : null
  return {
    schemaVersion: 1,
    candidate: structuredClone(CANDIDATE),
    before: {
      observation: {
        artifacts: {
          manifestSha256: manifestSha256(manifest),
          releaseRecordAsset: { sha256: releaseRecordSha256(releaseRecord) },
        },
      },
      plan: {
        state,
        disposition: "would-transition",
        nextTransition: transition,
        reasons: [`release state is ready for ${transition}`],
        conflicts: [],
        proposedMutations: [{ type: transition, version: VERSION, commitSha: COMMIT_SHA }],
      },
    },
    transition: {
      name: transition,
      status: "dry-run",
      result: null,
      error: null,
    },
    after: null,
    recovery: {
      schemaVersion: 1,
      candidate: structuredClone(CANDIDATE),
      manifest,
      releaseRecord,
      npmEvidence,
      auditDispatch,
      auditResult,
    },
    diagnostics: [],
  }
}

function releaseManifest() {
  return {
    schemaVersion: 1,
    version: VERSION,
    commitSha: COMMIT_SHA,
    ci: { workflow: "CI", runId: 100, runAttempt: 1 },
    artifact: {
      name: `release-v${VERSION}-${COMMIT_SHA.slice(0, 12)}`,
      prepareRunId: 200,
      prepareRunAttempt: 1,
    },
    packageOrder: [...CANONICAL_RELEASE_PACKAGE_ORDER],
    packages: CANONICAL_RELEASE_PACKAGE_ORDER.map((name, index) => packageEntry(name, index)),
  }
}

function packageEntry(name, index) {
  const bytes = Buffer.from(`packed:${name}`)
  const sha512 = createHash("sha512").update(bytes).digest("hex")
  const stem = name.startsWith("@") ? name.slice(1).replaceAll("/", "-") : name
  return {
    name,
    version: VERSION,
    filename: `${stem}-${VERSION}.tgz`,
    size: bytes.length + index,
    sha256: createHash("sha256").update(bytes).digest("hex"),
    sha512,
    npmIntegrity: `sha512-${Buffer.from(sha512, "hex").toString("base64")}`,
    access: "public",
  }
}

function recordFor(manifest) {
  return JSON.parse(
    canonicalReleaseRecordBytes({
      schemaVersion: 1,
      version: VERSION,
      commitSha: COMMIT_SHA,
      tag: `v${VERSION}`,
      manifestSha256: manifestSha256(manifest),
      actionsArtifact: {
        id: "123456789",
        name: manifest.artifact.name,
        serviceDigest: `sha256:${"a".repeat(64)}`,
        prepareRunId: "200",
        prepareRunAttempt: 1,
      },
    }),
  )
}

function npmEvidenceFor(manifest) {
  return JSON.parse(
    canonicalNpmEvidenceBytes(
      {
        schemaVersion: 1,
        version: VERSION,
        commitSha: COMMIT_SHA,
        manifestSha256: manifestSha256(manifest),
        complete: true,
        status: "NPM_COMPLETE",
        packages: manifest.packages.map((entry) => ({
          name: entry.name,
          version: VERSION,
          status: "present",
          size: entry.size,
          tarballSha256: entry.sha256,
          tarballSha512: entry.sha512,
          integrity: entry.npmIntegrity,
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
      },
      {
        candidate: CANDIDATE,
        manifest,
        manifestSha256: manifestSha256(manifest),
      },
    ),
  )
}

function canonicalJson(value) {
  return Buffer.from(`${JSON.stringify(canonicalize(value), null, 2)}\n`, "utf8")
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
