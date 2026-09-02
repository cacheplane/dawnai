import { createHash } from "node:crypto"
import { lstat, mkdir, realpath } from "node:fs/promises"
import path from "node:path"
import { isDeepStrictEqual, types as utilTypes } from "node:util"

import {
  captureConsolidationAuthority,
  captureNpmInventory,
} from "./duplicate-draft-consolidation-authority.mjs"
import {
  assertEvidenceEqualsProposal,
  inspectEquivalentDrafts,
  inspectEquivalentRemainingDrafts,
  semanticAssetProjection,
  semanticReleaseProjection,
} from "./duplicate-draft-consolidation-evidence.mjs"
import {
  readPrivateEnvelope,
  readTrackedReceipt,
  writePrivateEnvelope,
  writeTrackedReceipt,
} from "./duplicate-draft-consolidation-files.mjs"
import {
  appendJournalEvent,
  createConsolidationJournal,
  createFinalConsolidationReceipt,
  deriveConsolidationState,
  nextResumeAction,
  parseConsolidationJournal,
} from "./duplicate-draft-consolidation-journal.mjs"
import { classifyConsolidationReleases } from "./duplicate-draft-consolidation-release-classifier.mjs"
import {
  canonicalConsolidationEnvelopeBytes,
  canonicalEventEnvelope,
  canonicalRecordSha256,
  createConsolidationEnvelope,
  DUPLICATE_DRAFT_CONSOLIDATION_LIMITS,
  parseConsolidationEnvelope,
} from "./duplicate-draft-consolidation-schema.mjs"
import { parseReleaseMarker } from "./metadata.mjs"

const REPOSITORY = Object.freeze({
  name: "cacheplane/dawnai",
  id: "1210070282",
  defaultBranch: "main",
  actor: Object.freeze({ login: "blove", id: "61436" }),
})
const CANDIDATE = Object.freeze({
  version: "0.8.22",
  commitSha: "2a80deece2ff958fe7fde8fddeb4f99bed70a1c8",
  tag: "v0.8.22",
})
const SURVIVOR = "379991871"
const DUPLICATES = Object.freeze(["379982100", "379986168"])
const OUTPUT = ".dawn/release/duplicate-draft-consolidation.proposed.json"
const JOURNAL_OUTPUT = ".dawn/release/duplicate-draft-consolidation.journal.json"
const RECEIPT_OUTPUT = "scripts/release/duplicate-draft-consolidation.json"
const OBSERVATION_GAP_MS = 60_000
const MAXIMUM_RETRY_NPM_AGE_MS = 120_000
const CONVERGENCE_CEILING_MS = 90_000
const CONVERGENCE_BACKOFF_MS = Object.freeze([1_000, 5_000, 15_000, 30_000, 30_000])
const MAXIMUM_CONVERGENCE_ATTEMPTS = 6
const NATIVE_DATE = Date
const NATIVE_PERFORMANCE_NOW = performance.now.bind(performance)
const FAULT_BOUNDARIES = new Set([
  "after-authority-journal",
  "after-authority-head",
  "after-npm-journal",
  "after-npm-head",
  "after-intent-journal",
  "after-intent-head",
  "before-delete",
  "after-delete",
  "after-outcome-journal",
  "after-outcome-head",
  "after-resume-journal",
  "after-resume-head",
  "after-convergence-journal",
  "after-convergence-head",
])
const ROOT_GUARDS = new WeakMap()
const WORKFLOW_QUERY = deepFreeze({
  statuses: ["in_progress", "pending", "queued", "requested", "waiting"],
  perPage: 100,
  maximumPages: 100,
})
const HISTORICAL_PARITY_REPORT =
  "Historical duplicate payload parity is supported by embedded pre-delete evidence plus the currently reverified survivor; deleted bytes were not independently re-downloaded."

export async function verifyDuplicateDraftConsolidation(input, dependencies) {
  try {
    const context = await normalizeVerifyInvocation(input, dependencies)
    assertCompleteVerificationReceipt(context.receipt)
    const sourceAdapters = await context.createAdapters()
    const adapters = bindAdapters(sourceAdapters)

    for (const releaseId of DUPLICATES) {
      const direct = exactPlain(
        await adapters.github.getRelease({ releaseId }),
        ["status", "operation", "httpStatus", "code"],
        "deleted Release direct read",
      )
      if (
        direct.status !== "AMBIGUOUS" ||
        direct.operation !== "release" ||
        direct.httpStatus !== 404 ||
        direct.code !== "NOT_FOUND"
      ) {
        throw new Error("Deleted Release direct absence is not proven")
      }
    }

    const enumerated = await readReleaseEnumeration({ adapters })
    classifyConsolidationReleases(
      enumerated,
      context.receipt.record.proposedEnvelope.record,
      "final",
    )
    const current = await captureConsolidationAuthority({
      stage: "final",
      proposal: context.receipt.record.proposedEnvelope.record,
      targetReleaseId: null,
      adapters: sourceAdapters,
    })
    assertFreshFinalAuthority(
      current.authority,
      context.receipt.record.finalAuthority,
      context.receipt.record.proposedEnvelope.record,
    )

    return deepFreeze({
      status: "verified",
      survivor: SURVIVOR,
      deleted: [...DUPLICATES],
      receipt: RECEIPT_OUTPUT,
      receiptSha256: context.receipt.recordSha256,
      historicalParity: HISTORICAL_PARITY_REPORT,
    })
  } catch {
    throw new Error("Duplicate-draft verify failed.")
  }
}

async function normalizeVerifyInvocation(input, dependencies) {
  const value = exactPlain(input, ["receipt"], "verify input")
  if (value.receipt !== RECEIPT_OUTPUT) {
    throw new TypeError("Verify input does not identify the approved receipt")
  }
  const runtime = exactOptionalFields(
    dependencies,
    ["repositoryRoot", "createAdapters"],
    [],
    "verify dependencies",
  )
  if (
    typeof runtime.repositoryRoot !== "string" ||
    !path.isAbsolute(runtime.repositoryRoot) ||
    path.normalize(runtime.repositoryRoot) !== runtime.repositoryRoot ||
    (await realpath(runtime.repositoryRoot)) !== runtime.repositoryRoot
  ) {
    throw new TypeError("Verify repository root is invalid")
  }
  const receiptPath = approvedPerformPath(runtime.repositoryRoot, value.receipt, RECEIPT_OUTPUT)
  const receipt = parseConsolidationEnvelope(
    "final",
    await readTrackedReceipt(receiptPath, DUPLICATE_DRAFT_CONSOLIDATION_LIMITS.finalReceiptBytes),
  )
  return Object.freeze({
    repositoryRoot: runtime.repositoryRoot,
    receiptPath,
    receipt,
    createAdapters: safeFunction(runtime.createAdapters, "verify adapter factory"),
  })
}

function assertCompleteVerificationReceipt(receipt) {
  const proposal = receipt.record.proposedEnvelope
  const journal = parseConsolidationJournal(receipt.record.journalEnvelope)
  const expectedConfirmation = exactConfirmation(proposal)
  const expectedConfirmationSha256 = createHash("sha256")
    .update(expectedConfirmation, "utf8")
    .digest("hex")
  if (
    !isDeepStrictEqual(proposal.record.repository, REPOSITORY) ||
    !isDeepStrictEqual(proposal.record.candidate, CANDIDATE) ||
    proposal.record.roles.survivor !== SURVIVOR ||
    !safeArrayEquals(proposal.record.roles.duplicates, DUPLICATES) ||
    !isDeepStrictEqual(proposal.record.confirmation, {
      version: CANDIDATE.version,
      commitSha: CANDIDATE.commitSha,
      survivor: SURVIVOR,
      duplicates: [...DUPLICATES],
      template: "<64-lowercase-hex-digest>",
    }) ||
    proposal.record.releases.length !== 3 ||
    !isDeepStrictEqual(
      proposal.record.releases.map(({ id }) => id),
      [SURVIVOR, ...DUPLICATES],
    ) ||
    !isDeepStrictEqual(journal.record.repository, REPOSITORY) ||
    !isDeepStrictEqual(journal.record.candidate, CANDIDATE) ||
    journal.record.proposedRecordSha256 !== proposal.recordSha256 ||
    journal.record.confirmationSha256 !== expectedConfirmationSha256 ||
    !safeArrayEquals(journal.record.deletionOrder, DUPLICATES)
  ) {
    throw new Error("Receipt does not bind the approved consolidation identity")
  }
  if (
    proposal.record.controller.headSha !== proposal.record.controller.originMainSha ||
    proposal.record.controller.headSha !== proposal.record.controller.githubMainSha ||
    proposal.record.controller.headSha === CANDIDATE.commitSha
  ) {
    throw new Error("Receipt controller identity is invalid")
  }
  assertHistoricalEvidenceBinding(journal, proposal)
  assertMandatoryPerformHistory(journal, proposal)
  const state = deriveConsolidationState(journal)
  if (
    state.phase !== "final-authority-observed" ||
    !safeArrayEquals(state.completedTargets, DUPLICATES) ||
    !isDeepStrictEqual(state.lastAuthority, receipt.record.finalAuthority)
  ) {
    throw new Error("Receipt journal is not a complete consolidation history")
  }
  const reconstructed = createFinalConsolidationReceipt({
    proposedEnvelope: proposal,
    journalEnvelope: journal,
    finalAuthority: receipt.record.finalAuthority,
    completedAt: receipt.record.completedAt,
  })
  if (
    !canonicalConsolidationEnvelopeBytes("final", reconstructed).equals(
      canonicalConsolidationEnvelopeBytes("final", receipt),
    )
  ) {
    throw new Error("Receipt is not the exact canonical terminal result")
  }
}

