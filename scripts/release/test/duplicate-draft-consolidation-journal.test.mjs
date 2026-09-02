import assert from "node:assert/strict"
import { createHash } from "node:crypto"
import test from "node:test"

import { inspectEquivalentDrafts } from "../duplicate-draft-consolidation-evidence.mjs"
import {
  appendJournalEvent,
  createConsolidationJournal,
  createFinalConsolidationReceipt,
  deriveConsolidationState,
  nextResumeAction,
  parseConsolidationJournal,
} from "../duplicate-draft-consolidation-journal.mjs"
import {
  canonicalConsolidationEnvelopeBytes,
  canonicalEventEnvelope,
  canonicalRecordSha256,
  createConsolidationEnvelope,
  DUPLICATE_DRAFT_CONSOLIDATION_LIMITS,
} from "../duplicate-draft-consolidation-schema.mjs"
import { CANONICAL_RELEASE_PACKAGE_ORDER } from "../manifest.mjs"
import {
  createDuplicateDraftConsolidationFixture,
  DUPLICATE_DRAFT_CANDIDATE,
  DUPLICATE_DRAFT_IDS,
  DUPLICATE_DRAFT_SURVIVOR_ID,
} from "./support/duplicate-draft-consolidation-fixture.mjs"

const CONTROLLER_SHA = DUPLICATE_DRAFT_CANDIDATE.commitSha
const REPOSITORY_ID = "1210070282"
const ACTOR = Object.freeze({ login: "blove", id: "61436" })
const TAG_OBJECT_SHA = "a".repeat(40)
const WORKFLOW_ID = "202458345"
const BASE_TIME = Date.parse("2026-09-01T12:00:00.000Z")
let confirmationSha256

let fixture

test.before(async () => {
  fixture = await journalFixture()
  confirmationSha256 = createHash("sha256")
    .update(exactConfirmation(fixture.proposedEnvelope), "utf8")
    .digest("hex")
})

test("journal fixture hashes the exact v-prefixed incident confirmation", () => {
  const { candidate, roles } = fixture.proposedEnvelope.record
  assert.equal(
    exactConfirmation(fixture.proposedEnvelope),
    `CONSOLIDATE v${candidate.version} ${candidate.commitSha} SURVIVOR ${roles.survivor} DELETE ${roles.duplicates.join(",")} PROPOSAL ${fixture.proposedEnvelope.recordSha256}`,
  )
})

test("creates and strictly parses an immutable canonical operation journal", () => {
  const journal = newJournal()
  const parsed = parseConsolidationJournal(journal)

  assert.notEqual(parsed, journal)
  assert.deepEqual(parsed, journal)
  assert.equal(parsed.record.events.length, 1)
  assert.equal(parsed.record.events[0].event.type, "operation-started")
  assert.equal(parsed.record.events[0].event.sequence, 1)
  assert.equal(parsed.record.events[0].event.previousEventSha256, null)
  assert.equal(Object.isFrozen(parsed), true)
  assert.equal(Object.isFrozen(parsed.record.events), true)
  assert.equal(deriveConsolidationState(parsed).phase, "operation-started")
})

test("rejects event hash mutation, sequence gaps, reordering, and raw truncation", () => {
  const authority = preDeleteAuthority(0)
  const started = newJournal()
  const withAuthority = appendAuthority(started, 0, 1, authority, 1)
  const withIntent = appendIntent(withAuthority, 0, 1, 2)

  for (const mutate of [
    (value) => {
      value.record.events[1].event.payload.attemptNumber = 2
    },
    (value) => {
      value.record.events[1].event.sequence = 7
    },
    (value) => {
      ;[value.record.events[1], value.record.events[2]] = [
        value.record.events[2],
        value.record.events[1],
      ]
    },
    (value) => {
      value.record.events.pop()
    },
  ]) {
    const changed = structuredClone(withIntent)
    mutate(changed)
    assert.throws(
      () => parseConsolidationJournal(changed),
      /digest|sequence|previous|canonical|bind/iu,
    )
  }
})

