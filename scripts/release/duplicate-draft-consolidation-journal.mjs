import { isDeepStrictEqual, types as utilTypes } from "node:util"

import { assertEvidenceEqualsProposal } from "./duplicate-draft-consolidation-evidence.mjs"
import {
  canonicalConsolidationEnvelopeBytes,
  canonicalEventEnvelope,
  createConsolidationEnvelope,
  DUPLICATE_DRAFT_CONSOLIDATION_LIMITS,
  parseConsolidationEnvelope,
} from "./duplicate-draft-consolidation-schema.mjs"

const MAXIMUM_DELETE_ATTEMPTS = 3
const RETRY_OBSERVATION_GAP_MS = 60_000
const MAXIMUM_ORPHAN_AUTHORITY_RECOVERIES =
  DUPLICATE_DRAFT_CONSOLIDATION_LIMITS.maximumOrphanAuthorityRecoveries
if (MAXIMUM_ORPHAN_AUTHORITY_RECOVERIES !== 1) {
  throw new Error("Journal orphan-authority recovery bound must remain exactly one")
}
const APPROVED_DUPLICATE_IDS = Object.freeze(["379982100", "379986168"])
const SHA256_PATTERN = /^[0-9a-f]{64}$/u
const TIMESTAMP_PATTERN = /^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}\.[0-9]{3}Z$/u
const JOURNAL_STATES = new WeakSet()

export function createConsolidationJournal(input) {
  const value = exactInput(
    input,
    ["proposedEnvelope", "confirmationSha256", "recordedAt"],
    "journal creation input",
  )
  const proposedEnvelope = normalizeEnvelope(
    "proposed",
    dataValue(value, "proposedEnvelope", "proposed envelope"),
  )
  const confirmationSha256 = canonicalSha256(
    dataValue(value, "confirmationSha256", "confirmation digest"),
    "confirmation digest",
  )
  const recordedAt = canonicalTimestamp(
    dataValue(value, "recordedAt", "journal creation timestamp"),
    "journal creation timestamp",
  )
  const event = canonicalEventEnvelope(
    {
      schemaVersion: 1,
      sequence: 1,
      previousEventSha256: null,
      type: "operation-started",
      recordedAt,
      payload: {
        proposedRecordSha256: proposedEnvelope.recordSha256,
        confirmationSha256,
        controllerSha: proposedEnvelope.record.controller.headSha,
        deletionOrder: [...proposedEnvelope.record.roles.duplicates],
      },
    },
    null,
  )
  const journal = createConsolidationEnvelope("journal", {
    schemaVersion: 1,
    repository: proposedEnvelope.record.repository,
    candidate: proposedEnvelope.record.candidate,
    proposedRecordSha256: proposedEnvelope.recordSha256,
    confirmationSha256,
    deletionOrder: [...proposedEnvelope.record.roles.duplicates],
    events: [event],
    updatedAt: recordedAt,
  })
  return freezeEnvelope(journal)
}

export function parseConsolidationJournal(envelope) {
  const parsed = normalizeEnvelope("journal", envelope)
  replayJournal(parsed)
  return freezeEnvelope(parsed)
}

export function deriveConsolidationState(journal) {
  const parsed = parseConsolidationJournal(journal)
  const state = replayJournal(parsed)
  const result = deepFreeze({
    phase: state.phase,
    controllerSha: state.controllerSha,
    deletionOrder: [...state.deletionOrder],
    completedTargets: [...state.completedTargets],
    currentTargetReleaseId: state.currentTargetReleaseId,
    attemptNumber: state.attemptNumber,
    lastOutcomeClassification: state.lastOutcomeClassification,
    lastAuthority: state.lastAuthority,
    lastRetryNpmInventory: state.lastRetryNpmInventory,
    pendingRetryFromAttempt: state.pendingRetryFromAttempt,
    lastEventSha256: parsed.record.events.at(-1).eventSha256,
    journalRecordSha256: parsed.recordSha256,
  })
  JOURNAL_STATES.add(result)
  return result
}

