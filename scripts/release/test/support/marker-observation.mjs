import { createHash } from "node:crypto"

import { canonicalReleaseBody } from "../../metadata.mjs"

export const VERSION = "0.8.22"
export const COMMIT_SHA = "0123456789abcdef0123456789abcdef01234567"
export const MANIFEST_SHA256 = "a".repeat(64)
export const RELEASE_RECORD_SHA256 = "b".repeat(64)
export const MANIFEST_BUNDLE_SHA256 = "c".repeat(64)
export const AUDIT_SHA256 = "d".repeat(64)

export function candidate() {
  return {
    version: VERSION,
    commitSha: COMMIT_SHA,
    ciWorkflow: "CI",
    ciCheck: "validate",
    publisherWorkflow: ".github/workflows/release.yml",
  }
}

export function observationForMarker({
  phase,
  releaseStatus = "draft",
  npmComplete = !["ATTACHING", "ESCROWED", "ABANDONED_PREPUBLICATION"].includes(phase),
  smokesComplete = [
    "SMOKES_COMPLETE",
    "AUDIT_DISPATCHED",
    "AUDIT_RETRYABLE",
    "AUDIT_VERIFIED",
  ].includes(phase),
  partialBase = false,
} = {}) {
  const packages = packageIdentities()
  const marker = releaseMarker(phase, packages)
  const bodySha256 = createHash("sha256")
    .update(canonicalReleaseBody({ marker, manifest: null }))
    .digest("hex")
  const baseAssets = immutableAssets(packages)
  const releaseBase = partialBase ? baseAssets.slice(0, 10) : baseAssets
  return {
    inventory: { status: "valid", packages },
    ci: {
      status: "success",
      workflow: "CI",
      check: "validate",
      commitSha: COMMIT_SHA,
      workflowRunId: 30,
      runAttempt: 1,
    },
    otherCandidates: [],
    tag: { status: "present", commitSha: COMMIT_SHA },
    artifacts: {
      status: "attested",
      manifestVersion: VERSION,
      manifestCommitSha: COMMIT_SHA,
      manifestSha256: MANIFEST_SHA256,
      files: packages.map((pkg) => ({
        name: pkg.name,
        status: "valid",
        assetName: pkg.filename,
        sha256: pkg.tarballSha256,
        integrity: pkg.integrity,
      })),
      manifestAsset: { name: "manifest.json", sha256: MANIFEST_SHA256 },
      releaseRecordAsset: { name: "release-record.json", sha256: RELEASE_RECORD_SHA256 },
      manifestAttestationAsset: {
        name: "manifest.json.intoto.jsonl",
        sha256: MANIFEST_BUNDLE_SHA256,
      },
      attestations: [
        ...packages.map((pkg) => ({
          name: pkg.attestationFilename,
          status: "valid",
          sha256: pkg.attestationSha256,
          subjectName: pkg.filename,
          subjectSha256: pkg.tarballSha256,
        })),
        {
          name: "manifest.json.intoto.jsonl",
          status: "valid",
          sha256: MANIFEST_BUNDLE_SHA256,
          subjectName: "manifest.json",
          subjectSha256: MANIFEST_SHA256,
        },
      ],
    },
    escrow:
      partialBase || phase === "ABANDONED_PREPUBLICATION"
        ? { status: "absent", manifestSha256: null, assets: [] }
        : {
            status: "present",
            manifestSha256: MANIFEST_SHA256,
            assets: baseAssets.map((asset) => ({ ...asset, status: "matching" })),
          },
    registry: {
      publishJobStarted: npmComplete,
      mutationStarted: npmComplete,
      packages: packages.map((pkg) =>
        npmComplete
          ? {
              name: pkg.name,
              status: "present",
              version: VERSION,
              tarballSha256: pkg.tarballSha256,
              integrity: pkg.integrity,
              latest: { status: "present", version: VERSION },
              signature: { status: "valid" },
              provenance: {
                workflow: ".github/workflows/release.yml",
                commitSha: COMMIT_SHA,
              },
            }
          : {
              name: pkg.name,
              status: "e404",
              version: null,
              tarballSha256: null,
              integrity: null,
              latest: { status: "e404", version: null },
              signature: { status: "missing" },
              provenance: null,
            },
      ),
    },
    release: {
      status: releaseStatus,
      tag: `v${VERSION}`,
      commitSha: COMMIT_SHA,
      immutable: releaseStatus === "published",
      bodySha256,
      marker,
      assets: [
        ...releaseBase.map((asset) => ({ ...asset, status: "matching" })),
        ...terminalAssets(marker),
      ],
    },
    requiredSmokeLanes: ["published-install"],
    smokes: [
      {
        name: "published-install",
        status: smokesComplete ? "passed" : "pending",
        version: VERSION,
        commitSha: COMMIT_SHA,
        manifestSha256: MANIFEST_SHA256,
        workflowRunId: 400,
        runAttempt: 1,
      },
    ],
    audit: auditObservation(phase),
    abandonment: {
      requested: phase === "ABANDONED_PREPUBLICATION",
      recorded: phase === "ABANDONED_PREPUBLICATION",
      predecessor: phase === "ABANDONED_PREPUBLICATION" ? "CANDIDATE_ESCROWED" : null,
    },
  }
}

function packageIdentities() {
  return Array.from({ length: 21 }, (_unused, index) => {
    const ordinal = String(index + 1).padStart(2, "0")
    const filename = `dawn-ai-package-${ordinal}-${VERSION}.tgz`
    return {
      name: `@dawn-ai/package-${ordinal}`,
      version: VERSION,
      filename,
      tarballSha256: (index + 1).toString(16).padStart(64, "0"),
      attestationFilename: `${filename}.intoto.jsonl`,
      attestationSha256: MANIFEST_BUNDLE_SHA256,
      integrity: "sha512-cGFja2FnZQ==",
    }
  })
}

