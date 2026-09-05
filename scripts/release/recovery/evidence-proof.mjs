// Read-only proof boundary shared by the collector, writer, and durable observer.
import { createHash } from "node:crypto"
import { extractActionsArtifactZip } from "../artifact-store.mjs"
import { requiredRecoveryDockerImages } from "./model.mjs"
import {
  canonicalPolicyBytes,
  parseRecoveryPolicy,
  RECOVERY_POLICY_PATH,
  RECOVERY_RETRY,
  recoveryMethods,
  runRecoveryRead,
} from "./policy.mjs"
import {
  canonicalRecoveryBytes,
  metadataCheckName,
  parseRecovery,
  RECOVERY_LANES,
  RECOVERY_LIMITS,
  recoveryApiTimestampRange,
  snapshotRecoveryData,
} from "./schema.mjs"

export const recoveryEvidenceHash = (bytes) => createHash("sha256").update(bytes).digest("hex")
const requireThat = (ok, message) => {
  if (!ok) throw new Error(`Recovery evidence blocked: ${message}`)
}
const stable = (v) =>
  Array.isArray(v)
    ? v.map(stable)
    : v && typeof v === "object"
      ? Object.fromEntries(
          Object.keys(v)
            .sort()
            .map((k) => [k, stable(v[k])]),
        )
      : v
export const sameRecoveryEvidence = (a, b, message) =>
  requireThat(JSON.stringify(stable(a)) === JSON.stringify(stable(b)), message)
export const recoveryLaneArtifactName = (lane, executor) =>
  `recovery-v2-lane-${lane}-${executor.runId}-${executor.runAttempt}-${executor.jobId}`
export const recoveryProvenanceName = (value) =>
  `recovery-v2-provenance-${value.provenance.lane}-${value.provenance.artifactId}-${recoveryEvidenceHash(canonicalRecoveryBytes(value))}.json`
export const recoveryVerificationName = (executor) =>
  `recovery-v2-verification-set-${executor.controllerSha}-${executor.runId}-${executor.runAttempt}-${executor.jobId}.json`
const iso = (value) => {
  recoveryApiTimestampRange(value)
  return value
}
const sortRefs = (refs) =>
  [...refs].sort((a, b) => (a.assetName < b.assetName ? -1 : a.assetName > b.assetName ? 1 : 0))

export function verifyRecoveryLaneInstallations(lane, installations, manifestPackages) {
  const subjects = new Map()
  sameRecoveryEvidence(
    Object.keys(installations).sort(),
    lane.installations.map((d) => d.assetName).sort(),
    "exact installation file membership required",
  )
  for (const descriptor of lane.installations) {
    const bytes = Buffer.from(installations[descriptor.assetName], "base64")
    requireThat(
      bytes.toString("base64") === installations[descriptor.assetName] &&
        bytes.length === descriptor.size &&
        recoveryEvidenceHash(bytes) === descriptor.sha256,
      "installation bytes/size/digest differ",
    )
    const value = parseRecovery(bytes, {
      kind: "recovery-installation",
      candidate: lane.candidate,
      executor: lane.executor,
    })
    sameRecoveryEvidence(value.policySha256, lane.policySha256, "installation policy differs")
    sameRecoveryEvidence(value.lane, lane.lane, "installation lane differs")
    sameRecoveryEvidence(value.check, descriptor.check, "installation checkpoint differs")
    sameRecoveryEvidence(value.resolutions.length, descriptor.count, "installation count differs")
    for (const item of value.resolutions) {
      sameRecoveryEvidence(
        item.subject,
        manifestPackages.includes(item.name),
        "installation subject classification differs",
      )
      if (!item.subject) continue
      const previous = subjects.get(item.name)
      requireThat(
        !previous || (previous.resolved === item.resolved && previous.integrity === item.integrity),
        "installation subject identity changed",
      )
      if (!previous || item.installPath < previous.installPath) subjects.set(item.name, item)
    }
  }
  sameRecoveryEvidence(
    lane.resolutions,
    [...subjects.values()].sort((a, b) =>
      a.installPath < b.installPath ? -1 : a.installPath > b.installPath ? 1 : 0,
    ),
    "lane subject summary differs from installation bytes",
  )
}