export function appendJournalEvent(journal, type, payload, recordedAt) {
  const parsed = parseConsolidationJournal(journal)
  if (typeof type !== "string" || type.length === 0) {
    throw new TypeError("Journal event type must be a nonempty string")
  }
  const timestamp = canonicalTimestamp(recordedAt, "journal event timestamp")
  const previous = parsed.record.events.at(-1)
  if (Date.parse(timestamp) < Date.parse(previous.event.recordedAt)) {
    throw new Error("Journal event timestamps must be monotone")
  }
  const eventEnvelope = canonicalEventEnvelope(
    {
      schemaVersion: 1,
      sequence: parsed.record.events.length + 1,
      previousEventSha256: previous.eventSha256,
      type,
      recordedAt: timestamp,
      payload,
    },
    previous.eventSha256,
  )
  const candidate = createConsolidationEnvelope("journal", {
    ...parsed.record,
    events: [...parsed.record.events, eventEnvelope],
    updatedAt: timestamp,
  })
  replayJournal(candidate)
  return freezeEnvelope(candidate)
}

export function nextResumeAction(state, liveTarget) {
  if (!JOURNAL_STATES.has(state)) {
    throw new TypeError("Resume state must come from journal replay")
  }
  const live = exactInput(liveTarget, Object.keys(liveTarget), "live target observation")
  const classification = dataString(live, "classification", "live target classification")
  if (state.phase === "final-authority-observed") return "complete"
  if (state.phase === "target-converged") {
    return state.completedTargets.length === state.deletionOrder.length
      ? "complete"
      : "refresh-and-retry"
  }
  if (state.phase === "resume-present") {
    return state.attemptNumber >= MAXIMUM_DELETE_ATTEMPTS ? "stop" : "refresh-and-retry"
  }
  if (state.phase === "resume-absent") return "reconcile-absence"
  if (state.phase !== "delete-intent" && state.phase !== "delete-outcome") {
    return "stop"
  }
  if (classification === "absent") return "reconcile-absence"
  if (classification !== "present-unchanged") return "stop"
  if (
    (state.phase === "delete-outcome" &&
      !isAmbiguousOutcomeClassification(state.lastOutcomeClassification)) ||
    state.attemptNumber >= MAXIMUM_DELETE_ATTEMPTS
  ) {
    return "stop"
  }
  const evidence = dataValue(live, "releaseEvidence", "live Release evidence")
  const expected = state.lastAuthority?.targetRead?.evidence
  if (expected === undefined) {
    return "stop"
  }
  try {
    assertEvidenceEqualsProposal(evidence, expected)
  } catch {
    return "stop"
  }
  if (state.phase === "delete-outcome") {
    const observations = dataValue(live, "observations", "live unchanged observation count")
    if (!Number.isSafeInteger(observations) || observations !== 6) return "stop"
  }
  return "refresh-and-retry"
}

function isAmbiguousOutcomeClassification(value) {
  return value === "transport-ambiguous" || value === "response-404-ambiguous"
}

export function createFinalConsolidationReceipt(input) {
  const value = exactInput(
    input,
    ["proposedEnvelope", "journalEnvelope", "finalAuthority", "completedAt"],
    "final receipt input",
  )
  const proposedEnvelope = normalizeEnvelope(
    "proposed",
    dataValue(value, "proposedEnvelope", "final proposal envelope"),
  )
  const journalEnvelope = parseConsolidationJournal(
    dataValue(value, "journalEnvelope", "final journal envelope"),
  )
  const state = deriveConsolidationState(journalEnvelope)
  if (
    state.phase !== "final-authority-observed" ||
    state.completedTargets.length !== journalEnvelope.record.deletionOrder.length
  ) {
    throw new Error("Final receipt requires both targets converged and final authority recorded")
  }
  if (
    journalEnvelope.record.proposedRecordSha256 !== proposedEnvelope.recordSha256 ||
    !isDeepStrictEqual(journalEnvelope.record.repository, proposedEnvelope.record.repository) ||
    !isDeepStrictEqual(journalEnvelope.record.candidate, proposedEnvelope.record.candidate)
  ) {
    throw new Error("Final journal does not bind the proposed envelope")
  }
  const finalAuthority = snapshotPlain(
    dataValue(value, "finalAuthority", "final authority"),
    "final authority",
  )
  if (!isDeepStrictEqual(finalAuthority, state.lastAuthority)) {
    throw new Error("Final authority differs from the journal terminal event")
  }
  assertFinalAuthorityMatchesProposal(finalAuthority, proposedEnvelope.record)
  const completedAt = canonicalTimestamp(
    dataValue(value, "completedAt", "receipt completion timestamp"),
    "receipt completion timestamp",
  )
  if (Date.parse(completedAt) < Date.parse(journalEnvelope.record.updatedAt)) {
    throw new Error("Receipt completion precedes the completed journal")
  }
  return freezeEnvelope(
    createConsolidationEnvelope("final", {
      schemaVersion: 1,
      proposedEnvelope,
      journalEnvelope,
      finalAuthority,
      finalSurvivor: finalAuthority.releases[0],
      completedAt,
    }),
  )
}