function releaseMarker(phase, packages) {
  const audit = ["AUDIT_DISPATCHED", "AUDIT_RETRYABLE", "AUDIT_VERIFIED"].includes(phase)
    ? {
        workflow: ".github/workflows/published-artifact-verify.yml",
        workflowRunId: 500,
        runUrl: "https://api.github.com/repos/cacheplane/dawnai/actions/runs/500",
        htmlUrl: "https://github.com/cacheplane/dawnai/actions/runs/500",
        runAttempt: phase === "AUDIT_DISPATCHED" ? null : 1,
        attemptAssetName: phase === "AUDIT_DISPATCHED" ? null : "audit-attempt-500-1.json",
        attemptSha256: phase === "AUDIT_DISPATCHED" ? null : AUDIT_SHA256,
        canonicalSha256: phase === "AUDIT_VERIFIED" ? AUDIT_SHA256 : null,
        conclusion:
          phase === "AUDIT_VERIFIED" ? "success" : phase === "AUDIT_RETRYABLE" ? "failure" : null,
      }
    : null
  const subjects = [
    {
      subjectName: "manifest.json",
      subjectSha256: MANIFEST_SHA256,
      bundleName: "manifest.json.intoto.jsonl",
      bundleSha256: MANIFEST_BUNDLE_SHA256,
    },
    ...packages.map((pkg) => ({
      subjectName: pkg.filename,
      subjectSha256: pkg.tarballSha256,
      bundleName: pkg.attestationFilename,
      bundleSha256: pkg.attestationSha256,
    })),
  ]
  return {
    schemaVersion: 1,
    epoch: "fixed-group-v1",
    revision: 1,
    phase,
    version: VERSION,
    commitSha: COMMIT_SHA,
    tag: `v${VERSION}`,
    manifestSha256: MANIFEST_SHA256,
    releaseRecordSha256: RELEASE_RECORD_SHA256,
    baseAssetSetSha256: phase === "ATTACHING" ? null : baseDigest(packages),
    attestationSet:
      phase === "ATTACHING"
        ? null
        : {
            repository: "cacheplane/dawnai",
            workflow: ".github/workflows/release.yml",
            sourceRef: `refs/tags/v${VERSION}`,
            commitSha: COMMIT_SHA,
            workflowRunId: 300,
            runAttempt: 1,
            subjects,
          },
    npmEvidenceSha256: [
      "NPM_COMPLETE",
      "SMOKES_COMPLETE",
      "AUDIT_DISPATCHED",
      "AUDIT_RETRYABLE",
      "AUDIT_VERIFIED",
    ].includes(phase)
      ? "e".repeat(64)
      : null,
    smokeAggregateSha256: [
      "SMOKES_COMPLETE",
      "AUDIT_DISPATCHED",
      "AUDIT_RETRYABLE",
      "AUDIT_VERIFIED",
    ].includes(phase)
      ? "f".repeat(64)
      : null,
    audit,
    abandonmentSha256: phase === "ABANDONED_PREPUBLICATION" ? "7".repeat(64) : null,
  }
}

function immutableAssets(packages) {
  return [
    { name: "release-record.json", sha256: RELEASE_RECORD_SHA256 },
    { name: "manifest.json", sha256: MANIFEST_SHA256 },
    ...packages.map((pkg) => ({ name: pkg.filename, sha256: pkg.tarballSha256 })),
    { name: "manifest.json.intoto.jsonl", sha256: MANIFEST_BUNDLE_SHA256 },
    ...packages.map((pkg) => ({
      name: pkg.attestationFilename,
      sha256: pkg.attestationSha256,
    })),
  ]
}

function baseDigest(packages) {
  return createHash("sha256")
    .update(`${JSON.stringify(immutableAssets(packages))}\n`)
    .digest("hex")
}

function terminalAssets(marker) {
  if (marker.phase === "ABANDONED_PREPUBLICATION") {
    return [
      {
        name: "abandonment.json",
        status: "matching",
        sha256: marker.abandonmentSha256,
      },
    ]
  }
  if (marker.phase === "AUDIT_RETRYABLE") {
    return [
      {
        name: marker.audit.attemptAssetName,
        status: "matching",
        sha256: marker.audit.attemptSha256,
      },
    ]
  }
  if (marker.phase === "AUDIT_VERIFIED") {
    return [
      {
        name: marker.audit.attemptAssetName,
        status: "matching",
        sha256: marker.audit.attemptSha256,
      },
      { name: "audit-result.json", status: "matching", sha256: marker.audit.canonicalSha256 },
    ]
  }
  return []
}

function auditObservation(phase) {
  const status =
    phase === "AUDIT_DISPATCHED"
      ? "dispatched"
      : phase === "AUDIT_RETRYABLE"
        ? "failed"
        : phase === "AUDIT_VERIFIED"
          ? "success"
          : "none"
  return status === "none"
    ? {
        status,
        version: null,
        commitSha: null,
        manifestSha256: null,
        workflowRunId: null,
        runAttempt: null,
        conclusion: null,
      }
    : {
        status,
        version: VERSION,
        commitSha: COMMIT_SHA,
        manifestSha256: MANIFEST_SHA256,
        workflowRunId: 500,
        runAttempt: 1,
        conclusion: status === "success" ? "success" : status === "failed" ? "failure" : null,
      }
}
