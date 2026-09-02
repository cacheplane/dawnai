import assert from "node:assert/strict"
import test from "node:test"
import {
  canonicalConsolidationEnvelopeBytes,
  canonicalEventEnvelope,
  canonicalRecordSha256,
  createConsolidationEnvelope,
  DUPLICATE_DRAFT_CONSOLIDATION_LIMITS,
  parseConsolidationEnvelope,
  parseJournalEventEnvelope,
} from "../duplicate-draft-consolidation-schema.mjs"
import { RELEASE_PAYLOAD_LIMITS } from "../limits.mjs"
import { CANONICAL_RELEASE_PACKAGE_ORDER } from "../manifest.mjs"

const MEBIBYTE = 1024 * 1024
const SHA = "0123456789abcdef0123456789abcdef01234567"
const DIGEST = `${SHA}0123456789abcdef01234567`
const NOW = "2026-09-01T12:00:00.000Z"
const SURVIVOR_ID = "379991871"
const DUPLICATE_IDS = Object.freeze(["379982100", "379986168"])

test("dedicated consolidation limits preserve journal and receipt headroom", () => {
  assert.deepEqual(DUPLICATE_DRAFT_CONSOLIDATION_LIMITS, {
    proposedBytes: 4 * MEBIBYTE,
    journalBytes: 72 * MEBIBYTE,
    finalReceiptBytes: 96 * MEBIBYTE,
    authorityStageBytes: 8 * MEBIBYTE,
    survivorEvidenceBytes: 2 * MEBIBYTE,
    journalEventReserveBytes: 8 * MEBIBYTE,
    envelopeReserveBytes: MEBIBYTE,
    maximumDeleteAttempts: 3,
    maximumTargets: 2,
    maximumOrphanAuthorityRecoveries: 1,
    maximumAssetDownloads: 135,
  })
  assert.ok(
    DUPLICATE_DRAFT_CONSOLIDATION_LIMITS.journalBytes >=
      (2 * 3 + 1 + 1) * DUPLICATE_DRAFT_CONSOLIDATION_LIMITS.authorityStageBytes +
        DUPLICATE_DRAFT_CONSOLIDATION_LIMITS.journalEventReserveBytes,
  )
  assert.ok(
    DUPLICATE_DRAFT_CONSOLIDATION_LIMITS.finalReceiptBytes >=
      DUPLICATE_DRAFT_CONSOLIDATION_LIMITS.proposedBytes +
        DUPLICATE_DRAFT_CONSOLIDATION_LIMITS.journalBytes +
        DUPLICATE_DRAFT_CONSOLIDATION_LIMITS.authorityStageBytes +
        DUPLICATE_DRAFT_CONSOLIDATION_LIMITS.survivorEvidenceBytes +
        DUPLICATE_DRAFT_CONSOLIDATION_LIMITS.envelopeReserveBytes,
  )
  assert.equal(Object.isFrozen(DUPLICATE_DRAFT_CONSOLIDATION_LIMITS), true)
})

test("proposed envelopes round trip as canonical newline-terminated bytes", () => {
  const envelope = createConsolidationEnvelope("proposed", proposedRecord())
  const bytes = canonicalConsolidationEnvelopeBytes("proposed", envelope)

  assert.deepEqual(parseConsolidationEnvelope("proposed", bytes), envelope)
  assert.match(envelope.recordSha256, /^[0-9a-f]{64}$/u)
  assert.equal(envelope.recordSha256, canonicalRecordSha256(envelope.record))
  assert.equal(bytes.at(-1), 0x0a)
  assert.equal(bytes.at(-2) === 0x0a, false)
})

test("all three top-level record schemas and the journal event envelope are exact", () => {
  const proposedEnvelope = createConsolidationEnvelope("proposed", proposedRecord())
  const eventEnvelope = canonicalEventEnvelope(
    operationStartedEvent(proposedEnvelope.recordSha256),
    null,
  )
  const journalEnvelope = createConsolidationEnvelope(
    "journal",
    journalRecord(proposedEnvelope, [eventEnvelope]),
  )
  const finalEnvelope = createConsolidationEnvelope(
    "final",
    finalRecord(proposedEnvelope, journalEnvelope),
  )

  for (const [kind, envelope] of [
    ["proposed", proposedEnvelope],
    ["journal", journalEnvelope],
    ["final", finalEnvelope],
  ]) {
    const bytes = canonicalConsolidationEnvelopeBytes(kind, envelope)
    assert.deepEqual(parseConsolidationEnvelope(kind, bytes), envelope)

    for (const path of requiredObjectFieldPaths(envelope.record)) {
      const missing = structuredClone(envelope.record)
      delete valueAtPath(missing, path.slice(0, -1))[path.at(-1)]
      assert.throws(
        () => createConsolidationEnvelope(kind, missing),
        undefined,
        `${kind} accepted missing ${path.join(".")}`,
      )
    }

    const unknown = structuredClone(envelope.record)
    unknown.unexpected = true
    assert.throws(() => createConsolidationEnvelope(kind, unknown))
  }

  assert.deepEqual(parseJournalEventEnvelope(eventEnvelope, 1, null), eventEnvelope)
  const unknownEvent = structuredClone(eventEnvelope.event)
  unknownEvent.unexpected = true
  assert.throws(() => canonicalEventEnvelope(unknownEvent, null))
})