function replayJournal(journal) {
  const events = journal.record.events
  if (events.length === 0) throw new Error("Journal is truncated before start")
  const started = events[0].event
  if (started.type !== "operation-started") {
    throw new Error("Journal must begin with operation-started")
  }
  if (
    started.payload.proposedRecordSha256 !== journal.record.proposedRecordSha256 ||
    started.payload.confirmationSha256 !== journal.record.confirmationSha256 ||
    !isDeepStrictEqual(started.payload.deletionOrder, journal.record.deletionOrder)
  ) {
    throw new Error("Operation start does not bind the journal header")
  }
  if (!isDeepStrictEqual(journal.record.deletionOrder, APPROVED_DUPLICATE_IDS)) {
    throw new Error("Journal target order is not approved")
  }
  if (journal.record.updatedAt !== events.at(-1).event.recordedAt) {
    throw new Error("Journal update timestamp does not bind its final event")
  }

  const state = {
    phase: "operation-started",
    controllerSha: started.payload.controllerSha,
    deletionOrder: journal.record.deletionOrder,
    completedTargets: [],
    currentTargetReleaseId: journal.record.deletionOrder[0],
    attemptNumber: 1,
    lastOutcomeClassification: null,
    lastAuthority: null,
    lastAuthorityEventSha256: null,
    lastRetryEvidence: null,
    lastRetryNpmInventory: null,
    pendingRetryFromAttempt: null,
    orphanAuthorityRecoveries: 0,
  }
  assertEventTemporalOrder(started)
  let previousTimestamp = started.recordedAt
  for (let index = 1; index < events.length; index += 1) {
    const envelope = events[index]
    const event = envelope.event
    if (Date.parse(event.recordedAt) < Date.parse(previousTimestamp)) {
      throw new Error("Journal event timestamps are not monotone")
    }
    previousTimestamp = event.recordedAt
    assertEventTemporalOrder(event)
    applyEvent(state, event, envelope.eventSha256)
  }
  return state
}

function assertEventTemporalOrder(event) {
  const eventTime = event.recordedAt
  if (event.type === "npm-observed") {
    assertNpmTemporalOrder(event.payload.inventory, eventTime)
    return
  }
  if (event.type === "delete-authority-observed" || event.type === "final-authority-observed") {
    assertAuthorityEventTemporalOrder(event.payload.authority, eventTime)
    return
  }
  if (event.type === "delete-outcome" || event.type === "resume-reconciliation") {
    assertNotAfter(event.payload.observedAt, eventTime, `${event.type} observation`)
    if (event.payload.releaseEvidence !== null && event.payload.releaseEvidence !== undefined) {
      assertReleaseEvidenceTemporalOrder(event.payload.releaseEvidence, event.payload.observedAt)
    }
    return
  }
  if (event.type === "absence-converged") {
    assertOrderedTimestamps(
      [
        event.payload.directGet404At,
        event.payload.listAbsentAt,
        event.payload.completedAt,
        eventTime,
      ],
      "absence convergence",
    )
  }
}

function assertAuthorityEventTemporalOrder(authority, eventTime) {
  assertNotAfter(authority.observedAt, eventTime, "authority observation")
  assertNotAfter(
    authority.annotatedTag.observedAt,
    authority.observedAt,
    "annotated tag observation",
  )
  assertNotAfter(
    authority.workflowAuthority.observedAt,
    authority.observedAt,
    "workflow observation",
  )
  assertNpmTemporalOrder(authority.npmInventory, authority.observedAt)
  for (const release of authority.releases) {
    assertReleaseEvidenceTemporalOrder(release, authority.observedAt)
  }
  if (authority.targetRead !== null) {
    assertOrderedTimestamps(
      [
        authority.npmInventory.completedAt,
        authority.targetRead.releaseGetStartedAt,
        authority.targetRead.releaseGetCompletedAt,
        authority.targetRead.assetsListStartedAt,
        authority.targetRead.assetsListCompletedAt,
        authority.observedAt,
      ],
      "authority target read",
    )
  }
}