function assertHistoricalEvidenceBinding(journal, proposalEnvelope) {
  const proposal = proposalEnvelope.record
  assertProposalPayloadProof(proposal)
  const proposedById = new Map(proposal.releases.map((release) => [release.id, release]))
  const stablePackages = stableNpmObservation(proposal.npmInventories[0]).packages

  for (const { event } of journal.record.events) {
    if (event.type === "npm-observed") {
      if (
        event.payload.inventory.stage !== "perform-initial" ||
        !isDeepStrictEqual(stableNpmObservation(event.payload.inventory).packages, stablePackages)
      ) {
        throw new Error("Journal npm evidence differs from the reviewed proposal")
      }
      continue
    }
    if (event.type === "resume-reconciliation") {
      if (event.payload.classification === "present-unchanged-retryable") {
        assertHistoricalRelease(
          event.payload.releaseEvidence,
          proposedById.get(event.payload.targetReleaseId),
          "Retry reconciliation",
        )
      }
      continue
    }
    if (event.type === "delete-authority-observed") {
      const expectedStage =
        event.payload.targetReleaseId === DUPLICATES[0] ? "pre-delete-1" : "pre-delete-2"
      const expectedIds =
        expectedStage === "pre-delete-1" ? [SURVIVOR, ...DUPLICATES] : [SURVIVOR, DUPLICATES[1]]
      assertHistoricalAuthority(
        event.payload.authority,
        proposal,
        proposedById,
        expectedStage,
        expectedIds,
      )
      const targetRead = event.payload.authority.targetRead
      if (
        targetRead === null ||
        targetRead.evidence.id !== event.payload.targetReleaseId ||
        targetRead.evidenceSha256 !== canonicalRecordSha256(targetRead.evidence)
      ) {
        throw new Error("Delete authority target read is not the exact reviewed target")
      }
      assertHistoricalRelease(
        targetRead.evidence,
        proposedById.get(event.payload.targetReleaseId),
        "Delete authority target read",
      )
      continue
    }
    if (event.type === "final-authority-observed") {
      assertHistoricalAuthority(event.payload.authority, proposal, proposedById, "final", [
        SURVIVOR,
      ])
    }
  }
}

function assertProposalPayloadProof(proposal) {
  const releases = proposal.releases
  const releaseProjection = semanticReleaseProjection(releases[0])
  const assetProjection = releases[0].assets.map(semanticAssetProjection)
  for (const release of releases) {
    if (
      release.semantic.name !== `Dawn v${CANDIDATE.version}` ||
      !isDeepStrictEqual(semanticReleaseProjection(release), releaseProjection) ||
      !isDeepStrictEqual(release.assets.map(semanticAssetProjection), assetProjection)
    ) {
      throw new Error("Proposal does not prove exact three-way Release payload parity")
    }
  }

  const marker = parseReleaseMarker(releases[0].semantic.body)
  const markerSubjects = marker.attestationSet?.subjects.map(({ subjectName, subjectSha256 }) => ({
    name: subjectName,
    sha256: subjectSha256,
  }))
  const markerBaseAssetSet =
    marker.attestationSet === null
      ? null
      : [
          { name: "release-record.json", sha256: marker.releaseRecordSha256 },
          ...marker.attestationSet.subjects.map(({ subjectName, subjectSha256 }) => ({
            name: subjectName,
            sha256: subjectSha256,
          })),
          ...marker.attestationSet.subjects.map(({ bundleName, bundleSha256 }) => ({
            name: bundleName,
            sha256: bundleSha256,
          })),
        ]
  const proof = proposal.payloadProof
  const payloadProjection = releases.map((release) => ({
    release: semanticReleaseProjection(release),
    assets: release.assets.map(semanticAssetProjection),
  }))
  if (
    marker.phase !== "ESCROWED" ||
    marker.version !== CANDIDATE.version ||
    marker.commitSha !== CANDIDATE.commitSha ||
    marker.tag !== CANDIDATE.tag ||
    marker.attestationSet?.repository !== REPOSITORY.name ||
    marker.baseAssetSetSha256 !== proof.baseAssetSetSha256 ||
    !isDeepStrictEqual(markerBaseAssetSet, proof.baseAssetSet) ||
    !isDeepStrictEqual(markerSubjects, proof.attestationVerification.subjects) ||
    proof.baseAssetSetSha256 !== canonicalRecordSha256(proof.baseAssetSet) ||
    proof.consolidationPayloadSha256 !== canonicalRecordSha256(payloadProjection)
  ) {
    throw new Error("Proposal payload proof is not bound to its canonical Release evidence")
  }
}

function assertHistoricalAuthority(authority, proposal, proposedById, stage, expectedIds) {
  if (
    authority.stage !== stage ||
    !isDeepStrictEqual(
      authority.releases.map(({ id }) => id),
      expectedIds,
    ) ||
    !isDeepStrictEqual(authority.controller, proposal.controller) ||
    !isDeepStrictEqual(
      withoutObservationTime(authority.annotatedTag),
      withoutObservationTime(proposal.annotatedTag),
    ) ||
    !isDeepStrictEqual(
      withoutObservationTime(authority.workflowAuthority),
      withoutObservationTime(proposal.workflowAuthority),
    ) ||
    !isDeepStrictEqual(
      stableNpmObservation(authority.npmInventory).packages,
      stableNpmObservation(proposal.npmInventories[0]).packages,
    ) ||
    !isDeepStrictEqual(authority.payloadProof, proposal.payloadProof) ||
    (stage === "final") !== (authority.targetRead === null)
  ) {
    throw new Error("Historical authority differs from the reviewed stage evidence")
  }
  for (const release of authority.releases) {
    assertHistoricalRelease(release, proposedById.get(release.id), "Historical authority")
  }
}

function assertHistoricalRelease(actual, proposed, label) {
  if (proposed === undefined || actual.id !== proposed.id || actual.role !== proposed.role) {
    throw new Error(`${label} identifies an unreviewed Release`)
  }
  assertEvidenceEqualsProposal(actual, proposed)
}

export async function performDuplicateDraftConsolidation(input, dependencies) {
  try {
    const context = await normalizePerformInvocation(input, dependencies)
    let current = await loadOrCreatePerformJournal(context)
    assertPerformJournalBinding(context, current.journal)
    let state = deriveConsolidationState(current.journal)
    const resumedFromFinalAuthority = state.phase === "final-authority-observed"

    if (state.phase === "operation-started") {
      const inventory = await context.capturePerformInitial(context)
      current = await appendDurableEvent(
        context,
        current.journal,
        "npm-observed",
        {
          targetReleaseId: DUPLICATES[0],
          attemptNumber: 1,
          inventory,
        },
        inventory.completedAt,
        "npm",
      )
      state = deriveConsolidationState(current.journal)
    }
    assertMandatoryPerformHistory(current.journal, context.proposal)
    if (state.phase === "npm-observed") {
      if (state.lastRetryNpmInventory === null) {
        throw new Error("Perform initial npm evidence is unavailable")
      }
      await context.verifyPerformInitial(context, state.lastRetryNpmInventory)
    }

    for (const targetReleaseId of DUPLICATES) {
      state = deriveConsolidationState(current.journal)
      if (state.completedTargets.includes(targetReleaseId)) continue
      if (state.currentTargetReleaseId !== targetReleaseId) {
        throw new Error("Perform journal target order is invalid")
      }
      await context.performOneDeletion(
        {
          proposedEnvelope: context.proposal,
          confirmation: context.confirmation,
          targetReleaseId,
          journalPath: context.journalPath,
        },
        {
          createAdapters: context.createAdapters,
          wait: context.wait,
        },
      )
      current = await loadCurrentJournal(context.journalPath)
      state = deriveConsolidationState(current.journal)
      if (!state.completedTargets.includes(targetReleaseId)) {
        throw new Error("Perform target did not durably converge")
      }
    }

    state = deriveConsolidationState(current.journal)
    if (state.phase === "target-converged") {
      const finalAuthority = await context.captureFinalAuthority(context)
      current = await appendDurableEvent(
        context,
        current.journal,
        "final-authority-observed",
        { authority: finalAuthority },
        finalAuthority.observedAt,
        "final-authority",
      )
      state = deriveConsolidationState(current.journal)
    }
    if (state.phase !== "final-authority-observed" || state.lastAuthority === null) {
      throw new Error("Perform journal is not ready for its final receipt")
    }
    assertMandatoryPerformHistory(current.journal, context.proposal)
    const receipt = createFinalConsolidationReceipt({
      proposedEnvelope: context.proposal,
      journalEnvelope: current.journal,
      finalAuthority: state.lastAuthority,
      completedAt: state.lastAuthority.observedAt,
    })
    const receiptBytes = canonicalConsolidationEnvelopeBytes("final", receipt)
    const receiptAlreadyDurable = await exactExistingReceipt(context.receiptPath, receiptBytes)
    if (resumedFromFinalAuthority) {
      const freshFinalAuthority = await context.captureFinalAuthority(context)
      assertFreshFinalAuthority(freshFinalAuthority, state.lastAuthority, context.proposal.record)
    }
    if (receiptAlreadyDurable) return completedPerformResult(receipt)
    await context.publishReceipt(context.receiptPath, receiptBytes)
    return completedPerformResult(receipt)
  } catch {
    throw new Error("Duplicate-draft perform failed.")
  }
}

function completedPerformResult(receipt) {
  return deepFreeze({
    status: "complete",
    survivor: SURVIVOR,
    deleted: [...DUPLICATES],
    receipt: RECEIPT_OUTPUT,
    receiptSha256: receipt.recordSha256,
  })
}

async function exactExistingReceipt(receiptPath, expectedBytes) {
  let current
  try {
    current = await readTrackedReceipt(
      receiptPath,
      DUPLICATE_DRAFT_CONSOLIDATION_LIMITS.finalReceiptBytes,
    )
  } catch (error) {
    if (error?.code === "ENOENT") return false
    throw error
  }
  if (!current.equals(expectedBytes)) {
    throw new Error("Existing consolidation receipt differs from the canonical result")
  }
  parseConsolidationEnvelope("final", current)
  return true
}

function assertMandatoryPerformHistory(journal, proposal) {
  const parsed = parseConsolidationJournal(journal)
  if (
    proposal.record.npmInventories.length !== 2 ||
    proposal.record.npmInventories[0].stage !== "inspect-initial" ||
    proposal.record.npmInventories[1].stage !== "inspect-ready"
  ) {
    throw new Error("Proposal does not contain the mandatory inspection npm stages")
  }
  const events = parsed.record.events.map(({ event }) => event)
  const initial = events[1]
  if (
    initial?.type !== "npm-observed" ||
    initial.payload.targetReleaseId !== DUPLICATES[0] ||
    initial.payload.attemptNumber !== 1 ||
    initial.payload.inventory.stage !== "perform-initial"
  ) {
    throw new Error("Journal omitted the mandatory perform-initial proof")
  }
  const authorityStages = []
  for (let index = 2; index < events.length; index += 1) {
    const event = events[index]
    if (event.type === "npm-observed" && event.payload.inventory.stage !== "perform-initial") {
      throw new Error("Retry npm history contains an invalid stage")
    }
    if (event.type === "delete-authority-observed") {
      authorityStages.push(event.payload.authority.stage)
    }
    if (event.type === "final-authority-observed") authorityStages.push("final")
  }
  const state = deriveConsolidationState(parsed)
  if (
    state.phase === "final-authority-observed" &&
    !isDeepStrictEqual(
      authorityStages.filter((stage, index) => stage !== authorityStages[index - 1]),
      ["pre-delete-1", "pre-delete-2", "final"],
    )
  ) {
    throw new Error("Final history does not contain all mandatory npm authority stages")
  }
}