export function verifyRecoveryProvenanceBindings(value, lane, refs, bytes, manifestPackages) {
  value = parseRecovery(value, { kind: "recovery-provenance", candidate: lane.candidate })
  sameRecoveryEvidence(value.policySha256, lane.policySha256, "provenance policy differs")
  sameRecoveryEvidence(value.provenance.executor, lane.executor, "provenance lane executor differs")
  sameRecoveryEvidence(value.provenance.lane, lane.lane, "provenance lane differs")
  sameRecoveryEvidence(
    value.provenance.conclusion,
    lane.conclusion,
    "provenance conclusion differs",
  )
  sameRecoveryEvidence(
    value.receipt.sha256,
    recoveryEvidenceHash(canonicalRecoveryBytes(lane)),
    "provenance raw receipt differs",
  )
  sameRecoveryEvidence(
    value.receipt.size,
    canonicalRecoveryBytes(lane).length,
    "provenance raw size differs",
  )
  sameRecoveryEvidence(
    refs.find((r) => r.assetName === value.receipt.assetName),
    value.receipt,
    "provenance receipt not independently persisted",
  )
  sameRecoveryEvidence(
    value.installations,
    sortRefs(lane.installations.map((d) => refs.find((r) => r.assetName === d.assetName))),
    "provenance installation inventory differs",
  )
  verifyRecoveryLaneInstallations(lane, bytes, manifestPackages)
  requireThat(
    recoveryApiTimestampRange(value.artifact.jobStartedAt)[0] <= Date.parse(lane.startedAt) &&
      Date.parse(lane.finishedAt) <= recoveryApiTimestampRange(value.artifact.jobCompletedAt)[1],
    "lane timing differs from observed job",
  )
  return value
}