test("fixed array order, identities, workflow authority, and npm absence are enforced", () => {
  const reorderedStatuses = proposedRecord()
  reorderedStatuses.workflowAuthority.query.statuses.reverse()
  assert.throws(() => createConsolidationEnvelope("proposed", reorderedStatuses))

  const reorderedRoles = proposedRecord()
  reorderedRoles.roles.duplicates.reverse()
  assert.throws(() => createConsolidationEnvelope("proposed", reorderedRoles))

  const consistentlyReorderedRoles = proposedRecord()
  consistentlyReorderedRoles.roles.duplicates.reverse()
  consistentlyReorderedRoles.confirmation.duplicates.reverse()
  const [survivor, firstDuplicate, secondDuplicate] = consistentlyReorderedRoles.releases
  consistentlyReorderedRoles.releases = [survivor, secondDuplicate, firstDuplicate]
  assert.throws(() => createConsolidationEnvelope("proposed", consistentlyReorderedRoles))

  const reorderedReleases = proposedRecord()
  reorderedReleases.releases.reverse()
  assert.throws(() => createConsolidationEnvelope("proposed", reorderedReleases))

  const wrongWorkflow = proposedRecord()
  wrongWorkflow.workflowAuthority.state = "active"
  assert.throws(() => createConsolidationEnvelope("proposed", wrongWorkflow))

  const publishedPackage = proposedRecord()
  publishedPackage.npmInventories[0].packages[0].status = "PRESENT"
  assert.throws(() => createConsolidationEnvelope("proposed", publishedPackage))
})

test("canonical byte parsing rejects duplicate keys, drift, invalid UTF-8, and every size bound", () => {
  const envelope = createConsolidationEnvelope("proposed", proposedRecord())
  const canonical = canonicalConsolidationEnvelopeBytes("proposed", envelope)
  const source = canonical.toString("utf8")

  assert.throws(() =>
    parseConsolidationEnvelope(
      "proposed",
      Buffer.from(source.replace('{"record":', '{"recordSha256":"0","record":')),
    ),
  )

  const changedDigest = structuredClone(envelope)
  changedDigest.recordSha256 = "f".repeat(64)
  assert.throws(() =>
    parseConsolidationEnvelope(
      "proposed",
      Buffer.from(`${JSON.stringify(changedDigest)}\n`, "utf8"),
    ),
  )
  assert.throws(() => parseConsolidationEnvelope("proposed", canonical.subarray(0, -1)))
  assert.throws(() => parseConsolidationEnvelope("proposed", Buffer.from([0xc3, 0x28, 0x0a])))
  assert.throws(() =>
    parseConsolidationEnvelope(
      "proposed",
      Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), canonical]),
    ),
  )

  for (const [kind, maximum] of [
    ["proposed", DUPLICATE_DRAFT_CONSOLIDATION_LIMITS.proposedBytes],
    ["journal", DUPLICATE_DRAFT_CONSOLIDATION_LIMITS.journalBytes],
    ["final", DUPLICATE_DRAFT_CONSOLIDATION_LIMITS.finalReceiptBytes],
  ]) {
    assert.throws(() => parseConsolidationEnvelope(kind, Buffer.alloc(maximum + 1, 0x20)))
  }

  const oversizedRecord = proposedRecord()
  oversizedRecord.releases[0].semantic.body = "x".repeat(
    DUPLICATE_DRAFT_CONSOLIDATION_LIMITS.proposedBytes,
  )
  assert.throws(() => createConsolidationEnvelope("proposed", oversizedRecord))
})

test("nested evidence limits reject oversized authority, survivor, download, and Release payloads", () => {
  const oversizedAuthority = authorityStage("pre-delete-1")
  oversizedAuthority.annotatedTag.name = "x".repeat(
    DUPLICATE_DRAFT_CONSOLIDATION_LIMITS.authorityStageBytes,
  )
  assert.throws(() =>
    canonicalEventEnvelope(
      journalEvent("delete-authority-observed", {
        targetReleaseId: DUPLICATE_IDS[0],
        attemptNumber: 1,
        authority: oversizedAuthority,
      }),
      null,
    ),
  )

  const oversizedFinalAuthority = authorityStage("final", null)
  oversizedFinalAuthority.annotatedTag.name = "x".repeat(
    DUPLICATE_DRAFT_CONSOLIDATION_LIMITS.authorityStageBytes,
  )
  assert.throws(() =>
    canonicalEventEnvelope(
      journalEvent("final-authority-observed", {
        authority: oversizedFinalAuthority,
      }),
      null,
    ),
  )

  const tooManyDownloads = authorityStage("pre-delete-1")
  tooManyDownloads.releases.push(releaseEvidence("duplicate", "999999999", 4000))
  assert.throws(() =>
    canonicalEventEnvelope(
      journalEvent("delete-authority-observed", {
        targetReleaseId: DUPLICATE_IDS[0],
        attemptNumber: 1,
        authority: tooManyDownloads,
      }),
      null,
    ),
  )

  const { proposedEnvelope, journalEnvelope } = envelopeFixtures()
  const oversizedSurvivorRecord = finalRecord(proposedEnvelope, journalEnvelope)
  const oversizedNodeId = "x".repeat(DUPLICATE_DRAFT_CONSOLIDATION_LIMITS.survivorEvidenceBytes)
  oversizedSurvivorRecord.finalAuthority.releases[0].nodeId = oversizedNodeId
  oversizedSurvivorRecord.finalSurvivor.nodeId = oversizedNodeId
  assert.throws(() => createConsolidationEnvelope("final", oversizedSurvivorRecord))

  const oversizedAsset = releaseEvidence("duplicate", DUPLICATE_IDS[0], 2000)
  oversizedAsset.assets[0].size = RELEASE_PAYLOAD_LIMITS.tarballBytes + 1
  assert.throws(() =>
    canonicalEventEnvelope(
      journalEvent("resume-reconciliation", {
        targetReleaseId: DUPLICATE_IDS[0],
        attemptNumber: 1,
        classification: "present-unchanged-retryable",
        releaseEvidence: oversizedAsset,
        observedAt: NOW,
      }),
      null,
    ),
  )

  const aggregateOverflow = releaseEvidence("duplicate", DUPLICATE_IDS[0], 2000)
  for (const asset of aggregateOverflow.assets) asset.size = 2 * MEBIBYTE
  assert.throws(() =>
    canonicalEventEnvelope(
      journalEvent("resume-reconciliation", {
        targetReleaseId: DUPLICATE_IDS[0],
        attemptNumber: 1,
        classification: "present-unchanged-retryable",
        releaseEvidence: aggregateOverflow,
        observedAt: NOW,
      }),
      null,
    ),
  )

  const oversizedAssetName = releaseEvidence("duplicate", DUPLICATE_IDS[0], 2000)
  oversizedAssetName.assets[0].name = "x".repeat(RELEASE_PAYLOAD_LIMITS.archiveFilenameBytes + 1)
  assert.throws(() =>
    canonicalEventEnvelope(
      journalEvent("resume-reconciliation", {
        targetReleaseId: DUPLICATE_IDS[0],
        attemptNumber: 1,
        classification: "present-unchanged-retryable",
        releaseEvidence: oversizedAssetName,
        observedAt: NOW,
      }),
      null,
    ),
  )
})

