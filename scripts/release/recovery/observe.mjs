// Read-only v2 observation. Never adapts recovery evidence into a legacy observation.
import { createHash } from "node:crypto"
import { types } from "node:util"
import { RELEASE_PAYLOAD_LIMITS } from "../limits.mjs"
import { canonicalManifestBytes, parseSealedReleaseManifest } from "../manifest.mjs"
import { parseReleaseMarker, verifyReleaseAttestationAnchor } from "../metadata.mjs"
import { NPM_AUDIT_VERIFIER } from "../npm-audit.mjs"
import { canonicalReleaseRecordBytes, parseReleaseRecord } from "../release-record.mjs"
import { parseRecoveryReleaseMarker, renderRecoveryFinalMetadata } from "./metadata.mjs"
import { planRecovery, verifyRecoveryObservedPhase } from "./model.mjs"
import {
  canonicalPolicyBytes,
  hashVerifierClosure,
  parseRecoveryPolicy,
  RECOVERY_POLICY_PATH,
  RECOVERY_RETRY,
  recoveryMethods,
  runRecoveryRead,
} from "./policy.mjs"
import {
  canonicalRecoveryBytes,
  parseRecovery,
  RECOVERY_LIMITS,
  snapshotRecoveryData,
} from "./schema.mjs"

export const RECOVERY_FINALIZATION_ASSET = "recovery-v2-finalization.json"
const requireThat = (ok, message) => {
  if (!ok) throw new TypeError(`Recovery observation blocked: ${message}`)
}
const hash = (bytes) => createHash("sha256").update(bytes).digest("hex")
const stable = (value) =>
  Array.isArray(value)
    ? value.map(stable)
    : value && typeof value === "object"
      ? Object.fromEntries(
          Object.keys(value)
            .sort()
            .map((key) => [key, stable(value[key])]),
        )
      : value
const same = (a, b, message) =>
  requireThat(
    JSON.stringify(stable(snapshotRecoveryData(a, 16 * 1024 * 1024))) ===
      JSON.stringify(stable(snapshotRecoveryData(b, 16 * 1024 * 1024))),
    message,
  )
const sorted = (assets) =>
  [...assets].sort((a, b) => (a.assetName < b.assetName ? -1 : a.assetName > b.assetName ? 1 : 0))