function assertFreshFinalAuthority(value, recorded, proposal) {
  const normalized = canonicalEventEnvelope(
    {
      schemaVersion: 1,
      sequence: 1,
      previousEventSha256: null,
      type: "final-authority-observed",
      recordedAt: value?.observedAt,
      payload: { authority: value },
    },
    null,
  ).event.payload.authority
  if (
    normalized.stage !== "final" ||
    normalized.targetRead !== null ||
    !isDeepStrictEqual(normalized.controller, proposal.controller) ||
    !isDeepStrictEqual(
      withoutObservationTime(normalized.annotatedTag),
      withoutObservationTime(proposal.annotatedTag),
    ) ||
    !isDeepStrictEqual(
      withoutObservationTime(normalized.workflowAuthority),
      withoutObservationTime(proposal.workflowAuthority),
    ) ||
    !isDeepStrictEqual(
      stableNpmObservation(normalized.npmInventory),
      stableNpmObservation(recorded.npmInventory),
    ) ||
    normalized.releases.length !== 1 ||
    normalized.releases[0].id !== SURVIVOR ||
    !isDeepStrictEqual(normalized.payloadProof, proposal.payloadProof) ||
    Date.parse(normalized.observedAt) < Date.parse(recorded.observedAt)
  ) {
    throw new Error("Fresh final authority drifted from the completed operation")
  }
  assertEvidenceEqualsProposal(normalized.releases[0], proposal.releases[0])
}

function withoutObservationTime({ observedAt: _observedAt, ...value }) {
  return value
}

function stableNpmObservation({ startedAt: _startedAt, completedAt: _completedAt, ...inventory }) {
  return {
    ...inventory,
    packages: inventory.packages.map(({ observedAt: _observedAt, ...entry }) => entry),
  }
}

async function normalizePerformInvocation(input, dependencies) {
  const value = exactPlain(
    input,
    ["proposal", "proposalSha256", "journal", "receipt", "confirmation"],
    "perform input",
  )
  if (
    value.proposal !== OUTPUT ||
    value.journal !== JOURNAL_OUTPUT ||
    value.receipt !== RECEIPT_OUTPUT ||
    !/^[0-9a-f]{64}$/u.test(value.proposalSha256) ||
    typeof value.confirmation !== "string"
  ) {
    throw new TypeError("Perform input does not identify the approved operation")
  }
  const runtime = exactOptionalFields(
    dependencies,
    ["repositoryRoot", "createAdapters", "now", "wait"],
    [
      "capturePerformInitial",
      "verifyPerformInitial",
      "performOneDeletion",
      "captureFinalAuthority",
      "publishReceipt",
    ],
    "perform dependencies",
  )
  if (
    typeof runtime.repositoryRoot !== "string" ||
    !path.isAbsolute(runtime.repositoryRoot) ||
    path.normalize(runtime.repositoryRoot) !== runtime.repositoryRoot ||
    (await realpath(runtime.repositoryRoot)) !== runtime.repositoryRoot
  ) {
    throw new TypeError("Perform repository root is invalid")
  }
  const proposalPath = approvedPerformPath(runtime.repositoryRoot, value.proposal, OUTPUT)
  const journalPath = approvedPerformPath(runtime.repositoryRoot, value.journal, JOURNAL_OUTPUT)
  const receiptPath = approvedPerformPath(runtime.repositoryRoot, value.receipt, RECEIPT_OUTPUT)
  const proposal = parseConsolidationEnvelope(
    "proposed",
    await readPrivateEnvelope(proposalPath, DUPLICATE_DRAFT_CONSOLIDATION_LIMITS.proposedBytes),
  )
  const confirmation = exactConfirmation(proposal)
  if (proposal.recordSha256 !== value.proposalSha256 || value.confirmation !== confirmation) {
    throw new Error("Perform confirmation does not bind the reviewed proposal")
  }
  const createAdapters = safeFunction(runtime.createAdapters, "perform adapter factory")
  const now = trustedClock(safeFunction(runtime.now, "perform clock"))
  const wait = safeFunction(runtime.wait, "perform waiter")
  const context = {
    repositoryRoot: runtime.repositoryRoot,
    proposal,
    confirmation,
    proposalPath,
    journalPath,
    receiptPath,
    createAdapters,
    now,
    wait,
    faultAt: null,
  }
  context.capturePerformInitial =
    runtime.capturePerformInitial === undefined
      ? defaultCapturePerformInitial
      : safeFunction(runtime.capturePerformInitial, "perform initial capture")
  context.verifyPerformInitial =
    runtime.verifyPerformInitial === undefined
      ? defaultVerifyPerformInitial
      : safeFunction(runtime.verifyPerformInitial, "perform initial verifier")
  context.performOneDeletion =
    runtime.performOneDeletion === undefined
      ? performOneDuplicateDeletion
      : safeFunction(runtime.performOneDeletion, "perform target deletion")
  context.captureFinalAuthority =
    runtime.captureFinalAuthority === undefined
      ? defaultCaptureFinalAuthority
      : safeFunction(runtime.captureFinalAuthority, "perform final authority")
  context.publishReceipt =
    runtime.publishReceipt === undefined
      ? writeTrackedReceipt
      : safeFunction(runtime.publishReceipt, "perform receipt publisher")
  return Object.freeze(context)
}

function approvedPerformPath(repositoryRoot, relativePath, expected) {
  if (relativePath !== expected) throw new TypeError("Perform path is not approved")
  const absolute = path.join(repositoryRoot, ...relativePath.split("/"))
  if (path.relative(repositoryRoot, absolute) !== relativePath.split("/").join(path.sep)) {
    throw new TypeError("Perform path escapes the repository")
  }
  return absolute
}

function exactConfirmation(proposal) {
  return `CONSOLIDATE v${proposal.record.candidate.version} ${proposal.record.candidate.commitSha} SURVIVOR ${proposal.record.roles.survivor} DELETE ${proposal.record.roles.duplicates.join(",")} PROPOSAL ${proposal.recordSha256}`
}

async function loadOrCreatePerformJournal(context) {
  try {
    return await loadCurrentJournal(context.journalPath)
  } catch (error) {
    if (error?.code !== "ENOENT") throw error
  }
  const headPath = context.journalPath.replace(/journal\.json$/u, "journal.head.json")
  try {
    await readPrivateEnvelope(headPath, 16 * 1024)
    throw new Error("An orphan consolidation journal head blocks genesis")
  } catch (error) {
    if (error?.code !== "ENOENT") throw error
  }
  const recordedAt = timestamp(context.now, "operation start clock")
  const journal = createConsolidationJournal({
    proposedEnvelope: context.proposal,
    confirmationSha256: createHash("sha256").update(context.confirmation, "utf8").digest("hex"),
    recordedAt,
  })
  await writePrivateEnvelope(
    context.journalPath,
    canonicalConsolidationEnvelopeBytes("journal", journal),
  )
  await writePrivateEnvelope(headPath, canonicalJournalHeadBytes(context.journalPath, journal))
  return loadCurrentJournal(context.journalPath)
}

function assertPerformJournalBinding(context, journal) {
  const state = deriveConsolidationState(journal)
  const confirmationSha256 = createHash("sha256").update(context.confirmation, "utf8").digest("hex")
  if (
    journal.record.proposedRecordSha256 !== context.proposal.recordSha256 ||
    journal.record.confirmationSha256 !== confirmationSha256 ||
    state.controllerSha !== context.proposal.record.controller.headSha ||
    !safeArrayEquals(journal.record.deletionOrder, DUPLICATES)
  ) {
    throw new Error("Journal does not bind the exact approved perform operation")
  }
}

async function defaultCapturePerformInitial(context) {
  const adapters = bindAdapters(await context.createAdapters())
  return captureNpmInventory({
    stage: "perform-initial",
    candidate: CANDIDATE,
    npm: adapters.npm,
    now: context.now,
  })
}

async function defaultVerifyPerformInitial(context, inventory) {
  const adapters = bindAdapters(await context.createAdapters())
  const releases = await readReleaseEnumeration({ adapters })
  const inspected = await inspectEquivalentDrafts({
    candidate: CANDIDATE,
    survivorId: SURVIVOR,
    duplicateIds: DUPLICATES,
    releases,
    github: adapters.github,
    attestations: adapters.attestations,
  })
  for (let index = 0; index < inspected.releases.length; index += 1) {
    assertEvidenceEqualsProposal(inspected.releases[index], context.proposal.record.releases[index])
  }
  if (!isDeepStrictEqual(inspected.payloadProof, context.proposal.record.payloadProof)) {
    throw new Error("Perform payload proof differs from the proposal")
  }
  const elapsed =
    Date.parse(timestamp(context.now, "perform payload clock")) - Date.parse(inventory.completedAt)
  if (elapsed < 0) throw new Error("Perform observation clock reversed")
  const remaining = Math.max(0, OBSERVATION_GAP_MS - elapsed)
  if (remaining > 0) {
    const signal = AbortSignal.timeout(remaining + 5_000)
    await context.wait(remaining, { signal })
  }
  if (
    Date.parse(timestamp(context.now, "perform ready clock")) - Date.parse(inventory.completedAt) <
    OBSERVATION_GAP_MS
  ) {
    throw new Error("Perform observation gap did not reach sixty seconds")
  }
}

async function defaultCaptureFinalAuthority(context) {
  const sourceAdapters = await context.createAdapters()
  const captured = await captureConsolidationAuthority({
    stage: "final",
    proposal: context.proposal.record,
    targetReleaseId: null,
    adapters: sourceAdapters,
  })
  return captured.authority
}