test("embedded envelopes retain their own proposed and journal byte ceilings", () => {
  const { proposedEnvelope, journalEnvelope } = envelopeFixtures()
  const oversizedProposedRecord = structuredClone(proposedEnvelope.record)
  oversizedProposedRecord.repository.name = "x".repeat(
    DUPLICATE_DRAFT_CONSOLIDATION_LIMITS.proposedBytes,
  )
  const oversizedProposedEnvelope = {
    record: oversizedProposedRecord,
    recordSha256: canonicalRecordSha256(oversizedProposedRecord),
  }
  assert.throws(() =>
    createConsolidationEnvelope("final", finalRecord(oversizedProposedEnvelope, journalEnvelope)),
  )

  const oversizedJournalRecord = journalRecord(proposedEnvelope, [])
  let previousEventSha256 = null
  const operation = operationStartedEvent(proposedEnvelope.recordSha256)
  oversizedJournalRecord.events.push(canonicalEventEnvelope(operation, previousEventSha256))
  previousEventSha256 = oversizedJournalRecord.events.at(-1).eventSha256
  for (let index = 0; index < 11; index += 1) {
    const authority = authorityStage("final", null)
    authority.annotatedTag.name = "x".repeat(7 * MEBIBYTE)
    const event = journalEvent("final-authority-observed", { authority })
    event.sequence = index + 2
    event.previousEventSha256 = previousEventSha256
    const envelope = canonicalEventEnvelope(event, previousEventSha256)
    oversizedJournalRecord.events.push(envelope)
    previousEventSha256 = envelope.eventSha256
  }
  const oversizedJournalEnvelope = {
    record: oversizedJournalRecord,
    recordSha256: canonicalRecordSha256(oversizedJournalRecord),
  }
  assert.throws(() =>
    createConsolidationEnvelope("final", finalRecord(proposedEnvelope, oversizedJournalEnvelope)),
  )
})

test("every fixed array rejects holes and unexpected own properties", () => {
  for (const path of [
    ["roles", "duplicates"],
    ["confirmation", "duplicates"],
    ["workflowAuthority", "query", "statuses"],
    ["workflowAuthority", "nonterminalRuns"],
    ["npmInventories"],
    ["npmInventories", 0, "packages"],
    ["releases"],
    ["releases", 0, "assets"],
    ["payloadProof", "baseAssetSet"],
    ["payloadProof", "attestationVerification", "subjects"],
  ]) {
    const withExtra = proposedRecord()
    Object.defineProperty(valueAtPath(withExtra, path), "extra", {
      value: "unexpected",
      enumerable: true,
      configurable: true,
    })
    assert.throws(
      () => createConsolidationEnvelope("proposed", withExtra),
      undefined,
      `accepted extra array property at ${path.join(".")}`,
    )

    const withHole = proposedRecord()
    const array = valueAtPath(withHole, path)
    if (array.length > 0) {
      const last = array.length - 1
      const displaced = array[last]
      delete array[last]
      Object.defineProperty(array, "replacement", {
        value: displaced,
        enumerable: true,
        configurable: true,
      })
      assert.throws(
        () => createConsolidationEnvelope("proposed", withHole),
        undefined,
        `accepted sparse array at ${path.join(".")}`,
      )
    }
  }

  const symbolArray = proposedRecord()
  symbolArray.workflowAuthority.query.statuses[Symbol("hidden")] = true
  assert.throws(() => createConsolidationEnvelope("proposed", symbolArray))

  const hiddenArray = proposedRecord()
  Object.defineProperty(hiddenArray.workflowAuthority.query.statuses, "hidden", {
    value: true,
    enumerable: false,
  })
  assert.throws(() => createConsolidationEnvelope("proposed", hiddenArray))

  let arrayGetterCalls = 0
  const accessorArray = proposedRecord()
  Object.defineProperty(accessorArray.workflowAuthority.query.statuses, 0, {
    get() {
      arrayGetterCalls += 1
      return "in_progress"
    },
    enumerable: true,
    configurable: true,
  })
  assert.throws(() => createConsolidationEnvelope("proposed", accessorArray))
  assert.equal(arrayGetterCalls, 0)

  const { proposedEnvelope } = envelopeFixtures()
  for (const path of [["deletionOrder"], ["events"]]) {
    const record = journalRecord(proposedEnvelope, [
      canonicalEventEnvelope(operationStartedEvent(proposedEnvelope.recordSha256), null),
    ])
    Object.defineProperty(valueAtPath(record, path), "extra", {
      value: true,
      enumerable: true,
    })
    assert.throws(() => createConsolidationEnvelope("journal", record))
  }

  const event = operationStartedEvent()
  Object.defineProperty(event.payload.deletionOrder, "extra", {
    value: true,
    enumerable: true,
  })
  assert.throws(() => canonicalEventEnvelope(event, null))
})