test("replays every event type through the fixed two-target confirmed-204 sequence", () => {
  let journal = newJournal()
  journal = appendNpm(journal, 0, 1, "perform-initial", 1)
  journal = appendAuthority(journal, 0, 1, preDeleteAuthority(0, 61), 61)
  journal = appendIntent(journal, 0, 1, 62)
  journal = appendOutcome(journal, 0, 1, "confirmed-204", 204, 63)
  journal = appendAbsence(journal, 0, 1, "confirmed-204", 64)
  journal = appendAuthority(journal, 1, 1, preDeleteAuthority(1, 65), 65)
  journal = appendIntent(journal, 1, 1, 66)
  journal = appendOutcome(journal, 1, 1, "confirmed-204", 204, 67)
  journal = appendAbsence(journal, 1, 1, "confirmed-204", 68)
  journal = appendJournalEvent(
    journal,
    "final-authority-observed",
    { authority: finalAuthority() },
    at(69),
  )

  const state = deriveConsolidationState(journal)
  assert.deepEqual(state.completedTargets, [...DUPLICATE_DRAFT_IDS])
  assert.equal(state.currentTargetReleaseId, null)
  assert.equal(state.phase, "final-authority-observed")
  assert.equal(nextResumeAction(state, { classification: "absent" }), "complete")
})

test("rejects second-target events before first-target absence convergence", () => {
  assert.throws(
    () => appendAuthority(newJournal(), 1, 1, preDeleteAuthority(1), 1),
    /order|target|preceding|converge/iu,
  )
})

test("requires an authority event and its exact digest immediately before intent", () => {
  assert.throws(
    () =>
      appendJournalEvent(
        newJournal(),
        "delete-intent",
        {
          targetReleaseId: DUPLICATE_DRAFT_IDS[0],
          attemptNumber: 1,
          authorityEventSha256: "d".repeat(64),
        },
        at(1),
      ),
    /authority|intent|preced/iu,
  )
  const authorityJournal = appendAuthority(newJournal(), 0, 1, preDeleteAuthority(0), 1)
  assert.throws(
    () =>
      appendJournalEvent(
        authorityJournal,
        "delete-intent",
        {
          targetReleaseId: DUPLICATE_DRAFT_IDS[0],
          attemptNumber: 1,
          authorityEventSha256: "d".repeat(64),
        },
        at(2),
      ),
    /digest|authority|intent|bind/iu,
  )
})

test("admits exactly one orphan authority recovery globally and rejects a second before append", () => {
  let journal = newJournal()
  const authority = preDeleteAuthority(0)
  journal = appendAuthority(journal, 0, 1, authority, 1)
  const firstDigest = journal.record.events.at(-1).eventSha256
  journal = appendAuthority(journal, 0, 1, authority, 2)
  const newestDigest = journal.record.events.at(-1).eventSha256
  assert.notEqual(newestDigest, firstDigest)
  assert.equal(deriveConsolidationState(journal).phase, "delete-authority-observed")
  const driftedOrphan = preDeleteAuthority(0)
  driftedOrphan.targetRead.evidence.assets[0].label = "included drift"
  driftedOrphan.targetRead.evidenceSha256 = canonicalRecordSha256(driftedOrphan.targetRead.evidence)
  driftedOrphan.releases[1] = structuredClone(driftedOrphan.targetRead.evidence)
  assert.throws(
    () =>
      appendAuthority(appendAuthority(newJournal(), 0, 1, authority, 1), 0, 1, driftedOrphan, 2),
    /proposal|authority|evidence|asset|drift/iu,
  )

  assert.throws(() => appendAuthority(journal, 0, 1, authority, 3), /orphan|authority|bound/iu)
  assert.equal(journal.record.events.length, 3)
  assert.equal(journal.record.events.at(-1).eventSha256, newestDigest)
  journal = appendIntent(journal, 0, 1, 3)
  assert.equal(journal.record.events.at(-1).event.payload.authorityEventSha256, newestDigest)
  assert.throws(
    () => appendAuthority(journal, 0, 1, authority, 4),
    /authority|intent|legal|state/iu,
  )
})