export async function performOneDuplicateDeletion(input, dependencies) {
  try {
    const context = normalizeDeletionInvocation(input, dependencies)
    let current = await loadCurrentJournal(context.journalPath)
    assertDeletionBinding(context, current.journal)
    const completed = completedDeletionResult(context, current.journal)
    if (completed !== null) return completed
    let preparedAttempt = null

    for (;;) {
      const state = deriveConsolidationState(current.journal)
      if (state.currentTargetReleaseId !== context.targetReleaseId) {
        throw new Error("Journal current target differs from the requested target")
      }

      if (
        state.phase === "delete-outcome" &&
        state.lastOutcomeClassification === "response-hard-failure"
      ) {
        throw new Error("A hard GitHub DELETE response is terminal and cannot be retried")
      }

      if (["delete-intent", "delete-outcome", "resume-absent"].includes(state.phase)) {
        const observation = await observeConvergence(context, state)
        const resolved = await resolveConvergence(context, current.journal, state, observation)
        if (resolved.result !== null) return resolved.result
        current = { journal: resolved.journal }
        preparedAttempt = resolved.preparedAttempt
        continue
      }

      if (state.phase === "npm-observed" && state.pendingRetryFromAttempt !== null) {
        const resolved = await completeStaleRetryPreparation(context, current.journal, state)
        current = { journal: resolved.journal }
        preparedAttempt = resolved.preparedAttempt
        continue
      }

      if (
        ![
          "operation-started",
          "npm-observed",
          "target-converged",
          "resume-present",
          "delete-authority-observed",
        ].includes(state.phase)
      ) {
        throw new Error("Journal is not at a legal one-target mutation state")
      }

      const prepared = preparedAttempt ?? (await captureFreshDeleteAuthority(context, state))
      preparedAttempt = null
      const { adapters, captured } = prepared
      const attemptNumber =
        state.phase === "resume-present" ? state.attemptNumber + 1 : state.attemptNumber
      current = await appendDurableEvent(
        context,
        current.journal,
        "delete-authority-observed",
        {
          targetReleaseId: context.targetReleaseId,
          attemptNumber,
          authority: captured.authority,
        },
        captured.authority.observedAt,
        "authority",
      )
      const permit = await captured.networkEpoch.consume({
        authority: captured.authority,
        proposal: context.proposal.record,
        confirmation: context.confirmation,
        targetReleaseId: context.targetReleaseId,
        intentPath: context.journalPath,
        currentJournal: current.journal,
      })
      current = await loadCurrentJournal(context.journalPath)
      const intentState = deriveConsolidationState(current.journal)
      if (
        intentState.phase !== "delete-intent" ||
        intentState.currentTargetReleaseId !== context.targetReleaseId ||
        intentState.attemptNumber !== attemptNumber
      ) {
        throw new Error("Durable delete intent did not become current")
      }
      injectFault(context, "before-delete")
      const outcome = exactPlain(
        await adapters.writer.deleteDuplicate({
          releaseId: context.targetReleaseId,
          permit,
        }),
        ["classification", "httpStatus", "observedAt"],
        "delete outcome",
      )
      injectFault(context, "after-delete")
      current = await appendDurableEvent(
        context,
        current.journal,
        "delete-outcome",
        {
          targetReleaseId: context.targetReleaseId,
          attemptNumber,
          classification: outcome.classification,
          httpStatus: outcome.httpStatus,
          observedAt: outcome.observedAt,
        },
        outcome.observedAt,
        "outcome",
      )
      const outcomeState = deriveConsolidationState(current.journal)
      if (outcomeState.lastOutcomeClassification === "response-hard-failure") {
        throw new Error("A hard GitHub DELETE response is terminal and cannot be retried")
      }
      const observation = await observeConvergence(context, outcomeState)
      const resolved = await resolveConvergence(context, current.journal, outcomeState, observation)
      if (resolved.result !== null) return resolved.result
      current = { journal: resolved.journal }
      preparedAttempt = resolved.preparedAttempt
    }
  } catch {
    throw new Error("One duplicate deletion failed.")
  }
}

async function captureFreshDeleteAuthority(context, state) {
  const sourceAdapters = await context.createAdapters()
  const adapters = bindAdapters(sourceAdapters)
  const captured = await captureConsolidationAuthority({
    stage: deletionStage(state),
    proposal: context.proposal.record,
    targetReleaseId: context.targetReleaseId,
    adapters: sourceAdapters,
  })
  return Object.freeze({ adapters, captured })
}

async function captureStaleRetryInventory(context, journal, state) {
  const sourceAdapters = await context.createAdapters()
  const adapters = bindAdapters(sourceAdapters)
  const inventory = await captureNpmInventory({
    stage: "perform-initial",
    candidate: CANDIDATE,
    npm: adapters.npm,
    now: context.retryWallNow,
  })
  return appendDurableEvent(
    context,
    journal,
    "npm-observed",
    {
      targetReleaseId: context.targetReleaseId,
      attemptNumber: state.attemptNumber + 1,
      inventory,
    },
    inventory.completedAt,
    "npm",
  )
}

function normalizeDeletionInvocation(input, dependencies) {
  const value = exactPlain(
    input,
    ["proposedEnvelope", "confirmation", "targetReleaseId", "journalPath"],
    "one-target deletion input",
  )
  if (
    typeof value.targetReleaseId !== "string" ||
    !DUPLICATES.includes(value.targetReleaseId) ||
    value.targetReleaseId === SURVIVOR
  ) {
    throw new TypeError("Deletion target is not an approved duplicate")
  }
  if (
    typeof value.journalPath !== "string" ||
    !path.isAbsolute(value.journalPath) ||
    path.normalize(value.journalPath) !== value.journalPath ||
    path.basename(value.journalPath) !== "duplicate-draft-consolidation.journal.json"
  ) {
    throw new TypeError("Deletion journal path is invalid")
  }
  if (typeof value.confirmation !== "string") {
    throw new TypeError("Deletion confirmation is invalid")
  }
  const proposal = parseConsolidationEnvelope(
    "proposed",
    canonicalConsolidationEnvelopeBytes("proposed", value.proposedEnvelope),
  )
  const runtime = exactOptionalFields(
    dependencies,
    ["createAdapters", "wait"],
    ["faultAt", "monotonicTimeline", "wallClockTimeline"],
    "one-target deletion dependencies",
  )
  const createAdapters = safeFunction(runtime.createAdapters, "deletion adapter factory")
  const wait = safeFunction(runtime.wait, "convergence waiter")
  const convergenceAuditNow = deletionMonotonicClock(runtime.monotonicTimeline)
  const retryWallNow = deletionWallClock(runtime.wallClockTimeline)
  if (
    runtime.faultAt !== undefined &&
    (typeof runtime.faultAt !== "string" || !FAULT_BOUNDARIES.has(runtime.faultAt))
  ) {
    throw new TypeError("Deletion fault boundary is invalid")
  }
  return Object.freeze({
    proposal,
    confirmation: value.confirmation,
    targetReleaseId: value.targetReleaseId,
    journalPath: value.journalPath,
    createAdapters,
    wait,
    convergenceAuditNow,
    retryWallNow,
    faultAt: runtime.faultAt ?? null,
  })
}

function assertDeletionBinding(context, journal) {
  const state = deriveConsolidationState(journal)
  const confirmationSha256 = createHash("sha256").update(context.confirmation, "utf8").digest("hex")
  if (
    journal.record.proposedRecordSha256 !== context.proposal.recordSha256 ||
    journal.record.confirmationSha256 !== confirmationSha256 ||
    state.controllerSha !== context.proposal.record.controller.headSha ||
    !safeArrayEquals(journal.record.deletionOrder, DUPLICATES) ||
    (state.currentTargetReleaseId !== context.targetReleaseId &&
      !state.completedTargets.includes(context.targetReleaseId))
  ) {
    throw new Error("Journal does not bind the exact approved deletion")
  }
}

function completedDeletionResult(context, journal) {
  const state = deriveConsolidationState(journal)
  if (!state.completedTargets.includes(context.targetReleaseId)) return null
  const converged = journal.record.events.findLast(
    ({ event }) =>
      event.type === "absence-converged" &&
      event.payload.targetReleaseId === context.targetReleaseId,
  )
  if (converged === undefined) {
    throw new Error("Completed target lacks its durable convergence event")
  }
  return deepFreeze({
    status: "converged",
    targetReleaseId: context.targetReleaseId,
    attemptNumber: converged.event.payload.attemptNumber,
    basis: converged.event.payload.basis,
  })
}

function deletionStage(state) {
  const index = state.deletionOrder.indexOf(state.currentTargetReleaseId)
  if (index === 0) return "pre-delete-1"
  if (index === 1) return "pre-delete-2"
  throw new Error("Journal target is outside the fixed deletion order")
}

async function resolveConvergence(context, journal, state, observation) {
  if (observation.classification === "absent") {
    let current = { journal }
    let currentState = state
    if (currentState.phase === "delete-intent") {
      if (nextResumeAction(currentState, { classification: "absent" }) !== "reconcile-absence") {
        throw new Error("Journal rejected absent intent reconciliation")
      }
      current = await appendDurableEvent(
        context,
        current.journal,
        "resume-reconciliation",
        {
          targetReleaseId: context.targetReleaseId,
          attemptNumber: currentState.attemptNumber,
          classification: "absent-ambiguous",
          releaseEvidence: null,
          observedAt: observation.completedAt,
        },
        observation.completedAt,
        "resume",
      )
      currentState = deriveConsolidationState(current.journal)
    }
    if (currentState.phase !== "resume-absent" && currentState.phase !== "delete-outcome") {
      throw new Error("Absence is not legal in the current journal phase")
    }
    const basis =
      currentState.phase === "delete-outcome" &&
      currentState.lastOutcomeClassification === "confirmed-204"
        ? "confirmed-204"
        : "ambiguous"
    current = await appendDurableEvent(
      context,
      current.journal,
      "absence-converged",
      {
        targetReleaseId: context.targetReleaseId,
        attemptNumber: currentState.attemptNumber,
        basis,
        directGet404At: observation.directGet404At,
        listAbsentAt: observation.listAbsentAt,
        attempts: observation.attempts,
        completedAt: observation.completedAt,
      },
      observation.completedAt,
      "convergence",
    )
    return {
      journal: current.journal,
      result: deepFreeze({
        status: "converged",
        targetReleaseId: context.targetReleaseId,
        attemptNumber: currentState.attemptNumber,
        basis,
      }),
    }
  }

  const liveTarget = {
    classification: "present-unchanged",
    releaseEvidence: observation.releaseEvidence,
    ...(state.phase === "delete-outcome" ? { observations: observation.attempts } : {}),
  }
  if (nextResumeAction(state, liveTarget) !== "refresh-and-retry") {
    throw new Error("Present target is not eligible for another delete attempt")
  }
  if (retryNpmInventoryIsStale(context, state)) {
    const current = await captureStaleRetryInventory(context, journal, state)
    return completeStaleRetryPreparation(
      context,
      current.journal,
      deriveConsolidationState(current.journal),
    )
  }
  const preparedAttempt = await captureFreshDeleteAuthority(context, state)
  const current = await appendRetryReconciliation(context, journal, state, preparedAttempt)
  return { journal: current.journal, result: null, preparedAttempt }
}

function retryNpmInventoryIsStale(context, state) {
  const completedAt = state.lastAuthority?.npmInventory?.completedAt
  if (completedAt === undefined) {
    throw new Error("Retry freshness has no preceding npm inventory")
  }
  const current = timestampValue(context.retryWallNow(), "retry npm freshness clock")
  const age = Date.parse(current) - Date.parse(completedAt)
  if (age < 0) {
    throw new Error("Retry freshness clock precedes the prior npm inventory")
  }
  return age > MAXIMUM_RETRY_NPM_AGE_MS
}