test("exact objects reject accessors, hidden and symbol fields, unsafe keys, and prototypes", () => {
  let getterCalls = 0
  const accessor = proposedRecord()
  Object.defineProperty(accessor.repository, "name", {
    get() {
      getterCalls += 1
      return "cacheplane/dawnai"
    },
    enumerable: true,
    configurable: true,
  })
  assert.throws(() => createConsolidationEnvelope("proposed", accessor))
  assert.equal(getterCalls, 0)

  const hidden = proposedRecord()
  Object.defineProperty(hidden.repository, "hidden", {
    value: true,
    enumerable: false,
  })
  assert.throws(() => createConsolidationEnvelope("proposed", hidden))

  const symbol = proposedRecord()
  symbol.repository[Symbol("hidden")] = true
  assert.throws(() => createConsolidationEnvelope("proposed", symbol))

  const unsafe = proposedRecord()
  Object.defineProperty(unsafe.repository, "__proto__", {
    value: {},
    enumerable: true,
  })
  assert.throws(() => createConsolidationEnvelope("proposed", unsafe))

  const prototype = proposedRecord()
  Object.setPrototypeOf(prototype.repository.actor, { inherited: true })
  assert.throws(() => createConsolidationEnvelope("proposed", prototype))

  let proxyReads = 0
  const proxied = proposedRecord()
  proxied.repository.actor = new Proxy(proxied.repository.actor, {
    get(target, property, receiver) {
      proxyReads += 1
      return Reflect.get(target, property, receiver)
    },
  })
  assert.throws(() => createConsolidationEnvelope("proposed", proxied))
  assert.equal(proxyReads, 0)

  let eventGetterCalls = 0
  const eventAccessor = journalEvent("delete-intent", {
    targetReleaseId: DUPLICATE_IDS[0],
    attemptNumber: 1,
    authorityEventSha256: DIGEST,
  })
  Object.defineProperty(eventAccessor.payload, "targetReleaseId", {
    get() {
      eventGetterCalls += 1
      return DUPLICATE_IDS[0]
    },
    enumerable: true,
    configurable: true,
  })
  assert.throws(() => canonicalEventEnvelope(eventAccessor, null))
  assert.equal(eventGetterCalls, 0)
})

test("timestamps reject impossible dates and require canonical milliseconds", () => {
  const omittedMilliseconds = proposedRecord()
  omittedMilliseconds.inspectedAt = "2026-09-01T12:00:00Z"
  assert.throws(() => createConsolidationEnvelope("proposed", omittedMilliseconds))

  for (const invalid of [
    "2026-02-31T12:00:00.000Z",
    "2025-02-29T12:00:00.000Z",
    "2026-13-01T12:00:00.000Z",
  ]) {
    const record = proposedRecord()
    record.inspectedAt = invalid
    assert.throws(() => createConsolidationEnvelope("proposed", record))
  }
})

test("fixed cardinality and journal ceilings reject hostile tails before traversal", () => {
  let fixedTailCalls = 0
  const oversizedFixedArray = proposedRecord()
  const npmInventories = new Array(3)
  npmInventories[0] = npmInventory("inspect-initial")
  npmInventories[1] = npmInventory("inspect-ready")
  Object.defineProperty(npmInventories, 2, {
    get() {
      fixedTailCalls += 1
      return npmInventory("inspect-ready")
    },
    enumerable: true,
  })
  oversizedFixedArray.npmInventories = npmInventories
  assert.throws(() => createConsolidationEnvelope("proposed", oversizedFixedArray))
  assert.equal(fixedTailCalls, 0)

  let journalTailCalls = 0
  const { proposedEnvelope } = envelopeFixtures()
  const record = journalRecord(proposedEnvelope, [])
  record.events = new Array(DUPLICATE_DRAFT_CONSOLIDATION_LIMITS.journalBytes + 1)
  Object.defineProperty(record.events, record.events.length - 1, {
    get() {
      journalTailCalls += 1
      return {}
    },
    enumerable: true,
  })
  assert.throws(() => createConsolidationEnvelope("journal", record))
  assert.equal(journalTailCalls, 0)
})