const legacyIdentity = (c) => ({
  version: c.version,
  commitSha: c.candidateSha,
  ciWorkflow: "CI",
  ciCheck: "validate",
  publisherWorkflow: ".github/workflows/release.yml",
})
function validateIdentity(c) {
  parseRecovery({
    schemaVersion: 2,
    kind: "recovery-adoption-intent",
    candidate: c,
    policySha256: "0".repeat(64),
    legacyBodySha256: "0".repeat(64),
    legacyPhase: "NPM_COMPLETE",
    operations: ["adopt"],
  })
}
function safeInput(input, fields) {
  requireThat(
    input && typeof input === "object" && !types.isProxy(input),
    "safe input object required",
  )
  const result = {}
  for (const name of fields) {
    const descriptor = Object.getOwnPropertyDescriptor(input, name)
    if (!descriptor) continue
    requireThat(
      Object.hasOwn(descriptor, "value") && descriptor.enumerable,
      "safe data descriptor required",
    )
    result[name] = descriptor.value
  }
  return result
}
function readerContext({ github, git }) {
  const now = Date.now
  const deps = { now, sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)) }
  const phaseDeadline = now() + RECOVERY_RETRY.phaseDeadlineMs
  const envelope = async (fn, key = "value", responseBytes) => {
    const result = await runRecoveryRead(
      { phaseDeadline, ...(responseBytes === undefined ? {} : { responseBytes }) },
      fn,
      deps,
    )
    requireThat(
      result.status === "PRESENT" && Object.hasOwn(result, key),
      `exact ${key} read unavailable`,
    )
    return result[key]
  }
  const budget = createRecoveryWorkBudget({ phaseDeadline })
  return {
    read: (name, args) => envelope(() => recoveryMethods(github, [name])[name](args)),
    download: (args) =>
      envelope(
        () => recoveryMethods(github, ["downloadReleaseAsset"]).downloadReleaseAsset(args),
        "contentBase64",
        Math.ceil(args.maximumBytes / 3) * 4 + 4096,
      ),
    npm: (fn, key) =>
      envelope(
        fn,
        key,
        key === "tarball"
          ? Math.ceil(RELEASE_PAYLOAD_LIMITS.tarballBytes / 3) * 4 + 4096
          : undefined,
      ),
    git: async (name, args) =>
      envelope(async () => ({
        status: "PRESENT",
        value: await recoveryMethods(git, [name])[name](args),
      })),
    work: budget.work,
    settled: budget.settled,
  }
}
// A timeout invalidates this invocation. Cleanup may run only after that exact
// operation settles; late results never become proof or trigger another read.
export function createRecoveryWorkBudget(
  options,
  dependencies = { now: Date.now, setTimer: setTimeout, clearTimer: clearTimeout },
) {
  const { phaseDeadline } = snapshotRecoveryData(options, 4096)
  const { now, setTimer, clearTimer } = recoveryMethods(dependencies, [
    "now",
    "setTimer",
    "clearTimer",
  ])
  requireThat(
    Number.isSafeInteger(phaseDeadline) && phaseDeadline >= 0,
    "bounded phase deadline required",
  )
  let unsettled = false
  const work = async (operation, onLateSettlement = null) => {
    requireThat(
      typeof operation === "function" &&
        !types.isProxy(operation) &&
        (onLateSettlement === null ||
          (typeof onLateSettlement === "function" && !types.isProxy(onLateSettlement))),
      "safe verifier callbacks required",
    )
    requireThat(!unsettled, "prior verifier work has not settled")
    const remaining = phaseDeadline - now()
    requireThat(remaining > 0, "verification phase deadline expired")
    let timer,
      expired = false
    const pending = Promise.resolve().then(operation)
    try {
      const result = await Promise.race([
        pending,
        new Promise((_, reject) => {
          timer = setTimer(() => {
            expired = true
            unsettled = true
            reject(new Error("Recovery verifier phase deadline expired with unsettled work"))
          }, remaining)
        }),
      ])
      if (now() >= phaseDeadline) {
        expired = true
        unsettled = true
        throw new Error("Recovery verifier phase deadline expired")
      }
      return result
    } finally {
      clearTimer(timer)
      if (expired && onLateSettlement)
        void pending.then(onLateSettlement, () => onLateSettlement(undefined)).catch(() => {})
    }
  }
  return Object.freeze({ work, settled: () => !unsettled })
}
export function normalizeRecoveryAssetInventory(values) {
  values = snapshotRecoveryData(values, 16 * 1024 * 1024)
  requireThat(
    Array.isArray(values) &&
      values.length > 0 &&
      values.length <= RECOVERY_LIMITS.originalAssets + RECOVERY_LIMITS.retainedAssets,
    "bounded asset inventory required",
  )
  const ids = new Set(),
    names = new Set()
  let originalBytes = 0,
    recoveryBytes = 0,
    originalCount = 0,
    recoveryCount = 0
  return sorted(
    values.map((value) => {
      const id = String(value.id),
        assetName = value.name
      requireThat(
        /^[1-9][0-9]{0,31}$/u.test(id) &&
          !ids.has(id) &&
          typeof assetName === "string" &&
          /^[A-Za-z0-9][A-Za-z0-9._@+-]*$/u.test(assetName) &&
          !names.has(assetName),
        "unique asset identity required",
      )
      requireThat(
        Number.isSafeInteger(value.size) &&
          value.size > 0 &&
          value.size <=
            (assetName.startsWith("recovery-v2-")
              ? RECOVERY_LIMITS.selectionBytes
              : assetName === "manifest.json"
                ? RELEASE_PAYLOAD_LIMITS.manifestBytes
                : assetName === "release-record.json"
                  ? RELEASE_PAYLOAD_LIMITS.releaseRecordBytes
                  : assetName.endsWith(".intoto.jsonl")
                    ? RELEASE_PAYLOAD_LIMITS.attestationBundleBytes
                    : RELEASE_PAYLOAD_LIMITS.tarballBytes),
        "bounded asset size required",
      )
      requireThat(
        typeof value.digest === "string" && /^sha256:[a-f0-9]{64}$/u.test(value.digest),
        "service asset digest required",
      )
      ids.add(id)
      names.add(assetName)
      if (assetName.startsWith("recovery-v2-")) {
        recoveryBytes += value.size
        recoveryCount++
      } else {
        originalBytes += value.size
        originalCount++
      }
      requireThat(
        originalBytes <= RELEASE_PAYLOAD_LIMITS.escrowBytes &&
          recoveryBytes <= RECOVERY_LIMITS.retainedBytes &&
          originalCount <= RECOVERY_LIMITS.originalAssets &&
          recoveryCount <= RECOVERY_LIMITS.retainedAssets,
        "release namespace byte/count budget exceeded",
      )
      return { id, assetName, size: value.size, sha256: value.digest.slice(7) }
    }),
  )
}
async function loadAsset(context, ref) {
  const base64 = await context.download({ assetId: ref.id, maximumBytes: ref.size })
  requireThat(typeof base64 === "string", "asset bytes unavailable")
  const bytes = Buffer.from(base64, "base64")
  requireThat(
    bytes.length === ref.size && bytes.toString("base64") === base64 && hash(bytes) === ref.sha256,
    "asset bytes or digest differ",
  )
  return bytes
}
function exactRelease(release, c) {
  requireThat(
    String(release.id) === c.releaseId &&
      release.prerelease === false &&
      release.target_commitish === "main" &&
      typeof release.draft === "boolean" &&
      typeof release.immutable === "boolean",
    "canonical release identity differs",
  )
  requireThat(
    release.draft
      ? release.immutable === false &&
          (release.tag_name === c.tag || /^untagged-/u.test(release.tag_name))
      : release.immutable === true && release.tag_name === c.tag,
    "published tag or immutable release state differs",
  )
}
async function tagProof(context, c) {
  const ref = await context.read("getRef", { ref: `tags/${c.tag}` })
  requireThat(
    ref.ref === `refs/tags/${c.tag}` &&
      ref.object?.type === "tag" &&
      ref.object.sha === c.tagObjectSha,
    "annotated tag object differs",
  )
  const tag = await context.read("getGitTag", { tagSha: c.tagObjectSha })
  requireThat(
    tag.sha === c.tagObjectSha &&
      tag.tag === c.tag &&
      tag.object?.type === "commit" &&
      tag.object.sha === c.candidateSha,
    "exact annotated tag peel differs",
  )
  return { name: c.tag, objectSha: c.tagObjectSha, candidateSha: c.candidateSha }
}
async function baseProof(context, c, refs, bytes, attestations) {
  const get = (name) => {
    requireThat(bytes.has(name), `missing original asset ${name}`)
    return bytes.get(name)
  }
  const manifestBytes = get("manifest.json"),
    recordBytes = get("release-record.json")
  requireThat(
    hash(manifestBytes) === c.manifestSha256 && hash(recordBytes) === c.releaseRecordSha256,
    "original manifest or record digest differs",
  )
  const identity = legacyIdentity(c)
  const manifest = parseSealedReleaseManifest(manifestBytes, { candidate: identity })
  const record = parseReleaseRecord(recordBytes)
  requireThat(
    manifestBytes.equals(canonicalManifestBytes(manifest)) &&
      recordBytes.equals(canonicalReleaseRecordBytes(record)),
    "base canonical bytes differ",
  )
  requireThat(
    record.commitSha === c.candidateSha &&
      record.version === c.version &&
      record.manifestSha256 === c.manifestSha256,
    "base record candidate differs",
  )
  const files = [
    { name: "manifest.json", bytes: manifestBytes },
    ...manifest.packages.map((pkg) => {
      const payload = get(pkg.filename)
      requireThat(
        payload.length === pkg.size &&
          hash(payload) === pkg.sha256 &&
          createHash("sha512").update(payload).digest("hex") === pkg.sha512,
        "original tarball bytes differ",
      )
      return { name: pkg.filename, bytes: payload }
    }),
  ]
  const bundle = get("manifest.json.intoto.jsonl")
  for (const file of files)
    requireThat(
      get(`${file.name}.intoto.jsonl`).equals(bundle),
      "original attestation bundle set differs",
    )
  const anchor = await verifyReleaseAttestationAnchor({
    candidate: identity,
    record,
    artifact: { manifest, files },
    bundleBytes: bundle,
    attestations: {
      verify: (args) => context.work(() => recoveryMethods(attestations, ["verify"]).verify(args)),
    },
  })
  const names = [
    "release-record.json",
    ...files.flatMap((file) => [file.name, `${file.name}.intoto.jsonl`]),
  ].sort()
  const original = refs.filter((ref) => !ref.assetName.startsWith("recovery-v2-"))
  same(
    original.map((ref) => ref.assetName),
    names,
    "original asset set differs",
  )
  return { manifest, record, baseAssets: original, anchor }
}
async function npmProof(context, c, manifest, npm, npmAuditFactory) {
  npm = recoveryMethods(npm, ["observePackageVersion", "downloadRegistryTarball"])
  const verifier = recoveryMethods(
    await context.work(
      () => recoveryMethods(npmAuditFactory, ["create"]).create(),
      async (value) => {
        if (value !== undefined) await recoveryMethods(value, ["dispose"]).dispose()
      },
    ),
    ["verifyPackage", "dispose"],
  )
  const packages = []
  try {
    for (const entry of [...manifest.packages].sort((a, b) => (a.name < b.name ? -1 : 1))) {
      const pkg = await context.npm(
        () => npm.observePackageVersion({ name: entry.name, version: entry.version }),
        "package",
      )
      const url = `https://registry.npmjs.org/${entry.name}/-/${entry.name.split("/").at(-1)}-${entry.version}.tgz`
      requireThat(
        pkg.name === entry.name &&
          pkg.version === entry.version &&
          pkg.integrity === entry.npmIntegrity &&
          pkg.tarballUrl === url,
        "registry package identity differs",
      )
      const payload = await context.npm(
        () => npm.downloadRegistryTarball({ tarballUrl: url }),
        "tarball",
      )
      const bytes =
        typeof payload.contentBase64 === "string"
          ? Buffer.from(payload.contentBase64, "base64")
          : null
      requireThat(
        bytes &&
          bytes.toString("base64") === payload.contentBase64 &&
          bytes.length === entry.size &&
          payload.size === entry.size &&
          payload.url === url &&
          hash(bytes) === entry.sha256 &&
          payload.sha256 === entry.sha256 &&
          createHash("sha512").update(bytes).digest("hex") === entry.sha512 &&
          payload.sha512 === entry.sha512 &&
          createHash("sha1").update(bytes).digest("hex") === pkg.shasum &&
          payload.sha1 === pkg.shasum,
        "registry tarball bytes differ",
      )
      const audit = snapshotRecoveryData(
        await context.work(
          () => verifier.verifyPackage({ entry, candidate: legacyIdentity(c) }),
          () => verifier.dispose(),
        ),
      )
      requireThat(
        audit?.status === "verified" &&
          audit.signature?.status === "valid" &&
          audit.signature.verifier === NPM_AUDIT_VERIFIER,
        "registry signatures invalid",
      )
      same(
        audit.provenance,
        {
          predicateType: "https://slsa.dev/provenance/v1",
          repository: `https://github.com/${c.repository}`,
          workflow: ".github/workflows/release.yml",
          commitSha: c.candidateSha,
          ref: `refs/tags/${c.tag}`,
        },
        "registry source differs",
      )
      packages.push({
        name: entry.name,
        version: entry.version,
        sourceSha: c.candidateSha,
        integrity: entry.npmIntegrity,
        tarballSha256: entry.sha256,
        conclusion: "success",
      })
    }
  } finally {
    // Cleanup must still start after a read consumes the phase budget. It grants
    // no authority and cannot overlap the unsettled verifier work whose late
    // settlement callback owns disposal instead.
    if (context.settled()) await verifier.dispose()
  }
  return { manifestSha256: c.manifestSha256, packages, conclusion: "success" }
}

