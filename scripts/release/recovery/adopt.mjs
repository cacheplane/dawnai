import { createHash } from "node:crypto"
import { types } from "node:util"
import { captureRecoveryAuthority, captureRecoveryEligibility } from "./authority.mjs"
import { renderRecoveryReleaseBody } from "./metadata.mjs"
import { createRecoveryWorkBudget, observeRecoveryCandidate } from "./observe.mjs"
import { RECOVERY_RETRY, recoveryMethods } from "./policy.mjs"
import { canonicalRecoveryBytes, parseRecovery, snapshotRecoveryData } from "./schema.mjs"
import { createRecoveryWriter, recoveryAdoptionAssetName } from "./writer.mjs"

export async function adoptRecoveryCandidate(request, config, dependencies) {
  request = snapshotRecoveryData(request, 16384)
  if (Object.keys(request).sort().join(" ") !== "candidate expectedControllerSha intentPath")
    throw new TypeError("Exact adoption request required")
  const writer = createRecoveryWriter(config, dependencies)
  const observation = safeObservation(dependencies)
  const authorityDependencies = data(dependencies, "authority")
  const { now } = recoveryMethods(authorityDependencies, ["now"])
  const budget = createRecoveryWorkBudget(
    { phaseDeadline: now() + RECOVERY_RETRY.phaseDeadlineMs },
    {
      now,
      setTimer: (callback, delay) => setTimeout(callback, delay),
      clearTimer: (timer) => clearTimeout(timer),
    },
  )
  const observed = await budget.work(() =>
    observeRecoveryCandidate({
      ...observation,
      candidate: request.candidate,
      controllerRef: request.expectedControllerSha,
      intentPath: request.intentPath,
    }),
  )
  if (observed.outcome === "blocked") throw new Error(observed.errors.join("; "))
  if (observed.phase !== "NPM_COMPLETE") {
    if (!observed.terminal)
      await budget.work(() =>
        captureRecoveryEligibility(
          { candidate: request.candidate, expectedControllerSha: request.expectedControllerSha },
          authorityDependencies,
        ),
      )
    return observed
  }
  const legacyBody = observed.facts.release.body
  const bodySha256 = createHash("sha256").update(legacyBody).digest("hex")
  const authority = await budget.work(() =>
    captureRecoveryAuthority(
      { ...request, legacyBodySha256: bodySha256, operation: "adopt" },
      authorityDependencies,
    ),
  )
  const common = { ...request, expectedBodySha256: bodySha256 }
  const archive = await writer.uploadRecoveryAsset({
    ...common,
    name: `recovery-v2-legacy-${request.candidate.version}-${bodySha256}.txt`,
    contentBase64: Buffer.from(legacyBody).toString("base64"),
  })
  const name = recoveryAdoptionAssetName(authority.executor)
  const existing = observed.facts.partialAdoption.attempts.find((a) => a.ref.assetName === name)
  const { intent: _intent, ...authorityRef } = authority.authority
  const receipt =
    existing?.receipt ??
    parseRecovery({
      schemaVersion: 2,
      kind: "recovery-adoption",
      candidate: request.candidate,
      policySha256: authority.policySha256,
      executor: authority.executor,
      authority: authorityRef,
      archive,
      baseAssets: observed.facts.baseAssets,
      npmEvidence: observed.facts.npmEvidence,
      retainedAttempts: observed.facts.partialAdoption.attempts.map((a) => a.ref),
    })
  const adoption = await writer.uploadRecoveryAsset({
    ...common,
    name,
    contentBase64: canonicalRecoveryBytes(receipt).toString("base64"),
  })
  const marker = parseRecovery({
    schemaVersion: 2,
    kind: "recovery-marker",
    candidate: request.candidate,
    policySha256: authority.policySha256,
    revision: 1,
    phase: "RECOVERY_ADOPTED",
    adoption,
    verificationSet: null,
    audit: null,
    finalization: null,
  })
  const body = renderRecoveryReleaseBody({
    marker,
    body: `Post-publication recovery for ${request.candidate.tag}. Original release notes are preserved in ${archive.assetName}.`,
  })
  return writer.updateRecoveryDraft({ ...common, title: observed.facts.release.name, body })
}

function data(value, name) {
  if (
    value === null ||
    typeof value !== "object" ||
    types.isProxy(value) ||
    ![Object.prototype, null].includes(Object.getPrototypeOf(value))
  )
    throw new TypeError("Safe dependency container required")
  const descriptor = Object.getOwnPropertyDescriptor(value, name)
  if (!descriptor || !Object.hasOwn(descriptor, "value"))
    throw new TypeError("Safe dependency data required")
  return descriptor.value
}
function safeObservation(dependencies) {
  const value = data(dependencies, "observation")
  return Object.fromEntries(
    ["github", "git", "npm", "npmAuditFactory", "attestations"].map((name) => [
      name,
      data(value, name),
    ]),
  )
}