test("the maximum eight-stage authority history serializes within the 72 MiB journal admission bound", () => {
  let journal = newJournal()
  let second = 1
  for (let targetIndex = 0; targetIndex < 2; targetIndex += 1) {
    for (let attemptNumber = 1; attemptNumber <= 3; attemptNumber += 1) {
      const authority = maximumSizedAuthority(preDeleteAuthority(targetIndex))
      journal = appendAuthority(journal, targetIndex, attemptNumber, authority, second++)
      if (targetIndex === 0 && attemptNumber === 1) {
        journal = appendAuthority(
          journal,
          targetIndex,
          attemptNumber,
          maximumSizedAuthority(preDeleteAuthority(targetIndex)),
          second++,
        )
      }
      if (targetIndex === 1 && attemptNumber === 1) {
        const beforeRejectedRecovery = journal
        assert.throws(
          () =>
            appendAuthority(
              journal,
              targetIndex,
              attemptNumber,
              maximumSizedAuthority(preDeleteAuthority(targetIndex)),
              second,
            ),
          /orphan|authority|bound/iu,
        )
        assert.equal(journal, beforeRejectedRecovery)
      }
      journal = appendIntent(journal, targetIndex, attemptNumber, second++)
      if (attemptNumber < 3) {
        journal = appendOutcome(
          journal,
          targetIndex,
          attemptNumber,
          "transport-ambiguous",
          null,
          second++,
        )
        journal = appendReconciliation(
          journal,
          targetIndex,
          attemptNumber,
          "present-unchanged-retryable",
          targetEvidence(authority),
          second++,
        )
      } else {
        journal = appendOutcome(journal, targetIndex, attemptNumber, "confirmed-204", 204, second++)
        journal = appendAbsence(journal, targetIndex, attemptNumber, "confirmed-204", second++)
      }
    }
  }
  journal = appendJournalEvent(
    journal,
    "final-authority-observed",
    { authority: maximumSizedAuthority(finalAuthority()) },
    at(second),
  )
  const bytes = canonicalConsolidationEnvelopeBytes("journal", journal)
  assert.ok(bytes.byteLength <= DUPLICATE_DRAFT_CONSOLIDATION_LIMITS.journalBytes)
  assert.equal(
    journal.record.events.filter(({ event }) =>
      ["delete-authority-observed", "final-authority-observed"].includes(event.type),
    ).length,
    8,
  )
})

for (const [classification, httpStatus] of [
  ["transport-ambiguous", null],
  ["response-404-ambiguous", 404],
]) {
  test(`${classification} may converge absent without erasing its ambiguity`, () => {
    let journal = appendIntent(
      appendAuthority(newJournal(), 0, 1, preDeleteAuthority(0), 1),
      0,
      1,
      2,
    )
    journal = appendOutcome(journal, 0, 1, classification, httpStatus, 3)
    assert.equal(
      nextResumeAction(deriveConsolidationState(journal), {
        classification: "absent",
        directGet404At: at(4),
        listAbsentAt: at(4),
        attempts: 2,
      }),
      "reconcile-absence",
    )
    journal = appendAbsence(journal, 0, 1, "ambiguous", 4)
    assert.equal(deriveConsolidationState(journal).phase, "target-converged")
  })
}