// Historical executor eligibility is proved separately from current mutation authority.
async function executorAdmission(context, c, executor, policySha256, cache, role = "owner") {
  requireThat(
    executor.workflow ===
      (role === "audit"
        ? ".github/workflows/release-postpublication-audit.yml"
        : ".github/workflows/release-postpublication.yml"),
    "historical executor workflow role differs",
  )
  const key = `${executor.controllerSha}:${executor.verifierClosureSha256}`
  if (!cache.has(key)) {
    const policy = parseRecoveryPolicy(
      await context.git("showFile", { ref: executor.controllerSha, path: RECOVERY_POLICY_PATH }),
    )
    requireThat(
      policy.status === "ADMITTED" && hash(canonicalPolicyBytes(policy)) === policySha256,
      "historical recovery policy is not admitted",
    )
    const closure = await hashVerifierClosure(
      { controllerSha: executor.controllerSha, inputs: policy.verifierClosure.inputs },
      (args) => context.git("showFile", args),
    )
    requireThat(
      closure === policy.verifierClosure.sha256 && closure === executor.verifierClosureSha256,
      "historical verifier closure differs",
    )
    const main = await context.read("getRef", { ref: "heads/main" })
    requireThat(
      main.ref === "refs/heads/main" &&
        main.object?.type === "commit" &&
        (await context.git("isAncestor", {
          ancestor: executor.controllerSha,
          descendant: main.object.sha,
        })) === true,
      "historical executor not merged on main",
    )
    const runs = await context.read("listWorkflowRuns", {
      workflow: "ci.yml",
      commitSha: executor.controllerSha,
    })
    requireThat(Array.isArray(runs), "CI run inventory unavailable")
    const matches = runs.filter(
      (r) =>
        r.head_sha === executor.controllerSha &&
        r.head_branch === "main" &&
        r.path === policy.ci.workflow &&
        r.event === "push",
    )
    requireThat(matches.length === 1, "exact historical main CI run required")
    const ci = await context.read("getActionsRunAttempt", {
      runId: String(matches[0].id),
      attempt: String(matches[0].run_attempt),
    })
    for (const key of [
      "id",
      "run_attempt",
      "head_sha",
      "head_branch",
      "path",
      "event",
      "workflow_id",
      "check_suite_id",
    ])
      same(ci[key], matches[0][key], "CI attempt identity differs")
    requireThat(
      ci.status === "completed" &&
        ci.conclusion === "success" &&
        String(ci.repository?.id) === c.repositoryId &&
        ci.repository?.full_name === c.repository,
      "historical successful CI repository differs",
    )
    const workflow = await context.read("getWorkflow", { workflow: "ci.yml" })
    requireThat(
      workflow.id === ci.workflow_id && workflow.path === policy.ci.workflow,
      "CI workflow identity differs",
    )
    const checks = await context.read("getCommitCheckRuns", { commitSha: executor.controllerSha })
    const jobs = await context.read("listActionsRunJobs", { runId: String(ci.id) })
    requireThat(Array.isArray(checks) && Array.isArray(jobs), "CI checks and jobs unavailable")
    for (const name of policy.ci.checks) {
      const selected = checks.filter(
        (check) =>
          check.name === name &&
          check.head_sha === executor.controllerSha &&
          check.check_suite?.id === ci.check_suite_id,
      )
      const selectedJobs = jobs.filter(
        (job) => job.name === name && String(job.runAttempt) === String(ci.run_attempt),
      )
      requireThat(
        selected.length === 1 &&
          selectedJobs.length === 1 &&
          selected[0].id === selectedJobs[0].id &&
          selected[0].app?.slug === "github-actions" &&
          [selected[0], selectedJobs[0]].every(
            (x) => x.status === "completed" && x.conclusion === "success",
          ),
        `historical CI ${name} is not successful`,
      )
    }
    cache.set(key, policy)
  }
  return {
    admission: {
      schemaVersion: 2,
      policySha256,
      controllerSha: executor.controllerSha,
      verifierClosureSha256: executor.verifierClosureSha256,
      workflow: executor.workflow,
      admission: "reviewed-main-ci",
    },
    policy: cache.get(key),
  }
}
async function recoveryChain(
  context,
  c,
  refs,
  bytes,
  base,
  npmEvidence,
  marker,
  finalization,
  controllerRef,
) {
  const byName = new Map(refs.map((ref) => [ref.assetName, ref]))
  const wire = (ref, kind) => {
    same(byName.get(ref.assetName), ref, "selected receipt identity differs")
    return parseRecovery(bytes.get(ref.assetName), {
      ...(kind === undefined ? {} : { kind }),
      candidate: c,
    })
  }
  const adoptionRef = finalization?.adoption ?? marker.adoption
  const adoption = wire(adoptionRef, "recovery-adoption")
  const policySha256 = adoption.policySha256
  const currentPolicy = parseRecoveryPolicy(
    await context.git("showFile", { ref: controllerRef, path: RECOVERY_POLICY_PATH }),
  )
  requireThat(
    hash(canonicalPolicyBytes(currentPolicy)) === policySha256,
    "current accepted recovery policy differs",
  )
  const cache = new Map()
  const admitted = await executorAdmission(context, c, adoption.executor, policySha256, cache)
  const intent = parseRecovery(
    await context.git("showFile", {
      ref: adoption.authority.reviewedControllerSha,
      path: adoption.authority.intentPath,
    }),
    { kind: "recovery-adoption-intent", candidate: c },
  )
  same(
    intent.operations,
    ["adopt", "audit", "finalize", "publish", "verify"],
    "historical intent operations incomplete",
  )
  requireThat(
    hash(canonicalRecoveryBytes(intent)) === adoption.authority.intentSha256 &&
      intent.policySha256 === policySha256,
    "historical adoption intent differs",
  )
  same(adoption.baseAssets, base.baseAssets, "adopted original assets changed")
  same(adoption.npmEvidence, npmEvidence, "adopted npm bytes or source changed")
  same(byName.get(adoption.archive.assetName), adoption.archive, "legacy archive identity differs")
  const legacy = parseReleaseMarker(bytes.get(adoption.archive.assetName).toString("utf8"))
  requireThat(
    legacy.phase === "NPM_COMPLETE" &&
      legacy.version === c.version &&
      legacy.commitSha === c.candidateSha &&
      legacy.manifestSha256 === c.manifestSha256 &&
      legacy.releaseRecordSha256 === c.releaseRecordSha256 &&
      intent.legacyBodySha256 === adoption.archive.sha256,
    "adoption archived legacy identity differs",
  )
  same(
    legacy.attestationSet,
    base.anchor.attestationSet,
    "archived original attestation identity differs",
  )
  requireThat(
    legacy.baseAssetSetSha256 === base.anchor.baseAssetSetSha256,
    "archived original base digest differs",
  )
  const manifestPackages = npmEvidence.packages.map((p) => p.name)
  const facts = {
    candidate: c,
    policySha256,
    marker,
    manifestPackages,
    adoption: {
      receipt: adoption,
      ref: adoptionRef,
      admission: admitted.admission,
      archive: adoption.archive,
      baseAssets: base.baseAssets,
      npmEvidence,
      manifestPackages,
    },
  }
  const validateRetained = async (references) => {
    for (const ref of references) {
      const value = wire(ref)
      requireThat(
        !["recovery-marker", "recovery-finalization", "recovery-adoption-intent"].includes(
          value.kind,
        ),
        "unsupported retained receipt kind",
      )
      if (value.policySha256 !== undefined)
        requireThat(value.policySha256 === policySha256, "retained receipt policy differs")
      if (value.executor)
        await executorAdmission(
          context,
          c,
          value.executor,
          policySha256,
          cache,
          value.kind === "recovery-audit-result" ? "audit" : "owner",
        )
    }
  }
  await validateRetained(adoption.retainedAttempts)
  const verificationRef = finalization?.verificationSet ?? marker.verificationSet
  if (!verificationRef) return facts
  const set = wire(verificationRef, "recovery-verification-set")
  await executorAdmission(context, c, set.executor, policySha256, cache)
  const lanes = {}
  for (const selected of set.lanes) {
    const lane = wire(selected.receipt, "recovery-lane")
    const policy = admitted.policy
    const required = policy.lanes.find((item) => item.name === lane.lane).requiredChecks
    requireThat(
      required.every((name) =>
        lane.checks.some((check) => check.name === name && check.conclusion === "success"),
      ),
      "lane required policy checks missing",
    )
    requireThat(
      ["profile", "node", "packageManager", "platform", "architecture"].every(
        (key) => lane.environment[key] === policy.environment[key],
      ),
      "lane environment differs from reviewed policy",
    )
    if (lane.lane === "storage")
      same(
        lane.environment.dockerImages.map((image) => image.reference),
        policy.environment.dockerImages,
        "storage Docker image inventory differs",
      )
    else
      requireThat(
        lane.environment.dockerImages.every((image) =>
          policy.environment.dockerImages.includes(image.reference),
        ),
        "unapproved Docker image reference",
      )
    lanes[selected.lane] = lane
  }
  await validateRetained(set.retainedReceipts)
  facts.verification = { set, ref: verificationRef, lanes, provenance: set.provenance }
  const auditRef = finalization?.audit ?? marker.audit
  if (!auditRef) return facts
  const pending = marker?.phase === "AUDIT_PENDING" && !finalization
  const selectedAudit = wire(
    auditRef,
    pending ? "recovery-audit-dispatch" : "recovery-audit-result",
  )
  const audit = pending ? null : selectedAudit
  const intents = refs
    .filter((ref) => ref.assetName.startsWith("recovery-v2-audit-intent-"))
    .map((ref) => ({ ref, value: wire(ref, "recovery-audit-intent") }))
    .filter((x) => x.value.requestId === selectedAudit.requestId)
  requireThat(intents.length === 1, "exact selected audit intent required")
  const dispatches = refs
    .filter((ref) => ref.assetName.startsWith("recovery-v2-audit-dispatch-"))
    .map((ref) => ({ ref, value: wire(ref, "recovery-audit-dispatch") }))
    .filter((x) => x.value.intentSha256 === intents[0].ref.sha256)
  requireThat(dispatches.length === 1, "exact correlated audit dispatch required")
  await executorAdmission(context, c, intents[0].value.executor, policySha256, cache)
  if (pending) {
    same(dispatches[0].ref, auditRef, "marker selected dispatch differs")
    facts.audit = {
      intent: intents[0].value,
      intentRef: intents[0].ref,
      dispatch: dispatches[0].value,
      dispatchRef: dispatches[0].ref,
      result: null,
      resultRef: null,
    }
    return facts
  }
  const auditAdmission = await executorAdmission(
    context,
    c,
    audit.executor,
    policySha256,
    cache,
    "audit",
  )
  const run = await context.read("getActionsRunAttempt", {
    runId: audit.executor.runId,
    attempt: audit.executor.runAttempt,
  })
  const jobs = await context.read("listActionsRunJobs", { runId: audit.executor.runId })
  requireThat(
    String(run.id) === audit.executor.runId &&
      String(run.run_attempt) === audit.executor.runAttempt &&
      run.head_sha === audit.executor.controllerSha &&
      run.head_branch === "main" &&
      run.path === audit.executor.workflow &&
      run.event === "workflow_dispatch" &&
      run.status === "completed" &&
      run.conclusion === "success" &&
      String(run.repository?.id) === c.repositoryId &&
      run.repository?.full_name === c.repository,
    "independent audit run identity differs",
  )
  requireThat(
    Array.isArray(jobs) &&
      jobs.filter(
        (job) =>
          String(job.id) === audit.executor.jobId &&
          String(job.runAttempt) === audit.executor.runAttempt &&
          job.status === "completed" &&
          job.conclusion === "success",
      ).length === 1,
    "independent audit job identity differs",
  )
  facts.audit = {
    intent: intents[0].value,
    intentRef: intents[0].ref,
    dispatch: dispatches[0].value,
    dispatchRef: dispatches[0].ref,
    result: audit,
    resultRef: auditRef,
    observedExecutor: audit.executor,
    admission: auditAdmission.admission,
  }
  return facts
}

