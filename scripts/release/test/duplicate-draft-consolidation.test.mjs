import assert from "node:assert/strict"
import { createHash } from "node:crypto"
import { mkdirSync, renameSync } from "node:fs"
import {
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import test from "node:test"
import {
  inspectDuplicateDrafts,
  performDuplicateDraftConsolidation,
  performOneDuplicateDeletion,
  verifyDuplicateDraftConsolidation,
} from "../duplicate-draft-consolidation.mjs"
import { createDuplicateDraftConsolidationAdapters } from "../duplicate-draft-consolidation-adapters.mjs"
import { runDuplicateDraftConsolidationCli } from "../duplicate-draft-consolidation-cli.mjs"
import { captureDirectTargetRead } from "../duplicate-draft-consolidation-evidence.mjs"
import {
  readPrivateEnvelope,
  readTrackedReceipt,
  writePrivateEnvelope,
  writeTrackedReceipt,
} from "../duplicate-draft-consolidation-files.mjs"
import {
  appendJournalEvent,
  createConsolidationJournal,
  createFinalConsolidationReceipt,
  deriveConsolidationState,
} from "../duplicate-draft-consolidation-journal.mjs"
import {
  canonicalConsolidationEnvelopeBytes,
  canonicalEventEnvelope,
  canonicalRecordSha256,
  createConsolidationEnvelope,
  DUPLICATE_DRAFT_CONSOLIDATION_LIMITS,
  parseConsolidationEnvelope,
} from "../duplicate-draft-consolidation-schema.mjs"
import { CANONICAL_RELEASE_PACKAGE_ORDER } from "../manifest.mjs"
import {
  createDuplicateDraftConsolidationFixture,
  DUPLICATE_DRAFT_CANDIDATE,
  DUPLICATE_DRAFT_IDS,
  DUPLICATE_DRAFT_SURVIVOR_ID,
} from "./support/duplicate-draft-consolidation-fixture.mjs"

const OUTPUT = ".dawn/release/duplicate-draft-consolidation.proposed.json"
const BASE_TIME = Date.parse("2026-09-01T12:00:00.000Z")
const CONTROLLER_SHA = "b".repeat(40)
const CONVERGENCE_BACKOFFS = Object.freeze([1_000, 5_000, 15_000, 30_000, 30_000])

function rehashTestEnvelope(envelope) {
  envelope.recordSha256 = canonicalRecordSha256(envelope.record)
}

function rechainTestJournal(journalEnvelope) {
  let previous = null
  journalEnvelope.record.events = journalEnvelope.record.events.map(({ event }, index) => {
    const next = canonicalEventEnvelope(
      {
        ...event,
        sequence: index + 1,
        previousEventSha256: previous,
      },
      previous,
    )
    previous = next.eventSha256
    return next
  })
  journalEnvelope.record.updatedAt = journalEnvelope.record.events.at(-1).event.recordedAt
  rehashTestEnvelope(journalEnvelope)
}

function rebindTestProposal(receipt) {
  const proposal = receipt.record.proposedEnvelope
  const journal = receipt.record.journalEnvelope
  rehashTestEnvelope(proposal)
  journal.record.proposedRecordSha256 = proposal.recordSha256
  journal.record.events[0].event.payload.proposedRecordSha256 = proposal.recordSha256
  rechainTestJournal(journal)
  rehashTestEnvelope(receipt)
}

test("verify independently replays the receipt and revalidates the exact live survivor read-only", async (t) => {
  const harness = await verificationFixture(t)
  const result = await verifyDuplicateDraftConsolidation(
    { receipt: "scripts/release/duplicate-draft-consolidation.json" },
    harness.dependencies,
  )

  assert.deepEqual(result, {
    status: "verified",
    survivor: DUPLICATE_DRAFT_SURVIVOR_ID,
    deleted: [...DUPLICATE_DRAFT_IDS],
    receipt: "scripts/release/duplicate-draft-consolidation.json",
    receiptSha256: harness.receipt.recordSha256,
    historicalParity:
      "Historical duplicate payload parity is supported by embedded pre-delete evidence plus the currently reverified survivor; deleted bytes were not independently re-downloaded.",
  })
  assert.deepEqual(harness.calls, [
    `direct:${DUPLICATE_DRAFT_IDS[0]}`,
    `direct:${DUPLICATE_DRAFT_IDS[1]}`,
    "releases",
    "final-authority",
  ])
  assert.equal(harness.writerCalls, 0)
  assert.equal((await stat(harness.receiptPath)).mode & 0o777, 0o644)
})

test("verify rejects every receipt, embedded-envelope, event-chain, evidence, and identity tamper before claims", async (t) => {
  const cases = [
    [
      "outer digest",
      (receipt) => {
        receipt.recordSha256 = "f".repeat(64)
      },
    ],
    [
      "embedded proposal digest",
      (receipt) => {
        receipt.record.proposedEnvelope.recordSha256 = "f".repeat(64)
        rehashTestEnvelope(receipt)
      },
    ],
    [
      "embedded journal digest",
      (receipt) => {
        receipt.record.journalEnvelope.recordSha256 = "f".repeat(64)
        rehashTestEnvelope(receipt)
      },
    ],
    [
      "event digest",
      (receipt) => {
        receipt.record.journalEnvelope.record.events[1].eventSha256 = "f".repeat(64)
        rehashTestEnvelope(receipt.record.journalEnvelope)
        rehashTestEnvelope(receipt)
      },
    ],
    [
      "event previous link",
      (receipt) => {
        const events = receipt.record.journalEnvelope.record.events
        events[1] = canonicalEventEnvelope(
          { ...events[1].event, previousEventSha256: "f".repeat(64) },
          "f".repeat(64),
        )
        rehashTestEnvelope(receipt.record.journalEnvelope)
        rehashTestEnvelope(receipt)
      },
    ],
    [
      "journal truncation",
      (receipt) => {
        receipt.record.journalEnvelope.record.events.pop()
        receipt.record.journalEnvelope.record.updatedAt =
          receipt.record.journalEnvelope.record.events.at(-1).event.recordedAt
        rehashTestEnvelope(receipt.record.journalEnvelope)
        rehashTestEnvelope(receipt)
      },
    ],
    [
      "proposal evidence",
      (receipt) => {
        receipt.record.proposedEnvelope.record.releases[0].semantic.name = "tampered survivor"
        rebindTestProposal(receipt)
      },
    ],
    [
      "final authority evidence",
      (receipt) => {
        const authority = receipt.record.finalAuthority
        authority.releases[0].assets[0].label = "tampered"
        receipt.record.finalSurvivor = structuredClone(authority.releases[0])
        receipt.record.journalEnvelope.record.events.at(-1).event.payload.authority =
          structuredClone(authority)
        rechainTestJournal(receipt.record.journalEnvelope)
        rehashTestEnvelope(receipt)
      },
    ],
    [
      "intermediate authority evidence",
      (receipt) => {
        const event = receipt.record.journalEnvelope.record.events.find(
          ({ event: candidate }) => candidate.type === "delete-authority-observed",
        ).event
        event.payload.authority.releases[0].semantic.name = "tampered intermediate survivor"
        rechainTestJournal(receipt.record.journalEnvelope)
        rehashTestEnvelope(receipt)
      },
    ],
    [
      "intermediate asset identity",
      (receipt) => {
        const event = receipt.record.journalEnvelope.record.events.find(
          ({ event: candidate }) => candidate.type === "delete-authority-observed",
        ).event
        event.payload.authority.releases[0].assets[0].id = "999999999"
        rechainTestJournal(receipt.record.journalEnvelope)
        rehashTestEnvelope(receipt)
      },
    ],
    [
      "controller identity",
      (receipt) => {
        receipt.record.proposedEnvelope.record.controller = {
          headSha: "c".repeat(40),
          originMainSha: "c".repeat(40),
          githubMainSha: "c".repeat(40),
        }
        receipt.record.journalEnvelope.record.events[0].event.payload.controllerSha = "c".repeat(40)
        rebindTestProposal(receipt)
      },
    ],
    [
      "repository identity",
      (receipt) => {
        receipt.record.proposedEnvelope.record.repository.name = "other/repo"
        receipt.record.journalEnvelope.record.repository.name = "other/repo"
        rebindTestProposal(receipt)
      },
    ],
    [
      "confirmation binding",
      (receipt) => {
        receipt.record.journalEnvelope.record.confirmationSha256 = "f".repeat(64)
        receipt.record.journalEnvelope.record.events[0].event.payload.confirmationSha256 =
          "f".repeat(64)
        rechainTestJournal(receipt.record.journalEnvelope)
        rehashTestEnvelope(receipt)
      },
    ],
  ]

  for (const [name, mutate] of cases) {
    await t.test(name, async (t) => {
      const harness = await verificationFixture(t)
      const tampered = structuredClone(harness.receipt)
      mutate(tampered)
      await writeFile(harness.receiptPath, `${JSON.stringify(tampered)}\n`)
      await assert.rejects(
        verifyDuplicateDraftConsolidation(
          { receipt: "scripts/release/duplicate-draft-consolidation.json" },
          harness.dependencies,
        ),
        /failed/iu,
      )
      assert.deepEqual(harness.calls, [])
      assert.equal(harness.writerCalls, 0)
    })
  }
})

test("verify stops on deleted-ID presence, list disagreement, survivor drift, or final authority drift without mutation", async (t) => {
  for (const drift of [
    "deleted-present",
    "deleted-listed",
    "extra-managed",
    "survivor",
    "asset",
    "main",
    "workflow",
    "run",
    "tag",
    "npm",
  ]) {
    await t.test(drift, async (t) => {
      const harness = await verificationFixture(t, { drift })
      await assert.rejects(
        verifyDuplicateDraftConsolidation(
          { receipt: "scripts/release/duplicate-draft-consolidation.json" },
          harness.dependencies,
        ),
        /failed/iu,
      )
      assert.equal(harness.writerCalls, 0)
    })
  }
})

test("verify applies the tracked-receipt nofollow and non-writable source-file policy before adapters", async (t) => {
  for (const kind of ["symlink", "group-writable"]) {
    await t.test(kind, async (t) => {
      const harness = await verificationFixture(t)
      if (kind === "symlink") {
        await rm(harness.receiptPath)
        await symlink(path.join(harness.dependencies.repositoryRoot, OUTPUT), harness.receiptPath)
      } else {
        await chmod(harness.receiptPath, 0o664)
      }
      await assert.rejects(
        verifyDuplicateDraftConsolidation(
          { receipt: "scripts/release/duplicate-draft-consolidation.json" },
          harness.dependencies,
        ),
        /failed/iu,
      )
      assert.deepEqual(harness.calls, [])
      assert.equal(harness.writerCalls, 0)
    })
  }
})

test("perform durably completes both targets in order and writes the canonical final receipt", async (t) => {
  const harness = await performFixture(t)
  const result = await performDuplicateDraftConsolidation(harness.input, harness.dependencies)

  assert.deepEqual(harness.calls, [
    "perform-initial",
    "delete:379982100",
    "delete:379986168",
    "final",
    "receipt",
  ])
  assert.deepEqual(result, {
    status: "complete",
    survivor: DUPLICATE_DRAFT_SURVIVOR_ID,
    deleted: [...DUPLICATE_DRAFT_IDS],
    receipt: "scripts/release/duplicate-draft-consolidation.json",
    receiptSha256: result.receiptSha256,
  })
  assert.match(result.receiptSha256, /^[0-9a-f]{64}$/u)
  const receipt = parseConsolidationEnvelope(
    "final",
    await readTrackedReceipt(
      harness.receiptPath,
      DUPLICATE_DRAFT_CONSOLIDATION_LIMITS.finalReceiptBytes,
    ),
  )
  assert.equal(receipt.record.journalEnvelope.record.events[0].event.type, "operation-started")
  assert.deepEqual(
    receipt.record.journalEnvelope.record.events
      .filter(({ event }) => event.type === "absence-converged")
      .map(({ event }) => event.payload.targetReleaseId),
    [...DUPLICATE_DRAFT_IDS],
  )
  assert.equal(
    receipt.record.journalEnvelope.record.events.at(-1).event.type,
    "final-authority-observed",
  )
  assert.equal(receipt.record.finalSurvivor.id, DUPLICATE_DRAFT_SURVIVOR_ID)
  assert.deepEqual(
    [
      ...receipt.record.proposedEnvelope.record.npmInventories.map(({ stage }) => stage),
      ...receipt.record.journalEnvelope.record.events.flatMap(({ event }) => {
        if (event.type === "npm-observed") return [event.payload.inventory.stage]
        if (event.type === "delete-authority-observed") {
          return [event.payload.authority.npmInventory.stage]
        }
        if (event.type === "final-authority-observed") {
          return [event.payload.authority.npmInventory.stage]
        }
        return []
      }),
    ],
    [
      "inspect-initial",
      "inspect-ready",
      "perform-initial",
      "pre-delete-1",
      "pre-delete-2",
      "final",
    ],
  )
})

test("perform binds the exact proposal digest and confirmation before any operation", async (t) => {
  const harness = await performFixture(t)
  const wrongDigest = "f".repeat(64)
  for (const input of [
    {
      ...harness.input,
      proposalSha256: wrongDigest,
      confirmation: harness.input.confirmation.replace(harness.proposal.recordSha256, wrongDigest),
    },
    { ...harness.input, confirmation: `${harness.input.confirmation} altered` },
  ]) {
    await assert.rejects(
      performDuplicateDraftConsolidation(input, harness.dependencies),
      /failed/iu,
    )
  }
  const changedProposal = createConsolidationEnvelope("proposed", {
    ...harness.proposal.record,
    inspectedAt: new Date(Date.parse(harness.proposal.record.inspectedAt) + 1_000).toISOString(),
  })
  await writePrivateEnvelope(
    path.join(harness.dependencies.repositoryRoot, OUTPUT),
    canonicalConsolidationEnvelopeBytes("proposed", changedProposal),
  )
  await assert.rejects(
    performDuplicateDraftConsolidation(harness.input, harness.dependencies),
    /failed/iu,
  )
  assert.deepEqual(harness.calls, [])
})

test("perform refuses journal genesis when a prior durable head survives", async (t) => {
  const harness = await performFixture(t)
  await writePrivateEnvelope(
    harness.journalPath.replace(/journal\.json$/u, "journal.head.json"),
    Buffer.from("orphan durable head\n", "utf8"),
  )
  await assert.rejects(
    performDuplicateDraftConsolidation(harness.input, harness.dependencies),
    /failed/iu,
  )
  assert.deepEqual(harness.calls, [])
})

test("perform resumes a failed receipt publication without another DELETE and rematerializes identical bytes", async (t) => {
  const harness = await performFixture(t, { failReceiptOnce: true })
  await assert.rejects(
    performDuplicateDraftConsolidation(harness.input, harness.dependencies),
    /failed/iu,
  )
  const finalJournal = await readPrivateEnvelope(
    harness.journalPath,
    DUPLICATE_DRAFT_CONSOLIDATION_LIMITS.journalBytes,
  )
  const expected = createFinalConsolidationReceipt({
    proposedEnvelope: harness.proposal,
    journalEnvelope: parseConsolidationEnvelope("journal", finalJournal),
    finalAuthority: deriveConsolidationState(finalJournal).lastAuthority,
    completedAt: deriveConsolidationState(finalJournal).lastAuthority.observedAt,
  })
  const result = await performDuplicateDraftConsolidation(harness.input, harness.dependencies)
  assert.equal(result.receiptSha256, expected.recordSha256)
  assert.equal(harness.calls.filter((entry) => entry.startsWith("delete:")).length, 2)
  assert.equal(harness.calls.filter((entry) => entry === "final").length, 2)
})

test("perform receipt resume freshly rechecks final authority and stops on every live drift", async (t) => {
  for (const drift of [
    "main",
    "npm-publication",
    "survivor",
    "asset",
    "duplicate-reappeared",
    "extra-release",
    "workflow",
    "run",
    "tag",
  ]) {
    await t.test(drift, async (t) => {
      const harness = await performFixture(t, {
        failReceiptOnce: true,
        resumeFinalDrift: drift,
      })
      await assert.rejects(
        performDuplicateDraftConsolidation(harness.input, harness.dependencies),
        /failed/iu,
      )
      await assert.rejects(
        performDuplicateDraftConsolidation(harness.input, harness.dependencies),
        /failed/iu,
      )
      assert.equal(harness.calls.filter((entry) => entry.startsWith("delete:")).length, 2)
      assert.equal(harness.calls.filter((entry) => entry === "receipt").length, 1)
    })
  }
})

test("perform accepts an existing byte-identical canonical receipt without overwrite after fresh validation", async (t) => {
  const harness = await performFixture(t)
  const first = await performDuplicateDraftConsolidation(harness.input, harness.dependencies)
  const durable = await readFile(harness.receiptPath)
  const second = await performDuplicateDraftConsolidation(harness.input, harness.dependencies)
  assert.deepEqual(second, first)
  assert.equal(harness.calls.filter((entry) => entry === "final").length, 2)
  assert.equal(harness.calls.filter((entry) => entry === "receipt").length, 1)
  assert.deepEqual(await readFile(harness.receiptPath), durable)
})

test("CLI performs the complete production-composed consolidation using only external service fakes", async (t) => {
  const harness = await productionPerformRehearsalFixture(t)
  const code = await runDuplicateDraftConsolidationCli(harness.options)
  assert.equal(code, 0, harness.stderr.value)
  assert.equal(harness.stderr.value, "")
  assert.deepEqual(harness.deleteIds, [...DUPLICATE_DRAFT_IDS])
  assert.equal(harness.deleteIds.includes(DUPLICATE_DRAFT_SURVIVOR_ID), false)

  const firstDelete = harness.events.indexOf(`delete:${DUPLICATE_DRAFT_IDS[0]}`)
  const secondDelete = harness.events.indexOf(`delete:${DUPLICATE_DRAFT_IDS[1]}`)
  assert.ok(firstDelete > 0)
  assert.ok(secondDelete > firstDelete)
  const downloads = (from, to) =>
    harness.events.slice(from, to).filter((entry) => entry.startsWith("download:")).length
  assert.equal(downloads(0, firstDelete), 270)
  assert.equal(downloads(firstDelete + 1, secondDelete), 90)
  assert.equal(downloads(secondDelete + 1), 45)
  for (const [from, to, expectedIds] of [
    [0, firstDelete, [DUPLICATE_DRAFT_SURVIVOR_ID, ...DUPLICATE_DRAFT_IDS]],
    [firstDelete + 1, secondDelete, [DUPLICATE_DRAFT_SURVIVOR_ID, DUPLICATE_DRAFT_IDS[1]]],
    [secondDelete + 1, harness.events.length, [DUPLICATE_DRAFT_SURVIVOR_ID]],
  ]) {
    const sets = harness.events
      .slice(from, to)
      .filter((entry) => entry.startsWith("releases:"))
      .map((entry) => entry.slice("releases:".length))
    assert.ok(sets.length > 0)
    assert.equal(
      sets.every((entry) => entry === expectedIds.join(",")),
      true,
    )
  }
  assert.equal(harness.events.filter((entry) => entry === "local-main").length, 3)
  assert.equal(harness.events.filter((entry) => entry === "github-main").length, 3)
  assert.equal(harness.events.filter((entry) => entry === "npm").length, 84)

  const receiptBytes = await readTrackedReceipt(
    harness.receiptPath,
    DUPLICATE_DRAFT_CONSOLIDATION_LIMITS.finalReceiptBytes,
  )
  const receipt = parseConsolidationEnvelope("final", receiptBytes)
  assert.deepEqual(
    [
      ...receipt.record.proposedEnvelope.record.npmInventories.map(({ stage }) => stage),
      ...receipt.record.journalEnvelope.record.events.flatMap(({ event }) => {
        if (event.type === "npm-observed") return [event.payload.inventory.stage]
        if (event.type === "delete-authority-observed") {
          return [event.payload.authority.npmInventory.stage]
        }
        if (event.type === "final-authority-observed") {
          return [event.payload.authority.npmInventory.stage]
        }
        return []
      }),
    ],
    [
      "inspect-initial",
      "inspect-ready",
      "perform-initial",
      "pre-delete-1",
      "pre-delete-2",
      "final",
    ],
  )
  assert.equal((await stat(harness.receiptPath)).mode & 0o777, 0o644)
  assert.deepEqual(JSON.parse(harness.stdout.value), {
    status: "complete",
    survivor: DUPLICATE_DRAFT_SURVIVOR_ID,
    deleted: [...DUPLICATE_DRAFT_IDS],
    receipt: "scripts/release/duplicate-draft-consolidation.json",
    receiptSha256: receipt.recordSha256,
  })

  const beforeVerify = harness.events.length
  const deletesBeforeVerify = [...harness.deleteIds]
  harness.stdout.value = ""
  harness.options.argv = [
    "verify",
    "--receipt",
    "scripts/release/duplicate-draft-consolidation.json",
  ]
  assert.equal(await runDuplicateDraftConsolidationCli(harness.options), 0, harness.stderr.value)
  assert.deepEqual(harness.deleteIds, deletesBeforeVerify)
  const verifyEvents = harness.events.slice(beforeVerify)
  assert.equal(
    verifyEvents.filter((entry) => entry === `get-release:${DUPLICATE_DRAFT_IDS[0]}`).length,
    1,
  )
  assert.equal(
    verifyEvents.filter((entry) => entry === `get-release:${DUPLICATE_DRAFT_IDS[1]}`).length,
    1,
  )
  assert.equal(
    verifyEvents.filter((entry) => entry.startsWith(`download:${DUPLICATE_DRAFT_SURVIVOR_ID}:`))
      .length,
    45,
  )
  assert.equal(verifyEvents.filter((entry) => entry === "npm").length, 21)
  assert.equal(verifyEvents.filter((entry) => entry === "attestations").length, 1)
  assert.deepEqual(JSON.parse(harness.stdout.value), {
    status: "verified",
    survivor: DUPLICATE_DRAFT_SURVIVOR_ID,
    deleted: [...DUPLICATE_DRAFT_IDS],
    receipt: "scripts/release/duplicate-draft-consolidation.json",
    receiptSha256: receipt.recordSha256,
    historicalParity:
      "Historical duplicate payload parity is supported by embedded pre-delete evidence plus the currently reverified survivor; deleted bytes were not independently re-downloaded.",
  })
})

test("production-composed CLI stops after target one when main advances before target two", async (t) => {
  const harness = await productionPerformRehearsalFixture(t, { driftMainAfterFirstDelete: true })
  assert.equal(await runDuplicateDraftConsolidationCli(harness.options), 1)
  assert.deepEqual(harness.deleteIds, [DUPLICATE_DRAFT_IDS[0]])
  assert.equal(harness.stderr.value, "Duplicate-draft perform failed.\n")
  await assert.rejects(readFile(harness.receiptPath), /ENOENT/iu)
})

test("perform recovers post-rename receipt ambiguity only after fresh final validation", async (t) => {
  const harness = await performFixture(t, { postRenameReceiptFailureOnce: true })
  await assert.rejects(
    performDuplicateDraftConsolidation(harness.input, harness.dependencies),
    /failed/iu,
  )
  const durable = await readFile(harness.receiptPath)
  const result = await performDuplicateDraftConsolidation(harness.input, harness.dependencies)
  assert.match(result.receiptSha256, /^[0-9a-f]{64}$/u)
  assert.equal(harness.calls.filter((entry) => entry.startsWith("delete:")).length, 2)
  assert.equal(harness.calls.filter((entry) => entry === "final").length, 2)
  assert.equal(harness.calls.filter((entry) => entry === "receipt").length, 1)
  assert.deepEqual(await readFile(harness.receiptPath), durable)
})

test("perform rejects an exact durable receipt when its mandatory fresh final recheck drifts", async (t) => {
  const harness = await performFixture(t, { resumeFinalDrift: "main" })
  await performDuplicateDraftConsolidation(harness.input, harness.dependencies)
  const durable = await readFile(harness.receiptPath)
  await assert.rejects(
    performDuplicateDraftConsolidation(harness.input, harness.dependencies),
    /failed/iu,
  )
  assert.equal(harness.calls.filter((entry) => entry.startsWith("delete:")).length, 2)
  assert.equal(harness.calls.filter((entry) => entry === "receipt").length, 1)
  assert.deepEqual(await readFile(harness.receiptPath), durable)
})

test("perform never overwrites malformed, different canonical, or unsafe existing receipts", async (t) => {
  for (const kind of ["malformed", "different", "unsafe"]) {
    await t.test(kind, async (t) => {
      const harness = await performFixture(t)
      await performDuplicateDraftConsolidation(harness.input, harness.dependencies)
      const beforeCalls = [...harness.calls]
      if (kind === "malformed") {
        await writeTrackedReceipt(harness.receiptPath, Buffer.from("malformed\n", "utf8"))
      } else if (kind === "different") {
        const receipt = parseConsolidationEnvelope(
          "final",
          await readTrackedReceipt(
            harness.receiptPath,
            DUPLICATE_DRAFT_CONSOLIDATION_LIMITS.finalReceiptBytes,
          ),
        )
        const different = createConsolidationEnvelope("final", {
          ...receipt.record,
          completedAt: new Date(Date.parse(receipt.record.completedAt) + 1_000).toISOString(),
        })
        await writeTrackedReceipt(
          harness.receiptPath,
          canonicalConsolidationEnvelopeBytes("final", different),
        )
      } else {
        await rm(harness.receiptPath)
        await symlink(harness.proposalPath, harness.receiptPath)
      }
      await assert.rejects(
        performDuplicateDraftConsolidation(harness.input, harness.dependencies),
        /failed/iu,
      )
      assert.deepEqual(harness.calls, beforeCalls)
    })
  }
})

test("perform rejects a canonical completed history that omitted perform-initial proof", async (t) => {
  const harness = await performFixture(t)
  const confirmationSha256 = createHash("sha256")
    .update(harness.input.confirmation, "utf8")
    .digest("hex")
  const genesis = createConsolidationJournal({
    proposedEnvelope: harness.proposal,
    confirmationSha256,
    recordedAt: harness.proposal.record.inspectedAt,
  })
  await harness.persistJournal(genesis)
  await harness.dependencies.performOneDeletion({ targetReleaseId: DUPLICATE_DRAFT_IDS[0] })
  await harness.dependencies.performOneDeletion({ targetReleaseId: DUPLICATE_DRAFT_IDS[1] })
  harness.calls.length = 0
  await assert.rejects(
    performDuplicateDraftConsolidation(harness.input, harness.dependencies),
    /failed/iu,
  )
  assert.deepEqual(harness.calls, [])
})

test("journal replay rejects reordered, duplicate, and wrong-target perform-initial histories", async (t) => {
  const harness = await performFixture(t)
  const confirmationSha256 = createHash("sha256")
    .update(harness.input.confirmation, "utf8")
    .digest("hex")
  const genesis = createConsolidationJournal({
    proposedEnvelope: harness.proposal,
    confirmationSha256,
    recordedAt: harness.proposal.record.inspectedAt,
  })
  const inventory = harness.performInventory()
  const correct = appendJournalEvent(
    genesis,
    "npm-observed",
    { targetReleaseId: DUPLICATE_DRAFT_IDS[0], attemptNumber: 1, inventory },
    inventory.completedAt,
  )
  assert.throws(
    () =>
      appendJournalEvent(
        correct,
        "npm-observed",
        { targetReleaseId: DUPLICATE_DRAFT_IDS[0], attemptNumber: 1, inventory },
        inventory.completedAt,
      ),
    /npm|state|legal/iu,
  )
  assert.throws(
    () =>
      appendJournalEvent(
        genesis,
        "npm-observed",
        { targetReleaseId: DUPLICATE_DRAFT_IDS[1], attemptNumber: 1, inventory },
        inventory.completedAt,
      ),
    /target|current/iu,
  )
  const authority = harness.deletionAuthority(0)
  assert.throws(
    () =>
      appendJournalEvent(
        appendJournalEvent(
          genesis,
          "delete-authority-observed",
          {
            targetReleaseId: DUPLICATE_DRAFT_IDS[0],
            attemptNumber: 1,
            authority,
          },
          authority.observedAt,
        ),
        "npm-observed",
        { targetReleaseId: DUPLICATE_DRAFT_IDS[0], attemptNumber: 1, inventory },
        new Date(Date.parse(authority.observedAt) + 1_000).toISOString(),
      ),
    /npm|state|legal/iu,
  )
})

test("perform resumes the durable initial npm stage by repeating payload proof before any DELETE", async (t) => {
  const harness = await performFixture(t, { failInitialVerificationOnce: true })
  await assert.rejects(
    performDuplicateDraftConsolidation(harness.input, harness.dependencies),
    /failed/iu,
  )
  assert.deepEqual(harness.calls, ["perform-initial", "verify-initial"])
  await performDuplicateDraftConsolidation(harness.input, harness.dependencies)
  assert.equal(harness.calls.filter((entry) => entry === "perform-initial").length, 1)
  assert.equal(harness.calls.filter((entry) => entry === "verify-initial").length, 2)
  assert.equal(harness.calls.filter((entry) => entry.startsWith("delete:")).length, 2)
})

test("perform stops between targets on main, publication, survivor, or managed-set drift", async (t) => {
  for (const drift of ["main", "publication", "survivor", "fourth-draft"]) {
    await t.test(drift, async (t) => {
      const harness = await performFixture(t, { failSecondTarget: drift })
      await assert.rejects(
        performDuplicateDraftConsolidation(harness.input, harness.dependencies),
        /failed/iu,
      )
      assert.deepEqual(
        harness.calls.filter((entry) => entry.startsWith("delete:")),
        ["delete:379982100"],
      )
      assert.equal(harness.calls.includes("receipt"), false)
    })
  }
})

test("one-target deletion rejects a numeric or survivor target before creating network adapters", async () => {
  let adapterCreations = 0
  const dependencies = Object.freeze({
    async createAdapters() {
      adapterCreations += 1
      throw new Error("network adapter creation must not be reached")
    },
    async wait() {
      assert.fail("wait must not be reached")
    },
  })
  for (const targetReleaseId of [379982100, DUPLICATE_DRAFT_SURVIVOR_ID]) {
    await assert.rejects(
      performOneDuplicateDeletion(
        {
          proposedEnvelope: {},
          confirmation: "invalid",
          targetReleaseId,
          journalPath: "/tmp/duplicate-draft-consolidation.journal.json",
        },
        dependencies,
      ),
      /failed/iu,
    )
  }
  assert.equal(adapterCreations, 0)
})

test("one-target deletion durably orders authority, intent, confirmed outcome, and two-source convergence", async (t) => {
  const harness = await oneDeletionFixture(t, {
    deleteClassifications: ["confirmed-204"],
  })
  const result = await performOneDuplicateDeletion(harness.input, harness.dependencies)

  assert.deepEqual(result, {
    status: "converged",
    targetReleaseId: DUPLICATE_DRAFT_IDS[0],
    attemptNumber: 1,
    basis: "confirmed-204",
  })
  assert.deepEqual(harness.events, [
    "authority:pre-delete-1:379982100",
    "durable:authority",
    "durable:intent",
    "delete:379982100",
    "durable:outcome:confirmed-204",
    "direct:379982100",
    "list",
  ])
  const journal = await readPrivateEnvelope(
    harness.input.journalPath,
    DUPLICATE_DRAFT_CONSOLIDATION_LIMITS.journalBytes,
  )
  const state = deriveConsolidationState(journal)
  assert.equal(state.phase, "target-converged")
  assert.deepEqual(state.completedTargets, [DUPLICATE_DRAFT_IDS[0]])
  assert.equal(state.currentTargetReleaseId, DUPLICATE_DRAFT_IDS[1])
  assert.deepEqual(
    parseConsolidationEnvelope("journal", journal).record.events.map(({ event }) => event.type),
    [
      "operation-started",
      "delete-authority-observed",
      "delete-intent",
      "delete-outcome",
      "absence-converged",
    ],
  )
})

test("one-target deletion resumes a lost post-DELETE outcome as absent ambiguity without another writer", async (t) => {
  const harness = await oneDeletionFixture(t, {
    deleteClassifications: ["confirmed-204"],
  })
  await assert.rejects(
    performOneDuplicateDeletion(harness.input, harness.dependenciesWithFault("after-delete")),
    /failed/iu,
  )
  const result = await performOneDuplicateDeletion(harness.input, harness.dependencies)
  assert.equal(result.basis, "ambiguous")
  assert.equal(harness.events.filter((entry) => entry.startsWith("delete:")).length, 1)
  const state = deriveConsolidationState(
    await readPrivateEnvelope(
      harness.input.journalPath,
      DUPLICATE_DRAFT_CONSOLIDATION_LIMITS.journalBytes,
    ),
  )
  assert.equal(state.phase, "target-converged")
})

test("one-target deletion gives an unchanged ambiguous target six complete reads before fresh attempt two", async (t) => {
  const harness = await oneDeletionFixture(t, {
    deleteClassifications: ["transport-ambiguous", "confirmed-204"],
  })
  const result = await performOneDuplicateDeletion(harness.input, harness.dependencies)
  assert.equal(result.basis, "confirmed-204")
  assert.equal(harness.events.filter((entry) => entry === "list").length, 7)
  assert.deepEqual(
    harness.events.filter((entry) => entry.startsWith("authority:")),
    ["authority:pre-delete-1:379982100", "authority:pre-delete-1:379982100"],
  )
  const journal = parseConsolidationEnvelope(
    "journal",
    await readPrivateEnvelope(
      harness.input.journalPath,
      DUPLICATE_DRAFT_CONSOLIDATION_LIMITS.journalBytes,
    ),
  )
  assert.deepEqual(
    journal.record.events
      .filter(({ event }) => event.type === "delete-intent")
      .map(({ event }) => event.payload.attemptNumber),
    [1, 2],
  )
})

test("one-target retry persists the actual fresh 45-asset target evidence before binding that same authority", async (t) => {
  const harness = await oneDeletionFixture(t, {
    deleteClassifications: ["transport-ambiguous", "confirmed-204"],
    freshAuthorityMutation: "volatile",
  })
  await performOneDuplicateDeletion(harness.input, harness.dependencies)
  const journal = parseConsolidationEnvelope(
    "journal",
    await readPrivateEnvelope(
      harness.input.journalPath,
      DUPLICATE_DRAFT_CONSOLIDATION_LIMITS.journalBytes,
    ),
  )
  const authorities = journal.record.events.filter(
    ({ event }) => event.type === "delete-authority-observed",
  )
  const retry = journal.record.events.find(
    ({ event }) =>
      event.type === "resume-reconciliation" &&
      event.payload.classification === "present-unchanged-retryable",
  )
  assert.equal(authorities.length, 2)
  assert.equal(retry.event.payload.releaseEvidence.assets.length, 45)
  assert.notDeepEqual(
    retry.event.payload.releaseEvidence,
    authorities[0].event.payload.authority.targetRead.evidence,
  )
  assert.deepEqual(
    retry.event.payload.releaseEvidence,
    authorities[1].event.payload.authority.targetRead.evidence,
  )
  assert.ok(journal.record.events.indexOf(retry) < journal.record.events.indexOf(authorities[1]))
  const secondCapture = harness.events.lastIndexOf("authority:pre-delete-1:379982100")
  assert.deepEqual(harness.events.slice(secondCapture), [
    "authority:pre-delete-1:379982100",
    "durable:authority",
    "durable:intent",
    "delete:379982100",
    "durable:outcome:confirmed-204",
    "direct:379982100",
    "list",
  ])
})

test("one-target retry refreshes npm only beyond the exact two-minute boundary", async (t) => {
  for (const { ageMs, stale } of [
    { ageMs: 120_000, stale: false },
    { ageMs: 120_001, stale: true },
  ]) {
    await t.test(`${ageMs}ms`, async (t) => {
      const harness = await oneDeletionFixture(t, {
        deleteClassifications: ["transport-ambiguous", "confirmed-204"],
        freshAuthorityAdvanceMs: stale ? 61_000 : 1_000,
      })
      const timeline = retryWallClockTimeline(harness.authorityTime, ageMs, {
        heavyVerificationMs: 20_000,
      })
      await performOneDuplicateDeletion(
        harness.input,
        harness.dependenciesWithWallClockTimeline(timeline),
      )
      const journal = parseConsolidationEnvelope(
        "journal",
        await readPrivateEnvelope(
          harness.input.journalPath,
          DUPLICATE_DRAFT_CONSOLIDATION_LIMITS.journalBytes,
        ),
      )
      const npmEvents = journal.record.events.filter(({ event }) => event.type === "npm-observed")
      assert.equal(npmEvents.length, stale ? 1 : 0)
      if (!stale) {
        assert.equal(
          harness.events.some((entry) => entry.startsWith("npm:")),
          false,
        )
        return
      }
      assert.equal(npmEvents[0].event.payload.attemptNumber, 2)
      assert.equal(npmEvents[0].event.payload.inventory.stage, "perform-initial")
      assert.equal(
        harness.events.filter((entry) => entry.startsWith("npm:")).length,
        CANONICAL_RELEASE_PACKAGE_ORDER.length,
      )
      assert.equal(
        harness.events.filter((entry) => entry.startsWith("payload-download:")).length,
        135,
      )
      assert.equal(harness.waits.at(-1), 40_000)
      const retryAuthorityIndex = harness.events.lastIndexOf("authority:pre-delete-1:379982100")
      assert.deepEqual(harness.events.slice(retryAuthorityIndex), [
        "authority:pre-delete-1:379982100",
        "durable:authority",
        "durable:intent",
        "delete:379982100",
        "durable:outcome:confirmed-204",
        "direct:379982100",
        "list",
      ])
    })
  }
})

test("second-target retry verifies the exact remaining set across the npm freshness boundary", async (t) => {
  for (const { ageMs, stale } of [
    { ageMs: 120_000, stale: false },
    { ageMs: 120_001, stale: true },
  ]) {
    await t.test(`${ageMs}ms`, async (t) => {
      const harness = await oneDeletionFixture(t, {
        targetIndex: 1,
        deleteClassifications: ["transport-ambiguous", "confirmed-204"],
        freshAuthorityAdvanceMs: stale ? 61_000 : 1_000,
      })
      await performOneDuplicateDeletion(
        harness.input,
        harness.dependenciesWithWallClockTimeline(
          retryWallClockTimeline(harness.authorityTime, ageMs, {
            heavyVerificationMs: 20_000,
          }),
        ),
      )

      const journalBytes = await readFile(harness.input.journalPath)
      assert.ok(journalBytes.byteLength <= DUPLICATE_DRAFT_CONSOLIDATION_LIMITS.journalBytes)
      const journal = parseConsolidationEnvelope("journal", journalBytes)
      const npmEvents = journal.record.events.filter(({ event }) => event.type === "npm-observed")
      assert.equal(npmEvents.length, stale ? 1 : 0)
      assert.equal(
        harness.events.filter((entry) => entry.startsWith("payload-download:")).length,
        stale ? 90 : 0,
      )
      assert.equal(
        harness.events.filter((entry) => entry === "payload-attestations").length,
        stale ? 2 : 0,
      )
      if (stale) {
        assert.equal(npmEvents[0].event.payload.inventory.stage, "perform-initial")
        assert.equal(harness.waits.at(-1), 40_000)
      }
      const retryAuthorityIndex = harness.events.lastIndexOf("authority:pre-delete-2:379986168")
      assert.deepEqual(harness.events.slice(retryAuthorityIndex), [
        "authority:pre-delete-2:379986168",
        "durable:authority",
        "durable:intent",
        "delete:379986168",
        "durable:outcome:confirmed-204",
        "direct:379986168",
        "list",
      ])
    })
  }
})

test("second-target stale retry rejects changed, missing, or extra remaining Release evidence", async (t) => {
  for (const mutation of ["metadata-included", "asset-included", "missing", "extra"]) {
    await t.test(mutation, async (t) => {
      const harness = await oneDeletionFixture(t, {
        targetIndex: 1,
        deleteClassifications: ["transport-ambiguous"],
        retryRemainingMutation: mutation,
      })
      await assert.rejects(
        performOneDuplicateDeletion(
          harness.input,
          harness.dependenciesWithWallClockTimeline(
            retryWallClockTimeline(harness.authorityTime, 120_001),
          ),
        ),
        /failed/iu,
      )
      assert.equal(harness.events.filter((entry) => entry.startsWith("delete:")).length, 1)
      assert.equal(
        harness.events.filter((entry) => entry.startsWith("payload-download:")).length,
        mutation === "metadata-included" ? 45 : mutation === "asset-included" ? 90 : 0,
      )
      const state = deriveConsolidationState(
        await readPrivateEnvelope(
          harness.input.journalPath,
          DUPLICATE_DRAFT_CONSOLIDATION_LIMITS.journalBytes,
        ),
      )
      assert.equal(state.phase, "npm-observed")
    })
  }
})

test("second-target stale retry resumes npm durability crashes without replaying the uncertain DELETE", async (t) => {
  for (const faultAt of ["after-npm-journal", "after-npm-head"]) {
    await t.test(faultAt, async (t) => {
      const harness = await oneDeletionFixture(t, {
        targetIndex: 1,
        deleteClassifications: ["transport-ambiguous", "confirmed-204"],
        freshAuthorityAdvanceMs: 61_000,
      })
      await assert.rejects(
        performOneDuplicateDeletion(
          harness.input,
          harness.dependenciesWithWallClockTimeline(
            retryWallClockTimeline(harness.authorityTime, 120_001),
            faultAt,
          ),
        ),
        /failed/iu,
      )
      const interrupted = parseConsolidationEnvelope(
        "journal",
        await readPrivateEnvelope(
          harness.input.journalPath,
          DUPLICATE_DRAFT_CONSOLIDATION_LIMITS.journalBytes,
        ),
      )
      const npmEvent = interrupted.record.events.find(({ event }) => event.type === "npm-observed")
      assert.ok(npmEvent)
      assert.equal(deriveConsolidationState(interrupted).phase, "npm-observed")
      assert.equal(harness.events.filter((entry) => entry.startsWith("delete:")).length, 1)

      const completedAt = Date.parse(npmEvent.event.payload.inventory.completedAt)
      await performOneDuplicateDeletion(
        harness.input,
        harness.dependenciesWithWallClockTimeline(
          Object.freeze([
            new Date(completedAt + 30_000).toISOString(),
            new Date(completedAt + 60_000).toISOString(),
          ]),
        ),
      )
      assert.equal(harness.events.filter((entry) => entry.startsWith("delete:")).length, 2)
      const resumed = parseConsolidationEnvelope(
        "journal",
        await readPrivateEnvelope(
          harness.input.journalPath,
          DUPLICATE_DRAFT_CONSOLIDATION_LIMITS.journalBytes,
        ),
      )
      assert.equal(
        resumed.record.events.filter(({ event }) => event.type === "npm-observed").length,
        1,
      )
    })
  }
})

test("second-target stale retry rejects a future or reversing wall clock", async (t) => {
  for (const scenario of ["future", "reversal"]) {
    await t.test(scenario, async (t) => {
      const harness = await oneDeletionFixture(t, {
        targetIndex: 1,
        deleteClassifications: ["transport-ambiguous"],
      })
      const authorityMs = Date.parse(harness.authorityTime)
      const timeline =
        scenario === "future"
          ? Object.freeze([new Date(authorityMs - 1).toISOString()])
          : Object.freeze([
              new Date(authorityMs + 120_001).toISOString(),
              new Date(authorityMs + 120_000).toISOString(),
            ])
      await assert.rejects(
        performOneDuplicateDeletion(
          harness.input,
          harness.dependenciesWithWallClockTimeline(timeline),
        ),
        /failed/iu,
      )
      assert.equal(harness.events.filter((entry) => entry.startsWith("delete:")).length, 1)
    })
  }
})

test("one-target stale npm retry resumes either npm durability crash without duplicating evidence", async (t) => {
  for (const faultAt of ["after-npm-journal", "after-npm-head"]) {
    await t.test(faultAt, async (t) => {
      const harness = await oneDeletionFixture(t, {
        deleteClassifications: ["transport-ambiguous", "confirmed-204"],
        freshAuthorityAdvanceMs: 61_000,
      })
      await assert.rejects(
        performOneDuplicateDeletion(
          harness.input,
          harness.dependenciesWithWallClockTimeline(
            retryWallClockTimeline(harness.authorityTime, 120_001),
            faultAt,
          ),
        ),
        /failed/iu,
      )
      const interrupted = parseConsolidationEnvelope(
        "journal",
        await readPrivateEnvelope(
          harness.input.journalPath,
          DUPLICATE_DRAFT_CONSOLIDATION_LIMITS.journalBytes,
        ),
      )
      const npmEvent = interrupted.record.events.find(({ event }) => event.type === "npm-observed")
      assert.ok(npmEvent, JSON.stringify(harness.events))
      const npmCompletedAt = npmEvent.event.payload.inventory.completedAt
      assert.equal(deriveConsolidationState(interrupted).phase, "npm-observed")

      await performOneDuplicateDeletion(
        harness.input,
        harness.dependenciesWithWallClockTimeline(
          Object.freeze([
            new Date(Date.parse(npmCompletedAt) + 30_000).toISOString(),
            new Date(Date.parse(npmCompletedAt) + 60_000).toISOString(),
          ]),
        ),
      )
      const resumed = parseConsolidationEnvelope(
        "journal",
        await readPrivateEnvelope(
          harness.input.journalPath,
          DUPLICATE_DRAFT_CONSOLIDATION_LIMITS.journalBytes,
        ),
      )
      assert.equal(
        resumed.record.events.filter(({ event }) => event.type === "npm-observed").length,
        1,
      )
      assert.equal(harness.events.filter((entry) => entry.startsWith("delete:")).length, 2)
    })
  }
})

test("one-target stale npm retry fails closed on wall-clock future, reversal, or payload verification failure", async (t) => {
  for (const scenario of ["future", "reversal", "payload"]) {
    await t.test(scenario, async (t) => {
      const harness = await oneDeletionFixture(t, {
        deleteClassifications: ["transport-ambiguous"],
        ...(scenario === "payload" ? { retryPayloadFailure: true } : {}),
      })
      const authorityMs = Date.parse(harness.authorityTime)
      const timeline =
        scenario === "future"
          ? Object.freeze([new Date(authorityMs - 1).toISOString()])
          : scenario === "reversal"
            ? Object.freeze([
                new Date(authorityMs + 120_001).toISOString(),
                new Date(authorityMs + 120_000).toISOString(),
              ])
            : retryWallClockTimeline(harness.authorityTime, 120_001)
      await assert.rejects(
        performOneDuplicateDeletion(
          harness.input,
          harness.dependenciesWithWallClockTimeline(timeline),
        ),
        /failed/iu,
      )
      assert.equal(harness.events.filter((entry) => entry.startsWith("delete:")).length, 1)
      const state = deriveConsolidationState(
        await readPrivateEnvelope(
          harness.input.journalPath,
          DUPLICATE_DRAFT_CONSOLIDATION_LIMITS.journalBytes,
        ),
      )
      assert.equal(state.phase, scenario === "payload" ? "npm-observed" : "delete-outcome")
    })
  }
})

test("one-target retry stops when the fresh full authority capture finds included asset drift", async (t) => {
  const harness = await oneDeletionFixture(t, {
    deleteClassifications: ["transport-ambiguous"],
    freshAuthorityMutation: "asset-included",
  })
  await assert.rejects(performOneDuplicateDeletion(harness.input, harness.dependencies), /failed/iu)
  assert.equal(harness.events.filter((entry) => entry.startsWith("delete:")).length, 1)
  const state = deriveConsolidationState(
    await readPrivateEnvelope(
      harness.input.journalPath,
      DUPLICATE_DRAFT_CONSOLIDATION_LIMITS.journalBytes,
    ),
  )
  assert.equal(state.phase, "delete-outcome")
})

test("one-target deletion preserves received 404 ambiguity while converging absence", async (t) => {
  const harness = await oneDeletionFixture(t, {
    deleteClassifications: ["response-404-ambiguous"],
  })
  const result = await performOneDuplicateDeletion(harness.input, harness.dependencies)
  assert.equal(result.basis, "ambiguous")
  const journal = parseConsolidationEnvelope(
    "journal",
    await readPrivateEnvelope(
      harness.input.journalPath,
      DUPLICATE_DRAFT_CONSOLIDATION_LIMITS.journalBytes,
    ),
  )
  assert.equal(
    journal.record.events.find(({ event }) => event.type === "delete-outcome").event.payload
      .classification,
    "response-404-ambiguous",
  )
})

test("one-target deletion resumes each exact intent, request, outcome, resume, and convergence crash boundary", async (t) => {
  const scenarios = [
    ["after-intent-journal", ["confirmed-204"], 1, "confirmed-204", "delete-intent"],
    ["after-intent-head", ["confirmed-204"], 1, "confirmed-204", "delete-intent"],
    ["before-delete", ["confirmed-204"], 1, "confirmed-204", "delete-intent"],
    ["after-delete", ["confirmed-204"], 1, "ambiguous", "delete-intent"],
    ["after-outcome-journal", ["confirmed-204"], 1, "confirmed-204", "delete-outcome"],
    ["after-outcome-head", ["confirmed-204"], 1, "confirmed-204", "delete-outcome"],
    [
      "after-resume-journal",
      ["transport-ambiguous", "confirmed-204"],
      2,
      "confirmed-204",
      "resume-present",
    ],
    [
      "after-resume-head",
      ["transport-ambiguous", "confirmed-204"],
      2,
      "confirmed-204",
      "resume-present",
    ],
    ["after-convergence-journal", ["confirmed-204"], 1, "confirmed-204", "target-converged"],
    ["after-convergence-head", ["confirmed-204"], 1, "confirmed-204", "target-converged"],
  ]
  for (const [faultAt, deleteClassifications, deleteCalls, basis, crashPhase] of scenarios) {
    await t.test(faultAt, async (t) => {
      const harness = await oneDeletionFixture(t, { deleteClassifications })
      await assert.rejects(
        performOneDuplicateDeletion(harness.input, harness.dependenciesWithFault(faultAt)),
        /failed/iu,
      )
      assert.equal(
        deriveConsolidationState(
          await readPrivateEnvelope(
            harness.input.journalPath,
            DUPLICATE_DRAFT_CONSOLIDATION_LIMITS.journalBytes,
          ),
        ).phase,
        crashPhase,
      )
      const result = await performOneDuplicateDeletion(harness.input, harness.dependencies)
      assert.equal(result.status, "converged")
      assert.equal(result.basis, basis)
      assert.equal(
        harness.events.filter((entry) => entry.startsWith("delete:")).length,
        deleteCalls,
      )
      const journal = parseConsolidationEnvelope(
        "journal",
        await readPrivateEnvelope(
          harness.input.journalPath,
          DUPLICATE_DRAFT_CONSOLIDATION_LIMITS.journalBytes,
        ),
      )
      assert.equal(deriveConsolidationState(journal).phase, "target-converged")
      assert.deepEqual(
        await readPrivateEnvelope(
          harness.input.journalPath.replace(/journal\.json$/u, "journal.head.json"),
          16 * 1024,
        ),
        testJournalHeadBytes(harness.input.journalPath, journal),
      )
    })
  }
})

test("one-target deletion supersedes orphan authority after either authority durability crash window", async (t) => {
  for (const faultAt of ["after-authority-journal", "after-authority-head"]) {
    const harness = await oneDeletionFixture(t, {
      deleteClassifications: ["confirmed-204"],
    })
    await assert.rejects(
      performOneDuplicateDeletion(harness.input, harness.dependenciesWithFault(faultAt)),
      /failed/iu,
    )
    const result = await performOneDuplicateDeletion(harness.input, harness.dependencies)
    assert.equal(result.status, "converged")
    assert.equal(harness.events.filter((entry) => entry.startsWith("authority:")).length, 2)
    assert.equal(harness.events.filter((entry) => entry.startsWith("delete:")).length, 1)
  }
})

test("one-target deletion stops honestly before a second global orphan-authority recovery", async (t) => {
  const harness = await oneDeletionFixture(t, {
    deleteClassifications: ["confirmed-204"],
  })
  for (let crash = 0; crash < 2; crash += 1) {
    await assert.rejects(
      performOneDuplicateDeletion(
        harness.input,
        harness.dependenciesWithFault("after-authority-journal"),
      ),
      /failed/iu,
    )
  }
  await assert.rejects(performOneDuplicateDeletion(harness.input, harness.dependencies), /failed/iu)
  const journal = parseConsolidationEnvelope(
    "journal",
    await readPrivateEnvelope(
      harness.input.journalPath,
      DUPLICATE_DRAFT_CONSOLIDATION_LIMITS.journalBytes,
    ),
  )
  assert.equal(
    journal.record.events.filter(({ event }) => event.type === "delete-authority-observed").length,
    2,
  )
  assert.equal(harness.events.filter((entry) => entry.startsWith("delete:")).length, 0)
})

test("one-target deletion refreshes volatile retry evidence again after either resume durability crash", async (t) => {
  for (const faultAt of ["after-resume-journal", "after-resume-head"]) {
    const harness = await oneDeletionFixture(t, {
      deleteClassifications: ["transport-ambiguous", "confirmed-204"],
      freshAuthorityMutation: "volatile",
    })
    await assert.rejects(
      performOneDuplicateDeletion(harness.input, harness.dependenciesWithFault(faultAt)),
      /failed/iu,
    )
    const result = await performOneDuplicateDeletion(harness.input, harness.dependencies)
    assert.equal(result.status, "converged")
    const journal = parseConsolidationEnvelope(
      "journal",
      await readPrivateEnvelope(
        harness.input.journalPath,
        DUPLICATE_DRAFT_CONSOLIDATION_LIMITS.journalBytes,
      ),
    )
    const retry = journal.record.events.find(
      ({ event }) =>
        event.type === "resume-reconciliation" &&
        event.payload.classification === "present-unchanged-retryable",
    )
    const retryAuthority = journal.record.events.find(
      ({ event }) =>
        event.type === "delete-authority-observed" && event.payload.attemptNumber === 2,
    )
    assert.notDeepEqual(
      retry.event.payload.releaseEvidence,
      retryAuthority.event.payload.authority.targetRead.evidence,
    )
  }
})

test("one-target deletion resumes either convergence durability crash window from its completed target", async (t) => {
  for (const faultAt of ["after-convergence-journal", "after-convergence-head"]) {
    const harness = await oneDeletionFixture(t, {
      deleteClassifications: ["confirmed-204"],
    })
    await assert.rejects(
      performOneDuplicateDeletion(harness.input, harness.dependenciesWithFault(faultAt)),
      /failed/iu,
    )
    const networkEventsBeforeResume = harness.events.length
    const result = await performOneDuplicateDeletion(harness.input, harness.dependencies)
    assert.deepEqual(result, {
      status: "converged",
      targetReleaseId: DUPLICATE_DRAFT_IDS[0],
      attemptNumber: 1,
      basis: "confirmed-204",
    })
    assert.equal(harness.events.length, networkEventsBeforeResume)
    assert.equal(harness.events.filter((entry) => entry.startsWith("delete:")).length, 1)
  }
})

test("one-target deletion stops on third ambiguity and never mints a fourth writer permit", async (t) => {
  const harness = await oneDeletionFixture(t, {
    deleteClassifications: ["transport-ambiguous", "transport-ambiguous", "transport-ambiguous"],
  })
  await assert.rejects(performOneDuplicateDeletion(harness.input, harness.dependencies), /failed/iu)
  assert.equal(harness.events.filter((entry) => entry.startsWith("delete:")).length, 3)
})

test("one-target deletion stops on reader disagreement, changed evidence, confirmed-204 presence, and bounded read errors", async (t) => {
  for (const scenario of [
    { deleteLeavesPresent: true },
    { retainDeletedInList: true },
    {
      deleteClassifications: ["transport-ambiguous"],
      currentMutation: "changed",
    },
    {
      deleteClassifications: ["transport-ambiguous"],
      currentMutation: "published",
    },
    {
      deleteClassifications: ["transport-ambiguous"],
      currentMutation: "malformed",
    },
    { convergenceDirectFailure: 403 },
    { convergenceDirectFailure: 429 },
    { convergenceDirectFailure: 500 },
    { convergenceDirectFailure: "timeout" },
    { convergenceListFailure: 429 },
  ]) {
    const harness = await oneDeletionFixture(t, {
      deleteClassifications: ["confirmed-204"],
      ...scenario,
    })
    await assert.rejects(
      performOneDuplicateDeletion(harness.input, harness.dependencies),
      /failed/iu,
    )
    assert.equal(harness.events.filter((entry) => entry.startsWith("delete:")).length, 1)
  }
})

test("one-target convergence shares one exact 90-second budget across six complete request pairs and waits", async (t) => {
  const timing = exactConvergenceTimeline([
    500, 500, 500, 500, 500, 500, 500, 500, 500, 500, 500, 3_500,
  ])
  const harness = await oneDeletionFixture(t, {
    deleteClassifications: ["transport-ambiguous"],
    absenceOnConvergenceAttempt: 6,
  })
  const result = await performOneDuplicateDeletion(
    harness.input,
    harness.dependenciesWithTimeline(timing.values),
  )
  assert.equal(result.basis, "ambiguous")
  assert.deepEqual(harness.waits, [1_000, 5_000, 15_000, 30_000, 30_000])
  assert.deepEqual(
    harness.requestBudgets.map(({ operation }) => operation),
    timing.requests.map(({ operation }) => operation),
  )
  for (const [index, { timeoutMs }] of harness.requestBudgets.entries()) {
    assert.ok(timeoutMs > 0)
    assert.ok(timeoutMs <= timing.requests[index].timeoutMs)
  }
  assert.ok(harness.requestBudgets.at(-1).timeoutMs <= 3_500)
  assert.equal(harness.events.filter((entry) => entry.startsWith("direct:")).length, 6)
  assert.equal(harness.events.filter((entry) => entry === "list").length, 6)
  assert.equal(timing.completedAt, 90_000)
})

test("one-target convergence stops on a reversed or future monotonic test trace before a seventh request", async (t) => {
  for (const timeline of [Object.freeze([0, 1, 0]), Object.freeze([0, 90_001])]) {
    const harness = await oneDeletionFixture(t, {
      deleteClassifications: ["transport-ambiguous"],
    })
    await assert.rejects(
      performOneDuplicateDeletion(harness.input, harness.dependenciesWithTimeline(timeline)),
      /failed/iu,
    )
    assert.equal(harness.events.filter((entry) => entry.startsWith("delete:")).length, 1)
    assert.ok(harness.events.filter((entry) => entry.startsWith("direct:")).length < 7)
  }
})

test("one-target deletion rejects an accessor-backed monotonic test trace without invocation or network", async (t) => {
  const harness = await oneDeletionFixture(t, {
    deleteClassifications: ["confirmed-204"],
  })
  let accessorCalls = 0
  const monotonicTimeline = new Array(2)
  for (let index = 0; index < monotonicTimeline.length; index += 1) {
    Object.defineProperty(monotonicTimeline, index, {
      enumerable: true,
      get() {
        accessorCalls += 1
        return index
      },
    })
  }
  Object.freeze(monotonicTimeline)
  const eventCount = harness.events.length
  await assert.rejects(
    performOneDuplicateDeletion(harness.input, harness.dependenciesWithTimeline(monotonicTimeline)),
    /failed/iu,
  )
  assert.equal(accessorCalls, 0)
  assert.equal(harness.events.length, eventCount)
})

test("one-target deletion rejects an accessor-backed wall-clock test trace without invocation or network", async (t) => {
  const harness = await oneDeletionFixture(t, {
    deleteClassifications: ["confirmed-204"],
  })
  let accessorCalls = 0
  const wallClockTimeline = new Array(1)
  Object.defineProperty(wallClockTimeline, 0, {
    enumerable: true,
    get() {
      accessorCalls += 1
      return harness.authorityTime
    },
  })
  Object.freeze(wallClockTimeline)
  const eventCount = harness.events.length
  await assert.rejects(
    performOneDuplicateDeletion(
      harness.input,
      harness.dependenciesWithWallClockTimeline(wallClockTimeline),
    ),
    /failed/iu,
  )
  assert.equal(accessorCalls, 0)
  assert.equal(harness.events.length, eventCount)
})

test("inspects the exact incident, observes the gap, and writes one canonical private proposal", async (t) => {
  const fixture = await inspectionFixture(t)
  const result = await inspectDuplicateDrafts(exactInput(), fixture.dependencies)

  assert.deepEqual(result, {
    proposalSha256: result.proposalSha256,
    version: DUPLICATE_DRAFT_CANDIDATE.version,
    commitSha: DUPLICATE_DRAFT_CANDIDATE.commitSha,
    survivor: DUPLICATE_DRAFT_SURVIVOR_ID,
    duplicates: [...DUPLICATE_DRAFT_IDS],
    output: OUTPUT,
  })
  assert.match(result.proposalSha256, /^[0-9a-f]{64}$/u)
  assert.equal(Object.isFrozen(result), true)
  assert.equal(Object.isFrozen(result.duplicates), true)
  assert.deepEqual(fixture.waits, [60_000])
  assert.equal(fixture.releaseFixture.downloadCount, 135)
  assert.deepEqual(fixture.npmCalls, [
    ...CANONICAL_RELEASE_PACKAGE_ORDER,
    ...CANONICAL_RELEASE_PACKAGE_ORDER,
  ])

  const target = path.join(fixture.root, OUTPUT)
  const bytes = await readFile(target)
  const envelope = parseConsolidationEnvelope("proposed", bytes)
  assert.equal(envelope.recordSha256, result.proposalSha256)
  assert.deepEqual(
    envelope.record.npmInventories.map(({ stage }) => stage),
    ["inspect-initial", "inspect-ready"],
  )
  assert.equal(
    Date.parse(envelope.record.npmInventories[1].startedAt) -
      Date.parse(envelope.record.npmInventories[0].completedAt),
    60_000,
  )
  assert.equal(envelope.record.confirmation.template, "<64-lowercase-hex-digest>")
  assert.deepEqual(envelope.record.controller, {
    headSha: CONTROLLER_SHA,
    originMainSha: CONTROLLER_SHA,
    githubMainSha: CONTROLLER_SHA,
  })
  assert.deepEqual(
    envelope.record.releases.map(({ role, id }) => ({ role, id })),
    [
      { role: "survivor", id: DUPLICATE_DRAFT_SURVIVOR_ID },
      { role: "duplicate", id: DUPLICATE_DRAFT_IDS[0] },
      { role: "duplicate", id: DUPLICATE_DRAFT_IDS[1] },
    ],
  )
  assert.equal((await stat(target)).mode & 0o777, 0o600)
  assert.equal((await lstat(target)).isSymbolicLink(), false)
  assert.deepEqual(fixture.releaseFixture.operations.slice(-6), [
    `get:${DUPLICATE_DRAFT_SURVIVOR_ID}`,
    `list-assets:${DUPLICATE_DRAFT_SURVIVOR_ID}`,
    `get:${DUPLICATE_DRAFT_IDS[0]}`,
    `list-assets:${DUPLICATE_DRAFT_IDS[0]}`,
    `get:${DUPLICATE_DRAFT_IDS[1]}`,
    `list-assets:${DUPLICATE_DRAFT_IDS[1]}`,
  ])
  assert.deepEqual(fixture.events, expectedInspectionEvents(fixture.releaseFixture))
  assert.equal(fixture.events.filter((event) => event.startsWith("download:")).length, 135)
  assert.equal(fixture.events.filter((event) => event.startsWith("attest:")).length, 3)
  assert.equal(fixture.events.filter((event) => event.startsWith("npm:initial:")).length, 21)
  assert.equal(fixture.events.filter((event) => event.startsWith("npm:ready:")).length, 21)
  assert.equal(fixture.events.filter((event) => event.startsWith("metadata:initial:")).length, 7)
  assert.equal(fixture.events.filter((event) => event.startsWith("metadata:final:")).length, 7)
  assert.equal(fixture.clockCallsAfterTerminal, 0)
  assert.throws(() => fixture.dependencies.now(), /terminal/iu)
  await assert.rejects(fixture.dependencies.adapters.github.getRepository(), /sealed|terminal/iu)
})

test("uses verification work inside the gap and waits only the exact nonnegative remainder", async (t) => {
  const fixture = await inspectionFixture(t, { verificationMs: 61_000 })
  await inspectDuplicateDrafts(exactInput(), fixture.dependencies)
  assert.deepEqual(fixture.waits, [])

  const second = await inspectionFixture(t, { verificationMs: 17_250 })
  await inspectDuplicateDrafts(exactInput(), second.dependencies)
  assert.deepEqual(second.waits, [42_750])
})

test("creates only the exact private proposal parent in a clean canonical repository", async (t) => {
  const fixture = await inspectionFixture(t, { makeReleaseDirectory: false })
  await inspectDuplicateDrafts(exactInput(), fixture.dependencies)
  assert.equal((await stat(path.join(fixture.root, ".dawn"))).isDirectory(), true)
  assert.equal((await stat(path.join(fixture.root, ".dawn", "release"))).isDirectory(), true)
  assert.equal((await stat(path.join(fixture.root, OUTPUT))).mode & 0o777, 0o600)
})

test("rejects a symlinked repository root before any adapter, download, or write", async (t) => {
  const parent = await realpath(await mkdtemp(path.join(os.tmpdir(), "dawn-inspect-link-")))
  t.after(() => rm(parent, { recursive: true, force: true }))
  const physical = path.join(parent, "physical")
  const linked = path.join(parent, "linked")
  await mkdir(physical)
  await symlink(physical, linked, "dir")
  const fixture = await inspectionFixture(t, {
    root: linked,
    makeReleaseDirectory: false,
  })
  await assert.rejects(inspectDuplicateDrafts(exactInput(), fixture.dependencies))
  assert.deepEqual(fixture.events, [])
  assert.equal(fixture.releaseFixture.downloadCount, 0)
  await assert.rejects(() => lstat(path.join(physical, ".dawn")), {
    code: "ENOENT",
  })
})

test("seal validation precedes root revalidation and rejects a root replacement from the seal boundary", async (t) => {
  const parent = await realpath(await mkdtemp(path.join(os.tmpdir(), "dawn-inspect-race-")))
  t.after(() => rm(parent, { recursive: true, force: true }))
  const root = path.join(parent, "checkout")
  const displaced = path.join(parent, "checkout-displaced")
  await mkdir(path.join(root, ".dawn", "release"), { recursive: true })
  const fixture = await inspectionFixture(t, {
    root,
    onSeal() {
      renameSync(root, displaced)
      mkdirSync(path.join(root, ".dawn", "release"), { recursive: true })
    },
  })
  await assert.rejects(inspectDuplicateDrafts(exactInput(), fixture.dependencies))
  assert.equal(fixture.events.includes("write"), false)
  await assert.rejects(() => readFile(path.join(root, OUTPUT)), {
    code: "ENOENT",
  })
  await assert.rejects(() => readFile(path.join(displaced, OUTPUT)), {
    code: "ENOENT",
  })
})

test("rejects any injected post-root-validation hook before adapter calls", async (t) => {
  const fixture = await inspectionFixture(t)
  await assert.rejects(
    inspectDuplicateDrafts(exactInput(), {
      ...fixture.dependencies,
      afterRootValidation() {
        assert.fail("post-root-validation hooks must be unreachable")
      },
    }),
  )
  assert.deepEqual(fixture.events, [])
})

test("rejects a retreating trusted clock without writing", async (t) => {
  const fixture = await inspectionFixture(t)
  let calls = 0
  const dependencies = Object.freeze({
    ...fixture.dependencies,
    now() {
      calls += 1
      return new Date(BASE_TIME - calls).toISOString()
    },
  })
  await assert.rejects(inspectDuplicateDrafts(exactInput(), dependencies))
  await assert.rejects(() => readFile(path.join(fixture.root, OUTPUT)), {
    code: "ENOENT",
  })
})

test("rejects malformed incident input before any adapter or filesystem call", async (t) => {
  const variants = [
    {},
    { ...exactInput(), version: "0.8.23" },
    { ...exactInput(), survivor: 379991871 },
    { ...exactInput(), duplicates: [...DUPLICATE_DRAFT_IDS].reverse() },
    {
      ...exactInput(),
      duplicates: [DUPLICATE_DRAFT_IDS[0], DUPLICATE_DRAFT_IDS[0]],
    },
    { ...exactInput(), output: `../${OUTPUT}` },
    { ...exactInput(), output: path.resolve("/tmp/proposed.json") },
    { ...exactInput(), extra: true },
    new Proxy(exactInput(), {}),
  ]
  const accessor = exactInput()
  Object.defineProperty(accessor, "version", {
    enumerable: true,
    get() {
      throw new Error("secret accessor")
    },
  })
  variants.push(accessor)
  const hidden = exactInput()
  Object.defineProperty(hidden, "hidden", { value: true })
  variants.push(hidden)
  const symbol = exactInput()
  symbol[Symbol("hidden")] = true
  variants.push(symbol)

  for (const input of variants) {
    let calls = 0
    const fixture = await inspectionFixture(t)
    const adapters = Object.freeze({
      ...fixture.dependencies.adapters,
      local: Object.freeze({
        async readState() {
          calls += 1
          throw new Error("called")
        },
      }),
    })
    await assert.rejects(
      inspectDuplicateDrafts(input, Object.freeze({ ...fixture.dependencies, adapters })),
    )
    assert.equal(calls, 0)
    await assert.rejects(() => readFile(path.join(fixture.root, OUTPUT)), {
      code: "ENOENT",
    })
  }
})

test("rejects unsafe dependencies and adapter descriptors before calls", async (t) => {
  const fixture = await inspectionFixture(t)
  const badAdapters = { ...fixture.dependencies.adapters }
  Object.defineProperty(badAdapters, "github", {
    enumerable: true,
    get() {
      throw new Error("credential body")
    },
  })
  const hiddenAdapters = { ...fixture.dependencies.adapters }
  Object.defineProperty(hiddenAdapters, "hidden", { value: true })
  Object.freeze(hiddenAdapters)
  const hiddenLocal = { ...fixture.dependencies.adapters.local }
  Object.defineProperty(hiddenLocal, "hidden", { value: true })
  Object.freeze(hiddenLocal)
  const hiddenLocalAdapters = replaceFacade(fixture.dependencies.adapters, "local", hiddenLocal)
  for (const dependencies of [
    { ...fixture.dependencies, extra: true },
    {
      ...fixture.dependencies,
      repositoryRootIdentity: Object.freeze({}),
    },
    { ...fixture.dependencies, adapters: badAdapters },
    { ...fixture.dependencies, adapters: hiddenAdapters },
    { ...fixture.dependencies, adapters: hiddenLocalAdapters },
    new Proxy(fixture.dependencies, {}),
  ]) {
    await assert.rejects(inspectDuplicateDrafts(exactInput(), dependencies), (error) => {
      assert.doesNotMatch(String(error), /credential body/iu)
      return true
    })
  }
})

test("fails closed on changed authority or non-E404 npm evidence without writing", async (t) => {
  for (const mutation of ["dirty", "active-workflow", "published-package"]) {
    const fixture = await inspectionFixture(t, { mutation })
    await assert.rejects(inspectDuplicateDrafts(exactInput(), fixture.dependencies))
    await assert.rejects(() => readFile(path.join(fixture.root, OUTPUT)), {
      code: "ENOENT",
    })
  }
})

test("rejects the historical candidate in every current-controller position before output effects", async (t) => {
  for (const candidateControllerField of ["local", "origin", "github"]) {
    const fixture = await inspectionFixture(t, {
      candidateControllerField,
      makeReleaseDirectory: false,
    })
    await assert.rejects(inspectDuplicateDrafts(exactInput(), fixture.dependencies))
    assert.equal(fixture.events.includes("write"), false)
    assert.deepEqual(
      fixture.events,
      candidateControllerField === "github"
        ? [
            "metadata:initial:local",
            "metadata:initial:repository",
            "metadata:initial:actor",
            "metadata:initial:main",
          ]
        : ["metadata:initial:local"],
    )
    await assert.rejects(() => lstat(path.join(fixture.root, ".dawn")), {
      code: "ENOENT",
    })
  }
})

test("rejects authority and release drift between complete capture phases without writing", async (t) => {
  for (const lateMutation of ["controller", "repository", "workflow", "tag", "release"]) {
    const fixture = await inspectionFixture(t, { lateMutation })
    await assert.rejects(inspectDuplicateDrafts(exactInput(), fixture.dependencies))
    assert.equal(fixture.events.includes("write"), false)
    await assert.rejects(() => readFile(path.join(fixture.root, OUTPUT)), {
      code: "ENOENT",
    })
  }
})

test("rejects a managed Release added or published during the observation gap", async (t) => {
  for (const lateRelease of ["extra-draft", "published"]) {
    const fixture = await inspectionFixture(t, { lateRelease })
    await assert.rejects(inspectDuplicateDrafts(exactInput(), fixture.dependencies))
    await assert.rejects(() => readFile(path.join(fixture.root, OUTPUT)), {
      code: "ENOENT",
    })
    assert.equal(fixture.releaseListCalls, 2)
  }
})

test("rejects an unsafe existing output and a symlinked release directory", async (t) => {
  const fixture = await inspectionFixture(t)
  const target = path.join(fixture.root, OUTPUT)
  await writeFile(target, "unsafe existing output\n", { mode: 0o644 })
  const original = await readFile(target)
  await assert.rejects(inspectDuplicateDrafts(exactInput(), fixture.dependencies))
  assert.deepEqual(await readFile(target), original)

  const linked = await inspectionFixture(t, { makeReleaseDirectory: false })
  const outside = await mkdtemp(path.join(os.tmpdir(), "dawn-inspect-outside-"))
  t.after(() => rm(outside, { recursive: true, force: true }))
  await mkdir(path.join(linked.root, ".dawn"), { recursive: true })
  await symlink(outside, path.join(linked.root, ".dawn", "release"), "dir")
  await assert.rejects(inspectDuplicateDrafts(exactInput(), linked.dependencies))
  assert.deepEqual(linked.events, [])
  assert.equal(linked.releaseFixture.downloadCount, 0)
  await assert.rejects(() => readFile(path.join(outside, path.basename(OUTPUT))), {
    code: "ENOENT",
  })
})

test("redacts remote diagnostics and never returns raw evidence", async (t) => {
  const fixture = await inspectionFixture(t, {
    remoteError: "token ghp_secret response body",
  })
  await assert.rejects(inspectDuplicateDrafts(exactInput(), fixture.dependencies), (error) => {
    assert.equal(error.message, "Duplicate-draft inspection failed.")
    assert.doesNotMatch(String(error), /ghp_secret|response body/iu)
    return true
  })
})

function replaceFacade(adapters, name, facade) {
  const replacement = { ...adapters, [name]: facade }
  Object.defineProperty(
    replacement,
    "captureConsolidationAuthority",
    Object.getOwnPropertyDescriptor(adapters, "captureConsolidationAuthority"),
  )
  return Object.freeze(replacement)
}

function exactInput() {
  return {
    version: DUPLICATE_DRAFT_CANDIDATE.version,
    commitSha: DUPLICATE_DRAFT_CANDIDATE.commitSha,
    survivor: DUPLICATE_DRAFT_SURVIVOR_ID,
    duplicates: [...DUPLICATE_DRAFT_IDS],
    output: OUTPUT,
  }
}

function expectedInspectionEvents(releaseFixture) {
  const metadata = (phase) =>
    ["local", "repository", "actor", "main", "workflow", "runs", "tag"].map(
      (operation) => `metadata:${phase}:${operation}`,
    )
  const hydration = releaseFixture.releases.flatMap((release) => [
    ...release.assets.map((asset) => `download:${release.id}:${asset.id}`),
    `attest:${release.id}`,
  ])
  const terminalReads = [DUPLICATE_DRAFT_SURVIVOR_ID, ...DUPLICATE_DRAFT_IDS].flatMap(
    (releaseId) => [`get:${releaseId}`, `list-assets:${releaseId}`],
  )
  return [
    ...metadata("initial"),
    ...CANONICAL_RELEASE_PACKAGE_ORDER.map((name) => `npm:initial:${name}`),
    "releases:initial",
    ...hydration,
    "wait:60000",
    ...CANONICAL_RELEASE_PACKAGE_ORDER.map((name) => `npm:ready:${name}`),
    "releases:final",
    ...metadata("final"),
    ...terminalReads,
  ]
}

async function inspectionFixture(t, options = {}) {
  const root =
    options.root ?? (await realpath(await mkdtemp(path.join(os.tmpdir(), "dawn-inspect-"))))
  if (options.root === undefined) t.after(() => rm(root, { recursive: true, force: true }))
  if (options.makeReleaseDirectory !== false)
    await mkdir(path.join(root, ".dawn", "release"), { recursive: true })
  const releaseFixture = createDuplicateDraftConsolidationFixture()
  const events = []
  const npmCalls = []
  const waits = []
  let releaseListCalls = 0
  let metadataPhase = "initial"
  let attestationCalls = 0
  let terminalComplete = false
  let clockCallsAfterTerminal = 0
  let nowMs = BASE_TIME
  const now = () => {
    if (terminalComplete) {
      clockCallsAfterTerminal += 1
      throw new Error("injected clock rejected after terminal completion")
    }
    return new Date(nowMs).toISOString()
  }
  const assertNetworkOpen = () => {
    if (terminalComplete) throw new Error("adapter rejected by terminal seal")
  }
  const localState = {
    headSha:
      options.candidateControllerField === "local"
        ? DUPLICATE_DRAFT_CANDIDATE.commitSha
        : CONTROLLER_SHA,
    branch: "main",
    porcelainStatus: options.mutation === "dirty" ? " M package.json" : "",
    originMainSha:
      options.candidateControllerField === "origin"
        ? DUPLICATE_DRAFT_CANDIDATE.commitSha
        : CONTROLLER_SHA,
  }
  const adapters = {
    local: Object.freeze({
      async readState() {
        assertNetworkOpen()
        events.push(`metadata:${metadataPhase}:local`)
        if (metadataPhase === "final" && options.lateMutation === "controller") {
          return {
            ...structuredClone(localState),
            headSha: "c".repeat(40),
            originMainSha: "c".repeat(40),
          }
        }
        return structuredClone(localState)
      },
    }),
    github: Object.freeze({
      async getRepository() {
        assertNetworkOpen()
        events.push(`metadata:${metadataPhase}:repository`)
        if (options.remoteError) throw new Error(options.remoteError)
        if (metadataPhase === "final" && options.lateMutation === "repository") {
          return {
            name: "cacheplane/dawnai",
            id: "1210070283",
            defaultBranch: "main",
          }
        }
        return {
          name: "cacheplane/dawnai",
          id: "1210070282",
          defaultBranch: "main",
        }
      },
      async getAuthenticatedUser() {
        assertNetworkOpen()
        events.push(`metadata:${metadataPhase}:actor`)
        return { login: "blove", id: "61436" }
      },
      async getDefaultBranchSha() {
        assertNetworkOpen()
        events.push(`metadata:${metadataPhase}:main`)
        return metadataPhase === "final" && options.lateMutation === "controller"
          ? "c".repeat(40)
          : options.candidateControllerField === "github"
            ? DUPLICATE_DRAFT_CANDIDATE.commitSha
            : CONTROLLER_SHA
      },
      async getWorkflowState() {
        assertNetworkOpen()
        events.push(`metadata:${metadataPhase}:workflow`)
        return {
          workflowId: "202458345",
          path: ".github/workflows/release.yml",
          state:
            options.mutation === "active-workflow" ||
            (metadataPhase === "final" && options.lateMutation === "workflow")
              ? "active"
              : "disabled_manually",
        }
      },
      async listNonterminalWorkflowRuns(query) {
        assertNetworkOpen()
        events.push(`metadata:${metadataPhase}:runs`)
        return { query: structuredClone(query), runs: [] }
      },
      async getAnnotatedTag() {
        assertNetworkOpen()
        events.push(`metadata:${metadataPhase}:tag`)
        return {
          name: "v0.8.22",
          objectSha:
            metadataPhase === "final" && options.lateMutation === "tag"
              ? "c".repeat(40)
              : "a".repeat(40),
          targetSha: DUPLICATE_DRAFT_CANDIDATE.commitSha,
          objectType: "tag",
          observedAt: now(),
        }
      },
      async listReleases() {
        assertNetworkOpen()
        releaseListCalls += 1
        const phase = releaseListCalls === 1 ? "initial" : "final"
        events.push(`releases:${phase}`)
        nowMs += options.verificationMs ?? 0
        const releases = structuredClone(releaseFixture.releases)
        if (releaseListCalls === 2 && options.lateRelease === "extra-draft") {
          const extra = structuredClone(releases[1])
          extra.id = 379999999
          extra.node_id = "RE_late_extra"
          extra.tag_name = "untagged-late-extra"
          for (const [index, asset] of extra.assets.entries()) {
            asset.id = 990_000 + index
            asset.node_id = `RA_late_${index}`
          }
          releases.push(extra)
        }
        if (releaseListCalls === 2 && options.lateRelease === "published") {
          releases[0].draft = false
          releases[0].published_at = "2026-09-01T12:01:00Z"
        }
        if (phase === "final") metadataPhase = "final"
        return {
          status: "PRESENT",
          operation: "releases",
          httpStatus: 200,
          code: null,
          value: releases,
        }
      },
      async downloadReleaseAsset(request) {
        assertNetworkOpen()
        events.push(`download:${request.releaseId}:${request.assetId}`)
        return releaseFixture.github.downloadReleaseAsset(request)
      },
      async getRelease(request) {
        assertNetworkOpen()
        events.push(`get:${request.releaseId}`)
        const result = await releaseFixture.github.getRelease(request)
        if (options.lateMutation === "release") result.value.name = "changed after observation"
        return result
      },
      async listReleaseAssets(request) {
        assertNetworkOpen()
        events.push(`list-assets:${request.releaseId}`)
        return releaseFixture.github.listReleaseAssets(request)
      },
    }),
    npm: Object.freeze({
      async observePackageVersion({ name }) {
        assertNetworkOpen()
        events.push(
          `npm:${npmCalls.length < CANONICAL_RELEASE_PACKAGE_ORDER.length ? "initial" : "ready"}:${name}`,
        )
        npmCalls.push(name)
        return options.mutation === "published-package"
          ? {
              status: "PRESENT",
              operation: "package-version",
              httpStatus: 200,
              code: null,
            }
          : {
              status: "ABSENT",
              operation: "package-version",
              httpStatus: 404,
              code: "E404",
            }
      },
    }),
    attestations: Object.freeze({
      async verify(request) {
        assertNetworkOpen()
        const releaseId = [DUPLICATE_DRAFT_SURVIVOR_ID, ...DUPLICATE_DRAFT_IDS][attestationCalls]
        attestationCalls += 1
        events.push(`attest:${releaseId}`)
        return releaseFixture.attestations.verify(request)
      },
    }),
    writer: Object.freeze({
      async deleteDuplicate() {
        assert.fail("inspection must not delete")
      },
    }),
  }
  Object.defineProperty(adapters, "captureConsolidationAuthority", {
    value: Object.freeze(async function captureConsolidationAuthority() {
      assert.fail("inspection must not capture delete authority")
    }),
    enumerable: false,
    writable: false,
    configurable: false,
  })
  Object.defineProperty(adapters, "captureInspectionTerminal", {
    value: Object.freeze(async function captureInspectionTerminal(input) {
      assertNetworkOpen()
      const releases = []
      for (const expectedEvidence of input.releases) {
        const read = await captureDirectTargetRead({
          candidate: input.candidate,
          releaseId: expectedEvidence.id,
          role: expectedEvidence.role,
          expectedEvidence,
          github: adapters.github,
          now,
        })
        releases.push(read.evidence)
      }
      await options.afterTerminal?.()
      const completedAt = new Date(nowMs).toISOString()
      terminalComplete = true
      return Object.freeze({
        releases: Object.freeze(releases),
        completedAt,
      })
    }),
    enumerable: false,
    writable: false,
    configurable: false,
  })
  Object.defineProperty(adapters, "assertInspectionTerminalSealed", {
    value: Object.freeze(function assertInspectionTerminalSealed() {
      if (!terminalComplete) throw new Error("inspection terminal is not sealed")
      options.onSeal?.()
    }),
    enumerable: false,
    writable: false,
    configurable: false,
  })
  Object.freeze(adapters)
  const dependencies = Object.freeze({
    repositoryRoot: root,
    adapters,
    now,
    async wait(milliseconds, { signal }) {
      assert.equal(signal instanceof AbortSignal, true)
      assert.equal(signal.aborted, false)
      waits.push(milliseconds)
      events.push(`wait:${milliseconds}`)
      nowMs += milliseconds
    },
  })
  return {
    root,
    releaseFixture,
    events,
    npmCalls,
    waits,
    get clockCallsAfterTerminal() {
      return clockCallsAfterTerminal
    },
    get releaseListCalls() {
      return releaseListCalls
    },
    dependencies,
  }
}

async function productionPerformRehearsalFixture(t, options = {}) {
  const inspection = await inspectionFixture(t)
  await inspectDuplicateDrafts(exactInput(), inspection.dependencies)
  await mkdir(path.join(inspection.root, "scripts", "release"), { recursive: true })
  const proposal = parseConsolidationEnvelope(
    "proposed",
    await readPrivateEnvelope(
      path.join(inspection.root, OUTPUT),
      DUPLICATE_DRAFT_CONSOLIDATION_LIMITS.proposedBytes,
    ),
  )
  const releaseFixture = createDuplicateDraftConsolidationFixture()
  const deleted = new Set()
  const deleteIds = []
  const events = []
  let nowMs = Date.now() + 60 * 60_000
  const now = () => new Date(nowMs++).toISOString()
  const currentReleases = () =>
    releaseFixture.releases
      .filter(({ id }) => !deleted.has(String(id)))
      .map((release) => structuredClone(release))
  const present = (operation, value) => ({
    status: "PRESENT",
    operation,
    httpStatus: 200,
    code: null,
    value,
  })
  const externalGithub = {
    async getRef({ ref }) {
      if (ref === "heads/main") {
        events.push("github-main")
        const sha =
          options.driftMainAfterFirstDelete && deleted.has(DUPLICATE_DRAFT_IDS[0])
            ? "c".repeat(40)
            : CONTROLLER_SHA
        return present("ref", {
          ref: "refs/heads/main",
          object: { type: "commit", sha },
        })
      }
      assert.equal(ref, `tags/${DUPLICATE_DRAFT_CANDIDATE.tag}`)
      return present("ref", {
        ref: `refs/tags/${DUPLICATE_DRAFT_CANDIDATE.tag}`,
        object: { type: "tag", sha: "a".repeat(40) },
      })
    },
    async getGitTag({ tagSha }) {
      assert.equal(tagSha, "a".repeat(40))
      return present("git-tag", {
        sha: tagSha,
        tag: DUPLICATE_DRAFT_CANDIDATE.tag,
        object: { type: "commit", sha: DUPLICATE_DRAFT_CANDIDATE.commitSha },
      })
    },
    async getWorkflow({ workflow }) {
      events.push(`workflow:${workflow}`)
      assert.equal(workflow, "release.yml")
      return present("workflow", {
        id: 202_458_345,
        path: ".github/workflows/release.yml",
        state: "disabled_manually",
      })
    },
    async listReleases() {
      const releases = currentReleases()
      events.push(`releases:${releases.map(({ id }) => id).join(",")}`)
      return present("releases", releases)
    },
    async getRelease({ releaseId }) {
      events.push(`get-release:${releaseId}`)
      const release = currentReleases().find(({ id }) => String(id) === String(releaseId))
      if (release === undefined) {
        return {
          status: "AMBIGUOUS",
          operation: "release",
          httpStatus: 404,
          code: "NOT_FOUND",
        }
      }
      return present("release", release)
    },
    async listReleaseAssets({ releaseId }) {
      const release = currentReleases().find(({ id }) => String(id) === String(releaseId))
      if (release === undefined) throw new Error("deleted Release has no assets")
      return present("release-assets", release.assets)
    },
    async downloadReleaseAsset(input) {
      events.push(`download:${input.releaseId}:${input.assetId}`)
      return releaseFixture.github.downloadReleaseAsset(input)
    },
  }
  const fetchImpl = async (url, init = {}) => {
    const target = String(url)
    if (init.method === "DELETE") {
      const releaseId = target.split("/").at(-1)
      assert.equal(DUPLICATE_DRAFT_IDS.includes(releaseId), true)
      assert.equal(deleted.has(releaseId), false)
      deleted.add(releaseId)
      deleteIds.push(releaseId)
      events.push(`delete:${releaseId}`)
      return new Response(null, { status: 204 })
    }
    if (target === "https://api.github.com/repos/cacheplane/dawnai") {
      return jsonTestResponse({
        id: 1_210_070_282,
        full_name: "cacheplane/dawnai",
        default_branch: "main",
      })
    }
    if (target === "https://api.github.com/user") {
      return jsonTestResponse({ id: 61_436, login: "blove" })
    }
    if (target.includes("/actions/workflows/") && target.includes("/runs?")) {
      return jsonTestResponse({ total_count: 0, workflow_runs: [] })
    }
    throw new Error(`unexpected rehearsal request ${target}`)
  }
  const run = async (_command, args) => {
    if (args[0] === "symbolic-ref") {
      return { exitCode: 0, stdout: "main\n", stderr: "" }
    }
    if (args[0] === "status") return { exitCode: 0, stdout: "", stderr: "" }
    if (args[0] === "rev-parse" && args.at(-1).startsWith("refs/remotes/origin/main")) {
      return { exitCode: 0, stdout: `${CONTROLLER_SHA}\n`, stderr: "" }
    }
    throw new Error(`unexpected rehearsal command ${args.join(" ")}`)
  }
  const createAdapters = () =>
    createDuplicateDraftConsolidationAdapters({
      cwd: inspection.root,
      token: "ghp_fixture_token_1234567890",
      environment: { HOME: inspection.root, PATH: "/tools" },
      dependencies: {
        fetchImpl,
        run,
        now,
        createGitHubReader() {
          return externalGithub
        },
        createOwnerPreflightAdapters() {
          return {
            git: {
              async headSha() {
                events.push("local-main")
                return CONTROLLER_SHA
              },
            },
          }
        },
        createNpmReader() {
          return {
            async observePackageVersion() {
              events.push("npm")
              return {
                status: "ABSENT",
                operation: "package-version",
                httpStatus: 404,
                code: "E404",
              }
            },
          }
        },
        createCliAttestationVerifier() {
          return {
            async verify(input) {
              events.push("attestations")
              return releaseFixture.attestations.verify(input)
            },
          }
        },
      },
    })
  const stdout = memorySink()
  const stderr = memorySink()
  const confirmation = `CONSOLIDATE v${proposal.record.candidate.version} ${proposal.record.candidate.commitSha} SURVIVOR ${proposal.record.roles.survivor} DELETE ${proposal.record.roles.duplicates.join(",")} PROPOSAL ${proposal.recordSha256}`
  return {
    deleteIds,
    events,
    stdout,
    stderr,
    receiptPath: path.join(inspection.root, "scripts/release/duplicate-draft-consolidation.json"),
    options: {
      argv: [
        "perform",
        "--proposal",
        ".dawn/release/duplicate-draft-consolidation.proposed.json",
        "--journal",
        ".dawn/release/duplicate-draft-consolidation.journal.json",
        "--receipt",
        "scripts/release/duplicate-draft-consolidation.json",
        "--confirmation",
        confirmation,
      ],
      cwd: inspection.root,
      environment: {},
      stdout,
      stderr,
      dependencies: {
        createAdapters,
        now,
        async wait(milliseconds, { signal }) {
          assert.equal(signal instanceof AbortSignal, true)
          nowMs += milliseconds
        },
      },
    },
  }
}

function jsonTestResponse(value) {
  return new Response(JSON.stringify(value), {
    status: 200,
    headers: { "content-type": "application/json" },
  })
}

function memorySink() {
  const sink = {
    value: "",
    write(chunk) {
      sink.value += String(chunk)
      return true
    },
  }
  return sink
}

async function performFixture(t, options = {}) {
  const inspection = await inspectionFixture(t)
  await inspectDuplicateDrafts(exactInput(), inspection.dependencies)
  const proposalPath = path.join(inspection.root, OUTPUT)
  const proposal = parseConsolidationEnvelope("proposed", await readFile(proposalPath))
  const confirmation = `CONSOLIDATE v${proposal.record.candidate.version} ${proposal.record.candidate.commitSha} SURVIVOR ${proposal.record.roles.survivor} DELETE ${proposal.record.roles.duplicates.join(",")} PROPOSAL ${proposal.recordSha256}`
  const journalPath = path.join(
    inspection.root,
    ".dawn/release/duplicate-draft-consolidation.journal.json",
  )
  const receiptPath = path.join(
    inspection.root,
    "scripts/release/duplicate-draft-consolidation.json",
  )
  await mkdir(path.dirname(receiptPath), { recursive: true })
  const calls = []
  let failReceipt = options.failReceiptOnce === true
  let failAfterReceiptRename = options.postRenameReceiptFailureOnce === true
  let failInitialVerification = options.failInitialVerificationOnce === true
  let finalCaptures = 0
  let tick = Date.parse(proposal.record.inspectedAt) + 1_000
  const nextTime = () => {
    const value = new Date(tick).toISOString()
    tick += 1_000
    return value
  }
  const inventory = (stage) => {
    const observedAt = nextTime()
    return {
      stage,
      startedAt: observedAt,
      completedAt: observedAt,
      packages: proposal.record.npmInventories[0].packages.map((entry) => ({
        ...entry,
        observedAt,
      })),
    }
  }
  const persistJournal = async (journal) => {
    await writePrivateEnvelope(journalPath, canonicalConsolidationEnvelopeBytes("journal", journal))
    await writePrivateEnvelope(
      journalPath.replace(/journal\.json$/u, "journal.head.json"),
      testJournalHeadBytes(journalPath, journal),
    )
  }
  const completeTarget = async ({ targetReleaseId }) => {
    if (targetReleaseId === DUPLICATE_DRAFT_IDS[1] && options.failSecondTarget !== undefined) {
      throw new Error(`simulated ${options.failSecondTarget} drift`)
    }
    calls.push(`delete:${targetReleaseId}`)
    let journal = parseConsolidationEnvelope(
      "journal",
      await readPrivateEnvelope(journalPath, DUPLICATE_DRAFT_CONSOLIDATION_LIMITS.journalBytes),
    )
    const targetIndex = DUPLICATE_DRAFT_IDS.indexOf(targetReleaseId)
    const targetEvidence = proposal.record.releases[targetIndex + 1]
    const authority = deletionAuthorityFixture({
      proposal,
      stage: targetIndex === 0 ? "pre-delete-1" : "pre-delete-2",
      targetEvidence,
      observedAt: nextTime(),
      releases:
        targetIndex === 0
          ? proposal.record.releases
          : [proposal.record.releases[0], proposal.record.releases[2]],
    })
    journal = appendJournalEvent(
      journal,
      "delete-authority-observed",
      { targetReleaseId, attemptNumber: 1, authority },
      authority.observedAt,
    )
    journal = appendJournalEvent(
      journal,
      "delete-intent",
      {
        targetReleaseId,
        attemptNumber: 1,
        authorityEventSha256: journal.record.events.at(-1).eventSha256,
      },
      nextTime(),
    )
    journal = appendJournalEvent(
      journal,
      "delete-outcome",
      {
        targetReleaseId,
        attemptNumber: 1,
        classification: "confirmed-204",
        httpStatus: 204,
        observedAt: nextTime(),
      },
      new Date(tick - 1_000).toISOString(),
    )
    const completedAt = nextTime()
    journal = appendJournalEvent(
      journal,
      "absence-converged",
      {
        targetReleaseId,
        attemptNumber: 1,
        basis: "confirmed-204",
        directGet404At: completedAt,
        listAbsentAt: completedAt,
        attempts: 1,
        completedAt,
      },
      completedAt,
    )
    await persistJournal(journal)
    return { status: "converged", targetReleaseId, attemptNumber: 1, basis: "confirmed-204" }
  }
  const captureFinal = async () => {
    calls.push("final")
    finalCaptures += 1
    const observedAt = nextTime()
    const authority = {
      stage: "final",
      controller: structuredClone(proposal.record.controller),
      annotatedTag: { ...structuredClone(proposal.record.annotatedTag), observedAt },
      workflowAuthority: {
        ...structuredClone(proposal.record.workflowAuthority),
        observedAt,
      },
      npmInventory: inventory("final"),
      releases: [structuredClone(proposal.record.releases[0])],
      payloadProof: structuredClone(proposal.record.payloadProof),
      targetRead: null,
      observedAt: nextTime(),
    }
    if (finalCaptures > 1) {
      if (options.resumeFinalDrift === "main") authority.controller.headSha = "c".repeat(40)
      if (options.resumeFinalDrift === "npm-publication") {
        authority.npmInventory.packages[0].status = "PRESENT"
        authority.npmInventory.packages[0].httpStatus = 200
        authority.npmInventory.packages[0].code = null
      }
      if (options.resumeFinalDrift === "survivor") {
        authority.releases[0].semantic.name = "changed survivor"
      }
      if (options.resumeFinalDrift === "asset") authority.releases[0].assets[0].label = "changed"
      if (options.resumeFinalDrift === "duplicate-reappeared") {
        authority.releases.push(structuredClone(proposal.record.releases[1]))
      }
      if (options.resumeFinalDrift === "extra-release") {
        const extra = structuredClone(proposal.record.releases[1])
        extra.id = "400000001"
        authority.releases.push(extra)
      }
      if (options.resumeFinalDrift === "workflow") authority.workflowAuthority.state = "active"
      if (options.resumeFinalDrift === "run") {
        authority.workflowAuthority.nonterminalRuns.push({
          id: "1",
          runAttempt: 1,
          status: "queued",
          event: "workflow_dispatch",
          headSha: proposal.record.controller.headSha,
          headBranch: "main",
        })
      }
      if (options.resumeFinalDrift === "tag") authority.annotatedTag.targetSha = "d".repeat(40)
    }
    return authority
  }
  return {
    proposal,
    proposalPath,
    journalPath,
    receiptPath,
    calls,
    persistJournal,
    performInventory: () => inventory("perform-initial"),
    deletionAuthority(targetIndex) {
      const targetEvidence = proposal.record.releases[targetIndex + 1]
      return deletionAuthorityFixture({
        proposal,
        stage: targetIndex === 0 ? "pre-delete-1" : "pre-delete-2",
        targetEvidence,
        observedAt: nextTime(),
        releases:
          targetIndex === 0
            ? proposal.record.releases
            : [proposal.record.releases[0], proposal.record.releases[2]],
      })
    },
    input: {
      proposal: ".dawn/release/duplicate-draft-consolidation.proposed.json",
      proposalSha256: proposal.recordSha256,
      journal: ".dawn/release/duplicate-draft-consolidation.journal.json",
      receipt: "scripts/release/duplicate-draft-consolidation.json",
      confirmation,
    },
    dependencies: Object.freeze({
      repositoryRoot: inspection.root,
      async createAdapters() {
        throw new Error("high-level test facade should prevent network composition")
      },
      now: nextTime,
      async wait() {},
      async capturePerformInitial() {
        calls.push("perform-initial")
        return inventory("perform-initial")
      },
      async verifyPerformInitial() {
        if (options.failInitialVerificationOnce !== undefined) calls.push("verify-initial")
        if (failInitialVerification) {
          failInitialVerification = false
          throw new Error("simulated initial verification failure")
        }
        tick += 60_000
      },
      performOneDeletion: completeTarget,
      captureFinalAuthority: captureFinal,
      async publishReceipt(target, bytes) {
        calls.push("receipt")
        assert.equal(target, receiptPath)
        if (failReceipt) {
          failReceipt = false
          throw new Error("simulated receipt write failure")
        }
        const { writeTrackedReceipt } = await import("../duplicate-draft-consolidation-files.mjs")
        await writeTrackedReceipt(target, bytes)
        if (failAfterReceiptRename) {
          failAfterReceiptRename = false
          throw new Error("simulated post-rename receipt durability ambiguity")
        }
      },
    }),
  }
}

async function verificationFixture(t, options = {}) {
  const performed = await performFixture(t)
  await performDuplicateDraftConsolidation(performed.input, performed.dependencies)
  const receipt = parseConsolidationEnvelope(
    "final",
    await readTrackedReceipt(
      performed.receiptPath,
      DUPLICATE_DRAFT_CONSOLIDATION_LIMITS.finalReceiptBytes,
    ),
  )
  const releaseFixture = createDuplicateDraftConsolidationFixture()
  const calls = []
  let writerCalls = 0
  const drift = options.drift
  const survivorRaw = structuredClone(releaseFixture.releases[0])
  const listed = [survivorRaw]
  if (drift === "deleted-listed") listed.push(structuredClone(releaseFixture.releases[1]))
  if (drift === "extra-managed") {
    const extra = structuredClone(releaseFixture.releases[1])
    extra.id = 400_000_001
    extra.node_id = "RE_extra_managed"
    extra.tag_name = "untagged-extra-managed"
    listed.push(extra)
  }
  const currentAuthority = structuredClone(receipt.record.finalAuthority)
  if (drift === "survivor") currentAuthority.releases[0].semantic.name = "changed survivor"
  if (drift === "asset") currentAuthority.releases[0].assets[0].label = "changed asset"
  if (drift === "main") currentAuthority.controller.headSha = "c".repeat(40)
  if (drift === "workflow") currentAuthority.workflowAuthority.state = "active"
  if (drift === "run") {
    currentAuthority.workflowAuthority.nonterminalRuns.push({
      id: "1",
      runAttempt: 1,
      status: "queued",
      event: "workflow_dispatch",
      headSha: currentAuthority.controller.headSha,
      headBranch: "main",
    })
  }
  if (drift === "tag") currentAuthority.annotatedTag.targetSha = "d".repeat(40)
  if (drift === "npm") {
    currentAuthority.npmInventory.packages[0].status = "PRESENT"
    currentAuthority.npmInventory.packages[0].httpStatus = 200
    currentAuthority.npmInventory.packages[0].code = null
  }

  const uncalled = async () => {
    throw new Error("unexpected verification adapter call")
  }
  const adapters = {
    local: Object.freeze({ readState: uncalled }),
    github: Object.freeze({
      getRepository: uncalled,
      getAuthenticatedUser: uncalled,
      getDefaultBranchSha: uncalled,
      getWorkflowState: uncalled,
      listNonterminalWorkflowRuns: uncalled,
      getAnnotatedTag: uncalled,
      async listReleases() {
        calls.push("releases")
        return {
          status: "PRESENT",
          operation: "releases",
          httpStatus: 200,
          code: null,
          value: structuredClone(listed),
        }
      },
      async getRelease({ releaseId }) {
        calls.push(`direct:${releaseId}`)
        if (drift === "deleted-present" && releaseId === DUPLICATE_DRAFT_IDS[0]) {
          return {
            status: "PRESENT",
            operation: "release",
            httpStatus: 200,
            code: null,
            value: structuredClone(releaseFixture.releases[1]),
          }
        }
        return {
          status: "AMBIGUOUS",
          operation: "release",
          httpStatus: 404,
          code: "NOT_FOUND",
        }
      },
      listReleaseAssets: uncalled,
      downloadReleaseAsset: uncalled,
    }),
    npm: Object.freeze({ observePackageVersion: uncalled }),
    attestations: Object.freeze({ verify: uncalled }),
    writer: Object.freeze({
      async deleteDuplicate() {
        writerCalls += 1
        throw new Error("verify must never mutate")
      },
    }),
  }
  Object.defineProperties(adapters, {
    captureConsolidationAuthority: {
      value: Object.freeze(async function captureConsolidationAuthority(input) {
        calls.push("final-authority")
        assert.equal(input.stage, "final")
        assert.equal(input.targetReleaseId, null)
        return Object.freeze({ authority: structuredClone(currentAuthority) })
      }),
      enumerable: false,
      writable: false,
      configurable: false,
    },
    captureInspectionTerminal: {
      value: Object.freeze(uncalled),
      enumerable: false,
      writable: false,
      configurable: false,
    },
    assertInspectionTerminalSealed: {
      value: Object.freeze(function assertInspectionTerminalSealed() {
        throw new Error("verify must not use inspection terminal state")
      }),
      enumerable: false,
      writable: false,
      configurable: false,
    },
  })
  Object.freeze(adapters)
  return {
    receipt,
    receiptPath: performed.receiptPath,
    calls,
    get writerCalls() {
      return writerCalls
    },
    dependencies: Object.freeze({
      repositoryRoot: performed.dependencies.repositoryRoot,
      async createAdapters() {
        return adapters
      },
    }),
  }
}

async function oneDeletionFixture(t, options) {
  const inspection = await inspectionFixture(t)
  await inspectDuplicateDrafts(exactInput(), inspection.dependencies)
  const proposalPath = path.join(inspection.root, OUTPUT)
  const proposal = parseConsolidationEnvelope("proposed", await readFile(proposalPath))
  const confirmation = `CONSOLIDATE v${proposal.record.candidate.version} ${proposal.record.candidate.commitSha} SURVIVOR ${proposal.record.roles.survivor} DELETE ${proposal.record.roles.duplicates.join(",")} PROPOSAL ${proposal.recordSha256}`
  const confirmationSha256 = createHash("sha256").update(confirmation, "utf8").digest("hex")
  const journalPath = path.join(
    inspection.root,
    ".dawn",
    "release",
    "duplicate-draft-consolidation.journal.json",
  )
  const headPath = journalPath.replace(/journal\.json$/u, "journal.head.json")
  let journal = createConsolidationJournal({
    proposedEnvelope: proposal,
    confirmationSha256,
    recordedAt: proposal.record.inspectedAt,
  })

  const events = []
  const waits = []
  const requestBudgets = []
  const targetIndex = options.targetIndex ?? 0
  const targetReleaseId = DUPLICATE_DRAFT_IDS[targetIndex]
  if (targetIndex !== 0 && targetIndex !== 1) throw new Error("invalid fixture target index")
  if (targetIndex === 1) {
    const seedAuthorityTime = new Date(
      Date.parse(proposal.record.inspectedAt) + 1_000,
    ).toISOString()
    const seedTargetEvidence = proposal.record.releases.find(
      ({ id }) => id === DUPLICATE_DRAFT_IDS[0],
    )
    const seedAuthority = deletionAuthorityFixture({
      proposal,
      stage: "pre-delete-1",
      targetEvidence: seedTargetEvidence,
      observedAt: seedAuthorityTime,
      releases: proposal.record.releases,
    })
    journal = appendJournalEvent(
      journal,
      "delete-authority-observed",
      {
        targetReleaseId: DUPLICATE_DRAFT_IDS[0],
        attemptNumber: 1,
        authority: seedAuthority,
      },
      seedAuthorityTime,
    )
    const seedIntentTime = new Date(Date.parse(seedAuthorityTime) + 1_000).toISOString()
    journal = appendJournalEvent(
      journal,
      "delete-intent",
      {
        targetReleaseId: DUPLICATE_DRAFT_IDS[0],
        attemptNumber: 1,
        authorityEventSha256: journal.record.events.at(-1).eventSha256,
      },
      seedIntentTime,
    )
    const seedOutcomeTime = new Date(Date.parse(seedIntentTime) + 1_000).toISOString()
    journal = appendJournalEvent(
      journal,
      "delete-outcome",
      {
        targetReleaseId: DUPLICATE_DRAFT_IDS[0],
        attemptNumber: 1,
        classification: "confirmed-204",
        httpStatus: 204,
        observedAt: seedOutcomeTime,
      },
      seedOutcomeTime,
    )
    const seedConvergenceTime = new Date(Date.parse(seedOutcomeTime) + 1_000).toISOString()
    journal = appendJournalEvent(
      journal,
      "absence-converged",
      {
        targetReleaseId: DUPLICATE_DRAFT_IDS[0],
        attemptNumber: 1,
        basis: "confirmed-204",
        directGet404At: seedConvergenceTime,
        listAbsentAt: seedConvergenceTime,
        attempts: 1,
        completedAt: seedConvergenceTime,
      },
      seedConvergenceTime,
    )
  }
  await writePrivateEnvelope(journalPath, canonicalConsolidationEnvelopeBytes("journal", journal))
  await writePrivateEnvelope(headPath, testJournalHeadBytes(journalPath, journal))
  const authorityTime = new Date(
    Math.max(Date.now(), Date.parse(journal.record.updatedAt) + 1_000),
  ).toISOString()
  const targetEvidence = proposal.record.releases.find(({ id }) => id === targetReleaseId)
  const authority = deletionAuthorityFixture({
    proposal,
    stage: targetIndex === 0 ? "pre-delete-1" : "pre-delete-2",
    targetEvidence,
    observedAt: authorityTime,
    releases:
      targetIndex === 0
        ? proposal.record.releases
        : [proposal.record.releases[0], proposal.record.releases[2]],
  })
  let deleted = false
  let deleteCalls = 0
  let authorityCaptures = 0
  let adapterFault = null
  let convergenceDirectReads = 0
  let permit
  let currentAuthorityTime = authorityTime
  let npmDurabilityObserved = false
  const unsupported = async () => {
    throw new Error("unexpected fake adapter operation")
  }
  const currentRawReleases = ({ heavyVerification = false } = {}) => {
    const releases = inspection.releaseFixture.releases
      .filter(
        (release) =>
          !(
            targetIndex === 1 &&
            String(release.id) === DUPLICATE_DRAFT_IDS[0] &&
            !(heavyVerification && options.retryRemainingMutation === "extra")
          ) &&
          !(
            heavyVerification &&
            options.retryRemainingMutation === "missing" &&
            String(release.id) === DUPLICATE_DRAFT_SURVIVOR_ID
          ) &&
          (!deleted ||
            options.retainDeletedInList === true ||
            String(release.id) !== targetReleaseId),
      )
      .map((release) => structuredClone(release))
    const target = releases.find(({ id }) => String(id) === targetReleaseId)
    if (target !== undefined) {
      if (options.currentMutation === "changed") target.name = "changed"
      if (options.currentMutation === "published") {
        target.draft = false
        target.published_at = "2026-09-01T12:35:00Z"
      }
      if (options.currentMutation === "malformed") target.body = "{"
      if (heavyVerification && options.retryRemainingMutation === "metadata-included") {
        target.name = "changed"
      }
      if (heavyVerification && options.retryRemainingMutation === "asset-included") {
        target.assets[0].label = "changed"
      }
    }
    return releases
  }
  const github = Object.freeze({
    getRepository: unsupported,
    getAuthenticatedUser: unsupported,
    getDefaultBranchSha: unsupported,
    getWorkflowState: unsupported,
    listNonterminalWorkflowRuns: unsupported,
    getAnnotatedTag: unsupported,
    async listReleases() {
      const current = deriveConsolidationState(
        await readPrivateEnvelope(journalPath, DUPLICATE_DRAFT_CONSOLIDATION_LIMITS.journalBytes),
      )
      if (current.phase === "npm-observed") {
        if (!npmDurabilityObserved) {
          events.push("durable:npm")
          npmDurabilityObserved = true
        }
        events.push("payload:list")
      } else {
        events.push("list")
      }
      if (options.convergenceListFailure !== undefined) {
        return {
          status: "ERROR",
          operation: "releases",
          httpStatus: options.convergenceListFailure,
          code: "HTTP_ERROR",
        }
      }
      return {
        status: "PRESENT",
        operation: "releases",
        httpStatus: 200,
        code: null,
        value: currentRawReleases({ heavyVerification: current.phase === "npm-observed" }),
      }
    },
    async getRelease({ releaseId }) {
      events.push(`direct:${releaseId}`)
      convergenceDirectReads += 1
      if (options.absenceOnConvergenceAttempt === convergenceDirectReads) {
        deleted = true
      }
      if (options.convergenceDirectFailure === "timeout") {
        throw new Error("simulated timeout")
      }
      if (Number.isInteger(options.convergenceDirectFailure)) {
        return {
          status: "ERROR",
          operation: "release",
          httpStatus: options.convergenceDirectFailure,
          code: "HTTP_ERROR",
        }
      }
      const current = await readPrivateEnvelope(
        journalPath,
        DUPLICATE_DRAFT_CONSOLIDATION_LIMITS.journalBytes,
      )
      const outcome = deriveConsolidationState(current).lastOutcomeClassification
      if (outcome !== null) events.splice(-1, 0, `durable:outcome:${outcome}`)
      if (deleted) {
        return {
          status: "AMBIGUOUS",
          operation: "release",
          httpStatus: 404,
          code: "NOT_FOUND",
        }
      }
      const release = currentRawReleases().find(({ id }) => String(id) === releaseId)
      return {
        status: "PRESENT",
        operation: "release",
        httpStatus: 200,
        code: null,
        value: structuredClone(release),
      }
    },
    async listReleaseAssets(input) {
      events.push(`payload-assets:${input.releaseId}`)
      return inspection.releaseFixture.github.listReleaseAssets(input)
    },
    async downloadReleaseAsset(input) {
      events.push(`payload-download:${input.releaseId}:${input.assetId}`)
      return inspection.releaseFixture.github.downloadReleaseAsset(input)
    },
  })
  const npm = Object.freeze({
    async observePackageVersion({ name, version }) {
      assert.equal(version, DUPLICATE_DRAFT_CANDIDATE.version)
      assert.equal(CANONICAL_RELEASE_PACKAGE_ORDER.includes(name), true)
      events.push(`npm:${name}`)
      return {
        status: "ABSENT",
        operation: "package-version",
        httpStatus: 404,
        code: "E404",
      }
    },
  })
  const attestations = Object.freeze({
    async verify(input) {
      events.push("payload-attestations")
      return inspection.releaseFixture.attestations.verify(input)
    },
  })
  const writer = Object.freeze({
    async deleteDuplicate({ releaseId, permit: candidate }) {
      assert.equal(releaseId, targetReleaseId)
      assert.equal(candidate, permit)
      events.push(`delete:${releaseId}`)
      const classification = options.deleteClassifications[deleteCalls]
      deleteCalls += 1
      if (classification === undefined) throw new Error("unexpected additional delete attempt")
      deleted = classification !== "transport-ambiguous" && options.deleteLeavesPresent !== true
      return {
        classification,
        httpStatus:
          classification === "confirmed-204"
            ? 204
            : classification === "response-404-ambiguous"
              ? 404
              : null,
        observedAt: currentAuthorityTime,
      }
    },
  })
  const adapters = {
    local: Object.freeze({ readState: unsupported }),
    github,
    npm,
    attestations,
    writer,
  }
  Object.defineProperty(adapters, "captureConsolidationAuthority", {
    value: Object.freeze(async function capture(input) {
      assert.equal(input.adapters, adapters)
      authorityCaptures += 1
      events.push(`authority:${input.stage}:${input.targetReleaseId}`)
      const beforeAuthority = parseConsolidationEnvelope(
        "journal",
        await readPrivateEnvelope(journalPath, DUPLICATE_DRAFT_CONSOLIDATION_LIMITS.journalBytes),
      )
      currentAuthorityTime =
        authorityCaptures === 1
          ? authorityTime
          : new Date(
              Date.parse(beforeAuthority.record.updatedAt) +
                (options.freshAuthorityAdvanceMs ?? 1_000),
            ).toISOString()
      const networkEpoch = {}
      Object.defineProperty(networkEpoch, "consume", {
        value: async (consumption) => {
          assert.equal(consumption.targetReleaseId, targetReleaseId)
          const consumptionState = deriveConsolidationState(consumption.currentJournal)
          assert.equal(consumptionState.phase, "delete-authority-observed")
          const attemptNumber = consumptionState.attemptNumber
          events.push("durable:authority")
          journal = appendJournalEvent(
            consumption.currentJournal,
            "delete-intent",
            {
              targetReleaseId,
              attemptNumber,
              authorityEventSha256: consumption.currentJournal.record.events.at(-1).eventSha256,
            },
            currentAuthorityTime,
          )
          await writePrivateEnvelope(
            journalPath,
            canonicalConsolidationEnvelopeBytes("journal", journal),
          )
          if (adapterFault === "after-intent-journal") {
            throw new Error("injected intent journal process loss")
          }
          await writePrivateEnvelope(headPath, testJournalHeadBytes(journalPath, journal))
          if (adapterFault === "after-intent-head") {
            throw new Error("injected intent head process loss")
          }
          events.push("durable:intent")
          permit = Object.freeze({})
          return permit
        },
        enumerable: false,
        writable: false,
        configurable: false,
      })
      Object.freeze(networkEpoch)
      const freshAuthority = structuredClone(authority)
      if (authorityCaptures > 1 && options.freshAuthorityMutation === "asset-included") {
        throw new Error("fresh authority rejected included asset drift")
      }
      if (authorityCaptures > 1 && options.freshAuthorityMutation === "volatile") {
        const evidence = freshAuthority.targetRead.evidence
        evidence.nodeId = `RE_volatile_retry_${authorityCaptures}`
        evidence.createdAt = new Date(
          Date.parse(evidence.createdAt) + authorityCaptures * 1_000,
        ).toISOString()
        evidence.updatedAt = evidence.createdAt
        evidence.assets[0].id = String(999_999_000 + authorityCaptures)
        evidence.assets[0].nodeId = `RA_volatile_retry_${authorityCaptures}`
        evidence.assets[0].createdAt = evidence.createdAt
        evidence.assets[0].updatedAt = evidence.updatedAt
        evidence.assets[0].downloadCount += 1
        freshAuthority.targetRead.evidenceSha256 = canonicalRecordSha256(evidence)
        const releaseIndex = freshAuthority.releases.findIndex(({ id }) => id === targetReleaseId)
        freshAuthority.releases[releaseIndex] = structuredClone(evidence)
      }
      freshAuthority.annotatedTag.observedAt = currentAuthorityTime
      freshAuthority.workflowAuthority.observedAt = currentAuthorityTime
      freshAuthority.npmInventory.startedAt = currentAuthorityTime
      freshAuthority.npmInventory.completedAt = currentAuthorityTime
      for (const entry of freshAuthority.npmInventory.packages)
        entry.observedAt = currentAuthorityTime
      freshAuthority.targetRead.releaseGetStartedAt = currentAuthorityTime
      freshAuthority.targetRead.releaseGetCompletedAt = currentAuthorityTime
      freshAuthority.targetRead.assetsListStartedAt = currentAuthorityTime
      freshAuthority.targetRead.assetsListCompletedAt = currentAuthorityTime
      freshAuthority.observedAt = currentAuthorityTime
      const captured = { authority: freshAuthority }
      Object.defineProperty(captured, "networkEpoch", {
        value: networkEpoch,
        enumerable: false,
        writable: false,
        configurable: false,
      })
      return Object.freeze(captured)
    }),
    enumerable: false,
    writable: false,
    configurable: false,
  })
  for (const name of ["captureInspectionTerminal", "assertInspectionTerminalSealed"]) {
    Object.defineProperty(adapters, name, {
      value: Object.freeze(unsupported),
      enumerable: false,
      writable: false,
      configurable: false,
    })
  }
  Object.freeze(adapters)
  if (options.retryPayloadFailure === true) {
    inspection.releaseFixture.failVerification()
  }

  return {
    events,
    waits,
    requestBudgets,
    authorityTime,
    input: {
      proposedEnvelope: proposal,
      confirmation,
      targetReleaseId,
      journalPath,
    },
    dependencies: Object.freeze({
      createAdapters: Object.freeze(async (requestBudget) => {
        adapterFault = null
        if (requestBudget !== undefined) requestBudgets.push(requestBudget)
        return adapters
      }),
      wait: Object.freeze(async (milliseconds, { signal }) => {
        assert.equal(signal instanceof AbortSignal, true)
        waits.push(milliseconds)
      }),
    }),
    dependenciesWithFault(faultAt) {
      return Object.freeze({
        createAdapters: Object.freeze(async (requestBudget) => {
          adapterFault = faultAt
          if (requestBudget !== undefined) requestBudgets.push(requestBudget)
          return adapters
        }),
        wait: Object.freeze(async (milliseconds, { signal }) => {
          assert.equal(signal instanceof AbortSignal, true)
          waits.push(milliseconds)
        }),
        faultAt,
      })
    },
    dependenciesWithTimeline(monotonicTimeline) {
      return Object.freeze({
        createAdapters: Object.freeze(async (requestBudget) => {
          adapterFault = null
          if (requestBudget !== undefined) requestBudgets.push(requestBudget)
          return adapters
        }),
        wait: Object.freeze(async (milliseconds, { signal }) => {
          assert.equal(signal instanceof AbortSignal, true)
          waits.push(milliseconds)
        }),
        monotonicTimeline,
      })
    },
    dependenciesWithWallClockTimeline(wallClockTimeline, faultAt) {
      return Object.freeze({
        createAdapters: Object.freeze(async (requestBudget) => {
          adapterFault = faultAt ?? null
          if (requestBudget !== undefined) requestBudgets.push(requestBudget)
          return adapters
        }),
        wait: Object.freeze(async (milliseconds, { signal }) => {
          assert.equal(signal instanceof AbortSignal, true)
          waits.push(milliseconds)
        }),
        ...(faultAt === undefined ? {} : { faultAt }),
        wallClockTimeline,
      })
    },
  }
}

function deletionAuthorityFixture({ proposal, stage, targetEvidence, observedAt, releases }) {
  return {
    stage,
    controller: structuredClone(proposal.record.controller),
    annotatedTag: {
      ...structuredClone(proposal.record.annotatedTag),
      observedAt,
    },
    workflowAuthority: {
      ...structuredClone(proposal.record.workflowAuthority),
      observedAt,
    },
    npmInventory: {
      ...structuredClone(proposal.record.npmInventories[1]),
      stage,
      startedAt: observedAt,
      completedAt: observedAt,
      packages: proposal.record.npmInventories[1].packages.map((entry) => ({
        ...structuredClone(entry),
        observedAt,
      })),
    },
    releases: structuredClone(releases),
    payloadProof: structuredClone(proposal.record.payloadProof),
    targetRead: {
      releaseGetStartedAt: observedAt,
      releaseGetCompletedAt: observedAt,
      assetsListStartedAt: observedAt,
      assetsListCompletedAt: observedAt,
      evidence: structuredClone(targetEvidence),
      evidenceSha256: canonicalRecordSha256(targetEvidence),
    },
    observedAt,
  }
}

function retryWallClockTimeline(authorityTime, ageMs, { heavyVerificationMs = 0 } = {}) {
  const decisionMs = Date.parse(authorityTime) + ageMs
  const values = [decisionMs]
  if (ageMs > 120_000) {
    for (let index = 0; index < CANONICAL_RELEASE_PACKAGE_ORDER.length + 2; index += 1) {
      values.push(decisionMs)
    }
    values.push(decisionMs + heavyVerificationMs)
    values.push(decisionMs + 60_000)
  }
  return Object.freeze(values.map((value) => new Date(value).toISOString()))
}

function exactConvergenceTimeline(requestDurations) {
  assert.equal(requestDurations.length, 12)
  let now = 0
  const values = [now]
  const requests = []
  let requestIndex = 0
  for (let attempt = 0; attempt < 6; attempt += 1) {
    values.push(now)
    for (const operation of ["release", "releases"]) {
      values.push(now)
      requests.push({ operation, timeoutMs: 90_000 - now })
      now += requestDurations[requestIndex++]
      values.push(now)
    }
    if (attempt < 5) {
      values.push(now)
      const delay = Math.min(CONVERGENCE_BACKOFFS[attempt], 30_000, 90_000 - now)
      now += delay
      values.push(now)
    }
  }
  return Object.freeze({
    values: Object.freeze(values),
    requests: Object.freeze(requests),
    completedAt: now,
  })
}

function testJournalHeadBytes(journalPath, journal) {
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