test("response-hard-failure is terminal even when the target remains unchanged", () => {
  let journal = appendIntent(appendAuthority(newJournal(), 0, 1, preDeleteAuthority(0), 1), 0, 1, 2)
  journal = appendOutcome(journal, 0, 1, "response-hard-failure", 500, 3)
  assert.equal(
    nextResumeAction(deriveConsolidationState(journal), {
      classification: "present-unchanged",
      releaseEvidence: targetEvidence(preDeleteAuthority(0)),
      observations: 6,
    }),
    "stop",
  )
})

test("an intent with no outcome and unchanged target requires reconciliation then a fresh attempt", () => {
  const authority = preDeleteAuthority(0)
  let journal = appendIntent(appendAuthority(newJournal(), 0, 1, authority, 1), 0, 1, 2)
  let state = deriveConsolidationState(journal)
  assert.equal(
    nextResumeAction(state, {
      classification: "present-unchanged",
      releaseEvidence: targetEvidence(authority),
      observations: 1,
    }),
    "refresh-and-retry",
  )
  const freshEvidence = volatileEvidence(targetEvidence(authority), "retry")
  journal = appendReconciliation(journal, 0, 1, "present-unchanged-retryable", freshEvidence, 3)
  journal = appendAuthority(journal, 0, 2, preDeleteAuthority(0), 4)
  journal = appendIntent(journal, 0, 2, 5)
  state = deriveConsolidationState(journal)
  assert.equal(state.attemptNumber, 2)
  assert.equal(state.phase, "delete-intent")
})

test("retry evidence accepts service volatility but the next authority rejects included asset drift", () => {
  const authority = preDeleteAuthority(0)
  let journal = appendIntent(appendAuthority(newJournal(), 0, 1, authority, 1), 0, 1, 2)
  journal = appendReconciliation(
    journal,
    0,
    1,
    "present-unchanged-retryable",
    volatileEvidence(targetEvidence(authority), "observed"),
    3,
  )
  const drifted = preDeleteAuthority(0)
  drifted.targetRead.evidence.assets[0].label = "changed included label"
  drifted.targetRead.evidenceSha256 = canonicalRecordSha256(drifted.targetRead.evidence)
  drifted.releases[1] = structuredClone(drifted.targetRead.evidence)
  assert.throws(() => appendAuthority(journal, 0, 2, drifted, 4), /asset|evidence|proposal|equal/iu)
})

test("a retry perform-initial observation advances and binds the next attempt", () => {
  const authority = preDeleteAuthority(0)
  let journal = appendAuthority(newJournal(), 0, 1, authority, 1)
  journal = appendIntent(journal, 0, 1, 2)
  journal = appendReconciliation(
    journal,
    0,
    1,
    "present-unchanged-retryable",
    targetEvidence(authority),
    3,
  )
  journal = appendNpm(journal, 0, 2, "perform-initial", 4)
  assert.equal(deriveConsolidationState(journal).attemptNumber, 2)
  assert.throws(
    () => appendAuthority(journal, 0, 2, preDeleteAuthority(0, 63), 63),
    /sixty-second|observation gap/iu,
  )
  journal = appendAuthority(journal, 0, 2, preDeleteAuthority(0, 64), 64)
  journal = appendIntent(journal, 0, 2, 65)
  assert.equal(deriveConsolidationState(journal).attemptNumber, 2)
  const pendingRetry = appendNpm(journal, 0, 3, "perform-initial", 66)
  const pendingState = deriveConsolidationState(pendingRetry)
  assert.equal(pendingState.phase, "npm-observed")
  assert.equal(pendingState.attemptNumber, 2)
  assert.equal(pendingState.pendingRetryFromAttempt, 2)
  assert.throws(
    () => appendAuthority(pendingRetry, 0, 3, preDeleteAuthority(0, 126), 126),
    /reconciliation|authority|state/iu,
  )
})