export async function observeRecoveryCandidate(input) {
  const { candidate, github, git, npm, npmAuditFactory, attestations, controllerRef, intentPath } =
    safeInput(input, [
      "candidate",
      "github",
      "git",
      "npm",
      "npmAuditFactory",
      "attestations",
      "controllerRef",
      "intentPath",
    ])
  let phase = "UNKNOWN"
  try {
    const c = snapshotRecoveryData(candidate, 16384)
    validateIdentity(c)
    const context = readerContext({ github, git })
    const release = await context.read("getRelease", { releaseId: c.releaseId })
    exactRelease(release, c)
    const tag = await tagProof(context, c)
    const refs = normalizeRecoveryAssetInventory(
      await context.read("listReleaseAssets", { releaseId: c.releaseId }),
    )
    const bytes = new Map()
    for (const ref of refs) bytes.set(ref.assetName, await loadAsset(context, ref))
    const base = await baseProof(context, c, refs, bytes, attestations)
    const npmEvidence = await npmProof(context, c, base.manifest, npm, npmAuditFactory)
    const finalRef = refs.find((ref) => ref.assetName === RECOVERY_FINALIZATION_ASSET)
    const finalization = finalRef
      ? parseRecovery(bytes.get(finalRef.assetName), {
          kind: "recovery-finalization",
          candidate: c,
        })
      : null
    let marker = null
    if (release.draft || !finalization) {
      try {
        marker = parseRecoveryReleaseMarker(release.body)
      } catch {
        const legacy = parseReleaseMarker(release.body)
        requireThat(
          legacy.schemaVersion === 1 && legacy.phase === "NPM_COMPLETE",
          "unsupported recovery starting marker",
        )
        requireThat(
          legacy.version === c.version &&
            legacy.commitSha === c.candidateSha &&
            legacy.manifestSha256 === c.manifestSha256 &&
            legacy.releaseRecordSha256 === c.releaseRecordSha256,
          "reserved legacy marker identity differs",
        )
        phase = "NPM_COMPLETE"
        requireThat(
          finalization === null,
          "legacy NPM_COMPLETE cannot contain recovery finalization",
        )
        const path = intentPath ?? `scripts/release/recovery-adoptions/${c.version}.json`
        requireThat(
          /^scripts\/release\/recovery-adoptions\/[a-zA-Z0-9][a-zA-Z0-9._-]*\.json$/u.test(path),
          "safe immutable intent path required",
        )
        const intent = parseRecovery(await context.git("showFile", { ref: controllerRef, path }), {
          kind: "recovery-adoption-intent",
          candidate: c,
        })
        requireThat(
          intent.legacyBodySha256 === hash(Buffer.from(release.body)),
          "reserved legacy body differs",
        )
      }
    }
    if (marker) {
      same(marker.candidate, c, "recovery marker candidate differs")
      phase = marker.phase
    }
    let facts = {
      candidate: c,
      manifestPackages: npmEvidence.packages.map((p) => p.name),
      npmEvidence,
      baseAssets: base.baseAssets,
      release,
      assets: refs,
      tag,
    }
    if (!marker && !finalization) {
      const archiveName = `recovery-v2-legacy-${c.version}-${hash(Buffer.from(release.body))}.txt`
      const recovery = refs.filter((ref) => ref.assetName.startsWith("recovery-v2-"))
      const archive = recovery.find((ref) => ref.assetName === archiveName) ?? null
      if (archive)
        requireThat(
          bytes.get(archiveName).equals(Buffer.from(release.body)),
          "partial archive differs",
        )
      const attempts = []
      for (const ref of recovery) {
        if (ref === archive) continue
        const receipt = parseRecovery(bytes.get(ref.assetName), {
          kind: "recovery-adoption",
          candidate: c,
        })
        requireThat(
          ref.assetName ===
            `recovery-v2-adoption-${receipt.executor.controllerSha}-${receipt.executor.runId}-${receipt.executor.runAttempt}-${receipt.executor.jobId}.json`,
          "partial adoption attempt name differs",
        )
        requireThat(archive !== null, "partial adoption archive missing")
        same(receipt.archive, archive, "partial adoption archive differs")
        const proof = await recoveryChain(
          context,
          c,
          refs,
          bytes,
          base,
          npmEvidence,
          {
            schemaVersion: 2,
            kind: "recovery-marker",
            candidate: c,
            policySha256: receipt.policySha256,
            revision: 1,
            phase: "RECOVERY_ADOPTED",
            adoption: ref,
            verificationSet: null,
            audit: null,
            finalization: null,
          },
          null,
          controllerRef,
        )
        verifyRecoveryObservedPhase(proof)
        for (const retained of receipt.retainedAttempts)
          requireThat(
            retained.assetName !== ref.assetName &&
              recovery.some(
                (r) => r.assetName === retained.assetName && r.assetName !== archiveName,
              ),
            "partial retained attempt differs",
          )
        attempts.push({ ref, receipt })
      }
      facts.legacy = {
        phase: "NPM_COMPLETE",
        candidate: c,
        bodySha256: hash(Buffer.from(release.body)),
      }
      facts.partialAdoption = { archive, attempts }
    }
    if (marker || finalization)
      facts = {
        ...facts,
        ...(await recoveryChain(
          context,
          c,
          refs,
          bytes,
          base,
          npmEvidence,
          marker,
          finalization,
          controllerRef,
        )),
      }
    if (!release.draft) {
      requireThat(finalization !== null, "published recovery finalization is missing")
      const rendered = renderRecoveryFinalMetadata(finalization, finalRef)
      // The immutable chain is already collected. A published marker is retained
      // only for the model's display comparison, never as receipt selection authority.
      try {
        facts.marker = parseRecoveryReleaseMarker(release.body)
      } catch {
        facts.marker = null
      }
      facts.finalization = { receipt: finalization, ref: finalRef, inventory: finalization.assets }
      facts.publication = {
        state: "published",
        immutable: true,
        candidate: c,
        tag,
        assets: refs,
        finalizationSha256: finalRef.sha256,
        metadata:
          release.name === rendered.title && release.body === rendered.body ? "matching" : "drift",
      }
      const result = planRecovery(facts)
      requireThat(result.outcome === "complete", result.errors.join("; "))
      return snapshotRecoveryData(
        {
          candidate: c,
          phase: "COMPLETE",
          outcome: "complete",
          terminal: true,
          displayDrift: result.displayDrift,
          errors: [],
          facts,
        },
        16 * 1024 * 1024,
      )
    }
    if (marker) {
      if (finalization)
        facts.finalization = {
          receipt: finalization,
          ref: finalRef,
          inventory: finalization.assets,
        }
      verifyRecoveryObservedPhase(facts)
    }
    return snapshotRecoveryData(
      {
        candidate: c,
        phase,
        outcome: "recovery-required",
        terminal: false,
        displayDrift: false,
        errors: [],
        facts,
      },
      16 * 1024 * 1024,
    )
  } catch (error) {
    return snapshotRecoveryData({
      candidate,
      phase,
      outcome: "blocked",
      terminal: false,
      displayDrift: false,
      errors: [error instanceof Error ? error.message : "recovery observation failed"],
      facts: null,
    })
  }
}