async function completeStaleRetryPreparation(context, journal, state) {
  if (
    state.phase !== "npm-observed" ||
    state.pendingRetryFromAttempt === null ||
    state.lastRetryNpmInventory === null
  ) {
    throw new Error("Stale retry preparation is not durable in the journal")
  }
  const sourceAdapters = await context.createAdapters()
  const adapters = bindAdapters(sourceAdapters)
  const releases = await readReleaseEnumeration({ adapters })
  const stage = deletionStage(state)
  const inspected = await inspectEquivalentRemainingDrafts({
    stage,
    candidate: CANDIDATE,
    survivorId: SURVIVOR,
    duplicateIds: DUPLICATES,
    releases,
    github: adapters.github,
    attestations: adapters.attestations,
  })
  assertRetryPayloadMatchesProposal(inspected, context.proposal.record, stage)
  const gapStartedAt = Date.parse(state.lastRetryNpmInventory.completedAt)
  const afterVerification = Date.parse(
    timestampValue(context.retryWallNow(), "retry payload verification clock"),
  )
  const elapsed = afterVerification - gapStartedAt
  if (elapsed < 0) throw new Error("Retry observation clock reversed")
  const remaining = Math.max(0, OBSERVATION_GAP_MS - elapsed)
  if (remaining > 0) {
    const timeoutMs = remaining + 5_000
    const signal = AbortSignal.timeout(timeoutMs)
    await context.wait(remaining, { signal, timeoutMs })
  }
  const readyBoundary = Date.parse(
    timestampValue(context.retryWallNow(), "retry observation boundary clock"),
  )
  if (readyBoundary - gapStartedAt < OBSERVATION_GAP_MS) {
    throw new Error("Retry observation gap did not reach sixty seconds")
  }
  const preparedAttempt = await captureFreshDeleteAuthority(context, state)
  const current = await appendRetryReconciliation(context, journal, state, preparedAttempt)
  return { journal: current.journal, result: null, preparedAttempt }
}

function assertRetryPayloadMatchesProposal(inspected, proposal, stage) {
  const proposedReleases =
    stage === "pre-delete-1" ? proposal.releases : [proposal.releases[0], proposal.releases[2]]
  if (!Array.isArray(inspected.releases) || inspected.releases.length !== proposedReleases.length) {
    throw new Error("Retry payload verification returned incomplete Releases")
  }
  for (let index = 0; index < proposedReleases.length; index += 1) {
    if (inspected.releases[index].id !== proposedReleases[index].id) {
      throw new Error("Retry payload verification changed fixed Release order")
    }
    assertEvidenceEqualsProposal(inspected.releases[index], proposedReleases[index])
  }
  const payloadProofMatches =
    isDeepStrictEqual(inspected.payloadProof.baseAssetSet, proposal.payloadProof.baseAssetSet) &&
    inspected.payloadProof.baseAssetSetSha256 === proposal.payloadProof.baseAssetSetSha256 &&
    isDeepStrictEqual(
      inspected.payloadProof.attestationVerification,
      proposal.payloadProof.attestationVerification,
    ) &&
    (stage === "pre-delete-2" ||
      inspected.payloadProof.consolidationPayloadSha256 ===
        proposal.payloadProof.consolidationPayloadSha256)
  if (!payloadProofMatches) {
    throw new Error("Retry payload proof differs from the reviewed proposal")
  }
}

function appendRetryReconciliation(context, journal, state, preparedAttempt) {
  return appendDurableEvent(
    context,
    journal,
    "resume-reconciliation",
    {
      targetReleaseId: context.targetReleaseId,
      attemptNumber:
        state.pendingRetryFromAttempt === null
          ? state.attemptNumber
          : state.pendingRetryFromAttempt,
      classification: "present-unchanged-retryable",
      releaseEvidence: preparedAttempt.captured.authority.targetRead.evidence,
      observedAt: preparedAttempt.captured.authority.observedAt,
    },
    preparedAttempt.captured.authority.observedAt,
    "resume",
  )
}

async function observeConvergence(context, state) {
  const budget = createConvergenceBudget(NATIVE_PERFORMANCE_NOW, context.convergenceAuditNow)
  let lastPresent = null
  for (let attempt = 1; attempt <= MAXIMUM_CONVERGENCE_ATTEMPTS; attempt += 1) {
    budget.checkpoint()
    const direct = await runConvergenceRequest(context, budget, "release", (adapters) =>
      adapters.github.getRelease({
        releaseId: context.targetReleaseId,
      }),
    )
    const directCompletedAt = currentIsoTimestamp()
    const list = exactPlain(
      await runConvergenceRequest(context, budget, "releases", (adapters) =>
        adapters.github.listReleases(),
      ),
      ["status", "operation", "httpStatus", "code", "value"],
      "convergence Release enumeration",
    )
    const listCompletedAt = currentIsoTimestamp()
    if (
      list.status !== "PRESENT" ||
      list.operation !== "releases" ||
      list.httpStatus !== 200 ||
      list.code !== null ||
      !Array.isArray(list.value)
    ) {
      throw new Error("Convergence Release enumeration is incomplete")
    }
    const directStatus = safeDataValue(direct, "status")
    if (directStatus === "PRESENT") {
      const present = exactPlain(
        direct,
        ["status", "operation", "httpStatus", "code", "value"],
        "convergence direct Release read",
      )
      if (present.operation !== "release" || present.httpStatus !== 200 || present.code !== null) {
        throw new Error("Convergence direct Release read is malformed")
      }
      const classified = classifyConsolidationReleases(
        list.value,
        context.proposal.record,
        deletionStage(state),
      )
      validateRemainingConvergence(classified.selected, context)
      const listed = classified.selected.find(({ id }) => String(id) === context.targetReleaseId)
      if (listed === undefined || !isDeepStrictEqual(present.value, listed)) {
        throw new Error("Convergence direct and list readers disagree")
      }
      lastPresent = validatePresentConvergence(present.value, state)
    } else {
      const absent = exactPlain(
        direct,
        ["status", "operation", "httpStatus", "code"],
        "convergence direct Release absence",
      )
      if (
        absent.status !== "AMBIGUOUS" ||
        absent.operation !== "release" ||
        absent.httpStatus !== 404 ||
        typeof absent.code !== "string"
      ) {
        throw new Error("Convergence direct read is not exact 404 evidence")
      }
      const classified = classifyConsolidationReleases(
        list.value,
        context.proposal.record,
        nextDeletionStage(state),
      )
      validateRemainingConvergence(classified.selected, context)
      return deepFreeze({
        classification: "absent",
        directGet404At: directCompletedAt,
        listAbsentAt: listCompletedAt,
        attempts: attempt,
        completedAt: monotoneEventTimestamp(
          state,
          laterTimestamp(directCompletedAt, listCompletedAt),
        ),
      })
    }
    if (attempt === MAXIMUM_CONVERGENCE_ATTEMPTS) break
    await runConvergenceWait(context, budget, CONVERGENCE_BACKOFF_MS[attempt - 1])
  }
  if (lastPresent === null) {
    throw new Error("Convergence did not produce complete target evidence")
  }
  return deepFreeze({
    classification: "present-unchanged",
    releaseEvidence: lastPresent,
    attempts: MAXIMUM_CONVERGENCE_ATTEMPTS,
    completedAt: monotoneEventTimestamp(state, currentIsoTimestamp()),
  })
}

function validatePresentConvergence(rawRelease, state) {
  const expected = state.lastAuthority?.targetRead?.evidence
  if (expected === undefined) {
    throw new Error("Present convergence has no recorded authority evidence")
  }
  assertRawReleaseSemanticEqualsProposal(rawRelease, expected)
  return expected
}

function validateRemainingConvergence(rawReleases, context) {
  for (const rawRelease of rawReleases) {
    const releaseId = String(rawRelease.id)
    const expected = context.proposal.record.releases.find(({ id }) => id === releaseId)
    if (expected === undefined) {
      throw new Error("Convergence includes an unproposed managed Release")
    }
    assertRawReleaseSemanticEqualsProposal(rawRelease, expected)
  }
}

function assertRawReleaseSemanticEqualsProposal(rawRelease, expected) {
  if (!safeRecord(rawRelease)) {
    throw new TypeError("Convergence Release evidence is invalid")
  }
  const author = safeDataValue(rawRelease, "author")
  if (!safeRecord(author)) {
    throw new TypeError("Convergence Release author is invalid")
  }
  const id = safeDataValue(rawRelease, "id")
  const semantic = {
    name: safeDataValue(rawRelease, "name"),
    targetCommitish: safeDataValue(rawRelease, "target_commitish"),
    draft: safeDataValue(rawRelease, "draft"),
    immutable: safeDataValue(rawRelease, "immutable"),
    prerelease: safeDataValue(rawRelease, "prerelease"),
    publishedAt: safeDataValue(rawRelease, "published_at"),
    body: safeDataValue(rawRelease, "body"),
    bodySha256: createHash("sha256")
      .update(safeDataValue(rawRelease, "body"), "utf8")
      .digest("hex"),
    author: {
      login: safeDataValue(author, "login"),
      id: String(safeDataValue(author, "id")),
      nodeId: safeDataValue(author, "node_id"),
    },
  }
  if (String(id) !== expected.id || !isDeepStrictEqual(semantic, expected.semantic)) {
    throw new Error("Convergence Release semantic evidence changed")
  }
}

function nextDeletionStage(state) {
  return state.currentTargetReleaseId === DUPLICATES[0] ? "pre-delete-2" : "final"
}

async function appendDurableEvent(context, expectedJournal, type, payload, recordedAt, boundary) {
  return writePrivateEnvelope.withExclusiveTransaction(context.journalPath, async () => {
    const current = await loadCurrentJournalLocked(context.journalPath)
    if (current.journal.recordSha256 !== expectedJournal.recordSha256) {
      throw new Error("Journal changed before its legal append")
    }
    const timestamp = monotoneJournalTimestamp(current.journal, recordedAt)
    const appended = appendJournalEvent(current.journal, type, payload, timestamp)
    const bytes = canonicalConsolidationEnvelopeBytes("journal", appended)
    await writePrivateEnvelope(context.journalPath, bytes, undefined, current.bytes)
    injectFault(context, `after-${boundary}-journal`)
    const durable = await readPrivateEnvelope(
      context.journalPath,
      DUPLICATE_DRAFT_CONSOLIDATION_LIMITS.journalBytes,
    )
    if (!durable.equals(bytes)) {
      throw new Error("Durable journal differs from its legal append")
    }
    const headBytes = canonicalJournalHeadBytes(context.journalPath, appended)
    await writePrivateEnvelope(current.headPath, headBytes, undefined, current.headBytes)
    injectFault(context, `after-${boundary}-head`)
    const durableHead = await readPrivateEnvelope(current.headPath, 16 * 1024)
    if (!durableHead.equals(headBytes)) {
      throw new Error("Durable journal head differs from its legal append")
    }
    return { journal: parseConsolidationJournal(durable) }
  })
}