test("recorded ambiguity requires six unchanged reads before retry, or reconciles absence", () => {
  const authority = preDeleteAuthority(0)
  let journal = appendOutcome(
    appendIntent(appendAuthority(newJournal(), 0, 1, authority, 1), 0, 1, 2),
    0,
    1,
    "transport-ambiguous",
    null,
    3,
  )
  const state = deriveConsolidationState(journal)
  assert.equal(
    nextResumeAction(state, {
      classification: "present-unchanged",
      releaseEvidence: targetEvidence(authority),
      observations: 5,
    }),
    "stop",
  )
  assert.equal(
    nextResumeAction(state, {
      classification: "present-unchanged",
      releaseEvidence: targetEvidence(authority),
      observations: 6,
    }),
    "refresh-and-retry",
  )
  journal = appendReconciliation(journal, 0, 1, "absent-ambiguous", null, 4)
  journal = appendAbsence(journal, 0, 1, "ambiguous", 5)
  assert.equal(deriveConsolidationState(journal).phase, "target-converged")
})

test("changed, published, and malformed targets always stop", () => {
  const authority = preDeleteAuthority(0)
  const journal = appendIntent(appendAuthority(newJournal(), 0, 1, authority, 1), 0, 1, 2)
  const state = deriveConsolidationState(journal)
  for (const classification of ["changed", "published", "malformed"]) {
    assert.equal(nextResumeAction(state, { classification }), "stop")
  }
})

test("a target present after confirmed 204 stops instead of retrying", () => {
  const authority = preDeleteAuthority(0)
  const journal = appendOutcome(
    appendIntent(appendAuthority(newJournal(), 0, 1, authority, 1), 0, 1, 2),
    0,
    1,
    "confirmed-204",
    204,
    3,
  )
  assert.equal(
    nextResumeAction(deriveConsolidationState(journal), {
      classification: "present-unchanged",
      releaseEvidence: targetEvidence(authority),
      observations: 6,
    }),
    "stop",
  )
})

test("caps one target at three intents", () => {
  let journal = newJournal()
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    const authority = preDeleteAuthority(0)
    journal = appendAuthority(journal, 0, attempt, authority, attempt * 4 - 3)
    journal = appendIntent(journal, 0, attempt, attempt * 4 - 2)
    journal = appendOutcome(journal, 0, attempt, "transport-ambiguous", null, attempt * 4 - 1)
    journal = appendReconciliation(
      journal,
      0,
      attempt,
      "present-unchanged-retryable",
      targetEvidence(authority),
      attempt * 4,
    )
  }
  assert.equal(
    nextResumeAction(deriveConsolidationState(journal), {
      classification: "present-unchanged",
      releaseEvidence: targetEvidence(preDeleteAuthority(0)),
      observations: 6,
    }),
    "stop",
  )
  assert.throws(
    () => appendAuthority(journal, 0, 4, preDeleteAuthority(0), 13),
    /attempt|maximum|three|exhaust/iu,
  )
})

test("rejects main drift from the operation-started controller SHA", () => {
  const authority = structuredClone(preDeleteAuthority(0))
  const drifted = "f".repeat(40)
  authority.controller = {
    headSha: drifted,
    originMainSha: drifted,
    githubMainSha: drifted,
  }
  assert.throws(
    () => appendAuthority(newJournal(), 0, 1, authority, 1),
    /controller|main|drift|operation/iu,
  )
})

test("allows final authority only after both targets converge absent", () => {
  assert.throws(
    () =>
      appendJournalEvent(
        newJournal(),
        "final-authority-observed",
        { authority: finalAuthority() },
        at(1),
      ),
    /both|target|converge|final/iu,
  )
})