async function readFixedFinalization(context, assets) {
  const finals = assets.filter((asset) => asset.name === RECOVERY_FINALIZATION_ASSET)
  requireThat(finals.length <= 1, "duplicate finalization assets")
  if (finals.length === 0) return null
  const ref = normalizeRecoveryAssetInventory(finals)[0]
  return parseRecovery(await loadAsset(context, ref), { kind: "recovery-finalization" })
}

// Discover ownership independently of current tags, intents, and display labels.
// This only supplies routing subjects; observation must still prove each identity.
export async function discoverRecoveryReleaseCandidates(input) {
  const { github, releaseRecords } = safeInput(input, ["github", "releaseRecords"])
  const releases = snapshotRecoveryData(releaseRecords, 16 * 1024 * 1024)
  requireThat(Array.isArray(releases), "release discovery unavailable")
  const context = readerContext({ github })
  const ownership = new Map()
  for (const release of releases) {
    let assets
    if (release.draft === false) {
      assets = await context.read("listReleaseAssets", { releaseId: release.id })
      requireThat(Array.isArray(assets), "published recovery inventory unavailable")
      const final = await readFixedFinalization(context, assets)
      if (final) {
        requireThat(
          final.candidate.releaseId === String(release.id),
          "finalization Release ID differs",
        )
        ownership.set(String(release.id), final.candidate)
        continue
      }
    }
    let bodyIdentity = null
    try {
      bodyIdentity = parseRecoveryReleaseMarker(release.body).candidate
    } catch {
      /* Durable assets must also survive display loss. */
    }
    if (bodyIdentity) {
      requireThat(
        bodyIdentity.releaseId === String(release.id),
        "recovery marker Release ID differs",
      )
      ownership.set(String(release.id), bodyIdentity)
      continue
    }
    assets ??= await context.read("listReleaseAssets", { releaseId: release.id })
    requireThat(Array.isArray(assets), "opaque release ownership inventory unavailable")
    const recoveryAssets = assets.filter(
      (asset) => typeof asset.name === "string" && asset.name.startsWith("recovery-v2-"),
    )
    if (recoveryAssets.length === 0) {
      if (
        typeof release.body === "string" &&
        release.body.includes("DAWN_RELEASE_CONTROLLER_MARKER")
      ) {
        try {
          parseReleaseMarker(release.body)
        } catch {
          throw new TypeError("Unsupported recovery/legacy marker blocks routing")
        }
      }
      continue
    }
    const identities = []
    for (const ref of normalizeRecoveryAssetInventory(
      recoveryAssets.filter((asset) => asset.name.endsWith(".json")),
    )) {
      const receipt = parseRecovery(await loadAsset(context, ref))
      requireThat(
        receipt.candidate.releaseId === String(release.id),
        "opaque recovery Release ID differs",
      )
      identities.push(receipt.candidate)
    }
    requireThat(
      identities.length > 0,
      "unclassifiable durable recovery assets block legacy ownership",
    )
    for (const identity of identities)
      same(identity, identities[0], "mixed opaque recovery identities")
    ownership.set(String(release.id), identities[0])
  }
  return ownership
}