async function loadCurrentJournal(journalPath) {
  return writePrivateEnvelope.withExclusiveTransaction(journalPath, () =>
    loadCurrentJournalLocked(journalPath),
  )
}

async function loadCurrentJournalLocked(journalPath) {
  const bytes = await readPrivateEnvelope(
    journalPath,
    DUPLICATE_DRAFT_CONSOLIDATION_LIMITS.journalBytes,
  )
  const journal = parseConsolidationJournal(bytes)
  const headPath = journalPath.replace(/journal\.json$/u, "journal.head.json")
  let headBytes = await readPrivateEnvelope(headPath, 16 * 1024)
  const expected = canonicalJournalHeadBytes(journalPath, journal)
  if (!headBytes.equals(expected)) {
    const predecessor = predecessorJournal(journal)
    if (
      predecessor === null ||
      !headBytes.equals(canonicalJournalHeadBytes(journalPath, predecessor))
    ) {
      throw new Error("Journal head is divergent from the durable journal")
    }
    await writePrivateEnvelope(headPath, expected, undefined, headBytes)
    headBytes = await readPrivateEnvelope(headPath, 16 * 1024)
    if (!headBytes.equals(expected)) {
      throw new Error("Journal head reconciliation was not durable")
    }
  }
  return { bytes, journal, headPath, headBytes }
}

function predecessorJournal(journal) {
  if (journal.record.events.length <= 1) return null
  const events = journal.record.events.slice(0, -1)
  return createConsolidationEnvelope("journal", {
    ...journal.record,
    events,
    updatedAt: events.at(-1).event.recordedAt,
  })
}

function canonicalJournalHeadBytes(journalPath, journal) {
  return Buffer.from(
    `${JSON.stringify({
      schemaVersion: 1,
      journalPath,
      repository: journal.record.repository,
      proposedRecordSha256: journal.record.proposedRecordSha256,
      journalRecordSha256: journal.recordSha256,
      lastEventSha256: journal.record.events.at(-1).eventSha256,
      sequence: journal.record.events.length,
      updatedAt: journal.record.updatedAt,
    })}\n`,
    "utf8",
  )
}

function injectFault(context, boundary) {
  if (context.faultAt === boundary) {
    throw new Error("Injected consolidation process loss")
  }
}

function safeDataValue(value, field) {
  if (!safeRecord(value)) throw new TypeError("Adapter result is invalid")
  return dataValue(value, field)
}

function monotoneJournalTimestamp(journal, value) {
  const candidate = timestampValue(value, "journal append timestamp")
  return Date.parse(candidate) < Date.parse(journal.record.updatedAt)
    ? journal.record.updatedAt
    : candidate
}

function monotoneEventTimestamp(state, value) {
  const authorityTime = state.lastAuthority?.observedAt
  return authorityTime !== undefined && Date.parse(value) < Date.parse(authorityTime)
    ? authorityTime
    : value
}

function laterTimestamp(first, second) {
  return Date.parse(first) >= Date.parse(second) ? first : second
}

function currentIsoTimestamp() {
  return new NATIVE_DATE().toISOString()
}

function deletionMonotonicClock(timeline) {
  if (timeline === undefined) return null
  const descriptors =
    Array.isArray(timeline) && !utilTypes.isProxy(timeline)
      ? Object.getOwnPropertyDescriptors(timeline)
      : null
  if (
    descriptors === null ||
    !Object.isFrozen(timeline) ||
    timeline.length < 2 ||
    timeline.length > 256 ||
    !isDeepStrictEqual(Object.keys(descriptors), [
      ...Array.from({ length: timeline.length }, (_, index) => String(index)),
      "length",
    ])
  ) {
    throw new TypeError("Deletion monotonic test timeline is invalid")
  }
  const values = []
  for (let index = 0; index < timeline.length; index += 1) {
    const descriptor = descriptors[String(index)]
    if (
      descriptor?.enumerable !== true ||
      !("value" in descriptor) ||
      descriptor.get !== undefined ||
      descriptor.set !== undefined ||
      !Number.isSafeInteger(descriptor.value) ||
      descriptor.value < 0
    ) {
      throw new TypeError("Deletion monotonic test timeline is invalid")
    }
    values.push(descriptor.value)
  }
  let index = 0
  return Object.freeze(() => {
    if (index >= values.length) {
      throw new Error("Deletion monotonic test timeline is exhausted")
    }
    const value = values[index]
    index += 1
    return value
  })
}

function deletionWallClock(timeline) {
  if (timeline === undefined) {
    let previous = null
    return Object.freeze(() => {
      const current = currentIsoTimestamp()
      if (previous !== null && Date.parse(current) < Date.parse(previous)) {
        throw new Error("Deletion wall clock reversed")
      }
      previous = current
      return current
    })
  }
  const descriptors =
    Array.isArray(timeline) && !utilTypes.isProxy(timeline)
      ? Object.getOwnPropertyDescriptors(timeline)
      : null
  if (
    descriptors === null ||
    !Object.isFrozen(timeline) ||
    timeline.length < 1 ||
    timeline.length > 256 ||
    !isDeepStrictEqual(Object.keys(descriptors), [
      ...Array.from({ length: timeline.length }, (_, index) => String(index)),
      "length",
    ])
  ) {
    throw new TypeError("Deletion wall-clock test timeline is invalid")
  }
  const values = []
  for (let index = 0; index < timeline.length; index += 1) {
    const descriptor = descriptors[String(index)]
    if (
      descriptor?.enumerable !== true ||
      !("value" in descriptor) ||
      descriptor.get !== undefined ||
      descriptor.set !== undefined
    ) {
      throw new TypeError("Deletion wall-clock test timeline is invalid")
    }
    values.push(timestampValue(descriptor.value, "deletion wall-clock timeline"))
  }
  let index = 0
  let previous = null
  return Object.freeze(() => {
    if (index >= values.length) {
      throw new Error("Deletion wall-clock test timeline is exhausted")
    }
    const current = values[index]
    index += 1
    if (previous !== null && Date.parse(current) < Date.parse(previous)) {
      throw new Error("Deletion wall clock reversed")
    }
    previous = current
    return current
  })
}

function createConvergenceBudget(trustedNow, auditNow) {
  const clocks = [monotonicBudgetClock(trustedNow)]
  if (auditNow !== null) clocks.push(monotonicBudgetClock(auditNow))
  const checkpoint = () => {
    for (const clock of clocks) clock.read()
  }
  return Object.freeze({
    checkpoint,
    start() {
      const remaining = Math.min(
        ...clocks.map((clock) => Math.floor(clock.deadline - clock.read())),
      )
      if (remaining <= 0) {
        throw new Error("Convergence wall-clock ceiling expired")
      }
      return remaining
    },
    complete: checkpoint,
  })
}

function monotonicBudgetClock(now) {
  let previous = now()
  const deadline = previous + CONVERGENCE_CEILING_MS
  return Object.freeze({
    deadline,
    read() {
      const current = now()
      if (current < previous) {
        throw new Error("Convergence monotonic clock reversed")
      }
      if (current > deadline) {
        throw new Error("Convergence wall-clock ceiling expired")
      }
      previous = current
      return current
    },
  })
}

async function runConvergenceRequest(context, budget, operation, request) {
  const timeoutMs = budget.start()
  const signal = AbortSignal.timeout(timeoutMs)
  const requestBudget = Object.freeze({ operation, timeoutMs, signal })
  const value = await raceConvergenceOperation(
    () =>
      Promise.resolve(context.createAdapters(requestBudget)).then((source) =>
        request(bindAdapters(source)),
      ),
    signal,
  )
  budget.complete()
  return value
}

async function runConvergenceWait(context, budget, policyDelayMs) {
  const timeoutMs = budget.start()
  const delay = Math.min(policyDelayMs, 30_000, timeoutMs)
  if (delay <= 0) {
    throw new Error("Convergence backoff exceeded its bounded window")
  }
  const signal = AbortSignal.timeout(timeoutMs)
  await raceConvergenceOperation(() => context.wait(delay, { signal, timeoutMs }), signal)
  budget.complete()
}

async function raceConvergenceOperation(operation, signal) {
  return new Promise((resolve, reject) => {
    let settled = false
    const finish = (callback, value) => {
      if (settled) return
      settled = true
      signal.removeEventListener("abort", onAbort)
      callback(value)
    }
    const onAbort = () => finish(reject, new Error("Convergence wall-clock ceiling expired"))
    signal.addEventListener("abort", onAbort, { once: true })
    Promise.resolve()
      .then(operation)
      .then(
        (value) => finish(resolve, value),
        (error) => finish(reject, error),
      )
  })
}