function assertNpmTemporalOrder(inventory, upperBound) {
  assertNotAfter(inventory.startedAt, inventory.completedAt, "npm inventory interval")
  for (const entry of inventory.packages) {
    assertOrderedTimestamps(
      [inventory.startedAt, entry.observedAt, inventory.completedAt],
      "npm package observation",
    )
  }
  assertNotAfter(inventory.completedAt, upperBound, "npm inventory completion")
}

function assertReleaseEvidenceTemporalOrder(release, upperBound) {
  assertOrderedTimestamps([release.createdAt, release.updatedAt, upperBound], "Release evidence")
  for (const asset of release.assets) {
    assertOrderedTimestamps(
      [asset.createdAt, asset.updatedAt, upperBound],
      "Release asset evidence",
    )
  }
}

function assertNotAfter(earlier, later, label) {
  assertOrderedTimestamps([earlier, later], label)
}

function assertOrderedTimestamps(timestamps, label) {
  const values = timestamps.map((timestamp) => Date.parse(timestamp))
  if (
    values.some((value) => !Number.isFinite(value)) ||
    values.some((value, index) => index > 0 && value < values[index - 1])
  ) {
    throw new Error(`${label} timestamps are contradictory`)
  }
}

function applyEvent(state, event, eventSha256) {
  if (state.phase === "final-authority-observed") {
    throw new Error("Final authority must be the journal's terminal event")
  }
  if (event.type === "npm-observed") {
    const preparingRetry =
      state.phase === "delete-intent" ||
      (state.phase === "delete-outcome" &&
        isAmbiguousOutcomeClassification(state.lastOutcomeClassification))
    const expectedAttempt =
      state.phase === "resume-present" || preparingRetry
        ? state.attemptNumber + 1
        : state.attemptNumber
    assertCurrentTarget(state, event.payload, "npm observation")
    if (event.payload.attemptNumber !== expectedAttempt) {
      throw new Error("npm observation is not for the next legal attempt")
    }
    if (expectedAttempt > MAXIMUM_DELETE_ATTEMPTS) {
      throw new Error("Delete attempts are exhausted at the reviewed maximum")
    }
    if (
      ![
        "operation-started",
        "target-converged",
        "resume-present",
        "delete-intent",
        "delete-outcome",
      ].includes(state.phase) ||
      (state.phase === "delete-outcome" &&
        !isAmbiguousOutcomeClassification(state.lastOutcomeClassification))
    ) {
      throw new Error("npm observation is not legal in the current journal state")
    }
    if (event.payload.inventory.stage !== "perform-initial") {
      throw new Error("Journal npm events must record perform-initial inventory")
    }
    state.phase = "npm-observed"
    state.lastRetryNpmInventory = event.payload.inventory
    state.pendingRetryFromAttempt = preparingRetry ? state.attemptNumber : null
    if (!preparingRetry) state.attemptNumber = expectedAttempt
    return
  }
  if (event.type === "delete-authority-observed") {
    const supersedingOrphan = state.phase === "delete-authority-observed"
    const expectedAttempt =
      state.phase === "resume-present" ? state.attemptNumber + 1 : state.attemptNumber
    assertCurrentTarget(state, event.payload, "delete authority")
    if (event.payload.attemptNumber !== expectedAttempt) {
      throw new Error("Delete authority attempt is not the next legal attempt")
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
      throw new Error("Delete authority is not legal in the current state")
    }
    if (state.phase === "npm-observed" && state.pendingRetryFromAttempt !== null) {
      throw new Error("Stale retry npm evidence requires reconciliation before authority")
    }
    if (expectedAttempt > MAXIMUM_DELETE_ATTEMPTS) {
      throw new Error("Delete attempts are exhausted at the reviewed maximum")
    }
    const orphanAuthorityRecoveries = supersedingOrphan
      ? state.orphanAuthorityRecoveries + 1
      : state.orphanAuthorityRecoveries
    if (orphanAuthorityRecoveries > MAXIMUM_ORPHAN_AUTHORITY_RECOVERIES) {
      throw new Error("Orphan delete authority recoveries exceed their global bound")
    }
    const targetIndex = state.deletionOrder.indexOf(state.currentTargetReleaseId)
    const expectedStage = targetIndex === 0 ? "pre-delete-1" : "pre-delete-2"
    if (event.payload.authority.stage !== expectedStage) {
      throw new Error("Delete authority stage differs from fixed target order")
    }
    if (supersedingOrphan) {
      assertOrphanAuthorityMatches(event.payload.authority, state.lastAuthority)
    }
    if (
      event.payload.authority.controller.headSha !== state.controllerSha ||
      event.payload.authority.controller.originMainSha !== state.controllerSha ||
      event.payload.authority.controller.githubMainSha !== state.controllerSha
    ) {
      throw new Error("Controller main SHA drifted from operation-started")
    }
    if (state.lastRetryEvidence !== null) {
      assertEvidenceEqualsProposal(
        event.payload.authority.targetRead.evidence,
        state.lastRetryEvidence,
      )
    }
    if (
      state.lastRetryNpmInventory !== null &&
      Date.parse(event.payload.authority.npmInventory.startedAt) -
        Date.parse(state.lastRetryNpmInventory.completedAt) <
        RETRY_OBSERVATION_GAP_MS
    ) {
      throw new Error("Retry authority began before the sixty-second npm observation gap")
    }
    state.phase = "delete-authority-observed"
    state.attemptNumber = expectedAttempt
    state.lastOutcomeClassification = null
    state.lastAuthority = event.payload.authority
    state.lastAuthorityEventSha256 = eventSha256
    state.lastRetryEvidence = null
    state.lastRetryNpmInventory = null
    state.pendingRetryFromAttempt = null
    state.orphanAuthorityRecoveries = orphanAuthorityRecoveries
    return
  }
  if (event.type === "delete-intent") {
    assertCurrentAttempt(state, event.payload, "delete intent")
    if (
      state.phase !== "delete-authority-observed" ||
      event.payload.authorityEventSha256 !== state.lastAuthorityEventSha256
    ) {
      throw new Error("Delete intent must immediately bind the preceding authority digest")
    }
    state.phase = "delete-intent"
    return
  }
  if (event.type === "delete-outcome") {
    assertCurrentAttempt(state, event.payload, "delete outcome")
    if (state.phase !== "delete-intent") {
      throw new Error("Delete outcome requires a durable preceding intent")
    }
    state.phase = "delete-outcome"
    state.lastOutcomeClassification = event.payload.classification
    return
  }
  if (event.type === "resume-reconciliation") {
    const preparedByStaleNpm =
      state.phase === "npm-observed" && state.pendingRetryFromAttempt !== null
    if (preparedByStaleNpm) {
      assertCurrentTarget(state, event.payload, "resume reconciliation")
      if (event.payload.attemptNumber !== state.pendingRetryFromAttempt) {
        throw new Error("Retry reconciliation does not bind the stale npm source attempt")
      }
    } else {
      assertCurrentAttempt(state, event.payload, "resume reconciliation")
    }
    if (
      state.phase !== "delete-intent" &&
      !preparedByStaleNpm &&
      !(
        state.phase === "delete-outcome" &&
        isAmbiguousOutcomeClassification(state.lastOutcomeClassification)
      )
    ) {
      throw new Error("Resume reconciliation is not legal after this outcome")
    }
    if (
      event.payload.classification === "present-unchanged-retryable" &&
      state.lastAuthority?.targetRead?.evidence === undefined
    ) {
      throw new Error("Retryable target evidence has no preceding delete authority")
    }
    if (event.payload.classification === "present-unchanged-retryable") {
      assertEvidenceEqualsProposal(
        event.payload.releaseEvidence,
        state.lastAuthority.targetRead.evidence,
      )
      state.lastRetryEvidence = event.payload.releaseEvidence
    } else {
      state.lastRetryEvidence = null
    }
    state.phase =
      event.payload.classification === "present-unchanged-retryable"
        ? "resume-present"
        : "resume-absent"
    state.attemptNumber = event.payload.attemptNumber
    state.pendingRetryFromAttempt = null
    return
  }
  if (event.type === "absence-converged") {
    assertCurrentAttempt(state, event.payload, "absence convergence")
    const confirmed =
      state.phase === "delete-outcome" &&
      state.lastOutcomeClassification === "confirmed-204" &&
      event.payload.basis === "confirmed-204"
    const ambiguous =
      event.payload.basis === "ambiguous" &&
      (state.phase === "resume-absent" ||
        (state.phase === "delete-outcome" &&
          isAmbiguousOutcomeClassification(state.lastOutcomeClassification)))
    if (!confirmed && !ambiguous) {
      throw new Error("Absence convergence basis does not match delete history")
    }
    state.completedTargets.push(state.currentTargetReleaseId)
    state.currentTargetReleaseId = state.deletionOrder[state.completedTargets.length] ?? null
    state.attemptNumber = 1
    state.lastOutcomeClassification = null
    state.lastAuthority = null
    state.lastAuthorityEventSha256 = null
    state.lastRetryEvidence = null
    state.lastRetryNpmInventory = null
    state.pendingRetryFromAttempt = null
    state.phase = "target-converged"
    return
  }
  if (event.type === "final-authority-observed") {
    if (
      state.phase !== "target-converged" ||
      state.completedTargets.length !== state.deletionOrder.length ||
      state.currentTargetReleaseId !== null
    ) {
      throw new Error("Final authority requires both targets converged absent")
    }
    if (
      event.payload.authority.controller.headSha !== state.controllerSha ||
      event.payload.authority.controller.originMainSha !== state.controllerSha ||
      event.payload.authority.controller.githubMainSha !== state.controllerSha
    ) {
      throw new Error("Final authority controller drifted from operation-started")
    }
    state.phase = "final-authority-observed"
    state.lastAuthority = event.payload.authority
    return
  }
  throw new Error(`Illegal journal event ${event.type}`)
}