// Reservation and durable ownership are read before any legacy phase parser.
// Null means positively observed legacy ownership; errors never mean null.
export async function routeRecoveryCandidate(input) {
  let {
    candidate,
    git,
    github,
    terminalRecordRef,
    npm,
    npmAuditFactory,
    attestations,
    releaseRecords,
  } = safeInput(input, [
    "candidate",
    "git",
    "github",
    "terminalRecordRef",
    "npm",
    "npmAuditFactory",
    "attestations",
    "releaseRecords",
  ])
  candidate = snapshotRecoveryData(candidate, 16384)
  const context = readerContext({ git, github })
  let reservation = null
  let reservationPath = null
  const reservations = await readRecoveryReservations({ git, terminalRecordRef })
  for (const { intent, path } of reservations) {
    if (intent.candidate.version !== candidate.version) continue
    requireThat(
      intent.candidate.candidateSha === candidate.commitSha && !reservation,
      "adoption intent candidate conflict",
    )
    reservation = intent.candidate
    reservationPath = path
  }
  const releases = releaseRecords ?? (await context.read("listReleases"))
  requireThat(Array.isArray(releases), "release discovery unavailable")
  const tag = `v${candidate.version}`
  const opaqueOwnership = await discoverRecoveryReleaseCandidates({
    github,
    releaseRecords: releases.filter(
      (release) =>
        release.draft === false ||
        (release.draft === true &&
          release.tag_name !== tag &&
          release.name !== `Dawn ${tag}` &&
          !(reservation && String(release.id) === reservation.releaseId)),
    ),
  })
  const matches = releases.filter((release) => {
    let durable = null
    try {
      durable = parseRecoveryReleaseMarker(release.body)
    } catch {
      /* Exact candidate guards below reject unsupported bodies. */
    }
    return (
      opaqueOwnership.get(String(release.id))?.tag === tag ||
      (!opaqueOwnership.has(String(release.id)) && durable?.candidate.tag === tag) ||
      release.tag_name === tag ||
      (!opaqueOwnership.has(String(release.id)) && release.name === `Dawn ${tag}`) ||
      (reservation && String(release.id) === reservation.releaseId)
    )
  })
  requireThat(matches.length <= 1, "duplicate candidate releases block recovery routing")
  let identity =
    reservation ??
    (matches.length === 1 ? (opaqueOwnership.get(String(matches[0].id)) ?? null) : null)
  let owned = identity !== null
  if (matches.length === 1) {
    const release = matches[0]
    let marker = null
    let legacyMarkerValid = false
    try {
      marker = parseRecoveryReleaseMarker(release.body)
    } catch {
      // Only an independently valid v1 marker may enter the old interpretation.
      if (
        typeof release.body === "string" &&
        release.body.includes("DAWN_RELEASE_CONTROLLER_MARKER")
      ) {
        try {
          parseReleaseMarker(release.body)
          legacyMarkerValid = true
        } catch {
          // Published finalization may still prove completion after display corruption.
          if (release.draft !== false)
            throw new TypeError("Unsupported recovery/legacy marker blocks routing")
        }
      }
    }
    // Published display metadata cannot override fixed immutable ownership.
    const assets = await context.read("listReleaseAssets", { releaseId: release.id })
    requireThat(Array.isArray(assets), "ownership asset discovery unavailable")
    const final = await readFixedFinalization(context, assets)
    if (marker && (release.draft !== false || !final)) {
      if (identity)
        same(identity, marker.candidate, "reservation and durable marker candidate differ")
      identity = marker.candidate
      owned = true
    }
    if (final) {
      if (identity) same(identity, final.candidate, "reservation and finalization candidate differ")
      identity = final.candidate
      owned = true
    }
    if (
      assets.some(
        (asset) => typeof asset.name === "string" && asset.name.startsWith("recovery-v2-"),
      )
    ) {
      requireThat(identity !== null, "recovery assets without a supported ownership identity")
      owned = true
    }
    if (owned)
      requireThat(
        String(release.id) === identity.releaseId,
        "canonical recovery Release ID differs",
      )
    else if (
      typeof release.body === "string" &&
      release.body.includes("DAWN_RELEASE_CONTROLLER_MARKER")
    )
      requireThat(
        legacyMarkerValid,
        "unsupported published Release marker has no valid immutable recovery or legacy proof",
      )
  }
  if (!owned) return null
  requireThat(
    identity.version === candidate.version &&
      identity.candidateSha === candidate.commitSha &&
      identity.tag === tag,
    "recovery routed to a different candidate",
  )
  const selection = {
    candidate,
    state: "RECOVERY_REQUIRED",
    disposition: "recovery-owned",
    tag,
    conflicts: [],
  }
  // A reservation with a hidden/missing release remains a required handoff.
  if (matches.length === 0) return snapshotRecoveryData(selection)
  const observed = await observeRecoveryCandidate({
    candidate: identity,
    github,
    git,
    npm,
    npmAuditFactory,
    attestations,
    controllerRef: terminalRecordRef,
    ...(reservationPath === null ? {} : { intentPath: reservationPath }),
  })
  if (observed.terminal)
    return snapshotRecoveryData({
      ...selection,
      state: "RECOVERY_COMPLETE",
      disposition: "recovery-terminal",
    })
  if (observed.outcome === "blocked")
    return snapshotRecoveryData({
      ...selection,
      disposition: "blocked",
      conflicts: ["recovery-integrity-failure"],
    })
  return snapshotRecoveryData(selection)
}

