import { readFile } from "node:fs/promises"
import * as manifest from "../../manifest.mjs"
import * as metadata from "../../metadata.mjs"
import { auditName, RECOVERY_AUDIT_CHECKS } from "../../recovery/audit-proof.mjs"
import { recoveryProvenanceName } from "../../recovery/evidence-proof.mjs"
import { canonicalPolicyBytes, hashVerifierClosure } from "../../recovery/policy.mjs"
import { canonicalRecoveryBytes, metadataCheckName } from "../../recovery/schema.mjs"
import * as record from "../../release-record.mjs"
import { canonical, digest, executor, wireFixtures } from "./recovery-fixture.mjs"
import { CANDIDATE, candidateFixture } from "./recovery-legacy-fixture.mjs"

export async function recoveryRemote({
  published = false,
  operations = ["adopt", "audit", "finalize", "publish", "verify"],
  ownerWorkflow = ".github/workflows/release-postpublication.yml",
  platform = "linux",
  retainedRaw = null,
  mutateLane = () => {},
  mutateInstallation = () => {},
  mutateSet = () => {},
  configureFence = null,
} = {}) {
  const base = candidateFixture({ modules: { metadata, manifest, record } })
  const source = "reviewed source\n"
  const policy = JSON.parse(
    await readFile(new URL("../../recovery/policy.json", import.meta.url), "utf8"),
  )
  policy.status = "ADMITTED"
  policy.fence.contracts = [digest("fence")]
  policy.verifierClosure.sha256 = await hashVerifierClosure(
    {
      controllerSha: executor().controllerSha,
      inputs: policy.verifierClosure.inputs,
    },
    async () => source,
  )
  const c = {
    repository: "cacheplane/dawnai",
    repositoryId: "901",
    version: CANDIDATE.version,
    candidateSha: CANDIDATE.commitSha,
    tag: `v${CANDIDATE.version}`,
    tagObjectSha: "b".repeat(40),
    releaseId: "902",
    manifestSha256: base.record.manifestSha256,
    releaseRecordSha256: record.releaseRecordSha256(base.record),
  }
  const e = executor({
    verifierClosureSha256: policy.verifierClosure.sha256,
    workflow: ownerWorkflow,
  })
  const fence = configureFence
    ? await configureFence({ candidate: c, executor: e, policy, source })
    : null
  const policySha256 = digest(canonicalPolicyBytes(policy))
  const legacyMarker = {
    ...base.marker,
    phase: "NPM_COMPLETE",
    npmEvidenceSha256: digest("npm evidence"),
  }
  const legacyBody = metadata.canonicalReleaseBody({
    marker: legacyMarker,
    manifest: null,
  })
  const raws = new Map(
    base.base.assets.map((a) => [a.name, Buffer.from(a.contentBase64, "base64")]),
  )
  let nextId = 1000
  const refs = new Map()
  for (const [assetName, bytes] of raws)
    refs.set(assetName, {
      assetName,
      id: String(nextId++),
      sha256: digest(bytes),
      size: bytes.length,
    })
  const add = (name, value) => {
    const bytes = typeof value === "string" ? Buffer.from(value) : canonicalRecoveryBytes(value)
    raws.set(name, bytes)
    const ref = {
      assetName: name,
      id: String(nextId++),
      sha256: digest(bytes),
      size: bytes.length,
    }
    refs.set(name, ref)
    return ref
  }
  const all = () => [...refs.values()].sort((a, b) => a.assetName.localeCompare(b.assetName, "en"))
  const sort = (list) =>
    list.sort((a, b) => (a.assetName < b.assetName ? -1 : a.assetName > b.assetName ? 1 : 0))
  const wire = (kind, fields) => ({
    schemaVersion: 2,
    kind,
    candidate: c,
    ...fields,
  })
  const intent = wire("recovery-adoption-intent", {
    policySha256,
    legacyBodySha256: digest(legacyBody),
    legacyPhase: "NPM_COMPLETE",
    operations,
  })
  const intentPath = "scripts/release/recovery-adoptions/0.8.24.json"
  const npmEvidence = {
    manifestSha256: c.manifestSha256,
    conclusion: "success",
    packages: base.manifest.packages
      .map((pkg) => ({
        name: pkg.name,
        version: pkg.version,
        sourceSha: c.candidateSha,
        integrity: pkg.npmIntegrity,
        tarballSha256: pkg.sha256,
        conclusion: "success",
      }))
      .sort((a, b) => (a.name < b.name ? -1 : 1)),
  }
  const baseAssets = sort(all())
  const archive = add(`recovery-v2-legacy-${c.version}-${intent.legacyBodySha256}.txt`, legacyBody)
  const adoption = wire("recovery-adoption", {
    policySha256,
    executor: e,
    authority: {
      intentPath,
      intentSha256: digest(canonicalRecoveryBytes(intent)),
      reviewedControllerSha: e.controllerSha,
    },
    archive,
    baseAssets,
    npmEvidence,
    retainedAttempts: [],
  })
  const adoptionRef = add("recovery-v2-adoption-903-1.json", adoption)
  const original = wireFixtures()
  const lanes = {}
  const installationReceipts = {}
  const installationAssets = []
  for (const [name, lane] of Object.entries(original.lanes)) {
    lanes[name] = {
      ...lane,
      candidate: c,
      policySha256,
      executor: { ...e, jobId: lane.executor.jobId },
      environment: {
        ...lane.environment,
        dockerImages: (name === "storage"
          ? ["pgvector/pgvector:pg16", "postgres:16"]
          : name === "published-harness"
            ? ["node:22-slim"]
            : []
        ).map((reference) => ({
          reference,
          digest: `sha256:${digest(reference)}`,
        })),
        platform,
        profile: policy.environment.profile,
        node: policy.environment.node,
        packageManager: policy.environment.packageManager,
      },
      checks: policy.lanes
        .find((l) => l.name === name)
        .requiredChecks.map((name) => ({ name, conclusion: "success" })),
      resolutions:
        name === "metadata"
          ? []
          : [
              {
                ...lane.resolutions[0],
                integrity: npmEvidence.packages.find((p) => p.name === "@dawn-ai/sdk").integrity,
              },
            ],
    }
    if (name === "metadata")
      lanes[name].checks.push(
        ...base.manifest.packages.map((pkg) => ({
          name: metadataCheckName(`package:${pkg.name}`),
          conclusion: "success",
        })),
      )
    lanes[name].checks.sort((a, b) => (a.name < b.name ? -1 : 1))
    lanes[name].installations = lane.installations.map((descriptor) => {
      const value = wire("recovery-installation", {
        policySha256,
        lane: name,
        executor: lanes[name].executor,
        check: descriptor.check,
        resolutions: structuredClone(lanes[name].resolutions),
      })
      mutateInstallation(value)
      const bytes = canonicalRecoveryBytes(value)
      const sha256 = digest(bytes)
      const assetName = `recovery-v2-installation-${name}-${descriptor.check}-${sha256}.json`
      const ref = add(assetName, value)
      installationReceipts[assetName] = value
      installationAssets.push(ref)
      return {
        check: descriptor.check,
        assetName,
        sha256,
        size: bytes.length,
        count: value.resolutions.length,
      }
    })
    mutateLane(lanes[name])
  }
  const selected = Object.entries(lanes).map(([lane, value]) => ({
    lane,
    receipt: add(`recovery-v2-lane-${lane}-903-1-${value.executor.jobId}.json`, value),
    executor: value.executor,
    conclusion: "success",
  }))
  const provenanceDescriptors = selected.map((selected, index) =>
    wire("recovery-provenance", {
      policySha256,
      executor: e,
      provenance: {
        lane: selected.lane,
        executor: selected.executor,
        artifactId: String(200 + index),
        serviceDigest: `sha256:${digest(selected.lane)}`,
        receiptSha256: selected.receipt.sha256,
        conclusion: selected.conclusion,
        validatedAt: "2026-09-04T10:04:00.000Z",
      },
      receipt: selected.receipt,
      installations: sort(
        lanes[selected.lane].installations.map((d) =>
          installationAssets.find((r) => r.assetName === d.assetName),
        ),
      ),
      artifact: {
        name: selected.receipt.assetName.slice(0, -5),
        size: 1024,
        workflowId: "801",
        createdAt: "2026-09-04T10:02:00.000Z",
        updatedAt: "2026-09-04T10:02:00.000Z",
        jobStartedAt: "2026-09-04T10:00:00.000Z",
        jobCompletedAt: "2026-09-04T10:03:00.000Z",
      },
    }),
  )
  const provenanceAssets = provenanceDescriptors.map((value) =>
    add(recoveryProvenanceName(value), value),
  )
  const retainedReceipts = sort([
    ...installationAssets,
    ...provenanceAssets,
    ...(retainedRaw === null ? [] : [add("recovery-v2-retained-903-1.json", retainedRaw)]),
  ])
  const set = wire("recovery-verification-set", {
    policySha256,
    executor: e,
    lanes: selected,
    provenance: provenanceDescriptors.map((p) => p.provenance),
    retainedReceipts,
    conclusion: "success",
  })
  mutateSet(set)
  const setRef = add("recovery-v2-verification-set-903-1.json", set)
  const auditIntent = wire("recovery-audit-intent", {
    policySha256,
    executor: e,
    requestId: "audit-903-1-1",
    expectedAuditorSha: e.controllerSha,
    verificationSetSha256: setRef.sha256,
    inventory: sort(all()),
  })
  const intentRef = add(auditName(auditIntent), auditIntent)
  const dispatch = wire("recovery-audit-dispatch", {
    executor: e,
    requestId: auditIntent.requestId,
    expectedAuditorSha: e.controllerSha,
    intentSha256: intentRef.sha256,
    runId: "905",
  })
  const dispatchRef = add(auditName(dispatch), dispatch)
  const audit = wire("recovery-audit-result", {
    policySha256,
    executor: {
      ...e,
      workflow: ".github/workflows/release-postpublication-audit.yml",
      runId: "905",
      jobId: "906",
    },
    requestId: auditIntent.requestId,
    verificationSetSha256: setRef.sha256,
    inventorySha256: digest(canonical(auditIntent.inventory)),
    checks: RECOVERY_AUDIT_CHECKS.map((name) => ({
      name,
      conclusion: "success",
    })),
    conclusion: "success",
  })
  const auditRef = add(auditName(audit), audit)
  const auditEscrow = wire("recovery-audit-escrow", {
    policySha256,
    executor: { ...e, jobId: "907" },
    result: auditRef,
    artifact: {
      id: "999",
      serviceDigest: `sha256:${digest("audit zip")}`,
      name: "recovery-v2-audit-result-905-1-906",
      size: 100,
      workflowId: "802",
      createdAt: "2026-09-04T10:03:20.000Z",
      updatedAt: "2026-09-04T10:03:20.000Z",
      jobStartedAt: "2026-09-04T10:03:00.000Z",
      jobCompletedAt: "2026-09-04T10:03:40.000Z",
    },
    validatedAt: "2026-09-04T10:04:00.000Z",
  })
  const auditEscrowRef = add(auditName(auditEscrow), auditEscrow)
  const finalization = wire("recovery-finalization", {
    policySha256,
    adoption: adoptionRef,
    verificationSet: setRef,
    audit: auditRef,
    assets: sort(all()),
    metadata: {
      title: `Dawn ${c.tag}`,
      body: "Original release notes",
      markerRevision: 5,
    },
  })
  const finalRef = add("recovery-v2-finalization.json", finalization)
  const marker = wire("recovery-marker", {
    policySha256,
    revision: 1,
    phase: "RECOVERY_ADOPTED",
    adoption: adoptionRef,
    verificationSet: null,
    audit: null,
    finalization: null,
  })
  const release = {
    id: 902,
    tag_name: published ? c.tag : "untagged-902",
    name: `Dawn ${c.tag}`,
    body: legacyBody,
    target_commitish: "main",
    prerelease: false,
    draft: !published,
    immutable: published,
  }
  let activeAssets = published ? sort(all()) : baseAssets
  const calls = []
  const present = (value) => ({ status: "PRESENT", value })
  const ci = {
    id: 700,
    run_attempt: 1,
    head_sha: e.controllerSha,
    head_branch: "main",
    path: policy.ci.workflow,
    event: "push",
    workflow_id: 800,
    check_suite_id: 900,
    status: "completed",
    conclusion: "success",
    repository: { id: 901, full_name: c.repository },
  }
  const jobs = policy.ci.checks.map((name, i) => ({
    id: 710 + i,
    runAttempt: 1,
    name,
    status: "completed",
    conclusion: "success",
  }))
  const github = {
    async listReleases() {
      calls.push("listReleases")
      return present([release])
    },
    async getRelease({ releaseId }) {
      calls.push("getRelease")
      assertId(releaseId, c.releaseId)
      return present(release)
    },
    async getReleaseByTag() {
      return present(release)
    },
    async listReleaseAssets() {
      return present(
        activeAssets.map((a) => ({
          id: Number(a.id),
          name: a.assetName,
          size: a.size,
          digest: `sha256:${a.sha256}`,
        })),
      )
    },
    async downloadReleaseAsset({ assetId }) {
      calls.push("download")
      const ref = [...refs.values()].find((a) => a.id === String(assetId))
      return {
        status: "PRESENT",
        contentBase64: raws.get(ref.assetName).toString("base64"),
      }
    },
    async getRef({ ref }) {
      return present(
        ref === "heads/main"
          ? {
              ref: "refs/heads/main",
              object: { type: "commit", sha: e.controllerSha },
            }
          : {
              ref: `refs/tags/${c.tag}`,
              object: { type: "tag", sha: c.tagObjectSha },
            },
      )
    },
    async getGitTag() {
      return present({
        tag: c.tag,
        sha: c.tagObjectSha,
        object: { type: "commit", sha: c.candidateSha },
      })
    },
    async listWorkflowRuns() {
      return present([ci])
    },
    async getActionsRunAttempt({ runId }) {
      if (String(runId) === e.runId)
        return present({
          ...ci,
          id: Number(e.runId),
          path: e.workflow,
          workflow_id: 801,
          event: "workflow_dispatch",
          status: "in_progress",
        })
      return present(
        String(runId) === "905"
          ? {
              ...ci,
              id: 905,
              workflow_id: 802,
              run_attempt: 1,
              path: audit.executor.workflow,
              event: "workflow_dispatch",
            }
          : ci,
      )
    },
    async getWorkflow({ workflow } = {}) {
      if (workflow === "release-postpublication-audit.yml")
        return present({
          id: 802,
          path: audit.executor.workflow,
          state: "active",
        })
      if (workflow === e.workflow.split("/").at(-1))
        return present({ id: 801, path: e.workflow, state: "active" })
      return present({ id: 800, path: policy.ci.workflow, state: "active" })
    },
    async listActionsRunJobs({ runId }) {
      if (String(runId) === e.runId)
        return present([
          {
            id: 907,
            runAttempt: 1,
            name: "recovery-audit-evidence",
            status: "in_progress",
            startedAt: "2026-09-04T10:03:50.000Z",
            completedAt: null,
          },
          {
            id: Number(e.jobId),
            runAttempt: Number(e.runAttempt),
            name: "recovery-evidence",
            status: "in_progress",
            conclusion: null,
            startedAt: "2026-09-04T10:03:30.000Z",
            completedAt: null,
          },
        ])
      return present(
        String(runId) === "905"
          ? [
              {
                id: 906,
                runAttempt: 1,
                name: "recovery-audit",
                status: "completed",
                conclusion: "success",
                startedAt: auditEscrow.artifact.jobStartedAt,
                completedAt: auditEscrow.artifact.jobCompletedAt,
              },
            ]
          : jobs,
      )
    },
    async getCommitCheckRuns() {
      return present(
        jobs.map((j) => ({
          ...j,
          head_sha: e.controllerSha,
          check_suite: { id: 900 },
          app: { slug: "github-actions" },
        })),
      )
    },
  }
  const git = {
    async listTree() {
      return intentPath
    },
    async isAncestor() {
      return true
    },
    async showFile({ ref, path }) {
      if (fence?.files.has(`${ref}:${path}`)) return fence.files.get(`${ref}:${path}`)
      if (path === intentPath) return canonicalRecoveryBytes(intent).toString()
      if (path === "scripts/release/recovery/policy.json")
        return canonicalPolicyBytes(policy).toString()
      return source
    },
  }
  const npm = {
    async observePackageVersion({ name, version }) {
      const p = base.manifest.packages.find((p) => p.name === name)
      return {
        status: "PRESENT",
        package: {
          name,
          version,
          integrity: p.npmIntegrity,
          tarballUrl: tarballUrl(p),
          shasum: digestAlgorithm("sha1", raws.get(p.filename)),
        },
      }
    },
    async downloadRegistryTarball({ tarballUrl: url }) {
      const p = base.manifest.packages.find((p) => tarballUrl(p) === url)
      return {
        status: "PRESENT",
        tarball: {
          url,
          size: p.size,
          sha1: digestAlgorithm("sha1", raws.get(p.filename)),
          sha256: p.sha256,
          sha512: p.sha512,
          contentBase64: raws.get(p.filename).toString("base64"),
        },
      }
    },
  }
  const npmAuditFactory = {
    async create() {
      return {
        async verifyPackages({ entries }) {
          return entries.map((entry) => ({
            name: entry.name,
            version: entry.version,
            status: "verified",
            signature: {
              status: "valid",
              verifier: "npm-audit-signatures@11.17.0",
            },
            provenance: {
              predicateType: "https://slsa.dev/provenance/v1",
              repository: `https://github.com/${c.repository}`,
              workflow: CANDIDATE.publisherWorkflow,
              commitSha: c.candidateSha,
              ref: `refs/tags/${c.tag}`,
            },
          }))
        },
        async dispose() {
          calls.push("dispose")
        },
      }
    },
  }
  return {
    fence,
    c,
    e,
    base,
    policy,
    provenanceAssets,
    provenanceDescriptors,
    intent,
    marker,
    release,
    refs,
    raws,
    calls,
    baseAssets,
    adoption,
    adoptionRef,
    set,
    setRef,
    lanes,
    installationReceipts,
    installationAssets,
    audit,
    auditEscrow,
    auditEscrowRef,
    auditRef,
    auditIntent,
    intentRef,
    dispatch,
    dispatchRef,
    finalization,
    finalRef,
    intentPath,
    legacyBody,
    args: {
      candidate: c,
      git,
      github,
      npm,
      npmAuditFactory,
      attestations: base.attestations,
      controllerRef: e.controllerSha,
    },
    setAssets(value) {
      activeAssets = value
    },
    allAssets: sort(all()),
    add,
  }
}

import { createHash } from "node:crypto"

const digestAlgorithm = (kind, bytes) => createHash(kind).update(bytes).digest("hex")
const tarballUrl = (p) =>
  `https://registry.npmjs.org/${p.name}/-/${p.name.split("/").at(-1)}-${p.version}.tgz`
function assertId(actual, expected) {
  if (String(actual) !== expected) throw new Error("wrong requested release ID")
}