export async function inspectDuplicateDrafts(input, dependencies) {
  let context
  try {
    context = normalizeInvocation(input, dependencies)
  } catch {
    throw new TypeError("Duplicate-draft inspection input is invalid.")
  }

  try {
    const rootGuard =
      context.repositoryRootIdentity ?? (await captureRepositoryRoot(context.repositoryRoot))
    const initialMetadata = await captureMetadata(context)
    const initialInventory = await captureNpmInventory({
      stage: "inspect-initial",
      candidate: CANDIDATE,
      npm: context.adapters.npm,
      now: context.now,
    })
    const gapStartedAt = Date.parse(initialInventory.completedAt)

    const releases = await readReleaseEnumeration(context)
    const inspected = await inspectEquivalentDrafts({
      candidate: CANDIDATE,
      survivorId: SURVIVOR,
      duplicateIds: DUPLICATES,
      releases,
      github: context.adapters.github,
      attestations: context.adapters.attestations,
    })

    const afterVerification = timestamp(context.now, "inspection clock")
    const elapsed = Date.parse(afterVerification) - gapStartedAt
    if (elapsed < 0) throw new Error("Inspection clock is not monotone")
    const remaining = Math.max(0, OBSERVATION_GAP_MS - elapsed)
    if (remaining > 0) {
      const signal = AbortSignal.timeout(remaining + 5_000)
      await context.wait(remaining, { signal })
    }
    const readyBoundary = timestamp(context.now, "ready boundary clock")
    if (Date.parse(readyBoundary) - gapStartedAt < OBSERVATION_GAP_MS) {
      throw new Error("Observation gap did not reach sixty seconds")
    }

    const readyInventory = await captureNpmInventory({
      stage: "inspect-ready",
      candidate: CANDIDATE,
      npm: context.adapters.npm,
      now: context.now,
    })
    if (Date.parse(readyInventory.startedAt) - gapStartedAt < OBSERVATION_GAP_MS) {
      throw new Error("Ready inventory began before the observation gap closed")
    }
    const finalReleaseEnumeration = await readReleaseEnumeration(context)
    const finalMetadata = await captureMetadata(context)
    assertStableMetadata(initialMetadata, finalMetadata)
    const preliminaryEnvelope = proposalEnvelope({
      metadata: finalMetadata,
      npmInventories: [initialInventory, readyInventory],
      releases: inspected.releases,
      payloadProof: inspected.payloadProof,
      inspectedAt: timestamp(context.now, "preliminary inspection clock"),
    })
    classifyConsolidationReleases(
      finalReleaseEnumeration,
      preliminaryEnvelope.record,
      "pre-delete-1",
    )
    const terminal = exactPlain(
      await context.adapters.captureInspectionTerminal({
        candidate: CANDIDATE,
        releases: inspected.releases,
      }),
      ["releases", "completedAt"],
      "inspection terminal",
    )
    if (!Array.isArray(terminal.releases) || terminal.releases.length !== 3) {
      throw new Error("Inspection terminal evidence is incomplete")
    }
    terminal.completedAt = timestampValue(terminal.completedAt, "inspection terminal completion")
    context.adapters.assertInspectionTerminalSealed()

    const envelope = proposalEnvelope({
      metadata: finalMetadata,
      npmInventories: [initialInventory, readyInventory],
      releases: terminal.releases,
      payloadProof: inspected.payloadProof,
      inspectedAt: terminal.completedAt,
    })
    const bytes = canonicalConsolidationEnvelopeBytes("proposed", envelope)
    const absoluteOutput = context.absoluteOutput
    await revalidateRepositoryRoot(rootGuard)
    await writePrivateEnvelope(absoluteOutput, bytes)
    return deepFreeze({
      proposalSha256: envelope.recordSha256,
      version: CANDIDATE.version,
      commitSha: CANDIDATE.commitSha,
      survivor: SURVIVOR,
      duplicates: [...DUPLICATES],
      output: OUTPUT,
    })
  } catch {
    throw new Error("Duplicate-draft inspection failed.")
  }
}

Object.defineProperty(inspectDuplicateDrafts, "captureRepositoryRoot", {
  value: Object.freeze(captureRepositoryRoot),
  enumerable: false,
  writable: false,
  configurable: false,
})

async function readReleaseEnumeration(context) {
  const envelope = exactPlain(
    await context.adapters.github.listReleases(),
    ["status", "operation", "httpStatus", "code", "value"],
    "Release enumeration",
  )
  if (
    envelope.status !== "PRESENT" ||
    envelope.operation !== "releases" ||
    envelope.httpStatus !== 200 ||
    envelope.code !== null ||
    !Array.isArray(envelope.value)
  ) {
    throw new Error("Release enumeration is incomplete")
  }
  return envelope.value
}

function proposalEnvelope({ metadata, npmInventories, releases, payloadProof, inspectedAt }) {
  return createConsolidationEnvelope("proposed", {
    schemaVersion: 1,
    repository: metadata.repository,
    controller: metadata.controller,
    candidate: CANDIDATE,
    roles: { survivor: SURVIVOR, duplicates: DUPLICATES },
    confirmation: {
      version: CANDIDATE.version,
      commitSha: CANDIDATE.commitSha,
      survivor: SURVIVOR,
      duplicates: DUPLICATES,
      template: "<64-lowercase-hex-digest>",
    },
    annotatedTag: metadata.annotatedTag,
    workflowAuthority: metadata.workflowAuthority,
    npmInventories,
    releases,
    payloadProof,
    inspectedAt,
  })
}

async function captureMetadata(context) {
  const local = exactPlain(
    await context.adapters.local.readState(),
    ["headSha", "branch", "porcelainStatus", "originMainSha"],
    "local checkout",
  )
  if (
    !/^[0-9a-f]{40}$/u.test(local.headSha) ||
    local.headSha === CANDIDATE.commitSha ||
    local.originMainSha === CANDIDATE.commitSha ||
    local.originMainSha !== local.headSha ||
    local.branch !== "main" ||
    local.porcelainStatus !== ""
  ) {
    throw new Error("Local checkout authority is invalid")
  }

  const repository = exactPlain(
    await context.adapters.github.getRepository(),
    ["name", "id", "defaultBranch"],
    "repository authority",
  )
  const actor = exactPlain(
    await context.adapters.github.getAuthenticatedUser(),
    ["login", "id"],
    "actor authority",
  )
  if (!isDeepStrictEqual({ ...repository, actor }, REPOSITORY)) {
    throw new Error("Repository or actor authority is invalid")
  }
  const githubMainSha = await context.adapters.github.getDefaultBranchSha()
  if (githubMainSha === CANDIDATE.commitSha || githubMainSha !== local.headSha) {
    throw new Error("GitHub main authority is invalid")
  }
  const workflow = exactPlain(
    await context.adapters.github.getWorkflowState(),
    ["workflowId", "path", "state"],
    "workflow authority",
  )
  if (
    !/^[1-9][0-9]*$/u.test(workflow.workflowId) ||
    workflow.path !== ".github/workflows/release.yml" ||
    workflow.state !== "disabled_manually"
  ) {
    throw new Error("Release workflow authority is invalid")
  }
  const runRead = exactPlain(
    await context.adapters.github.listNonterminalWorkflowRuns(WORKFLOW_QUERY),
    ["query", "runs"],
    "workflow-run authority",
  )
  if (
    !isDeepStrictEqual(runRead.query, WORKFLOW_QUERY) ||
    !Array.isArray(runRead.runs) ||
    runRead.runs.length !== 0
  ) {
    throw new Error("Release workflow has nonterminal runs")
  }
  const annotatedTag = exactPlain(
    await context.adapters.github.getAnnotatedTag({ name: CANDIDATE.tag }),
    ["name", "objectSha", "targetSha", "objectType", "observedAt"],
    "annotated-tag authority",
  )
  if (
    annotatedTag.name !== CANDIDATE.tag ||
    !/^[0-9a-f]{40}$/u.test(annotatedTag.objectSha) ||
    annotatedTag.targetSha !== CANDIDATE.commitSha ||
    annotatedTag.objectType !== "tag"
  ) {
    throw new Error("Annotated tag authority is invalid")
  }
  annotatedTag.observedAt = timestampValue(annotatedTag.observedAt, "tag timestamp")
  const observedAt = timestamp(context.now, "workflow observation clock")
  return deepFreeze({
    repository: { ...repository, actor },
    controller: {
      headSha: local.headSha,
      originMainSha: local.originMainSha,
      githubMainSha,
    },
    annotatedTag,
    workflowAuthority: {
      ...workflow,
      query: WORKFLOW_QUERY,
      nonterminalRuns: [],
      observedAt,
    },
  })
}

function assertStableMetadata(initial, final) {
  const stableInitial = structuredClone(initial)
  const stableFinal = structuredClone(final)
  delete stableInitial.annotatedTag.observedAt
  delete stableFinal.annotatedTag.observedAt
  delete stableInitial.workflowAuthority.observedAt
  delete stableFinal.workflowAuthority.observedAt
  if (!isDeepStrictEqual(stableInitial, stableFinal)) {
    throw new Error("Authority changed during the observation gap")
  }
}

function normalizeInvocation(input, dependencies) {
  const normalizedInput = exactPlain(
    input,
    ["version", "commitSha", "survivor", "duplicates", "output"],
    "inspection input",
  )
  if (
    normalizedInput.version !== CANDIDATE.version ||
    normalizedInput.commitSha !== CANDIDATE.commitSha ||
    normalizedInput.survivor !== SURVIVOR ||
    normalizedInput.output !== OUTPUT ||
    !safeArrayEquals(normalizedInput.duplicates, DUPLICATES)
  ) {
    throw new TypeError("Inspection does not identify the approved incident")
  }
  const normalizedDependencies = exactOptionalFields(
    dependencies,
    ["repositoryRoot", "adapters", "now", "wait"],
    ["repositoryRootIdentity"],
    "inspection dependencies",
  )
  if (
    typeof normalizedDependencies.repositoryRoot !== "string" ||
    !path.isAbsolute(normalizedDependencies.repositoryRoot) ||
    path.normalize(normalizedDependencies.repositoryRoot) !== normalizedDependencies.repositoryRoot
  ) {
    throw new TypeError("Repository root is not canonical")
  }
  const adapters = bindAdapters(normalizedDependencies.adapters)
  const now = trustedClock(safeFunction(normalizedDependencies.now, "inspection clock"))
  const wait = safeFunction(normalizedDependencies.wait, "inspection waiter")
  const repositoryRootIdentity = bindRepositoryRootIdentity(
    normalizedDependencies.repositoryRootIdentity,
    normalizedDependencies.repositoryRoot,
  )
  const absoluteOutput = path.join(normalizedDependencies.repositoryRoot, ...OUTPUT.split("/"))
  if (
    path.relative(normalizedDependencies.repositoryRoot, absoluteOutput) !==
      OUTPUT.split("/").join(path.sep) ||
    path.basename(absoluteOutput) !== "duplicate-draft-consolidation.proposed.json"
  ) {
    throw new TypeError("Proposal output is outside the approved path")
  }
  return {
    adapters,
    now,
    wait,
    absoluteOutput,
    repositoryRootIdentity,
    repositoryRoot: normalizedDependencies.repositoryRoot,
  }
}