function assertOrphanAuthorityMatches(actual, previous) {
  if (
    previous === null ||
    actual.stage !== previous.stage ||
    !isDeepStrictEqual(actual.controller, previous.controller) ||
    !isDeepStrictEqual(
      withoutObservedAt(actual.annotatedTag),
      withoutObservedAt(previous.annotatedTag),
    ) ||
    !isDeepStrictEqual(
      withoutObservedAt(actual.workflowAuthority),
      withoutObservedAt(previous.workflowAuthority),
    ) ||
    !isDeepStrictEqual(
      stableNpmInventory(actual.npmInventory),
      stableNpmInventory(previous.npmInventory),
    ) ||
    !isDeepStrictEqual(actual.payloadProof, previous.payloadProof) ||
    actual.releases.length !== previous.releases.length ||
    !isDeepStrictEqual(
      actual.releases.map(({ id }) => id),
      previous.releases.map(({ id }) => id),
    )
  ) {
    throw new Error("Orphan authority recovery drifted from prior authority")
  }
  for (let index = 0; index < actual.releases.length; index += 1) {
    assertEvidenceEqualsProposal(actual.releases[index], previous.releases[index])
  }
  assertEvidenceEqualsProposal(actual.targetRead.evidence, previous.targetRead.evidence)
}