test("creates a final receipt only from a completed two-target journal", () => {
  let journal = newJournal()
  for (let index = 0; index < 2; index += 1) {
    journal = appendAuthority(journal, index, 1, preDeleteAuthority(index), index * 4 + 1)
    journal = appendIntent(journal, index, 1, index * 4 + 2)
    journal = appendOutcome(journal, index, 1, "confirmed-204", 204, index * 4 + 3)
    journal = appendAbsence(journal, index, 1, "confirmed-204", index * 4 + 4)
  }
  const final = finalAuthority()
  journal = appendJournalEvent(journal, "final-authority-observed", { authority: final }, at(9))
  const receipt = createFinalConsolidationReceipt({
    proposedEnvelope: fixture.proposedEnvelope,
    journalEnvelope: journal,
    finalAuthority: final,
    completedAt: at(10),
  })
  assert.equal(receipt.record.journalEnvelope.recordSha256, journal.recordSha256)
  assert.deepEqual(receipt.record.finalSurvivor, final.releases[0])
  for (const mutate of [
    (authority) => {
      authority.annotatedTag.objectSha = "b".repeat(40)
    },
    (authority) => {
      authority.workflowAuthority.state = "active"
    },
    (authority) => {
      authority.releases[0].semantic.name = "changed survivor"
    },
    (authority) => {
      authority.payloadProof.consolidationPayloadSha256 = "f".repeat(64)
    },
  ]) {
    const changed = structuredClone(final)
    mutate(changed)
    assert.throws(() => {
      const changedJournal = replaceFinalAuthority(journal, changed)
      createFinalConsolidationReceipt({
        proposedEnvelope: fixture.proposedEnvelope,
        journalEnvelope: changedJournal,
        finalAuthority: changed,
        completedAt: at(10),
      })
    }, /tag|workflow|survivor|payload|proposal|authority|state/iu)
  }

  const incomplete = appendAuthority(newJournal(), 0, 1, preDeleteAuthority(0), 1)
  assert.throws(
    () =>
      createFinalConsolidationReceipt({
        proposedEnvelope: fixture.proposedEnvelope,
        journalEnvelope: incomplete,
        finalAuthority: final,
        completedAt: at(10),
      }),
    /both|complete|final|converge/iu,
  )
})

function newJournal() {
  return createConsolidationJournal({
    proposedEnvelope: fixture.proposedEnvelope,
    confirmationSha256,
    recordedAt: at(0),
  })
}

function maximumSizedAuthority(value) {
  const authority = structuredClone(value)
  const currentBytes = Buffer.byteLength(`${JSON.stringify(authority)}\n`, "utf8")
  const currentNameBytes = Buffer.byteLength(JSON.stringify(authority.annotatedTag.name), "utf8")
  const replacementBytes =
    DUPLICATE_DRAFT_CONSOLIDATION_LIMITS.authorityStageBytes - currentBytes + currentNameBytes
  authority.annotatedTag.name = "x".repeat(replacementBytes - 2)
  assert.equal(
    Buffer.byteLength(`${JSON.stringify(authority)}\n`, "utf8"),
    DUPLICATE_DRAFT_CONSOLIDATION_LIMITS.authorityStageBytes,
  )
  return authority
}

function exactConfirmation(proposedEnvelope) {
  const { candidate, roles } = proposedEnvelope.record
  return `CONSOLIDATE v${candidate.version} ${candidate.commitSha} SURVIVOR ${roles.survivor} DELETE ${roles.duplicates.join(",")} PROPOSAL ${proposedEnvelope.recordSha256}`
}

function replaceFinalAuthority(journal, authority) {
  const changed = structuredClone(journal)
  changed.record.events.at(-1).event.payload.authority = authority
  changed.record.events = rebuildEventChain(changed.record.events)
  changed.record.updatedAt = changed.record.events.at(-1).event.recordedAt
  return createConsolidationEnvelope("journal", changed.record)
}

function rebuildEventChain(events) {
  let previousEventSha256 = null
  return events.map(({ event }, index) => {
    const envelope = canonicalEventEnvelope(
      {
        ...event,
        sequence: index + 1,
        previousEventSha256,
      },
      previousEventSha256,
    )
    previousEventSha256 = envelope.eventSha256
    return envelope
  })
}