function bindAdapters(value) {
  if (!safeRecord(value) || !Object.isFrozen(value)) throw new TypeError("Adapters are invalid")
  const names = Object.keys(value)
  if (!isDeepStrictEqual(names, ["local", "github", "npm", "attestations", "writer"])) {
    throw new TypeError("Adapter facade is not exact")
  }
  if (
    !isDeepStrictEqual(Object.getOwnPropertyNames(value), [
      ...names,
      "captureConsolidationAuthority",
      "captureInspectionTerminal",
      "assertInspectionTerminalSealed",
    ]) ||
    Object.getOwnPropertySymbols(value).length !== 0
  ) {
    throw new TypeError("Adapter facade hidden fields are invalid")
  }
  const captureAuthority = hiddenAdapterMethod(value, "captureConsolidationAuthority")
  const captureInspectionTerminal = hiddenAdapterMethod(value, "captureInspectionTerminal")
  const assertInspectionTerminalSealed = hiddenAdapterMethod(
    value,
    "assertInspectionTerminalSealed",
  )
  const adapters = {
    local: bindFacade(dataValue(value, "local"), ["readState"], "local adapter"),
    github: bindFacade(
      dataValue(value, "github"),
      [
        "getRepository",
        "getAuthenticatedUser",
        "getDefaultBranchSha",
        "getWorkflowState",
        "listNonterminalWorkflowRuns",
        "getAnnotatedTag",
        "listReleases",
        "getRelease",
        "listReleaseAssets",
        "downloadReleaseAsset",
      ],
      "GitHub adapter",
    ),
    npm: bindFacade(dataValue(value, "npm"), ["observePackageVersion"], "npm adapter"),
    attestations: bindFacade(dataValue(value, "attestations"), ["verify"], "attestation adapter"),
    writer: bindFacade(dataValue(value, "writer"), ["deleteDuplicate"], "writer adapter"),
  }
  for (const [name, operation] of [
    ["captureConsolidationAuthority", captureAuthority],
    ["captureInspectionTerminal", captureInspectionTerminal],
    ["assertInspectionTerminalSealed", assertInspectionTerminalSealed],
  ]) {
    Object.defineProperty(adapters, name, {
      value: (...args) => Reflect.apply(operation, value, args),
      enumerable: false,
      writable: false,
      configurable: false,
    })
    Object.freeze(adapters[name])
  }
  return Object.freeze(adapters)
}

function hiddenAdapterMethod(value, name) {
  const descriptor = Object.getOwnPropertyDescriptor(value, name)
  if (
    descriptor?.enumerable !== false ||
    descriptor.writable !== false ||
    descriptor.configurable !== false ||
    typeof descriptor.value !== "function" ||
    utilTypes.isProxy(descriptor.value) ||
    !Object.isFrozen(descriptor.value)
  ) {
    throw new TypeError("Adapter hidden entrypoint is invalid")
  }
  return descriptor.value
}

async function captureRepositoryRoot(repositoryRoot) {
  if (
    typeof repositoryRoot !== "string" ||
    !path.isAbsolute(repositoryRoot) ||
    path.normalize(repositoryRoot) !== repositoryRoot ||
    (await realpath(repositoryRoot)) !== repositoryRoot
  ) {
    throw new Error("Repository root is not physically canonical")
  }
  const effectiveUserId = currentEffectiveUserId()
  const root = await captureDirectoryIdentity(repositoryRoot, effectiveUserId, false)
  const dawnPath = path.join(repositoryRoot, ".dawn")
  const releasePath = path.join(dawnPath, "release")
  if (path.relative(repositoryRoot, releasePath) !== ".dawn/release") {
    throw new Error("Proposal directory is outside the repository root")
  }
  const dawn = await captureDirectoryIdentity(dawnPath, effectiveUserId, true)
  const release = await captureDirectoryIdentity(releasePath, effectiveUserId, true)
  if (!dawn.exists && release.exists) {
    throw new Error("Proposal directory containment is invalid")
  }
  const capability = {}
  Object.defineProperty(capability, "toJSON", {
    value() {
      throw new TypeError("Repository-root identity cannot be serialized")
    },
    enumerable: false,
    writable: false,
    configurable: false,
  })
  Object.freeze(capability.toJSON)
  Object.freeze(capability)
  ROOT_GUARDS.set(
    capability,
    Object.freeze({
      repositoryRoot,
      effectiveUserId,
      root,
      dawn,
      release,
    }),
  )
  return capability
}

function bindRepositoryRootIdentity(value, repositoryRoot) {
  if (value === undefined) return undefined
  const record = value !== null && typeof value === "object" ? ROOT_GUARDS.get(value) : undefined
  if (record === undefined || record.repositoryRoot !== repositoryRoot) {
    throw new TypeError("Repository-root identity is invalid")
  }
  return value
}

async function revalidateRepositoryRoot(capability) {
  const record = ROOT_GUARDS.get(capability)
  if (record === undefined) throw new Error("Repository-root identity is invalid")
  if ((await realpath(record.repositoryRoot)) !== record.repositoryRoot) {
    throw new Error("Repository root changed before proposal publication")
  }
  await assertDirectoryIdentity(record.repositoryRoot, record.root, record.effectiveUserId)
  const currentComponents = []
  for (const [target, expected] of [
    [path.join(record.repositoryRoot, ".dawn"), record.dawn],
    [path.join(record.repositoryRoot, ".dawn", "release"), record.release],
  ]) {
    if (expected.exists) {
      currentComponents.push([
        target,
        await assertDirectoryIdentity(target, expected, record.effectiveUserId),
      ])
      continue
    }
    await assertDirectoryAbsent(target)
    await mkdir(target, { mode: 0o700 })
    currentComponents.push([
      target,
      await captureDirectoryIdentity(target, record.effectiveUserId, false),
    ])
  }
  await assertDirectoryIdentity(record.repositoryRoot, record.root, record.effectiveUserId)
  for (const [target, identity] of currentComponents) {
    await assertDirectoryIdentity(target, identity, record.effectiveUserId)
  }
}

async function captureDirectoryIdentity(target, effectiveUserId, allowAbsent) {
  let status
  try {
    status = await lstat(target, { bigint: true })
  } catch (error) {
    if (allowAbsent && error?.code === "ENOENT") {
      return Object.freeze({ exists: false })
    }
    throw error
  }
  if (
    status.isSymbolicLink() ||
    !status.isDirectory() ||
    status.uid !== effectiveUserId ||
    (status.mode & 0o022n) !== 0n ||
    (await realpath(target)) !== target
  ) {
    throw new Error("Repository path identity is unsafe")
  }
  const current = await lstat(target, { bigint: true })
  if (
    current.isSymbolicLink() ||
    !current.isDirectory() ||
    current.dev !== status.dev ||
    current.ino !== status.ino ||
    current.mode !== status.mode ||
    current.uid !== status.uid
  ) {
    throw new Error("Repository path identity changed during validation")
  }
  return Object.freeze({
    exists: true,
    dev: current.dev,
    ino: current.ino,
    mode: current.mode,
    uid: current.uid,
  })
}

async function assertDirectoryIdentity(target, expected, effectiveUserId) {
  const observed = await captureDirectoryIdentity(target, effectiveUserId, false)
  if (
    !expected.exists ||
    observed.dev !== expected.dev ||
    observed.ino !== expected.ino ||
    observed.mode !== expected.mode ||
    observed.uid !== expected.uid
  ) {
    throw new Error("Repository path identity changed before publication")
  }
  return observed
}

async function assertDirectoryAbsent(target) {
  try {
    await lstat(target, { bigint: true })
  } catch (error) {
    if (error?.code === "ENOENT") return
    throw error
  }
  throw new Error("Repository path appeared before publication")
}

function currentEffectiveUserId() {
  if (typeof process.geteuid !== "function") {
    throw new Error("Repository owner identity is unavailable")
  }
  const value = process.geteuid()
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error("Repository owner identity is invalid")
  }
  return BigInt(value)
}

function bindFacade(value, methods, label) {
  if (
    !safeRecord(value) ||
    !Object.isFrozen(value) ||
    !isDeepStrictEqual([...Object.keys(value)].sort(), [...methods].sort()) ||
    !isDeepStrictEqual([...Object.getOwnPropertyNames(value)].sort(), [...methods].sort()) ||
    Object.getOwnPropertySymbols(value).length !== 0
  ) {
    throw new TypeError(`${label} is invalid`)
  }
  const facade = {}
  for (const method of methods) {
    const operation = safeFunction(dataValue(value, method), `${label} method`)
    facade[method] = (...args) => Reflect.apply(operation, value, args)
  }
  return Object.freeze(facade)
}

function exactPlain(value, fields, label) {
  if (!safeRecord(value) || Object.getOwnPropertySymbols(value).length !== 0) {
    throw new TypeError(`${label} must be a plain object`)
  }
  const names = Object.getOwnPropertyNames(value)
  if (!isDeepStrictEqual(names, fields)) throw new TypeError(`${label} fields are invalid`)
  const output = {}
  for (const field of fields) output[field] = dataValue(value, field)
  return output
}

function exactOptionalFields(value, fields, optionalFields, label) {
  if (!safeRecord(value) || Object.getOwnPropertySymbols(value).length !== 0) {
    throw new TypeError(`${label} must be a plain object`)
  }
  const names = Object.getOwnPropertyNames(value)
  const expected = [...fields, ...optionalFields.filter((field) => names.includes(field))]
  if (!isDeepStrictEqual(names, expected)) throw new TypeError(`${label} fields are invalid`)
  const output = {}
  for (const field of names) output[field] = dataValue(value, field)
  return output
}

function dataValue(value, field) {
  const descriptor = Object.getOwnPropertyDescriptor(value, field)
  if (
    descriptor?.enumerable !== true ||
    !("value" in descriptor) ||
    descriptor.get !== undefined ||
    descriptor.set !== undefined
  ) {
    throw new TypeError("Required data property is unsafe")
  }
  return descriptor.value
}

function safeRecord(value) {
  return (
    value !== null &&
    typeof value === "object" &&
    !utilTypes.isProxy(value) &&
    [Object.prototype, null].includes(Object.getPrototypeOf(value))
  )
}

function safeFunction(value, label) {
  if (typeof value !== "function" || utilTypes.isProxy(value))
    throw new TypeError(`${label} is invalid`)
  return value
}

function safeArrayEquals(value, expected) {
  if (
    !Array.isArray(value) ||
    utilTypes.isProxy(value) ||
    value.length !== expected.length ||
    Object.getOwnPropertySymbols(value).length !== 0
  )
    return false
  if (!isDeepStrictEqual(Object.getOwnPropertyNames(value), ["0", "1", "length"])) return false
  return expected.every((entry, index) => dataValue(value, String(index)) === entry)
}

function timestamp(now, label) {
  return timestampValue(Reflect.apply(now, undefined, []), label)
}

function trustedClock(source) {
  let previous = null
  const clock = () => {
    const value = timestampValue(Reflect.apply(source, undefined, []), "trusted inspection clock")
    const current = Date.parse(value)
    if (previous !== null && current < previous) {
      throw new TypeError("Trusted inspection clock is not monotone")
    }
    previous = current
    return value
  }
  return Object.freeze(clock)
}

function timestampValue(value, label) {
  if (
    typeof value !== "string" ||
    !/^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}\.[0-9]{3}Z$/u.test(value) ||
    !Number.isFinite(Date.parse(value))
  ) {
    throw new TypeError(`${label} is invalid`)
  }
  return value
}

function deepFreeze(value) {
  if (value !== null && typeof value === "object" && !Object.isFrozen(value)) {
    for (const child of Object.values(value)) deepFreeze(child)
    Object.freeze(value)
  }
  return value
}