function withoutObservedAt({ observedAt: _observedAt, ...value }) {
  return value
}

function stableNpmInventory({ startedAt: _startedAt, completedAt: _completedAt, ...inventory }) {
  return {
    ...inventory,
    packages: inventory.packages.map(({ observedAt: _observedAt, ...entry }) => entry),
  }
}

function assertFinalAuthorityMatchesProposal(authority, proposal) {
  if (
    authority.stage !== "final" ||
    !isDeepStrictEqual(authority.controller, proposal.controller)
  ) {
    throw new Error("Final authority controller differs from the proposal")
  }
  const stableTag = ({ observedAt: _observedAt, ...value }) => value
  const stableWorkflow = ({ observedAt: _observedAt, ...value }) => value
  if (
    !isDeepStrictEqual(stableTag(authority.annotatedTag), stableTag(proposal.annotatedTag)) ||
    !isDeepStrictEqual(
      stableWorkflow(authority.workflowAuthority),
      stableWorkflow(proposal.workflowAuthority),
    )
  ) {
    throw new Error("Final authority tag or workflow differs from the proposal")
  }
  if (
    authority.releases.length !== 1 ||
    authority.releases[0].id !== proposal.roles.survivor ||
    proposal.roles.duplicates.some((id) => authority.releases.some((release) => release.id === id))
  ) {
    throw new Error("Final authority does not contain only the survivor")
  }
  const proposedSurvivor = proposal.releases.find(({ id }) => id === proposal.roles.survivor)
  if (proposedSurvivor === undefined) {
    throw new Error("Proposal survivor evidence is missing")
  }
  assertEvidenceEqualsProposal(authority.releases[0], proposedSurvivor)
  if (!isDeepStrictEqual(authority.payloadProof, proposal.payloadProof)) {
    throw new Error("Final authority payload proof differs from the proposal")
  }
  if (
    authority.npmInventory.stage !== "final" ||
    authority.npmInventory.packages.some((entry) => entry.version !== proposal.candidate.version)
  ) {
    throw new Error("Final authority npm evidence differs from the candidate")
  }
}