test("cumulative budgets stop repeated shared strings before hostile trailing evidence", () => {
  const record = proposedRecord()
  const shared = "x".repeat(512 * 1024)
  for (const asset of record.releases[1].assets) asset.label = shared
  let sentinelTraps = 0
  record.payloadProof = new Proxy(record.payloadProof, {
    getPrototypeOf(target) {
      sentinelTraps += 1
      return Reflect.getPrototypeOf(target)
    },
    ownKeys(target) {
      sentinelTraps += 1
      return Reflect.ownKeys(target)
    },
  })
  assert.throws(
    () => createConsolidationEnvelope("proposed", record),
    /cumulative proposed envelope budget/iu,
  )
  assert.equal(sentinelTraps, 0)

  const authority = authorityStage("pre-delete-1")
  for (const asset of authority.releases[1].assets) asset.label = shared
  let authoritySentinelTraps = 0
  authority.payloadProof = new Proxy(authority.payloadProof, {
    getPrototypeOf(target) {
      authoritySentinelTraps += 1
      return Reflect.getPrototypeOf(target)
    },
  })
  assert.throws(
    () =>
      canonicalEventEnvelope(
        journalEvent("delete-authority-observed", {
          targetReleaseId: DUPLICATE_IDS[0],
          attemptNumber: 1,
          authority,
        }),
        null,
      ),
    /cumulative (?:journal event envelope|authority stage) budget/iu,
  )
  assert.equal(authoritySentinelTraps, 0)

  const resumeEvidence = releaseEvidence("duplicate", DUPLICATE_IDS[0], 2000)
  for (const asset of resumeEvidence.assets.slice(0, -1)) asset.label = shared
  let resumeSentinelTraps = 0
  resumeEvidence.assets[resumeEvidence.assets.length - 1] = new Proxy(
    resumeEvidence.assets.at(-1),
    {
      getPrototypeOf(target) {
        resumeSentinelTraps += 1
        return Reflect.getPrototypeOf(target)
      },
    },
  )
  assert.throws(
    () =>
      canonicalEventEnvelope(
        journalEvent("resume-reconciliation", {
          targetReleaseId: DUPLICATE_IDS[0],
          attemptNumber: 1,
          classification: "present-unchanged-retryable",
          releaseEvidence: resumeEvidence,
          observedAt: NOW,
        }),
        null,
      ),
    /cumulative journal event envelope budget/iu,
  )
  assert.equal(resumeSentinelTraps, 0)
})

test("incremental accounting accepts canonical evidence close to its proposed cap", () => {
  const record = proposedRecord()
  const shared = "x".repeat(1_700_000)
  record.releases[1].semantic.body = shared
  record.releases[2].semantic.body = shared
  const envelope = createConsolidationEnvelope("proposed", record)
  const bytes = canonicalConsolidationEnvelopeBytes("proposed", envelope)
  assert.ok(bytes.byteLength > DUPLICATE_DRAFT_CONSOLIDATION_LIMITS.proposedBytes - MEBIBYTE)
  assert.ok(bytes.byteLength < DUPLICATE_DRAFT_CONSOLIDATION_LIMITS.proposedBytes)
})

test("authority-bearing events compose exact authority and wrapper budgets", () => {
  for (const [type, authority, payload] of [
    [
      "delete-authority-observed",
      authorityStage("pre-delete-1"),
      (authorityValue) => ({
        targetReleaseId: DUPLICATE_IDS[0],
        attemptNumber: 1,
        authority: authorityValue,
      }),
    ],
    [
      "final-authority-observed",
      authorityStage("final", null),
      (authorityValue) => ({ authority: authorityValue }),
    ],
  ]) {
    resizeAuthorityStage(authority, DUPLICATE_DRAFT_CONSOLIDATION_LIMITS.authorityStageBytes)
    const event = journalEvent(type, payload(authority))
    const envelope = canonicalEventEnvelope(event, null)
    assert.deepEqual(parseJournalEventEnvelope(envelope, 1, null), envelope)

    const oversized = structuredClone(authority)
    resizeAuthorityStage(oversized, DUPLICATE_DRAFT_CONSOLIDATION_LIMITS.authorityStageBytes + 1)
    const oversizedEvent = journalEvent(type, payload(oversized))
    assert.throws(() => canonicalEventEnvelope(oversizedEvent, null))
    assert.throws(() =>
      parseJournalEventEnvelope(
        {
          event: oversizedEvent,
          eventSha256: canonicalRecordSha256(oversizedEvent),
        },
        1,
        null,
      ),
    )
  }

  const resumeEvidence = releaseEvidence("duplicate", DUPLICATE_IDS[0], 2000)
  resumeEvidence.semantic.body = "x".repeat(
    DUPLICATE_DRAFT_CONSOLIDATION_LIMITS.journalEventReserveBytes,
  )
  const oversizedResumeEvent = journalEvent("resume-reconciliation", {
    targetReleaseId: DUPLICATE_IDS[0],
    attemptNumber: 1,
    classification: "present-unchanged-retryable",
    releaseEvidence: resumeEvidence,
    observedAt: NOW,
  })
  assert.throws(() => canonicalEventEnvelope(oversizedResumeEvent, null))
  assert.throws(() =>
    parseJournalEventEnvelope(
      {
        event: oversizedResumeEvent,
        eventSha256: canonicalRecordSha256(oversizedResumeEvent),
      },
      1,
      null,
    ),
  )
})

test("Git object SHAs accept exactly 40 or 64 lowercase hex characters", () => {
  assert.doesNotThrow(() => createConsolidationEnvelope("proposed", proposedRecord()))

  const sha64 = "a".repeat(64)
  const withSha256Objects = proposedRecord()
  withSha256Objects.controller = {
    headSha: sha64,
    originMainSha: sha64,
    githubMainSha: sha64,
  }
  withSha256Objects.candidate.commitSha = sha64
  withSha256Objects.confirmation.commitSha = sha64
  withSha256Objects.annotatedTag.objectSha = sha64
  withSha256Objects.annotatedTag.targetSha = sha64
  assert.doesNotThrow(() => createConsolidationEnvelope("proposed", withSha256Objects))

  for (const length of [39, 41, 52, 63, 65]) {
    const impossible = proposedRecord()
    impossible.controller = {
      headSha: "a".repeat(length),
      originMainSha: "a".repeat(length),
      githubMainSha: "a".repeat(length),
    }
    assert.throws(
      () => createConsolidationEnvelope("proposed", impossible),
      undefined,
      `accepted impossible Git object SHA length ${length}`,
    )
  }
})

