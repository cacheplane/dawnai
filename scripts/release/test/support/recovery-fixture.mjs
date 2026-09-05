import { createHash } from "node:crypto"
import { RECOVERY_AUDIT_CHECKS } from "../../recovery/audit-proof.mjs"
import { metadataCheckName } from "../../recovery/schema.mjs"

export const digest = (text) => createHash("sha256").update(text).digest("hex")
export const canonical = (value) => Buffer.from(`${JSON.stringify(sort(value))}\n`)
function sort(value) {
  if (Array.isArray(value)) return value.map(sort)
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .map((key) => [key, sort(value[key])]),
    )
  }
  return value
}
export const LANES = ["metadata", "published-harness", "runtime-targets", "scaffold", "storage"]
export const PHASES = [
  "RECOVERY_ADOPTED",
  "VERIFICATION_COMPLETE",
  "AUDIT_PENDING",
  "AUDIT_VERIFIED",
  "PUBLICATION_READY",
  "COMPLETE",
]
export const candidate = () => ({
  repository: "cacheplane/dawnai",
  repositoryId: "901",
  version: "0.8.24",
  candidateSha: "a".repeat(40),
  tag: "v0.8.24",
  tagObjectSha: "b".repeat(40),
  releaseId: "902",
  manifestSha256: digest("original manifest"),
  releaseRecordSha256: digest("original record"),
})
export const executor = (overrides = {}) => ({
  controllerSha: "c".repeat(40),
  verifierClosureSha256: digest("reviewed verifier closure"),
  workflow: ".github/workflows/release-postpublication.yml",
  runId: "903",
  runAttempt: "1",
  jobId: "904",
  ...overrides,
})
export const asset = (assetName, bytes, id) => ({
  assetName,
  id: String(id),
  sha256: digest(bytes),
  size: Buffer.byteLength(bytes),
})
export const receiptRef = (receipt, name, id) => asset(name, canonical(receipt), id)
export function wireFixtures({ retainedCount = 0 } = {}) {
  const c = candidate()
  const e = executor()
  const policySha256 = digest("reviewed recovery policy")
  const wire = (kind, fields) => ({
    schemaVersion: 2,
    kind,
    candidate: c,
    ...fields,
  })
  const baseAssets = [
    asset("dawn-ai-sdk-0.8.24.tgz", "tarball", 15),
    asset("dawn-ai-sdk-0.8.24.tgz.intoto.jsonl", "original sdk attestation", 16),
    asset("manifest.json", "original manifest", 11),
    asset("manifest.json.intoto.jsonl", "original manifest attestation", 17),
    asset("release-record.json", "original record", 12),
  ]
  const checks = [
    { name: "cleanup", conclusion: "success" },
    { name: "published-payload", conclusion: "success" },
  ]
  const intent = wire("recovery-adoption-intent", {
    legacyBodySha256: digest("legacy body"),
    legacyPhase: "NPM_COMPLETE",
    policySha256,
    operations: ["adopt", "audit", "finalize", "publish", "verify"],
  })
  const adoption = wire("recovery-adoption", {
    policySha256,
    authority: {
      intentPath: "scripts/release/recovery-adoptions/0.8.24.json",
      intentSha256: digest(canonical(intent)),
      reviewedControllerSha: e.controllerSha,
    },
    executor: e,
    archive: asset(
      `recovery-v2-legacy-${c.version}-${intent.legacyBodySha256}.txt`,
      "legacy body",
      13,
    ),
    baseAssets,
    npmEvidence: {
      manifestSha256: c.manifestSha256,
      packages: [
        {
          name: "@dawn-ai/sdk",
          version: c.version,
          sourceSha: c.candidateSha,
          integrity: `sha512-${Buffer.alloc(64, 1).toString("base64")}`,
          tarballSha256: digest("tarball"),
          conclusion: "success",
        },
      ],
      conclusion: "success",
    },
    retainedAttempts: [],
  })
  const adoptionRef = receiptRef(adoption, "recovery-v2-adoption-903-1.json", 14)
  const lanes = Object.fromEntries(
    LANES.map((lane, index) => [
      lane,
      wire("recovery-lane", {
        policySha256,
        lane,
        executor: executor({ jobId: String(100 + index) }),
        environment: {
          profile: "linux-node24",
          node: "24.20.0",
          packageManager: "npm@11.0.0",
          platform: "linux",
          architecture: "x64",
          dockerImages: (lane === "storage"
            ? ["pgvector/pgvector:pg16", "postgres:16"]
            : lane === "published-harness"
              ? ["node:22-slim"]
              : []
          ).map((reference) => ({
            reference,
            digest: `sha256:${digest(reference)}`,
          })),
        },
        startedAt: "2026-09-04T10:00:00.000Z",
        finishedAt: "2026-09-04T10:01:00.000Z",
        checks:
          lane === "metadata"
            ? [
                ...checks,
                {
                  name: metadataCheckName("package:@dawn-ai/sdk"),
                  conclusion: "success",
                },
              ].sort((a, b) => (a.name < b.name ? -1 : 1))
            : checks,
        resolutions:
          lane === "metadata"
            ? []
            : [
                {
                  installPath: "node_modules/@dawn-ai/sdk",
                  subject: true,
                  name: "@dawn-ai/sdk",
                  requested: "0.8.24",
                  resolved: "0.8.24",
                  source: "registry",
                  integrity: adoption.npmEvidence.packages[0].integrity,
                },
              ],
        conclusion: "success",
      }),
    ]),
  )
  const installationReceipts = {}
  const installationAssets = []
  const installChecks = {
    metadata: [],
    "published-harness": ["ag-ui", "exact-install", "typescript-tooling"],
    "runtime-targets": ["exact-install"],
    scaffold: ["dependency-install", "scaffolder-install"],
    storage: ["exact-install"],
  }
  for (const lane of LANES) {
    lanes[lane].installations = installChecks[lane].map((check) => {
      const installation = wire("recovery-installation", {
        policySha256,
        lane,
        executor: lanes[lane].executor,
        check,
        resolutions: lanes[lane].resolutions,
      })
      const bytes = canonical(installation)
      const sha256 = digest(bytes)
      const assetName = `recovery-v2-installation-${lane}-${check}-${sha256}.json`
      installationReceipts[assetName] = installation
      installationAssets.push(asset(assetName, bytes, 500 + installationAssets.length))
      return {
        check,
        assetName,
        sha256,
        size: bytes.length,
        count: installation.resolutions.length,
      }
    })
  }
  const selected = LANES.map((lane, index) => ({
    lane,
    receipt: receiptRef(lanes[lane], `recovery-v2-lane-${lane}-903-1.json`, 20 + index),
    executor: lanes[lane].executor,
    conclusion: "success",
  }))
  const provenance = selected.map(({ lane, receipt, executor: laneExecutor }, index) => ({
    lane,
    executor: laneExecutor,
    artifactId: String(200 + index),
    serviceDigest: `sha256:${digest(lane)}`,
    receiptSha256: receipt.sha256,
    conclusion: "success",
    validatedAt: "2026-09-04T10:02:00.000Z",
  }))
  const set = wire("recovery-verification-set", {
    policySha256,
    executor: e,
    lanes: selected,
    provenance,
    retainedReceipts: [
      ...installationAssets,
      ...Array.from({ length: retainedCount }, (_, index) =>
        asset(
          `recovery-v2-retained-${String(index).padStart(4, "0")}.json`,
          `retained-${index}`,
          10000 + index,
        ),
      ),
    ].sort(byName),
    conclusion: "success",
  })
  const setRef = receiptRef(set, "recovery-v2-verification-set-903-1.json", 30)
  const preAuditAssets = [
    ...baseAssets,
    adoption.archive,
    adoptionRef,
    ...selected.map(({ receipt }) => receipt),
    ...set.retainedReceipts,
    setRef,
  ].sort(byName)
  const auditIntent = wire("recovery-audit-intent", {
    policySha256,
    requestId: "audit-903-1-1",
    expectedAuditorSha: e.controllerSha,
    verificationSetSha256: setRef.sha256,
    inventory: preAuditAssets,
    executor: e,
  })
  const intentRef = receiptRef(auditIntent, "recovery-v2-audit-intent-903-1-1.json", 31)
  const dispatch = wire("recovery-audit-dispatch", {
    requestId: auditIntent.requestId,
    intentSha256: intentRef.sha256,
    runId: "905",
    expectedAuditorSha: auditIntent.expectedAuditorSha,
    executor: e,
  })
  const dispatchRef = receiptRef(dispatch, "recovery-v2-audit-dispatch-903-1-1.json", 32)
  const audit = wire("recovery-audit-result", {
    policySha256,
    requestId: auditIntent.requestId,
    verificationSetSha256: setRef.sha256,
    inventorySha256: digest(canonical(preAuditAssets)),
    executor: executor({
      controllerSha: auditIntent.expectedAuditorSha,
      workflow: ".github/workflows/release-postpublication-audit.yml",
      runId: dispatch.runId,
      jobId: "906",
    }),
    checks: RECOVERY_AUDIT_CHECKS.map((name) => ({
      name,
      conclusion: "success",
    })),
    conclusion: "success",
  })
  const auditRef = receiptRef(audit, "recovery-v2-audit-result-905-1.json", 33)
  const assets = [...preAuditAssets, intentRef, dispatchRef, auditRef].sort(byName)
  const finalization = wire("recovery-finalization", {
    policySha256,
    adoption: adoptionRef,
    verificationSet: setRef,
    audit: auditRef,
    assets,
    metadata: {
      title: "v0.8.24",
      body: "Release notes preserved from the candidate.",
      markerRevision: 5,
    },
  })
  const finalRef = receiptRef(finalization, "recovery-v2-finalization.json", 34)
  const marker = wire("recovery-marker", {
    revision: 1,
    phase: "RECOVERY_ADOPTED",
    policySha256,
    adoption: adoptionRef,
    verificationSet: null,
    audit: null,
    finalization: null,
  })
  const runResult = wire("recovery-run-result", {
    executor: e,
    before: "NPM_COMPLETE",
    after: "RECOVERY_ADOPTED",
    outcome: "advanced",
    effects: [{ operation: "write-marker", target: "RECOVERY_ADOPTED" }],
    evidence: [adoptionRef],
    nextAction: "verify",
    errors: [],
  })
  return JSON.parse(
    JSON.stringify({
      installationReceipts,
      installationAssets,
      intent,
      adoption,
      lanes,
      set,
      auditIntent,
      dispatch,
      audit,
      finalization,
      marker,
      runResult,
      adoptionRef,
      setRef,
      intentRef,
      dispatchRef,
      auditRef,
      finalRef,
      assets,
    }),
  )
}
const byName = (a, b) => (a.assetName < b.assetName ? -1 : a.assetName > b.assetName ? 1 : 0)
export function markerAt(phase, f = wireFixtures()) {
  if (phase === "COMPLETE") phase = "PUBLICATION_READY"
  const index = PHASES.indexOf(phase)
  return {
    ...f.marker,
    revision: index + 1,
    phase,
    verificationSet: index >= 1 ? f.setRef : null,
    audit: index >= 2 ? (index === 2 ? f.dispatchRef : f.auditRef) : null,
    finalization: index >= 4 ? f.finalRef : null,
  }
}
export function recoveryFacts({ phase = "NPM_COMPLETE", retainedCount = 0 } = {}) {
  const f = wireFixtures({ retainedCount })
  const c = candidate()
  const e = executor()
  return JSON.parse(
    JSON.stringify({
      candidate: c,
      executor: e,
      policySha256: f.intent.policySha256,
      manifestPackages: ["@dawn-ai/sdk"],
      capability: {
        schemaVersion: 2,
        policySha256: f.intent.policySha256,
        controllerSha: e.controllerSha,
        verifierClosureSha256: e.verifierClosureSha256,
        workflow: e.workflow,
        admission: "reviewed-main-ci",
      },
      marker: phase === "NPM_COMPLETE" ? null : markerAt(phase, f),
      legacy: {
        phase: "NPM_COMPLETE",
        bodySha256: f.intent.legacyBodySha256,
        candidate: c,
      },
      authority: {
        intent: f.intent,
        intentPath: f.adoption.authority.intentPath,
        intentSha256: f.adoption.authority.intentSha256,
        reviewedControllerSha: e.controllerSha,
      },
      ownership: {
        candidate: c,
        controllerSha: e.controllerSha,
        concurrencyGroup: "dawn-release-controller",
        fence: "verified-exclusive",
        legacyWriters: "drained-and-rejected",
      },
      adoption: {
        admission: {
          schemaVersion: 2,
          policySha256: f.intent.policySha256,
          controllerSha: e.controllerSha,
          verifierClosureSha256: e.verifierClosureSha256,
          workflow: e.workflow,
          admission: "reviewed-main-ci",
        },
        receipt: f.adoption,
        ref: f.adoptionRef,
        archive: f.adoption.archive,
        baseAssets: f.adoption.baseAssets,
        npmEvidence: f.adoption.npmEvidence,
        manifestPackages: ["@dawn-ai/sdk"],
      },
      verification: {
        set: f.set,
        ref: f.setRef,
        lanes: f.lanes,
        installations: Object.fromEntries(
          f.installationAssets.map((ref) => [
            ref.assetName,
            {
              ref,
              bytes: canonical(f.installationReceipts[ref.assetName]).toString("utf8"),
            },
          ]),
        ),
        provenance: f.set.provenance,
      },
      audit: {
        intent: f.auditIntent,
        intentRef: f.intentRef,
        dispatch: f.dispatch,
        dispatchRef: f.dispatchRef,
        result: f.audit,
        resultRef: f.auditRef,
        observedExecutor: f.audit.executor,
        admission: {
          schemaVersion: 2,
          policySha256: f.intent.policySha256,
          controllerSha: f.audit.executor.controllerSha,
          verifierClosureSha256: f.audit.executor.verifierClosureSha256,
          workflow: f.audit.executor.workflow,
          admission: "reviewed-main-ci",
        },
      },
      finalization:
        phase === "PUBLICATION_READY" || phase === "COMPLETE"
          ? { receipt: f.finalization, ref: f.finalRef, inventory: f.assets }
          : null,
      proposedFinalization: { receipt: f.finalization },
      fresh: {
        candidate: c,
        registry: f.adoption.npmEvidence,
        assets:
          phase === "PUBLICATION_READY" || phase === "COMPLETE"
            ? [...f.assets, f.finalRef].sort(byName)
            : f.assets,
        tag: {
          name: c.tag,
          objectSha: c.tagObjectSha,
          candidateSha: c.candidateSha,
        },
        immutableReleasePolicy: "enabled",
        ownership: "exclusive",
      },
      publication:
        phase === "COMPLETE"
          ? {
              candidate: c,
              state: "published",
              immutable: true,
              tag: {
                name: c.tag,
                objectSha: c.tagObjectSha,
                candidateSha: c.candidateSha,
              },
              assets: [...f.assets, f.finalRef].sort(byName),
              finalizationSha256: f.finalRef.sha256,
              metadata: "matching",
            }
          : null,
      legacyAdjudication: null,
    }),
  )
}