function appendNpm(journal, targetIndex, attemptNumber, stage, second) {
  return appendJournalEvent(
    journal,
    "npm-observed",
    {
      targetReleaseId: DUPLICATE_DRAFT_IDS[targetIndex],
      attemptNumber,
      inventory: npmInventory(stage, second),
    },
    at(second),
  )
}

function appendAuthority(journal, targetIndex, attemptNumber, authority, second) {
  return appendJournalEvent(
    journal,
    "delete-authority-observed",
    {
      targetReleaseId: DUPLICATE_DRAFT_IDS[targetIndex],
      attemptNumber,
      authority,
    },
    at(second),
  )
}

function appendIntent(journal, targetIndex, attemptNumber, second) {
  const authorityEvent = journal.record.events.at(-1)
  return appendJournalEvent(
    journal,
    "delete-intent",
    {
      targetReleaseId: DUPLICATE_DRAFT_IDS[targetIndex],
      attemptNumber,
      authorityEventSha256: authorityEvent.eventSha256,
    },
    at(second),
  )
}

function appendOutcome(journal, targetIndex, attemptNumber, classification, httpStatus, second) {
  return appendJournalEvent(
    journal,
    "delete-outcome",
    {
      targetReleaseId: DUPLICATE_DRAFT_IDS[targetIndex],
      attemptNumber,
      classification,
      httpStatus,
      observedAt: at(second),
    },
    at(second),
  )
}

function appendReconciliation(
  journal,
  targetIndex,
  attemptNumber,
  classification,
  releaseEvidence,
  second,
) {
  return appendJournalEvent(
    journal,
    "resume-reconciliation",
    {
      targetReleaseId: DUPLICATE_DRAFT_IDS[targetIndex],
      attemptNumber,
      classification,
      releaseEvidence,
      observedAt: at(second),
    },
    at(second),
  )
}

function appendAbsence(journal, targetIndex, attemptNumber, basis, second) {
  return appendJournalEvent(
    journal,
    "absence-converged",
    {
      targetReleaseId: DUPLICATE_DRAFT_IDS[targetIndex],
      attemptNumber,
      basis,
      directGet404At: at(second),
      listAbsentAt: at(second),
      attempts: 1,
      completedAt: at(second),
    },
    at(second),
  )
}

function preDeleteAuthority(targetIndex, second = 0) {
  const stage = targetIndex === 0 ? "pre-delete-1" : "pre-delete-2"
  const releases =
    targetIndex === 0
      ? fixture.proposedEnvelope.record.releases
      : [fixture.proposedEnvelope.record.releases[0], fixture.proposedEnvelope.record.releases[2]]
  const target = releases.find(({ id }) => id === DUPLICATE_DRAFT_IDS[targetIndex])
  return {
    stage,
    controller: { ...fixture.proposedEnvelope.record.controller },
    annotatedTag: {
      ...fixture.proposedEnvelope.record.annotatedTag,
      observedAt: at(second),
    },
    workflowAuthority: {
      ...fixture.proposedEnvelope.record.workflowAuthority,
      observedAt: at(second),
    },
    npmInventory: npmInventory(stage, second),
    releases: structuredClone(releases),
    payloadProof: structuredClone(fixture.proposedEnvelope.record.payloadProof),
    targetRead: {
      releaseGetStartedAt: at(second),
      releaseGetCompletedAt: at(second),
      assetsListStartedAt: at(second),
      assetsListCompletedAt: at(second),
      evidence: structuredClone(target),
      evidenceSha256: canonicalRecordSha256(target),
    },
    observedAt: at(second),
  }
}