test("Release evidence requires the exact main target commitish", () => {
  assert.doesNotThrow(() => createConsolidationEnvelope("proposed", proposedRecord()))

  for (const targetCommitish of [SHA, "develop", "refs/heads/main", "main\n", "ma\u0456n"]) {
    const proposed = proposedRecord()
    proposed.releases[0].semantic.targetCommitish = targetCommitish
    assert.throws(() => createConsolidationEnvelope("proposed", proposed))

    const resume = journalEvent("resume-reconciliation", {
      targetReleaseId: DUPLICATE_IDS[0],
      attemptNumber: 1,
      classification: "present-unchanged-retryable",
      releaseEvidence: releaseEvidence("duplicate", DUPLICATE_IDS[0], 2000),
      observedAt: NOW,
    })
    resume.payload.releaseEvidence.semantic.targetCommitish = targetCommitish
    assert.throws(() => canonicalEventEnvelope(resume, null))

    const { proposedEnvelope, journalEnvelope } = envelopeFixtures()
    const final = finalRecord(proposedEnvelope, journalEnvelope)
    final.finalSurvivor.semantic.targetCommitish = targetCommitish
    assert.throws(() => createConsolidationEnvelope("final", final))
  }
})

test("journal events enforce the hash chain and every exact typed payload", () => {
  const events = eventFixtures()
  let previous = null
  for (let index = 0; index < events.length; index += 1) {
    const event = {
      ...events[index],
      sequence: index + 1,
      previousEventSha256: previous,
    }
    const envelope = canonicalEventEnvelope(event, previous)
    assert.deepEqual(parseJournalEventEnvelope(envelope, index + 1, previous), envelope)

    for (const path of requiredObjectFieldPaths(event)) {
      const missingField = structuredClone(event)
      delete valueAtPath(missingField, path.slice(0, -1))[path.at(-1)]
      assert.throws(
        () => canonicalEventEnvelope(missingField, previous),
        undefined,
        `${event.type} accepted missing ${path.join(".")}`,
      )
    }

    previous = envelope.eventSha256
  }

  const first = canonicalEventEnvelope(operationStartedEvent(), null)
  assert.throws(() => parseJournalEventEnvelope(first, 2, null))
  assert.throws(() => parseJournalEventEnvelope(first, 1, DIGEST))
  assert.throws(() => parseJournalEventEnvelope({ ...first, eventSha256: DIGEST }, 1, null))
})

test("event classifications, nullable evidence, convergence bases, and attempts are exact", () => {
  const outcomeTriplets = [
    ["confirmed-204", 204],
    ["transport-ambiguous", null],
    ["response-404-ambiguous", 404],
  ]
  for (const [classification, httpStatus] of outcomeTriplets) {
    assert.doesNotThrow(() =>
      canonicalEventEnvelope(
        journalEvent("delete-outcome", {
          targetReleaseId: DUPLICATE_IDS[0],
          attemptNumber: 1,
          classification,
          httpStatus,
          observedAt: NOW,
        }),
        null,
      ),
    )
    for (const wrongStatus of [204, null, 404].filter((value) => value !== httpStatus)) {
      assert.throws(() =>
        canonicalEventEnvelope(
          journalEvent("delete-outcome", {
            targetReleaseId: DUPLICATE_IDS[0],
            attemptNumber: 1,
            classification,
            httpStatus: wrongStatus,
            observedAt: NOW,
          }),
          null,
        ),
      )
    }
  }
  for (const httpStatus of [null, 302, 403, 429, 500]) {
    assert.doesNotThrow(() =>
      canonicalEventEnvelope(
        journalEvent("delete-outcome", {
          targetReleaseId: DUPLICATE_IDS[0],
          attemptNumber: 1,
          classification: "response-hard-failure",
          httpStatus,
          observedAt: NOW,
        }),
        null,
      ),
    )
  }
  for (const httpStatus of [204, 404]) {
    assert.throws(() =>
      canonicalEventEnvelope(
        journalEvent("delete-outcome", {
          targetReleaseId: DUPLICATE_IDS[0],
          attemptNumber: 1,
          classification: "response-hard-failure",
          httpStatus,
          observedAt: NOW,
        }),
        null,
      ),
    )
  }
  assert.throws(() =>
    canonicalEventEnvelope(
      journalEvent("delete-outcome", {
        targetReleaseId: DUPLICATE_IDS[0],
        attemptNumber: 1,
        classification: "unknown",
        httpStatus: null,
        observedAt: NOW,
      }),
      null,
    ),
  )

  const presentEvidence = releaseEvidence("duplicate", DUPLICATE_IDS[0], 2000)
  for (const [classification, releaseEvidenceValue] of [
    ["present-unchanged-retryable", presentEvidence],
    ["absent-ambiguous", null],
  ]) {
    assert.doesNotThrow(() =>
      canonicalEventEnvelope(
        journalEvent("resume-reconciliation", {
          targetReleaseId: DUPLICATE_IDS[0],
          attemptNumber: 1,
          classification,
          releaseEvidence: releaseEvidenceValue,
          observedAt: NOW,
        }),
        null,
      ),
    )
  }
  for (const [classification, releaseEvidenceValue] of [
    ["present-unchanged-retryable", null],
    ["absent-ambiguous", presentEvidence],
  ]) {
    assert.throws(() =>
      canonicalEventEnvelope(
        journalEvent("resume-reconciliation", {
          targetReleaseId: DUPLICATE_IDS[0],
          attemptNumber: 1,
          classification,
          releaseEvidence: releaseEvidenceValue,
          observedAt: NOW,
        }),
        null,
      ),
    )
  }

  for (const basis of ["confirmed-204", "ambiguous"]) {
    assert.doesNotThrow(() =>
      canonicalEventEnvelope(
        journalEvent("absence-converged", {
          targetReleaseId: DUPLICATE_IDS[0],
          attemptNumber: 1,
          basis,
          directGet404At: NOW,
          listAbsentAt: NOW,
          attempts: 1,
          completedAt: NOW,
        }),
        null,
      ),
    )
  }
  assert.throws(() =>
    canonicalEventEnvelope(
      journalEvent("absence-converged", {
        targetReleaseId: DUPLICATE_IDS[0],
        attemptNumber: 1,
        basis: "unknown",
        directGet404At: NOW,
        listAbsentAt: NOW,
        attempts: 1,
        completedAt: NOW,
      }),
      null,
    ),
  )
  assert.throws(() =>
    canonicalEventEnvelope(
      journalEvent("delete-intent", {
        targetReleaseId: DUPLICATE_IDS[0],
        attemptNumber: 4,
        authorityEventSha256: DIGEST,
      }),
      null,
    ),
  )
})