export async function observeRecoveryLaneEvidence(input, githubInput, clock) {
  const {
    candidate,
    executor,
    policy,
    policySha256,
    manifestPackages,
    lane: laneName,
  } = snapshotRecoveryData(input)
  const github = recoveryMethods(githubInput, [
    "getWorkflow",
    "getActionsRunAttempt",
    "listActionsRunJobs",
    "listActionsRunArtifacts",
    "getActionsArtifact",
    "downloadActionsArtifact",
  ])
  const { now, sleep } = recoveryMethods(clock, ["now", "sleep"])
  const phaseDeadline = now() + RECOVERY_RETRY.phaseDeadlineMs
  const read = async (method, args, maximumBytes = 16 * 1024 * 1024) => {
    const r = await runRecoveryRead(
      { phaseDeadline, responseBytes: Math.ceil(maximumBytes / 3) * 4 + 4096 },
      () => github[method](args),
      { now, sleep },
    )
    requireThat(r.status === "PRESENT", `${method} proof unavailable`)
    return method === "downloadActionsArtifact" ? r.contentBase64 : r.value
  }
  const workflow = await read("getWorkflow", { workflow: executor.workflow.split("/").at(-1) })
  const run = await read("getActionsRunAttempt", {
    runId: executor.runId,
    attempt: executor.runAttempt,
  })
  requireThat(
    workflow.path === executor.workflow &&
      workflow.id === run.workflow_id &&
      workflow.state === "active",
    "workflow identity differs",
  )
  requireThat(
    String(run.id) === executor.runId &&
      String(run.run_attempt) === executor.runAttempt &&
      run.path === executor.workflow &&
      run.head_sha === executor.controllerSha &&
      run.head_branch === "main" &&
      run.event === "workflow_dispatch" &&
      ["in_progress", "completed"].includes(run.status) &&
      String(run.repository?.id) === candidate.repositoryId &&
      run.repository?.full_name === candidate.repository,
    "run/attempt/SHA/repository identity differs",
  )
  const jobs = await read("listActionsRunJobs", { runId: executor.runId })
  requireThat(Array.isArray(jobs), "job inventory unavailable")
  const matchedJobs = jobs.filter(
    (j) => j.name === `recovery-${laneName}` && String(j.runAttempt) === executor.runAttempt,
  )
  requireThat(matchedJobs.length <= 1, "duplicate lane job")
  if (matchedJobs.length === 0) {
    const artifacts = await read("listActionsRunArtifacts", { runId: executor.runId })
    requireThat(
      Array.isArray(artifacts) &&
        !artifacts.some((a) =>
          a.name.startsWith(
            `recovery-v2-lane-${laneName}-${executor.runId}-${executor.runAttempt}-`,
          ),
        ),
      "artifact lacks matching attempt-specific job",
    )
    return { missing: `Missing ${laneName} job` }
  }
  const job = matchedJobs[0]
  requireThat(/^[1-9][0-9]*$/u.test(String(job.id)), "lane job run/SHA identity differs")
  if (job.status !== "completed") return { missing: `Pending ${laneName} job` }
  const laneExecutor = { ...executor, jobId: String(job.id) }
  const name = recoveryLaneArtifactName(laneName, laneExecutor)
  const artifacts = await read("listActionsRunArtifacts", { runId: executor.runId })
  requireThat(
    Array.isArray(artifacts) &&
      artifacts.length <= RECOVERY_LIMITS.retainedAssets &&
      new Set(artifacts.map((a) => String(a.id))).size === artifacts.length,
    "bounded unique artifact inventory required",
  )
  const matched = artifacts.filter((a) => a.name === name)
  // Another current-attempt artifact for this lane is conflicting proof, not a missing lane.
  requireThat(
    artifacts.filter((a) =>
      a.name.startsWith(`recovery-v2-lane-${laneName}-${executor.runId}-${executor.runAttempt}-`),
    ).length === matched.length,
    "foreign lane artifact job identity",
  )
  requireThat(matched.length <= 1, "duplicate lane artifact")
  if (matched.length === 0) return { missing: `Missing ${laneName} artifact` }
  const artifact = await read("getActionsArtifact", { artifactId: String(matched[0].id) })
  sameRecoveryEvidence(artifact, matched[0], "artifact list/detail identity differs")
  const identity = artifact.workflow_run
  requireThat(
    identity &&
      String(identity.id) === executor.runId &&
      String(identity.repository_id) === candidate.repositoryId &&
      String(identity.head_repository_id) === candidate.repositoryId &&
      identity.head_sha === executor.controllerSha &&
      identity.head_branch === "main",
    "artifact workflow run identity differs",
  )
  requireThat(
    artifact.expired === false &&
      /^sha256:[a-f0-9]{64}$/u.test(artifact.digest) &&
      Number.isSafeInteger(artifact.size_in_bytes) &&
      artifact.size_in_bytes > 0 &&
      artifact.size_in_bytes <= 4 * RECOVERY_LIMITS.selectionBytes,
    "artifact expired or bytes/digest unavailable",
  )
  const encoded = await read(
    "downloadActionsArtifact",
    { artifactId: String(artifact.id), maximumBytes: artifact.size_in_bytes },
    artifact.size_in_bytes,
  )
  requireThat(typeof encoded === "string", "artifact bytes unavailable")
  const archive = Buffer.from(encoded, "base64")
  requireThat(
    archive.toString("base64") === encoded &&
      archive.length === artifact.size_in_bytes &&
      `sha256:${recoveryEvidenceHash(archive)}` === artifact.digest,
    "artifact bytes/service digest differ",
  )
  const files = extractActionsArtifactZip(archive, {
    maxOutputBytes: 4 * RECOVERY_LIMITS.selectionBytes,
  })
  const raw = files.find((f) => f.name === `${name}.json`)
  requireThat(raw, "raw lane receipt missing")
  const lane = parseRecovery(raw.bytes, {
    kind: "recovery-lane",
    candidate,
    executor: laneExecutor,
  })
  sameRecoveryEvidence(lane.lane, laneName, "lane identity differs")
  sameRecoveryEvidence(lane.policySha256, policySha256, "lane policy differs")
  sameRecoveryEvidence(
    files.map((f) => f.name).sort(),
    [raw.name, ...lane.installations.map((d) => d.assetName)].sort(),
    "exact artifact file membership required",
  )
  const installations = Object.fromEntries(
    files.filter((f) => f !== raw).map((f) => [f.name, f.bytes.toString("base64")]),
  )
  verifyRecoveryLaneInstallations(lane, installations, manifestPackages)
  const p = policy.lanes.find((p) => p.name === laneName)
  const checks = [
    ...p.requiredChecks,
    ...(p.packageChecks === "each-manifest-package"
      ? manifestPackages.map((n) => metadataCheckName(`package:${n}`))
      : []),
  ]
  if (lane.conclusion === "success")
    requireThat(
      checks.every((name) =>
        lane.checks.some((c) => c.name === name && c.conclusion === "success"),
      ),
      "required policy check missing",
    )
  if (lane.conclusion === "success") {
    for (const key of ["profile", "node", "packageManager", "platform", "architecture"])
      sameRecoveryEvidence(
        lane.environment[key],
        policy.environment[key],
        "lane environment differs",
      )
    sameRecoveryEvidence(
      lane.environment.dockerImages.map((i) => i.reference),
      requiredRecoveryDockerImages(laneName),
      "lane Docker image inventory differs",
    )
  }
  requireThat(
    lane.environment.dockerImages.every((image) =>
      policy.environment.dockerImages.includes(image.reference),
    ),
    "unapproved observed Docker image",
  )
  const conclusion = job.conclusion === "success" ? "success" : "failure"
  requireThat(lane.conclusion === conclusion, "lane/API job conclusion differs")
  const provenance = {
    lane: laneName,
    executor: laneExecutor,
    artifactId: String(artifact.id),
    serviceDigest: artifact.digest,
    receiptSha256: recoveryEvidenceHash(raw.bytes),
    conclusion,
    validatedAt: new Date(now()).toISOString(),
  }
  const descriptor = {
    name,
    size: artifact.size_in_bytes,
    workflowId: String(workflow.id),
    createdAt: iso(artifact.created_at),
    updatedAt: iso(artifact.updated_at),
    jobStartedAt: iso(job.startedAt),
    jobCompletedAt: iso(job.completedAt),
  }
  // Reuse the exact wire timing and identity rules before any caller may upload bytes.
  parseRecovery({
    schemaVersion: 2,
    kind: "recovery-provenance",
    candidate,
    policySha256,
    executor,
    provenance,
    receipt: {
      assetName: raw.name,
      id: "1",
      sha256: provenance.receiptSha256,
      size: raw.bytes.length,
    },
    installations: [],
    artifact: descriptor,
  })
  requireThat(
    recoveryApiTimestampRange(job.startedAt)[0] <= Date.parse(lane.startedAt) &&
      Date.parse(lane.finishedAt) <= recoveryApiTimestampRange(job.completedAt)[1],
    "lane timing differs from observed job",
  )
  return {
    lane,
    name: raw.name,
    contentBase64: raw.bytes.toString("base64"),
    installations,
    provenance,
    artifact: descriptor,
  }
}