// Legacy audit entrypoints explicitly refuse v2; only the independent recovery
// audit contract may audit or dispatch work for these releases.
export async function assertLegacyAuditCompatibleRelease(input) {
  const { release, github } = safeInput(input, ["release", "github"])
  const context = readerContext({ github })
  const assets = await context.read("listReleaseAssets", { releaseId: release.id })
  requireThat(Array.isArray(assets), "audit ownership asset inventory unavailable")
  let recoveryMarker = false
  try {
    parseRecoveryReleaseMarker(release.body)
    recoveryMarker = true
  } catch {
    /* Legacy parser validates every other body. */
  }
  if (
    recoveryMarker ||
    assets.some((asset) => typeof asset.name === "string" && asset.name.startsWith("recovery-v2-"))
  ) {
    const error = new Error(
      "RECOVERY_UNSUPPORTED_MODE: use the independent post-publication recovery observer",
    )
    error.code = "RECOVERY_UNSUPPORTED_MODE"
    throw error
  }
  return release
}

export async function readRecoveryReservations(input) {
  const { git, terminalRecordRef } = safeInput(input, ["git", "terminalRecordRef"])
  const context = readerContext({ git })
  const tree = await context.git("listTree", { ref: terminalRecordRef })
  requireThat(typeof tree === "string", "immutable git intent inventory unavailable")
  const paths = tree
    .split("\n")
    .filter((path) =>
      /^scripts\/release\/recovery-adoptions\/[a-zA-Z0-9][a-zA-Z0-9._-]*\.json$/u.test(path),
    )
  requireThat(paths.length <= 256, "adoption intent inventory exceeded")
  const reservations = []
  for (const path of paths)
    reservations.push({
      path,
      intent: parseRecovery(await context.git("showFile", { ref: terminalRecordRef, path }), {
        kind: "recovery-adoption-intent",
      }),
    })
  return reservations
}