function proposedRecord() {
  const releases = [
    releaseEvidence("survivor", SURVIVOR_ID, 1000),
    releaseEvidence("duplicate", DUPLICATE_IDS[0], 2000),
    releaseEvidence("duplicate", DUPLICATE_IDS[1], 3000),
  ]
  return {
    schemaVersion: 1,
    repository: repository(),
    controller: controller(),
    candidate: candidate(),
    roles: { survivor: SURVIVOR_ID, duplicates: [...DUPLICATE_IDS] },
    confirmation: {
      version: "0.8.22",
      commitSha: SHA,
      survivor: SURVIVOR_ID,
      duplicates: [...DUPLICATE_IDS],
      template: "Consolidate <64-lowercase-hex-digest>",
    },
    annotatedTag: annotatedTag(),
    workflowAuthority: workflowAuthority(),
    npmInventories: [npmInventory("inspect-initial"), npmInventory("inspect-ready")],
    releases,
    payloadProof: payloadProof(),
    inspectedAt: NOW,
  }
}

function journalRecord(proposedEnvelope, events) {
  return {
    schemaVersion: 1,
    repository: repository(),
    candidate: candidate(),
    proposedRecordSha256: proposedEnvelope.recordSha256,
    confirmationSha256: DIGEST,
    deletionOrder: [...DUPLICATE_IDS],
    events,
    updatedAt: NOW,
  }
}

function finalRecord(proposedEnvelope, journalEnvelope) {
  const finalAuthority = authorityStage("final", null)
  return {
    schemaVersion: 1,
    proposedEnvelope,
    journalEnvelope,
    finalAuthority,
    finalSurvivor: finalAuthority.releases[0],
    completedAt: NOW,
  }
}

function envelopeFixtures() {
  const proposedEnvelope = createConsolidationEnvelope("proposed", proposedRecord())
  const operation = canonicalEventEnvelope(
    operationStartedEvent(proposedEnvelope.recordSha256),
    null,
  )
  const journalEnvelope = createConsolidationEnvelope(
    "journal",
    journalRecord(proposedEnvelope, [operation]),
  )
  return { proposedEnvelope, journalEnvelope }
}

function repository() {
  return {
    name: "cacheplane/dawnai",
    id: "123456789",
    defaultBranch: "main",
    actor: { login: "blove", id: "1234" },
  }
}

function controller() {
  return { headSha: SHA, originMainSha: SHA, githubMainSha: SHA }
}

function candidate() {
  return { version: "0.8.22", commitSha: SHA, tag: "v0.8.22" }
}

function annotatedTag() {
  return {
    name: "v0.8.22",
    objectSha: SHA,
    targetSha: SHA,
    objectType: "tag",
    observedAt: NOW,
  }
}

function workflowAuthority() {
  return {
    workflowId: "12345",
    path: ".github/workflows/release.yml",
    state: "disabled_manually",
    query: {
      statuses: ["in_progress", "pending", "queued", "requested", "waiting"],
      perPage: 100,
      maximumPages: 100,
    },
    nonterminalRuns: [],
    observedAt: NOW,
  }
}

function npmInventory(stage) {
  return {
    stage,
    startedAt: NOW,
    completedAt: NOW,
    packages: CANONICAL_RELEASE_PACKAGE_ORDER.map((name) => ({
      name,
      version: "0.8.22",
      status: "ABSENT",
      httpStatus: 404,
      code: "E404",
      observedAt: NOW,
    })),
  }
}

function releaseEvidence(role, id, assetIdStart) {
  return {
    role,
    id,
    nodeId: `RE_${id}`,
    tagName: `untagged-${id}`,
    createdAt: NOW,
    updatedAt: NOW,
    semantic: {
      name: "v0.8.22 escrow",
      targetCommitish: "main",
      draft: true,
      immutable: false,
      prerelease: false,
      publishedAt: null,
      body: "ESCROWED",
      bodySha256: DIGEST,
      author: {
        login: "github-actions[bot]",
        id: "41898282",
        nodeId: "MDQ6VXNlcjQxODk4Mjgy",
      },
    },
    assets: Array.from({ length: 45 }, (_, index) => ({
      id: String(assetIdStart + index),
      nodeId: `RA_${assetIdStart + index}`,
      name: `asset-${String(index).padStart(2, "0")}`,
      label: null,
      state: "uploaded",
      contentType: "application/octet-stream",
      size: 1,
      digest: `sha256:${DIGEST}`,
      uploader: {
        login: "github-actions[bot]",
        id: "41898282",
        nodeId: "MDQ6VXNlcjQxODk4Mjgy",
      },
      createdAt: NOW,
      updatedAt: NOW,
      downloadCount: 0,
      downloadSha256: DIGEST,
    })),
  }
}