// Unlike main-CI admission, this proves the descriptor-producing invocation existed.
export async function verifyRecoveryEscrowProducer(value, read, now = Date.now()) {
  const e = value.executor,
    c = value.candidate
  const run = await read("getActionsRunAttempt", { runId: e.runId, attempt: e.runAttempt })
  const workflow = await read("getWorkflow", { workflow: e.workflow.split("/").at(-1) })
  requireThat(
    run.path === e.workflow &&
      workflow.path === e.workflow &&
      workflow.id === run.workflow_id &&
      String(run.id) === e.runId &&
      String(run.run_attempt) === e.runAttempt &&
      run.head_sha === e.controllerSha &&
      run.head_branch === "main" &&
      run.event === "workflow_dispatch" &&
      ["in_progress", "completed"].includes(run.status) &&
      String(run.repository?.id) === c.repositoryId &&
      run.repository?.full_name === c.repository,
    "escrow producer run identity differs",
  )
  const jobs = await read("listActionsRunJobs", { runId: e.runId })
  requireThat(Array.isArray(jobs), "escrow producer job inventory missing")
  const selected = jobs.filter(
    (j) => String(j.id) === e.jobId && String(j.runAttempt) === e.runAttempt,
  )
  requireThat(
    selected.length === 1 && selected[0].name === "recovery-evidence",
    "escrow producer job identity differs",
  )
  const j = selected[0],
    stamp = Date.parse(value.provenance.validatedAt)
  requireThat(
    ["in_progress", "completed"].includes(j.status) &&
      Date.parse(j.startedAt) <= stamp &&
      stamp <= now &&
      (j.status !== "completed" || stamp <= recoveryApiTimestampRange(j.completedAt)[1]),
    "escrow producer timing differs",
  )
}

export function buildRecoveryVerificationSet(current, executor) {
  const facts = current.facts
  const selected = (facts.escrow ?? []).filter((entry) =>
    ["controllerSha", "verifierClosureSha256", "workflow", "runId", "runAttempt"].every(
      (key) => entry.receipt.executor[key] === executor[key],
    ),
  )
  const lanes = facts.adoption.receipt ? RECOVERY_LANES : []
  requireThat(
    lanes.length === 5 &&
      selected.length === 5 &&
      lanes.every((lane) => selected.filter((e) => e.lane.lane === lane).length === 1),
    "five unambiguous independently persisted escrow lanes required",
  )
  selected.sort((a, b) => (a.lane.lane < b.lane.lane ? -1 : 1))
  requireThat(
    selected.every((e) => e.lane.conclusion === "success"),
    "failed lane cannot be selected",
  )
  const adoption = facts.adoption.receipt
  const excluded = new Set(
    [
      ...adoption.baseAssets,
      adoption.archive,
      ...adoption.retainedAttempts,
      facts.adoption.ref,
      ...selected.map((e) => e.receipt.receipt),
    ].map((r) => r.assetName),
  )
  return parseRecovery({
    schemaVersion: 2,
    kind: "recovery-verification-set",
    candidate: current.candidate,
    policySha256: facts.policySha256,
    executor,
    lanes: selected.map((e) => ({
      lane: e.lane.lane,
      receipt: e.receipt.receipt,
      executor: e.lane.executor,
      conclusion: e.lane.conclusion,
    })),
    provenance: selected.map((e) => e.receipt.provenance),
    retainedReceipts: sortRefs(facts.assets.filter((r) => !excluded.has(r.assetName))),
    conclusion: "success",
  })
}

export async function readRecoveryEvidencePolicy(executor, policySha256, git) {
  const { showFile } = recoveryMethods(git, ["showFile"])
  const policy = parseRecoveryPolicy(
    await showFile({ ref: executor.controllerSha, path: RECOVERY_POLICY_PATH }),
  )
  requireThat(
    policy.status === "ADMITTED" &&
      recoveryEvidenceHash(canonicalPolicyBytes(policy)) === policySha256,
    "accepted evidence policy differs",
  )
  return policy
}