function assertCurrentAttempt(state, payload, label) {
  assertCurrentTarget(state, payload, label)
  if (payload.attemptNumber !== state.attemptNumber) {
    throw new Error(`${label} does not match the current delete attempt`)
  }
}

function assertCurrentTarget(state, payload, label) {
  if (
    state.currentTargetReleaseId === null ||
    payload.targetReleaseId !== state.currentTargetReleaseId
  ) {
    throw new Error(`${label} violates the fixed target convergence order`)
  }
}

function normalizeEnvelope(kind, value) {
  if (value instanceof Uint8Array) {
    return parseConsolidationEnvelope(kind, Buffer.from(value))
  }
  return parseConsolidationEnvelope(kind, canonicalConsolidationEnvelopeBytes(kind, value))
}

function freezeEnvelope(value) {
  return deepFreeze(value)
}

function exactInput(value, expectedKeys, label) {
  if (!isPlainObject(value) || utilTypes.isProxy(value)) {
    throw new TypeError(`${label} must be a plain non-proxy object`)
  }
  const descriptors = Object.getOwnPropertyDescriptors(value)
  const keys = Object.keys(descriptors)
  if (
    Object.getOwnPropertySymbols(value).length !== 0 ||
    keys.length !== expectedKeys.length ||
    keys.some((key) => !expectedKeys.includes(key)) ||
    keys.some((key) => {
      const descriptor = descriptors[key]
      return !descriptor.enumerable || !("value" in descriptor)
    })
  ) {
    throw new TypeError(`${label} fields are invalid`)
  }
  return value
}

function dataValue(value, name, label) {
  const descriptor = Object.getOwnPropertyDescriptor(value, name)
  if (descriptor === undefined || !descriptor.enumerable || !("value" in descriptor)) {
    throw new TypeError(`${label} must be an enumerable data property`)
  }
  return descriptor.value
}

function dataString(value, name, label) {
  const result = dataValue(value, name, label)
  if (typeof result !== "string") throw new TypeError(`${label} must be a string`)
  return result
}

function canonicalSha256(value, label) {
  if (typeof value !== "string" || !SHA256_PATTERN.test(value)) {
    throw new TypeError(`${label} must be a canonical SHA-256 digest`)
  }
  return value
}

function canonicalTimestamp(value, label) {
  if (
    typeof value !== "string" ||
    !TIMESTAMP_PATTERN.test(value) ||
    !Number.isFinite(Date.parse(value)) ||
    new Date(Date.parse(value)).toISOString() !== value
  ) {
    throw new TypeError(`${label} must be a canonical UTC timestamp`)
  }
  return value
}

function snapshotPlain(value, label) {
  if (utilTypes.isProxy(value)) throw new TypeError(`${label} must not be a proxy`)
  if (Array.isArray(value)) {
    if (
      Object.getPrototypeOf(value) !== Array.prototype ||
      Object.keys(value).length !== value.length
    ) {
      throw new TypeError(`${label} must be a dense array`)
    }
    return value.map((entry, index) => snapshotPlain(entry, `${label}[${index}]`))
  }
  if (value !== null && typeof value === "object") {
    if (!isPlainObject(value)) throw new TypeError(`${label} must be plain data`)
    const result = {}
    for (const [key, descriptor] of Object.entries(Object.getOwnPropertyDescriptors(value))) {
      if (!descriptor.enumerable || !("value" in descriptor)) {
        throw new TypeError(`${label} contains a hidden or accessor field`)
      }
      result[key] = snapshotPlain(descriptor.value, `${label}.${key}`)
    }
    return result
  }
  if (["bigint", "function", "symbol", "undefined"].includes(typeof value)) {
    throw new TypeError(`${label} contains a non-JSON value`)
  }
  return value
}

function isPlainObject(value) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return false
  }
  const prototype = Object.getPrototypeOf(value)
  return prototype === Object.prototype || prototype === null
}

function deepFreeze(value) {
  if (value !== null && typeof value === "object" && !Object.isFrozen(value)) {
    for (const child of Object.values(value)) deepFreeze(child)
    Object.freeze(value)
  }
  return value
}