function payloadProof() {
  const baseAssetSet = Array.from({ length: 45 }, (_, index) => ({
    name: `asset-${String(index).padStart(2, "0")}`,
    sha256: DIGEST,
  }))
  return {
    baseAssetSet,
    baseAssetSetSha256: DIGEST,
    consolidationPayloadSha256: DIGEST,
    attestationVerification: {
      status: "VERIFIED",
      subjects: Array.from({ length: 22 }, (_, index) => ({
        name: `subject-${String(index).padStart(2, "0")}`,
        sha256: DIGEST,
      })),
    },
  }
}

function targetRead() {
  const evidence = releaseEvidence("duplicate", DUPLICATE_IDS[0], 2000)
  return {
    releaseGetStartedAt: NOW,
    releaseGetCompletedAt: NOW,
    assetsListStartedAt: NOW,
    assetsListCompletedAt: NOW,
    evidence,
    evidenceSha256: canonicalRecordSha256(evidence),
  }
}

function authorityStage(stage, read = targetRead()) {
  return {
    stage,
    controller: controller(),
    annotatedTag: annotatedTag(),
    workflowAuthority: workflowAuthority(),
    npmInventory: npmInventory(stage),
    releases:
      stage === "final"
        ? [releaseEvidence("survivor", SURVIVOR_ID, 1000)]
        : [
            releaseEvidence("survivor", SURVIVOR_ID, 1000),
            releaseEvidence("duplicate", DUPLICATE_IDS[0], 2000),
            releaseEvidence("duplicate", DUPLICATE_IDS[1], 3000),
          ],
    payloadProof: payloadProof(),
    targetRead: read,
    observedAt: NOW,
  }
}

function resizeAuthorityStage(authority, canonicalBytes) {
  const currentBytes = Buffer.byteLength(`${JSON.stringify(authority)}\n`, "utf8")
  const currentNameBytes = Buffer.byteLength(JSON.stringify(authority.annotatedTag.name), "utf8")
  const replacementBytes = canonicalBytes - currentBytes + currentNameBytes
  assert.ok(replacementBytes >= 2)
  authority.annotatedTag.name = "x".repeat(replacementBytes - 2)
  assert.equal(Buffer.byteLength(`${JSON.stringify(authority)}\n`, "utf8"), canonicalBytes)
}

function operationStartedEvent(proposedRecordSha256 = DIGEST) {
  return {
    schemaVersion: 1,
    sequence: 1,
    previousEventSha256: null,
    type: "operation-started",
    recordedAt: NOW,
    payload: {
      proposedRecordSha256,
      confirmationSha256: DIGEST,
      controllerSha: SHA,
      deletionOrder: [...DUPLICATE_IDS],
    },
  }
}

function journalEvent(type, payload) {
  return {
    schemaVersion: 1,
    sequence: 1,
    previousEventSha256: null,
    type,
    recordedAt: NOW,
    payload,
  }
}

function eventFixtures() {
  return [
    operationStartedEvent(),
    {
      schemaVersion: 1,
      sequence: 2,
      previousEventSha256: null,
      type: "npm-observed",
      recordedAt: NOW,
      payload: {
        targetReleaseId: DUPLICATE_IDS[0],
        attemptNumber: 1,
        inventory: npmInventory("perform-initial"),
      },
    },
    {
      schemaVersion: 1,
      sequence: 3,
      previousEventSha256: null,
      type: "delete-authority-observed",
      recordedAt: NOW,
      payload: {
        targetReleaseId: DUPLICATE_IDS[0],
        attemptNumber: 1,
        authority: authorityStage("pre-delete-1"),
      },
    },
    {
      schemaVersion: 1,
      sequence: 4,
      previousEventSha256: null,
      type: "delete-intent",
      recordedAt: NOW,
      payload: {
        targetReleaseId: DUPLICATE_IDS[0],
        attemptNumber: 1,
        authorityEventSha256: DIGEST,
      },
    },
    {
      schemaVersion: 1,
      sequence: 5,
      previousEventSha256: null,
      type: "delete-outcome",
      recordedAt: NOW,
      payload: {
        targetReleaseId: DUPLICATE_IDS[0],
        attemptNumber: 1,
        classification: "confirmed-204",
        httpStatus: 204,
        observedAt: NOW,
      },
    },
    {
      schemaVersion: 1,
      sequence: 6,
      previousEventSha256: null,
      type: "resume-reconciliation",
      recordedAt: NOW,
      payload: {
        targetReleaseId: DUPLICATE_IDS[0],
        attemptNumber: 1,
        classification: "absent-ambiguous",
        releaseEvidence: null,
        observedAt: NOW,
      },
    },
    {
      schemaVersion: 1,
      sequence: 7,
      previousEventSha256: null,
      type: "absence-converged",
      recordedAt: NOW,
      payload: {
        targetReleaseId: DUPLICATE_IDS[0],
        attemptNumber: 1,
        basis: "confirmed-204",
        directGet404At: NOW,
        listAbsentAt: NOW,
        attempts: 1,
        completedAt: NOW,
      },
    },
    {
      schemaVersion: 1,
      sequence: 8,
      previousEventSha256: null,
      type: "final-authority-observed",
      recordedAt: NOW,
      payload: { authority: authorityStage("final", null) },
    },
  ]
}

function requiredObjectFieldPaths(value, prefix = []) {
  const paths = []
  if (value === null || typeof value !== "object") return paths
  if (Array.isArray(value)) {
    if (value.length > 0) paths.push(...requiredObjectFieldPaths(value[0], [...prefix, 0]))
    return paths
  }
  for (const [key, child] of Object.entries(value)) {
    const path = [...prefix, key]
    paths.push(path)
    paths.push(...requiredObjectFieldPaths(child, path))
  }
  return paths
}

function valueAtPath(value, path) {
  return path.reduce((current, key) => current[key], value)
}