function finalAuthority() {
  return {
    stage: "final",
    controller: { ...fixture.proposedEnvelope.record.controller },
    annotatedTag: {
      ...fixture.proposedEnvelope.record.annotatedTag,
      observedAt: at(0),
    },
    workflowAuthority: {
      ...fixture.proposedEnvelope.record.workflowAuthority,
      observedAt: at(0),
    },
    npmInventory: npmInventory("final", 0),
    releases: [structuredClone(fixture.proposedEnvelope.record.releases[0])],
    payloadProof: structuredClone(fixture.proposedEnvelope.record.payloadProof),
    targetRead: null,
    observedAt: at(0),
  }
}

function targetEvidence(authority) {
  return structuredClone(authority.targetRead.evidence)
}

function volatileEvidence(value, suffix) {
  const evidence = structuredClone(value)
  evidence.nodeId = `RE_${suffix}`
  evidence.createdAt = at(1)
  evidence.updatedAt = at(2)
  evidence.assets[0].id = `99000${suffix.length}`
  evidence.assets[0].nodeId = `RA_${suffix}`
  evidence.assets[0].createdAt = at(1)
  evidence.assets[0].updatedAt = at(2)
  evidence.assets[0].downloadCount += 1
  return evidence
}

async function journalFixture() {
  const source = createDuplicateDraftConsolidationFixture()
  const inspected = await inspectEquivalentDrafts({
    candidate: source.candidate,
    survivorId: source.survivorId,
    duplicateIds: source.duplicateIds,
    releases: source.releases,
    github: source.github,
    attestations: source.attestations,
  })
  const repository = {
    name: "cacheplane/dawnai",
    id: REPOSITORY_ID,
    defaultBranch: "main",
    actor: { ...ACTOR },
  }
  const controller = {
    headSha: CONTROLLER_SHA,
    originMainSha: CONTROLLER_SHA,
    githubMainSha: CONTROLLER_SHA,
  }
  const annotatedTag = {
    name: DUPLICATE_DRAFT_CANDIDATE.tag,
    objectSha: TAG_OBJECT_SHA,
    targetSha: DUPLICATE_DRAFT_CANDIDATE.commitSha,
    objectType: "tag",
    observedAt: at(0),
  }
  const workflowAuthority = {
    workflowId: WORKFLOW_ID,
    path: ".github/workflows/release.yml",
    state: "disabled_manually",
    query: {
      statuses: ["in_progress", "pending", "queued", "requested", "waiting"],
      perPage: 100,
      maximumPages: 100,
    },
    nonterminalRuns: [],
    observedAt: at(0),
  }
  const proposedEnvelope = createConsolidationEnvelope("proposed", {
    schemaVersion: 1,
    repository,
    controller,
    candidate: DUPLICATE_DRAFT_CANDIDATE,
    roles: {
      survivor: DUPLICATE_DRAFT_SURVIVOR_ID,
      duplicates: [...DUPLICATE_DRAFT_IDS],
    },
    confirmation: {
      version: DUPLICATE_DRAFT_CANDIDATE.version,
      commitSha: DUPLICATE_DRAFT_CANDIDATE.commitSha,
      survivor: DUPLICATE_DRAFT_SURVIVOR_ID,
      duplicates: [...DUPLICATE_DRAFT_IDS],
      template: "CONSOLIDATE <64-lowercase-hex-digest>",
    },
    annotatedTag,
    workflowAuthority,
    npmInventories: [npmInventory("inspect-initial", 0), npmInventory("inspect-ready", 0)],
    releases: inspected.releases,
    payloadProof: inspected.payloadProof,
    inspectedAt: at(0),
  })
  return { proposedEnvelope }
}

function npmInventory(stage, second) {
  return {
    stage,
    startedAt: at(second),
    completedAt: at(second),
    packages: CANONICAL_RELEASE_PACKAGE_ORDER.map((name) => ({
      name,
      version: DUPLICATE_DRAFT_CANDIDATE.version,
      status: "ABSENT",
      httpStatus: 404,
      code: "E404",
      observedAt: at(second),
    })),
  }
}

function at(second) {
  return new Date(BASE_TIME + second * 1000).toISOString()
}
