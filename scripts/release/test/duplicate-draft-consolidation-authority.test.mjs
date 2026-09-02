import assert from "node:assert/strict"
import { createHash } from "node:crypto"
import { unlinkSync } from "node:fs"
import { mkdir, mkdtemp, readFile, realpath, rm, stat, writeFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import test from "node:test"
import {
  createDuplicateDraftConsolidationAdapters,
  createExactDuplicateDeleteEffect,
} from "../duplicate-draft-consolidation-adapters.mjs"
import {
  assertFreshWriterAuthority,
  captureConsolidationAuthority,
  captureNpmInventory,
} from "../duplicate-draft-consolidation-authority.mjs"
import { inspectEquivalentDrafts } from "../duplicate-draft-consolidation-evidence.mjs"
import {
  readPrivateEnvelope,
  writePrivateEnvelope,
} from "../duplicate-draft-consolidation-files.mjs"
import {
  appendJournalEvent,
  createConsolidationJournal,
  deriveConsolidationState,
  parseConsolidationJournal,
} from "../duplicate-draft-consolidation-journal.mjs"
import {
  canonicalConsolidationEnvelopeBytes,
  canonicalEventEnvelope,
  canonicalRecordSha256,
  createConsolidationEnvelope,
} from "../duplicate-draft-consolidation-schema.mjs"
import { CANONICAL_RELEASE_PACKAGE_ORDER } from "../manifest.mjs"
import {
  createDuplicateDraftConsolidationFixture,
  DUPLICATE_DRAFT_CANDIDATE,
  DUPLICATE_DRAFT_IDS,
  DUPLICATE_DRAFT_SURVIVOR_ID,
} from "./support/duplicate-draft-consolidation-fixture.mjs"

const REPOSITORY_ID = "1210070282"
const ACTOR = Object.freeze({ login: "blove", id: "61436" })
const TAG_OBJECT_SHA = "a".repeat(40)
const WORKFLOW_ID = "202458345"
const BASE_TIME = Date.parse("2026-09-01T12:00:00.000Z")
const TEMPORARY_ROOTS = []
test.after(async () => {
  await Promise.all(TEMPORARY_ROOTS.map((root) => rm(root, { recursive: true, force: true })))
})
const EXACT_WORKFLOW_RUN_QUERY = Object.freeze({
  statuses: Object.freeze(["in_progress", "pending", "queued", "requested", "waiting"]),
  perPage: 100,
  maximumPages: 100,
})

test("inspection terminal captures three exact direct reads, owns completion time, and permanently seals adapters", async () => {
  const fixture = await authorityFixture()
  let injectedClockCallsAfterSixthRead = 0
  let injectedNetworkAttemptsAfterSixthRead = 0
  fixture.setClock(() => {
    if (
      fixture.networkOperations.filter(
        (operation) => operation.startsWith("get-release:") || operation.startsWith("list-assets:"),
      ).length >= 6
    ) {
      injectedClockCallsAfterSixthRead += 1
      injectedNetworkAttemptsAfterSixthRead += 1
      void fixture.adapters.github.getRepository().catch(() => {})
      throw new Error("injected clock ran after the sixth terminal read")
    }
    return new Date(BASE_TIME).toISOString()
  })
  const nativeStartedAt = Date.now()
  const terminal = await fixture.adapters.captureInspectionTerminal({
    candidate: fixture.proposal.candidate,
    releases: fixture.proposal.releases,
  })

  assert.deepEqual(Reflect.ownKeys(terminal), ["releases", "completedAt"])
  assert.deepEqual(
    terminal.releases.map(({ role, id }) => ({ role, id })),
    [
      { role: "survivor", id: DUPLICATE_DRAFT_SURVIVOR_ID },
      { role: "duplicate", id: DUPLICATE_DRAFT_IDS[0] },
      { role: "duplicate", id: DUPLICATE_DRAFT_IDS[1] },
    ],
  )
  assert.match(
    terminal.completedAt,
    /^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}\.[0-9]{3}Z$/u,
  )
  assert.equal(Date.parse(terminal.completedAt) >= nativeStartedAt, true)
  assert.equal(Date.parse(terminal.completedAt) <= Date.now(), true)
  assert.equal(injectedClockCallsAfterSixthRead, 0)
  assert.equal(injectedNetworkAttemptsAfterSixthRead, 0)
  assert.equal(Object.isFrozen(terminal), true)
  assert.equal(Object.isFrozen(terminal.releases), true)
  assert.deepEqual(fixture.networkOperations, [
    `get-release:${DUPLICATE_DRAFT_SURVIVOR_ID}`,
    `list-assets:${DUPLICATE_DRAFT_SURVIVOR_ID}`,
    `get-release:${DUPLICATE_DRAFT_IDS[0]}`,
    `list-assets:${DUPLICATE_DRAFT_IDS[0]}`,
    `get-release:${DUPLICATE_DRAFT_IDS[1]}`,
    `list-assets:${DUPLICATE_DRAFT_IDS[1]}`,
  ])
  assert.equal(Reflect.ownKeys(terminal).includes("permit"), false)
  assert.equal(fixture.adapters.assertInspectionTerminalSealed(), undefined)
  await assert.rejects(fixture.adapters.github.getRepository(), /sealed|terminal|epoch/iu)
  await assert.rejects(
    fixture.adapters.captureInspectionTerminal({
      candidate: fixture.proposal.candidate,
      releases: fixture.proposal.releases,
    }),
    /sealed|terminal|epoch|state/iu,
  )
  assert.throws(() => fixture.adapters.assertInspectionTerminalSealed(), /sealed|terminal|epoch/iu)
  assert.equal(
    fixture.networkOperations.some((operation) => operation.startsWith("delete:")),
    false,
  )
})

test("inspection terminal rejects a reordered target set before any direct read", async () => {
  const fixture = await authorityFixture()
  await assert.rejects(
    fixture.adapters.captureInspectionTerminal({
      candidate: fixture.proposal.candidate,
      releases: [...fixture.proposal.releases].reverse(),
    }),
    /terminal|failed|state/iu,
  )
  assert.deepEqual(fixture.networkOperations, [])
  await assert.rejects(fixture.adapters.github.getRepository(), /sealed|terminal|epoch|invalid/iu)
})

test("captures exact pre-delete authority and leaves direct GET plus asset enumeration terminal", async () => {
  const fixture = await authorityFixture()
  const captured = await captureConsolidationAuthority(fixture.input)

  assert.deepEqual(
    captured.authority.releases.map(({ role, id }) => ({ role, id })),
    [
      { role: "survivor", id: DUPLICATE_DRAFT_SURVIVOR_ID },
      { role: "duplicate", id: DUPLICATE_DRAFT_IDS[0] },
      { role: "duplicate", id: DUPLICATE_DRAFT_IDS[1] },
    ],
  )
  assert.equal(captured.authority.stage, "pre-delete-1")
  assert.equal(captured.authority.targetRead.evidence.id, DUPLICATE_DRAFT_IDS[0])
  assert.deepEqual(fixture.networkOperations.slice(-2), [
    `get-release:${DUPLICATE_DRAFT_IDS[0]}`,
    `list-assets:${DUPLICATE_DRAFT_IDS[0]}`,
  ])
  assert.equal(
    fixture.networkOperations.filter((entry) => entry.startsWith("download:")).length,
    135,
  )
  assert.equal(Object.isFrozen(captured.authority), true)
  assert.equal(Object.isFrozen(captured.authority.releases[0].assets), true)
  assert.equal(Object.isSealed(captured.networkEpoch), true)
  assert.deepEqual(Object.keys(captured.networkEpoch), [])
  assert.equal(JSON.stringify(captured).includes("networkEpoch"), false)
  assert.equal(JSON.stringify(captured.authority).includes("consume"), false)
  assert.throws(() => JSON.stringify(captured.networkEpoch), /serialize|capability|epoch/iu)

  const consumption = await journalIntentConsumption(captured, fixture)
  const permit = await captured.networkEpoch.consume(consumption)
  assert.equal(Object.isFrozen(permit), true)
  assert.deepEqual(Object.keys(permit), [])
  assert.throws(() => JSON.stringify(permit), /serialize|permit|capability/iu)
  const persistedJournal = parseConsolidationJournal(
    await readPrivateEnvelope(fixture.journalPath, 64 * 1024 * 1024),
  )
  assert.equal(persistedJournal.record.events.at(-1).event.type, "delete-intent")
  assert.equal(
    persistedJournal.record.events.length,
    consumption.currentJournal.record.events.length + 1,
  )
  assert.equal((await stat(fixture.journalPath)).mode & 0o777, 0o600)
  assert.deepEqual(
    await fixture.adapters.writer.deleteDuplicate({
      releaseId: DUPLICATE_DRAFT_IDS[0],
      permit,
    }),
    {
      classification: "confirmed-204",
      httpStatus: 204,
      observedAt: new Date(fixture.nowMs).toISOString(),
    },
  )
  await assert.rejects(captured.networkEpoch.consume(consumption), /consumed|epoch/iu)
  await assert.rejects(
    fixture.adapters.writer.deleteDuplicate({
      releaseId: DUPLICATE_DRAFT_IDS[0],
      permit,
    }),
    /permit|one-use|valid/iu,
  )
})

test("invalidates the one-use epoch after any intervening adapter read", async () => {
  const fixture = await authorityFixture()
  const captured = await captureConsolidationAuthority(fixture.input)
  await assert.rejects(fixture.adapters.github.getRepository(), /sealed|epoch|rejected/iu)

  await assert.rejects(
    captured.networkEpoch.consume(await journalIntentConsumption(captured, fixture)),
    /epoch|intervening|read/iu,
  )
  assert.equal(
    parseConsolidationJournal(
      await readPrivateEnvelope(fixture.journalPath, 64 * 1024 * 1024),
    ).record.events.at(-1).event.type,
    "delete-authority-observed",
  )
})

test("cannot authorize DELETE without the exact current private journal", async () => {
  const fixture = await authorityFixture()
  const captured = await captureConsolidationAuthority(fixture.input)
  const consumption = await journalIntentConsumption(captured, fixture)
  await rm(fixture.journalPath)

  await assert.rejects(
    captured.networkEpoch.consume(consumption),
    /journal|ENOENT|durable|current|private/iu,
  )
  assert.equal(
    fixture.networkOperations.some((entry) => entry.startsWith("delete:")),
    false,
  )
})

test("requires the exact incident confirmation string instead of a template-object digest", async () => {
  for (const variant of ["spacing", "newline", "template-object"]) {
    const fixture = await authorityFixture()
    const captured = await captureConsolidationAuthority(fixture.input)
    const consumption = await journalIntentConsumption(captured, fixture)
    const confirmation =
      variant === "spacing"
        ? consumption.confirmation.replace(" SURVIVOR ", "  SURVIVOR ")
        : variant === "newline"
          ? `${consumption.confirmation}\n`
          : JSON.stringify(fixture.proposal.confirmation)
    await assert.rejects(
      captured.networkEpoch.consume({ ...consumption, confirmation }),
      /confirmation|exact|consumed|epoch/iu,
    )
  }

  const secondFixture = await authorityFixture()
  const secondCapture = await captureConsolidationAuthority(secondFixture.input)
  const second = await journalIntentConsumption(secondCapture, secondFixture)
  const templateDigestJournal = createConsolidationJournal({
    proposedEnvelope: createConsolidationEnvelope("proposed", secondFixture.proposal),
    confirmationSha256: canonicalRecordSha256(secondFixture.proposal.confirmation),
    recordedAt: secondCapture.authority.observedAt,
  })
  const withAuthority = appendJournalEvent(
    templateDigestJournal,
    "delete-authority-observed",
    {
      targetReleaseId: DUPLICATE_DRAFT_IDS[0],
      attemptNumber: 1,
      authority: secondCapture.authority,
    },
    secondCapture.authority.observedAt,
  )
  await writePrivateEnvelope(
    secondFixture.journalPath,
    canonicalConsolidationEnvelopeBytes("journal", withAuthority),
  )
  await assert.rejects(
    secondCapture.networkEpoch.consume({
      ...second,
      currentJournal: withAuthority,
    }),
    /confirmation|digest|journal|bind/iu,
  )
})

test("rejects unrelated valid journal replacement without overwriting it", async () => {
  const fixture = await authorityFixture()
  const captured = await captureConsolidationAuthority(fixture.input)
  const consumption = await journalIntentConsumption(captured, fixture)
  let unrelated = createConsolidationJournal({
    proposedEnvelope: createConsolidationEnvelope("proposed", fixture.proposal),
    confirmationSha256: "d".repeat(64),
    recordedAt: captured.authority.observedAt,
  })
  unrelated = appendJournalEvent(
    unrelated,
    "delete-authority-observed",
    {
      targetReleaseId: DUPLICATE_DRAFT_IDS[0],
      attemptNumber: 1,
      authority: captured.authority,
    },
    captured.authority.observedAt,
  )
  const unrelatedBytes = canonicalConsolidationEnvelopeBytes("journal", unrelated)
  await writePrivateEnvelope(fixture.journalPath, unrelatedBytes)

  await assert.rejects(
    captured.networkEpoch.consume(consumption),
    /confirmation|journal|current|replace|history|binding/iu,
  )
  assert.deepEqual(await readFile(fixture.journalPath), unrelatedBytes)
})

test("rejects confirmation and operation-controller mismatch before journal replacement", async (t) => {
  for (const mismatch of ["confirmation", "controller"]) {
    await t.test(mismatch, async () => {
      const fixture = await authorityFixture()
      const captured = await captureConsolidationAuthority(fixture.input)
      const consumption = await journalIntentConsumption(captured, fixture)
      const changed = structuredClone(consumption.currentJournal)
      if (mismatch === "confirmation") {
        changed.record.confirmationSha256 = "e".repeat(64)
        changed.record.events[0].event.payload.confirmationSha256 = "e".repeat(64)
      } else {
        changed.record.events[0].event.payload.controllerSha = "f".repeat(40)
      }
      changed.record.events = rebuildEventChain(changed.record.events)
      const envelope = createConsolidationEnvelope("journal", changed.record)
      const changedBytes = canonicalConsolidationEnvelopeBytes("journal", envelope)
      await writePrivateEnvelope(fixture.journalPath, changedBytes)
      await assert.rejects(
        captured.networkEpoch.consume({
          ...consumption,
          currentJournal: envelope,
        }),
        /confirmation|controller|journal|proposal|authority|drift/iu,
      )
      assert.deepEqual(await readFile(fixture.journalPath), changedBytes)
    })
  }
})

test("rejects an illegal intent append from a journal without current delete authority", async () => {
  const fixture = await authorityFixture()
  const captured = await captureConsolidationAuthority(fixture.input)
  const consumption = await journalIntentConsumption(captured, fixture)
  const operationOnly = createConsolidationJournal({
    proposedEnvelope: createConsolidationEnvelope("proposed", fixture.proposal),
    confirmationSha256: canonicalRecordSha256(fixture.proposal.confirmation),
    recordedAt: captured.authority.observedAt,
  })
  const operationOnlyBytes = canonicalConsolidationEnvelopeBytes("journal", operationOnly)
  await writePrivateEnvelope(fixture.journalPath, operationOnlyBytes)

  await assert.rejects(
    captured.networkEpoch.consume({
      ...consumption,
      currentJournal: operationOnly,
    }),
    /authority|journal|state|intent|bind/iu,
  )
  assert.deepEqual(await readFile(fixture.journalPath), operationOnlyBytes)
})

test("rejects canonical journal truncation or divergence against the durable head anchor", async (t) => {
  for (const mode of ["truncated", "divergent"]) {
    await t.test(mode, async () => {
      const fixture = await authorityFixture()
      const captured = await captureConsolidationAuthority(fixture.input)
      const consumption = await journalIntentConsumption(captured, fixture)
      await writePrivateEnvelope(
        fixture.journalHeadPath,
        journalHeadBytes(fixture, consumption.currentJournal),
      )
      let changed
      if (mode === "truncated") {
        changed = createConsolidationJournal({
          proposedEnvelope: createConsolidationEnvelope("proposed", fixture.proposal),
          confirmationSha256: consumption.currentJournal.record.confirmationSha256,
          recordedAt: captured.authority.observedAt,
        })
      } else {
        const divergent = structuredClone(consumption.currentJournal)
        divergent.record.events[0].event.payload.confirmationSha256 = "e".repeat(64)
        divergent.record.confirmationSha256 = "e".repeat(64)
        divergent.record.events = rebuildEventChain(divergent.record.events)
        changed = createConsolidationEnvelope("journal", divergent.record)
      }
      const changedBytes = canonicalConsolidationEnvelopeBytes("journal", changed)
      await writePrivateEnvelope(fixture.journalPath, changedBytes)
      await assert.rejects(
        captured.networkEpoch.consume({
          ...consumption,
          currentJournal: changed,
        }),
        /head|anchor|lineage|truncat|diverg|confirmation/iu,
      )
      assert.deepEqual(await readFile(fixture.journalPath), changedBytes)
    })
  }
})

test("recovers an anchor behind by exactly one legal append and advances it with intent", async () => {
  const fixture = await authorityFixture()
  const captured = await captureConsolidationAuthority(fixture.input)
  const consumption = await journalIntentConsumption(captured, fixture)
  const predecessor = createConsolidationJournal({
    proposedEnvelope: createConsolidationEnvelope("proposed", fixture.proposal),
    confirmationSha256: consumption.currentJournal.record.confirmationSha256,
    recordedAt: captured.authority.observedAt,
  })
  await writePrivateEnvelope(fixture.journalHeadPath, journalHeadBytes(fixture, predecessor))

  await captured.networkEpoch.consume(consumption)
  const committed = parseConsolidationJournal(
    await readPrivateEnvelope(fixture.journalPath, 64 * 1024 * 1024),
  )
  assert.equal(committed.record.events.at(-1).event.type, "delete-intent")
  assert.deepEqual(await readFile(fixture.journalHeadPath), journalHeadBytes(fixture, committed))
})

test("repairs the intent-written anchor crash window without issuing another permit", async () => {
  const fixture = await authorityFixture()
  const captured = await captureConsolidationAuthority(fixture.input)
  const consumption = await journalIntentConsumption(captured, fixture)
  await writePrivateEnvelope(
    fixture.journalHeadPath,
    journalHeadBytes(fixture, consumption.currentJournal),
  )
  const state = deriveConsolidationState(consumption.currentJournal)
  const intent = appendJournalEvent(
    consumption.currentJournal,
    "delete-intent",
    {
      targetReleaseId: DUPLICATE_DRAFT_IDS[0],
      attemptNumber: 1,
      authorityEventSha256: state.lastEventSha256,
    },
    captured.authority.observedAt,
  )
  await writePrivateEnvelope(
    fixture.journalPath,
    canonicalConsolidationEnvelopeBytes("journal", intent),
  )

  await assert.rejects(
    captured.networkEpoch.consume({
      ...consumption,
      currentJournal: intent,
    }),
    /predecessor|authority|state|legal/iu,
  )
  assert.deepEqual(await readFile(fixture.journalHeadPath), journalHeadBytes(fixture, intent))
})

test("burns a delayed permit at the absolute npm-authority expiry with zero DELETE fetches", async () => {
  const fixture = await authorityFixture()
  const captured = await captureConsolidationAuthority(fixture.input)
  const permit = await captured.networkEpoch.consume(
    await journalIntentConsumption(captured, fixture),
  )
  fixture.setClock(() =>
    new Date(Date.parse(captured.authority.npmInventory.completedAt) + 120_001).toISOString(),
  )

  await assert.rejects(
    fixture.adapters.writer.deleteDuplicate({
      releaseId: DUPLICATE_DRAFT_IDS[0],
      permit,
    }),
    /expired|fresh|authority|permit/iu,
  )
  assert.equal(
    fixture.networkOperations.some((entry) => entry.startsWith("delete:")),
    false,
  )
})

test("the raw writer enforces expiry on its final pre-send clock", async () => {
  const fixture = await authorityFixture()
  const captured = await captureConsolidationAuthority(fixture.input)
  const permit = await captured.networkEpoch.consume(
    await journalIntentConsumption(captured, fixture),
  )
  const expiry = Date.parse(captured.authority.npmInventory.completedAt) + 120_000
  let reads = 0
  fixture.setClock(() => {
    reads += 1
    return new Date(expiry + (reads >= 3 ? 1 : 0)).toISOString()
  })

  await assert.rejects(
    fixture.adapters.writer.deleteDuplicate({
      releaseId: DUPLICATE_DRAFT_IDS[0],
      permit,
    }),
    /expired|final|pre-send|authority|permit/iu,
  )
  assert.equal(
    fixture.networkOperations.some((entry) => entry.startsWith("delete:")),
    false,
  )
})

test("a microtask expiry during awaited verification burns zero DELETE fetches", async () => {
  const fixture = await authorityFixture()
  const captured = await captureConsolidationAuthority(fixture.input)
  const permit = await captured.networkEpoch.consume(
    await journalIntentConsumption(captured, fixture),
  )
  const expiry = Date.parse(captured.authority.npmInventory.completedAt) + 120_000
  let reads = 0
  let expired = false
  fixture.setClock(() => {
    reads += 1
    if (reads === 3) queueMicrotask(() => (expired = true))
    return new Date(expiry + (expired ? 1 : 0)).toISOString()
  })

  await assert.rejects(
    fixture.adapters.writer.deleteDuplicate({
      releaseId: DUPLICATE_DRAFT_IDS[0],
      permit,
    }),
    /expired|final|pre-send|authority|permit/iu,
  )
  assert.equal(reads, 4)
  assert.equal(
    fixture.networkOperations.some((entry) => entry.startsWith("delete:")),
    false,
  )
})

test("the final guard clock invokes transport before its scheduled microtask", async () => {
  let betweenFinalClockAndFetch = false
  const fixture = await authorityFixture({
    deleteHook: () => assert.equal(betweenFinalClockAndFetch, false),
  })
  const captured = await captureConsolidationAuthority(fixture.input)
  const permit = await captured.networkEpoch.consume(
    await journalIntentConsumption(captured, fixture),
  )
  const expiry = Date.parse(captured.authority.npmInventory.completedAt) + 120_000
  let reads = 0
  fixture.setClock(() => {
    reads += 1
    if (reads === 4) {
      queueMicrotask(() => (betweenFinalClockAndFetch = true))
    }
    return new Date(expiry).toISOString()
  })

  assert.deepEqual(
    await fixture.adapters.writer.deleteDuplicate({
      releaseId: DUPLICATE_DRAFT_IDS[0],
      permit,
    }),
    {
      classification: "confirmed-204",
      httpStatus: 204,
      observedAt: new Date(expiry).toISOString(),
    },
  )
  assert.equal(reads, 4)
})

test("pre-send journal, head, and lock failures are stable and path-free", async (t) => {
  for (const failure of ["journal", "head", "lock"]) {
    await t.test(failure, async () => {
      const fixture = await authorityFixture()
      const captured = await captureConsolidationAuthority(fixture.input)
      const permit = await captured.networkEpoch.consume(
        await journalIntentConsumption(captured, fixture),
      )
      if (failure === "journal") await rm(fixture.journalPath)
      if (failure === "head") await rm(fixture.journalHeadPath)
      if (failure === "lock") {
        const lockPath = path.join(
          path.dirname(fixture.journalPath),
          `.${path.basename(fixture.journalPath)}.lock`,
        )
        await writeFile(lockPath, "secret-root-path-content\n", {
          mode: 0o600,
        })
      }

      await assert.rejects(
        fixture.adapters.writer.deleteDuplicate({
          releaseId: DUPLICATE_DRAFT_IDS[0],
          permit,
        }),
        (error) => {
          const diagnostic = `${error.message}\n${error.stack ?? ""}`
          assert.match(
            error.message,
            /ERR_CONSOLIDATION_(COMMITTED_JOURNAL|COMMITTED_HEAD|JOURNAL_LOCK)_VERIFICATION/iu,
          )
          assert.equal(diagnostic.includes(fixture.root), false)
          assert.equal(diagnostic.includes("secret-root-path-content"), false)
          assert.equal(Object.hasOwn(error, "cause"), false)
          return true
        },
      )
      assert.equal(
        fixture.networkOperations.some((entry) => entry.startsWith("delete:")),
        false,
      )
    })
  }
})

test("missing or replaced committed journal heads burn the permit before DELETE", async (t) => {
  for (const mutation of ["missing", "replaced"]) {
    await t.test(mutation, async () => {
      const fixture = await authorityFixture()
      const captured = await captureConsolidationAuthority(fixture.input)
      const permit = await captured.networkEpoch.consume(
        await journalIntentConsumption(captured, fixture),
      )
      if (mutation === "missing") {
        await rm(fixture.journalHeadPath)
      } else {
        const bytes = await readPrivateEnvelope(fixture.journalHeadPath, 16 * 1024)
        await writePrivateEnvelope(fixture.journalHeadPath, bytes)
      }

      await assert.rejects(
        fixture.adapters.writer.deleteDuplicate({
          releaseId: DUPLICATE_DRAFT_IDS[0],
          permit,
        }),
        /head|anchor|identity|missing|replace/iu,
      )
      assert.equal(
        fixture.networkOperations.some((entry) => entry.startsWith("delete:")),
        false,
      )
    })
  }
})

test("removing the journal head from the raw writer clock prevents DELETE send", async () => {
  const fixture = await authorityFixture()
  const captured = await captureConsolidationAuthority(fixture.input)
  const permit = await captured.networkEpoch.consume(
    await journalIntentConsumption(captured, fixture),
  )
  const captureCompletedAt = Date.parse(captured.authority.observedAt)
  let reads = 0
  fixture.setClock(() => {
    reads += 1
    if (reads === 3) unlinkSync(fixture.journalHeadPath)
    return new Date(captureCompletedAt + reads).toISOString()
  })

  await assert.rejects(
    fixture.adapters.writer.deleteDuplicate({
      releaseId: DUPLICATE_DRAFT_IDS[0],
      permit,
    }),
    /head|journal|identity|lease|missing/iu,
  )
  assert.equal(
    fixture.networkOperations.some((entry) => entry.startsWith("delete:")),
    false,
  )
})

test("removing the journal head inside fetch prevents confirmed classification", async () => {
  let fixture
  fixture = await authorityFixture({
    deleteHook: async () => rm(fixture.journalHeadPath),
  })
  const captured = await captureConsolidationAuthority(fixture.input)
  const permit = await captured.networkEpoch.consume(
    await journalIntentConsumption(captured, fixture),
  )

  await assert.rejects(
    fixture.adapters.writer.deleteDuplicate({
      releaseId: DUPLICATE_DRAFT_IDS[0],
      permit,
    }),
    /head|journal|identity|lease|missing/iu,
  )
  assert.equal(fixture.networkOperations.filter((entry) => entry.startsWith("delete:")).length, 1)
})

test("a nested adapter call during DELETE invalidates an outer 204", async () => {
  let fixture
  fixture = await authorityFixture({
    deleteHook: async () => fixture.adapters.github.getRepository(),
  })
  const captured = await captureConsolidationAuthority(fixture.input)
  const permit = await captured.networkEpoch.consume(
    await journalIntentConsumption(captured, fixture),
  )
  await assert.rejects(
    fixture.adapters.writer.deleteDuplicate({
      releaseId: DUPLICATE_DRAFT_IDS[0],
      permit,
    }),
    /reentrant|invalid|sealed|delete|adapter/iu,
  )
})

test("rejects replacement of the committed journal before DELETE even when bytes match", async () => {
  const fixture = await authorityFixture()
  const captured = await captureConsolidationAuthority(fixture.input)
  const permit = await captured.networkEpoch.consume(
    await journalIntentConsumption(captured, fixture),
  )
  const committed = await readPrivateEnvelope(fixture.journalPath, 64 * 1024 * 1024)
  await writePrivateEnvelope(fixture.journalPath, committed)

  await assert.rejects(
    fixture.adapters.writer.deleteDuplicate({
      releaseId: DUPLICATE_DRAFT_IDS[0],
      permit,
    }),
    /journal|identity|replace|permit|current/iu,
  )
  assert.equal(
    fixture.networkOperations.some((entry) => entry.startsWith("delete:")),
    false,
  )
})

test("rejects a constant-counter bypass and concurrent terminal-read race", async () => {
  const constantCounter = await authorityFixture()
  constantCounter.input.networkReadCount = () => 0
  await assert.rejects(
    captureConsolidationAuthority(constantCounter.input),
    /input|field|adapter/iu,
  )

  let releaseTerminal
  let signalTerminal
  const terminalEntered = new Promise((resolve) => {
    signalTerminal = resolve
  })
  const terminalGate = new Promise((resolve) => {
    releaseTerminal = resolve
  })
  const raced = await authorityFixture({
    terminalGate: { entered: signalTerminal, wait: terminalGate },
  })
  const pendingCapture = captureConsolidationAuthority(raced.input)
  await terminalEntered
  await assert.rejects(
    raced.adapters.github.getRepository(),
    /terminal|epoch|concurrent|rejected/iu,
  )
  releaseTerminal()
  await assert.rejects(pendingCapture, /terminal|epoch|failed/iu)
})

test("a full public capture exposes no raw trace, callback, or transition boundary", async () => {
  const victim = await authorityFixture()
  const captured = await captureConsolidationAuthority(victim.input)
  const forbidden = new Set([
    "authorityEpoch",
    "beginAuthorityCapture",
    "beginTerminalRead",
    "bindAuthority",
    "acceptTransitionBoundary",
    "armTransition",
    "armTask6Transition",
    "trace",
  ])
  for (const value of [victim.adapters, captured, captured.networkEpoch]) {
    for (const key of Reflect.ownKeys(new Proxy(value, {}))) {
      assert.equal(forbidden.has(key), false)
    }
  }
  await assert.rejects(
    victim.adapters.writer.deleteDuplicate({
      releaseId: DUPLICATE_DRAFT_IDS[0],
      permit: Object.freeze({}),
    }),
    /permit|guard|one-use|valid/iu,
  )
  assert.equal(
    victim.networkOperations.some((entry) => entry.startsWith("delete:")),
    false,
  )
})

test("caller reads outside capture cannot substitute for the private trace", async () => {
  const fixture = await authorityFixture()
  await fixture.adapters.github.getRepository()
  const captured = await captureConsolidationAuthority(fixture.input)
  assert.equal(captured.authority.stage, "pre-delete-1")
  assert.equal(Object.hasOwn(fixture.adapters, "beginAuthorityCapture"), false)
  assert.equal(
    fixture.networkOperations.some((entry) => entry.startsWith("delete:")),
    false,
  )
})

test("concurrent high-level captures cannot share one private trace", async () => {
  const fixture = await authorityFixture()
  const results = await Promise.allSettled([
    captureConsolidationAuthority(fixture.input),
    captureConsolidationAuthority(fixture.input),
  ])
  assert.equal(
    results.some(({ status }) => status === "rejected"),
    true,
  )
  assert.equal(
    fixture.networkOperations.some((entry) => entry.startsWith("delete:")),
    false,
  )
})

test("safe authority capture rejects a complete Release trace that violates its stage", async (t) => {
  await t.test("pre-delete-2 rejects the first target reappearing", async () => {
    const source = await authorityFixture()
    const fixture = await authorityFixture({ stage: "pre-delete-2" })
    fixture.remainingReleases.push(
      structuredClone(
        source.remainingReleases.find(({ id }) => String(id) === DUPLICATE_DRAFT_IDS[0]),
      ),
    )
    await assertRawReleaseTraceRejected(fixture)
  })

  await t.test("rejects a fourth managed candidate draft", async () => {
    const fixture = await authorityFixture()
    const extra = structuredClone(fixture.remainingReleases[0])
    extra.id = 999_999_999
    extra.node_id = "RE_kwDO-managed-extra"
    fixture.remainingReleases.push(extra)
    await assertRawReleaseTraceRejected(fixture)
  })

  await t.test("rejects a published candidate", async () => {
    const fixture = await authorityFixture()
    fixture.remainingReleases[0].published_at = "2026-09-01T11:59:00Z"
    await assertRawReleaseTraceRejected(fixture)
  })

  await t.test("rejects malformed and duplicate expected entries", async (t) => {
    await t.test("malformed managed marker", async () => {
      const fixture = await authorityFixture()
      fixture.remainingReleases[0].body = "malformed managed candidate"
      await assertRawReleaseTraceRejected(fixture)
    })

    await t.test("duplicate expected id", async () => {
      const fixture = await authorityFixture()
      fixture.remainingReleases.push(structuredClone(fixture.remainingReleases[1]))
      await assertRawReleaseTraceRejected(fixture)
    })
  })

  await t.test("an authority cannot omit an extra managed entry", async () => {
    const fixture = await authorityFixture()
    const extra = structuredClone(fixture.remainingReleases[2])
    extra.id = 999_999_998
    extra.node_id = "RE_kwDO-omitted-managed-extra"
    fixture.remainingReleases.push(extra)
    await assertRawReleaseTraceRejected(fixture)
  })

  for (const body of [
    "<!-- DAWN_RELEASE_CONTROLLER_MARKER\r\nmalformed -->",
    "prefix\u0000DAWN_RELEASE_CONTROLLER_MARKER-near-prefix",
    `incident ${DUPLICATE_DRAFT_CANDIDATE.commitSha}`,
  ]) {
    await t.test("rejects a suspicious malformed marker on an unexpected id", async () => {
      const fixture = await authorityFixture()
      const suspicious = structuredClone(fixture.remainingReleases[0])
      suspicious.id = 999_999_997
      suspicious.node_id = "RE_kwDO-suspicious-unexpected"
      suspicious.tag_name = "unrelated-tag"
      suspicious.body = body
      fixture.remainingReleases.push(suspicious)
      await assertRawReleaseTraceRejected(fixture)
    })
  }

  await t.test("allows an ordinary unrelated Release", async () => {
    const fixture = await authorityFixture()
    fixture.remainingReleases.push({
      id: 999_999_996,
      node_id: "RE_kwDO-ordinary-unrelated",
      tag_name: "v0.8.21",
      name: "ordinary unrelated release",
      target_commitish: "main",
      draft: false,
      immutable: true,
      prerelease: false,
      published_at: "2026-08-01T00:00:00Z",
      created_at: "2026-08-01T00:00:00Z",
      updated_at: "2026-08-01T00:00:00Z",
      body: "ordinary unrelated body",
      author: { login: "other", id: 1, node_id: "U_other" },
      assets: [],
    })
    await captureConsolidationAuthority(fixture.input)
  })
})

test("caller attestation activity cannot enter the private authority trace", async () => {
  const fixture = await authorityFixture()
  await assert.rejects(
    fixture.adapters.attestations.verify({ arbitrary: "caller-authored" }),
    /attestation|bundle|record|argument|input|verify/iu,
  )
  assert.equal(Reflect.ownKeys(fixture.adapters).includes("beginAuthorityCapture"), false)
  assert.equal(Reflect.ownKeys(fixture.adapters).includes("authorityEpoch"), false)
})

test("a missing durable head bootstraps only exact operation genesis", async (t) => {
  await t.test("post-genesis authority history rejects", async () => {
    const fixture = await authorityFixture()
    const captured = await captureConsolidationAuthority(fixture.input)
    const consumption = await journalIntentConsumption(captured, fixture)
    await rm(fixture.journalHeadPath, { force: true })
    await assert.rejects(
      captured.networkEpoch.consume(consumption),
      /head|anchor|genesis|missing|history/iu,
    )
    assert.equal(
      fixture.networkOperations.some((entry) => entry.startsWith("delete:")),
      false,
    )
  })

  await t.test("exact genesis creates and binds the head before stopping", async () => {
    const fixture = await authorityFixture()
    const captured = await captureConsolidationAuthority(fixture.input)
    const consumption = await journalIntentConsumption(captured, fixture)
    const genesis = createConsolidationJournal({
      proposedEnvelope: createConsolidationEnvelope("proposed", fixture.proposal),
      confirmationSha256: consumption.currentJournal.record.confirmationSha256,
      recordedAt: captured.authority.observedAt,
    })
    await writePrivateEnvelope(
      fixture.journalPath,
      canonicalConsolidationEnvelopeBytes("journal", genesis),
    )
    await rm(fixture.journalHeadPath, { force: true })
    await assert.rejects(
      captured.networkEpoch.consume({
        ...consumption,
        currentJournal: genesis,
      }),
      /authority|predecessor|state|intent/iu,
    )
    assert.deepEqual(await readFile(fixture.journalHeadPath), journalHeadBytes(fixture, genesis))
  })

  await t.test("deleting both files cannot reset post-genesis history", async () => {
    const fixture = await authorityFixture()
    const captured = await captureConsolidationAuthority(fixture.input)
    const consumption = await journalIntentConsumption(captured, fixture)
    await writePrivateEnvelope(
      fixture.journalHeadPath,
      journalHeadBytes(fixture, consumption.currentJournal),
    )
    await rm(fixture.journalPath)
    await rm(fixture.journalHeadPath)
    await writePrivateEnvelope(
      fixture.journalPath,
      canonicalConsolidationEnvelopeBytes("journal", consumption.currentJournal),
    )
    await assert.rejects(
      captured.networkEpoch.consume(consumption),
      /head|anchor|genesis|missing|history/iu,
    )
  })

  await t.test("same-binding divergent history cannot create a new head", async () => {
    const fixture = await authorityFixture()
    const captured = await captureConsolidationAuthority(fixture.input)
    const consumption = await journalIntentConsumption(captured, fixture)
    const divergent = appendJournalEvent(
      consumption.currentJournal,
      "delete-intent",
      {
        targetReleaseId: DUPLICATE_DRAFT_IDS[0],
        attemptNumber: 1,
        authorityEventSha256: deriveConsolidationState(consumption.currentJournal).lastEventSha256,
      },
      captured.authority.observedAt,
    )
    await writePrivateEnvelope(
      fixture.journalPath,
      canonicalConsolidationEnvelopeBytes("journal", divergent),
    )
    await rm(fixture.journalHeadPath, { force: true })
    await assert.rejects(
      captured.networkEpoch.consume({
        ...consumption,
        currentJournal: divergent,
      }),
      /head|anchor|genesis|missing|history/iu,
    )
  })
})

test("real Task4 composition binds the executed workflow query into Task5 authority", async () => {
  const fixture = await authorityFixture()
  const captured = await captureConsolidationAuthority(fixture.input)
  assert.deepEqual(captured.authority.workflowAuthority.query, EXACT_WORKFLOW_RUN_QUERY)
  assert.match(fixture.workflowRunUrls[0], /per_page=100&page=1/u)
})

test("captures exact ordered npm absence evidence with bounded canonical timestamps", async () => {
  let nowMs = BASE_TIME
  const calls = []
  const inventory = await captureNpmInventory({
    stage: "pre-delete-1",
    candidate: DUPLICATE_DRAFT_CANDIDATE,
    npm: Object.freeze({
      async observePackageVersion(input) {
        calls.push(structuredClone(input))
        nowMs += 1
        return {
          status: "ABSENT",
          operation: "package-version",
          httpStatus: 404,
          code: "E404",
        }
      },
    }),
    now: () => new Date(nowMs).toISOString(),
  })

  assert.deepEqual(
    inventory.packages.map(({ name }) => name),
    CANONICAL_RELEASE_PACKAGE_ORDER,
  )
  assert.deepEqual(
    calls,
    CANONICAL_RELEASE_PACKAGE_ORDER.map((name) => ({
      name,
      version: "0.8.22",
    })),
  )
  assert.equal(
    inventory.packages.every(({ status }) => status === "ABSENT"),
    true,
  )
  assert.equal(Object.isFrozen(inventory.packages), true)
})

test("rejects every non-exact npm observation and a reversed or overlong operation clock", async (t) => {
  for (const [name, result] of [
    [
      "present",
      {
        status: "PRESENT",
        operation: "package-version",
        httpStatus: 200,
        code: null,
      },
    ],
    [
      "ambiguous",
      {
        status: "AMBIGUOUS",
        operation: "package-version",
        httpStatus: 404,
        code: "E404",
      },
    ],
    [
      "wrong status",
      {
        status: "ABSENT",
        operation: "package-version",
        httpStatus: 500,
        code: "E404",
      },
    ],
    [
      "wrong code",
      {
        status: "ABSENT",
        operation: "package-version",
        httpStatus: 404,
        code: "HTTP_404",
      },
    ],
    [
      "wrong operation",
      {
        status: "ABSENT",
        operation: "package-metadata",
        httpStatus: 404,
        code: "E404",
      },
    ],
  ]) {
    await t.test(name, async () => {
      await assert.rejects(
        captureNpmInventory({
          stage: "pre-delete-1",
          candidate: DUPLICATE_DRAFT_CANDIDATE,
          npm: Object.freeze({
            async observePackageVersion() {
              return result
            },
          }),
          now: () => "2026-09-01T12:00:00.000Z",
        }),
        /npm|absence|E404|package-version/iu,
      )
    })
  }

  for (const [name, times] of [
    ["reversal", [BASE_TIME + 1, BASE_TIME]],
    ["overlong", [BASE_TIME, BASE_TIME + 120_001]],
  ]) {
    await t.test(name, async () => {
      let index = 0
      await assert.rejects(
        captureNpmInventory({
          stage: "pre-delete-1",
          candidate: DUPLICATE_DRAFT_CANDIDATE,
          npm: Object.freeze({
            async observePackageVersion() {
              return absent()
            },
          }),
          now: () => new Date(times[Math.min(index++, times.length - 1)]).toISOString(),
        }),
        /clock|timestamp|duration|monotone/iu,
      )
    })
  }

  await t.test("pairwise package observation reversal", async () => {
    let call = 0
    await assert.rejects(
      captureNpmInventory({
        stage: "pre-delete-1",
        candidate: DUPLICATE_DRAFT_CANDIDATE,
        npm: Object.freeze({
          async observePackageVersion() {
            return absent()
          },
        }),
        now: () => {
          call += 1
          const offset = call === 2 ? 10 : call === 3 ? 5 : 10
          return new Date(BASE_TIME + (call === 1 ? 0 : offset)).toISOString()
        },
      }),
      /monotone|observation|timestamp/iu,
    )
  })
})

test("rejects invalid repository, checkout, workflow, tag, actor, and SHA authority before a writer exists", async (t) => {
  const cases = [
    ["dirty checkout", (fixture) => (fixture.localState.porcelainStatus = " M package.json")],
    ["non-main", (fixture) => (fixture.localState.branch = "release")],
    ["detached", (fixture) => (fixture.localState.branch = null)],
    ["origin mismatch", (fixture) => (fixture.localState.originMainSha = "b".repeat(40))],
    ["GitHub mismatch", (fixture) => (fixture.githubMainSha.value = "b".repeat(40))],
    ["repository", (fixture) => (fixture.repository.name = "cacheplane/other")],
    ["repository id", (fixture) => (fixture.repository.id = "1")],
    ["actor", (fixture) => (fixture.actor.login = "someone-else")],
    ["actor id", (fixture) => (fixture.actor.id = "1")],
    ["workflow state", (fixture) => (fixture.workflow.state = "active")],
    ["workflow path", (fixture) => (fixture.workflow.path = ".github/workflows/ci.yml")],
    ["active run", (fixture) => fixture.nonterminalRuns.push({ id: "1" })],
    ["moved tag", (fixture) => (fixture.annotatedTag.targetSha = "b".repeat(40))],
    ["lightweight tag", (fixture) => (fixture.annotatedTag.objectType = "commit")],
  ]

  for (const [name, mutate] of cases) {
    await t.test(name, async () => {
      const fixture = await authorityFixture()
      mutate(fixture)
      await assert.rejects(
        captureConsolidationAuthority(fixture.input),
        /repository|actor|checkout|branch|clean|SHA|workflow|run|tag|authority|local Git reader/iu,
      )
    })
  }
})

test("rejects wrong stage sets, missing or changed drafts, and target disagreement", async (t) => {
  for (const [name, mutate] of [
    ["wrong target", (fixture) => (fixture.input.targetReleaseId = DUPLICATE_DRAFT_IDS[1])],
    ["missing draft", (fixture) => fixture.remainingReleases.splice(1, 1)],
    [
      "extra managed draft",
      (fixture) =>
        fixture.remainingReleases.push({
          ...structuredClone(fixture.remainingReleases[1]),
          id: 999999999,
        }),
    ],
    [
      "published draft",
      (fixture) => (fixture.remainingReleases[1].published_at = "2026-09-01T12:00:00Z"),
    ],
    ["changed body", (fixture) => (fixture.remainingReleases[1].name = "changed")],
    [
      "target/list disagreement",
      (fixture) => (fixture.directRelease.updated_at = "2026-09-01T11:59:59Z"),
    ],
  ]) {
    await t.test(name, async () => {
      const fixture = await authorityFixture()
      mutate(fixture)
      await assert.rejects(
        captureConsolidationAuthority(fixture.input),
        /release|draft|target|proposal|parity|managed|identity|digest/iu,
      )
    })
  }
})

test("epoch rejects proposal drift before invoking the journal-intent writer", async () => {
  const fixture = await authorityFixture()
  const captured = await captureConsolidationAuthority(fixture.input)
  const driftedProposal = structuredClone(fixture.proposal)
  driftedProposal.inspectedAt = "2026-09-01T11:59:59.000Z"
  const consumption = await journalIntentConsumption(captured, fixture, {
    proposal: driftedProposal,
  })

  await assert.rejects(captured.networkEpoch.consume(consumption), /proposal|binding|changed/iu)
  await assert.rejects(captured.networkEpoch.consume(consumption), /consumed|epoch/iu)
  assert.equal(
    parseConsolidationJournal(
      await readPrivateEnvelope(fixture.journalPath, 64 * 1024 * 1024),
    ).record.events.at(-1).event.type,
    "delete-authority-observed",
  )
})

test("epoch attempts burn before binding and trusted-clock failures", async (t) => {
  const invalidCases = [
    [
      "wrong authority",
      ({ authority, consumption }) => {
        authority.controller.headSha = "b".repeat(40)
        consumption.authority = authority
      },
    ],
    [
      "wrong target",
      ({ consumption }) => {
        consumption.targetReleaseId = DUPLICATE_DRAFT_IDS[1]
      },
    ],
    [
      "wrong path",
      ({ consumption }) => {
        consumption.intentPath = `${consumption.intentPath}.other`
      },
    ],
    [
      "current journal digest drift",
      ({ consumption }) => {
        consumption.currentJournal = structuredClone(consumption.currentJournal)
        consumption.currentJournal.record.updatedAt = "2026-09-01T11:59:59.000Z"
      },
    ],
  ]
  for (const [name, mutate] of invalidCases) {
    await t.test(name, async () => {
      const fixture = await authorityFixture()
      const captured = await captureConsolidationAuthority(fixture.input)
      const authority = structuredClone(captured.authority)
      const consumption = await journalIntentConsumption(captured, fixture)
      mutate({ authority, consumption })
      await assert.rejects(
        captured.networkEpoch.consume(consumption),
        /authority|binding|canonical|envelope|epoch|JSON|path|proposal|sha|target/iu,
      )
      assert.equal(
        parseConsolidationJournal(
          await readPrivateEnvelope(fixture.journalPath, 64 * 1024 * 1024),
        ).record.events.at(-1).event.type,
        "delete-authority-observed",
      )
      await assert.rejects(captured.networkEpoch.consume(consumption), /consumed|epoch/iu)
    })
  }

  for (const [name, clock] of [
    ["invalid", () => "2026-09-01T12:00:00Z"],
    [
      "throwing",
      () => {
        throw new Error("secret-clock-token")
      },
    ],
    [
      "stale",
      (captured) => () =>
        new Date(Date.parse(captured.authority.npmInventory.completedAt) + 120_001).toISOString(),
    ],
    [
      "future/reversed",
      (captured) => () => new Date(Date.parse(captured.authority.observedAt) - 1).toISOString(),
    ],
  ]) {
    await t.test(`${name} trusted clock`, async () => {
      const fixture = await authorityFixture()
      const captured = await captureConsolidationAuthority(fixture.input)
      fixture.setClock(clock.length === 0 ? clock : clock(captured))
      await assert.rejects(
        captured.networkEpoch.consume(await journalIntentConsumption(captured, fixture)),
        (error) => {
          assert.equal(error.message.includes("secret-clock-token"), false)
          return /clock|fresh|future|monotone|stale|epoch/iu.test(error.message)
        },
      )
      assert.equal(
        parseConsolidationJournal(
          await readPrivateEnvelope(fixture.journalPath, 64 * 1024 * 1024),
        ).record.events.at(-1).event.type,
        "delete-authority-observed",
      )
      await assert.rejects(
        captured.networkEpoch.consume(await journalIntentConsumption(captured, fixture)),
        /consumed|epoch/iu,
      )
    })
  }

  for (const forbidden of ["writeIntent", "now"]) {
    await t.test(`caller ${forbidden} cannot substitute for owned authority`, async () => {
      const fixture = await authorityFixture()
      const captured = await captureConsolidationAuthority(fixture.input)
      const consumption = await journalIntentConsumption(captured, fixture)
      consumption[forbidden] =
        forbidden === "writeIntent" ? async () => {} : "2099-01-01T00:00:00.000Z"
      await assert.rejects(
        captured.networkEpoch.consume(consumption),
        /field|descriptor|consumption/iu,
      )
      assert.equal(
        parseConsolidationJournal(
          await readPrivateEnvelope(fixture.journalPath, 64 * 1024 * 1024),
        ).record.events.at(-1).event.type,
        "delete-authority-observed",
      )
      await assert.rejects(captured.networkEpoch.consume(consumption), /consumed|epoch/iu)
    })
  }
})

test("epoch fails closed when freshness expires during the real durable write", async () => {
  const fixture = await authorityFixture()
  const captured = await captureConsolidationAuthority(fixture.input)
  let calls = 0
  fixture.setClock(() => {
    calls += 1
    const offset = calls <= 2 ? 0 : 120_001
    return new Date(Date.parse(captured.authority.npmInventory.completedAt) + offset).toISOString()
  })
  await assert.rejects(
    captured.networkEpoch.consume(await journalIntentConsumption(captured, fixture)),
    /epoch|invalid|durable|do not DELETE/iu,
  )
  await readFile(fixture.journalPath)
  await assert.rejects(
    captured.networkEpoch.consume(await journalIntentConsumption(captured, fixture)),
    /consumed|epoch/iu,
  )
})

test("post-write trusted-clock failures are redacted and report possibly durable intent", async () => {
  const fixture = await authorityFixture()
  const captured = await captureConsolidationAuthority(fixture.input)
  let calls = 0
  fixture.setClock(() => {
    calls += 1
    if (calls === 3) throw new Error("secret-post-write-clock")
    return captured.authority.observedAt
  })
  await assert.rejects(
    captured.networkEpoch.consume(await journalIntentConsumption(captured, fixture)),
    (error) => {
      assert.equal(error.message.includes("secret-post-write-clock"), false)
      return /may already be durable.*do not DELETE/iu.test(error.message)
    },
  )
  await readFile(fixture.journalPath)
})

test("raw reads and DELETE attempts during intent persistence invalidate the permit", async (t) => {
  for (const effect of ["read", "delete"]) {
    await t.test(effect, async () => {
      const fixture = await authorityFixture()
      const captured = await captureConsolidationAuthority(fixture.input)
      const pending = captured.networkEpoch.consume(
        await journalIntentConsumption(captured, fixture),
      )
      if (effect === "read") {
        await assert.rejects(fixture.adapters.github.getRepository(), /sealed|epoch|rejected/iu)
      } else {
        await assert.rejects(
          fixture.adapters.writer.deleteDuplicate({
            releaseId: DUPLICATE_DRAFT_IDS[0],
            permit: Object.freeze({}),
          }),
          /permit|one-use|valid/iu,
        )
      }
      await assert.rejects(pending, /epoch|invalid|may already be durable|do not DELETE/iu)
      assert.equal(
        fixture.networkOperations.some((entry) => entry.startsWith("delete:")),
        false,
      )
    })
  }
})

test("a permit is unforgeably bound to its composed delete writer", async () => {
  const fixture = await authorityFixture()
  const captured = await captureConsolidationAuthority(fixture.input)
  const permit = await captured.networkEpoch.consume(
    await journalIntentConsumption(captured, fixture),
  )
  let standaloneFetches = 0
  const standalone = createExactDuplicateDeleteEffect({
    repository: "cacheplane/dawnai",
    apiOrigin: "https://api.github.com",
    survivorId: DUPLICATE_DRAFT_SURVIVOR_ID,
    duplicateIds: DUPLICATE_DRAFT_IDS,
    token: "github_test_token_123456789",
    fetchImpl: async () => {
      standaloneFetches += 1
      return new Response(null, { status: 204 })
    },
    timeoutMs: 15_000,
    now: () => captured.authority.observedAt,
  })
  await assert.rejects(
    standalone.deleteDuplicate({
      releaseId: DUPLICATE_DRAFT_IDS[0],
      permit,
    }),
    /guard|permit|one-use/iu,
  )
  assert.equal(standaloneFetches, 0)
  await assert.rejects(
    fixture.adapters.writer.deleteDuplicate({
      releaseId: DUPLICATE_DRAFT_IDS[0],
      permit,
    }),
    /guard|permit|one-use|valid/iu,
  )
  assert.equal(
    fixture.networkOperations.some((entry) => entry.startsWith("delete:")),
    false,
  )
})

test("captures pre-delete-2 and final authority with their exact remaining-set rules", async () => {
  const second = await authorityFixture({ stage: "pre-delete-2" })
  const secondCapture = await captureConsolidationAuthority(second.input)
  assert.deepEqual(
    secondCapture.authority.releases.map(({ id }) => id),
    [DUPLICATE_DRAFT_SURVIVOR_ID, DUPLICATE_DRAFT_IDS[1]],
  )
  assert.equal(secondCapture.authority.targetRead.evidence.id, DUPLICATE_DRAFT_IDS[1])
  assert.equal(second.networkOperations.filter((entry) => entry.startsWith("download:")).length, 90)

  const final = await authorityFixture({ stage: "final" })
  const finalCapture = await captureConsolidationAuthority(final.input)
  assert.deepEqual(
    finalCapture.authority.releases.map(({ id }) => id),
    [DUPLICATE_DRAFT_SURVIVOR_ID],
  )
  assert.equal(finalCapture.authority.targetRead, null)
  assert.equal(final.networkOperations.filter((entry) => entry.startsWith("download:")).length, 45)
  assert.equal(final.networkOperations.at(-1).startsWith("download:"), true)
})

test("writer freshness accepts exactly 120000ms and rejects 120001ms, future evidence, and noncanonical clocks", async () => {
  const fixture = await authorityFixture()
  const { authority } = await captureConsolidationAuthority(fixture.input)
  const completed = Date.parse(authority.npmInventory.completedAt)

  assert.doesNotThrow(() =>
    assertFreshWriterAuthority(
      authority,
      fixture.proposal,
      new Date(completed + 120_000).toISOString(),
    ),
  )
  assert.throws(
    () =>
      assertFreshWriterAuthority(
        authority,
        fixture.proposal,
        new Date(completed + 120_001).toISOString(),
      ),
    /stale|fresh|120/iu,
  )
  assert.throws(
    () =>
      assertFreshWriterAuthority(
        authority,
        fixture.proposal,
        new Date(Date.parse(authority.observedAt) - 1).toISOString(),
      ),
    /future|clock|timestamp/iu,
  )
  assert.throws(
    () => assertFreshWriterAuthority(authority, fixture.proposal, "2026-09-01T12:00:00Z"),
    /canonical|timestamp|clock/iu,
  )

  const reorderedPackages = structuredClone(authority)
  reorderedPackages.npmInventory.packages[1].observedAt = reorderedPackages.npmInventory.startedAt
  assert.throws(
    () => assertFreshWriterAuthority(reorderedPackages, fixture.proposal, authority.observedAt),
    /order|monotone|timestamp/iu,
  )

  const reorderedPhases = structuredClone(authority)
  reorderedPhases.workflowAuthority.observedAt = reorderedPhases.npmInventory.packages[0].observedAt
  assert.throws(
    () => assertFreshWriterAuthority(reorderedPhases, fixture.proposal, authority.observedAt),
    /order|monotone|timestamp/iu,
  )
})

test("writer validation owns every adjacent target-read chronology boundary", async (t) => {
  const fixture = await authorityFixture()
  const { authority } = await captureConsolidationAuthority(fixture.input)
  const ordered = structuredClone(authority)
  let timestamp = Date.parse(ordered.npmInventory.completedAt)
  for (const [object, key] of [
    [ordered.targetRead, "releaseGetStartedAt"],
    [ordered.targetRead, "releaseGetCompletedAt"],
    [ordered.targetRead, "assetsListStartedAt"],
    [ordered.targetRead, "assetsListCompletedAt"],
    [ordered, "observedAt"],
  ]) {
    timestamp += 1
    object[key] = new Date(timestamp).toISOString()
  }
  const boundaries = [
    [
      "npm completion to release GET start",
      (authorityValue) => authorityValue.npmInventory.completedAt,
      (authorityValue) => [authorityValue.targetRead, "releaseGetStartedAt"],
    ],
    [
      "release GET start to completion",
      (authorityValue) => authorityValue.targetRead.releaseGetStartedAt,
      (authorityValue) => [authorityValue.targetRead, "releaseGetCompletedAt"],
    ],
    [
      "release GET completion to asset-list start",
      (authorityValue) => authorityValue.targetRead.releaseGetCompletedAt,
      (authorityValue) => [authorityValue.targetRead, "assetsListStartedAt"],
    ],
    [
      "asset-list start to completion",
      (authorityValue) => authorityValue.targetRead.assetsListStartedAt,
      (authorityValue) => [authorityValue.targetRead, "assetsListCompletedAt"],
    ],
    [
      "asset-list completion to authority observation",
      (authorityValue) => authorityValue.targetRead.assetsListCompletedAt,
      (authorityValue) => [authorityValue, "observedAt"],
    ],
  ]
  for (const [name, earlierValue, laterLocation] of boundaries) {
    await t.test(`${name} accepts equality`, () => {
      const equal = structuredClone(ordered)
      const [object, key] = laterLocation(equal)
      object[key] = earlierValue(equal)
      assert.doesNotThrow(() =>
        assertFreshWriterAuthority(equal, fixture.proposal, new Date(timestamp + 1).toISOString()),
      )
    })
    await t.test(`${name} rejects reversal`, () => {
      const reversed = structuredClone(ordered)
      const [object, key] = laterLocation(reversed)
      object[key] = new Date(Date.parse(earlierValue(reversed)) - 1).toISOString()
      assert.throws(
        () =>
          assertFreshWriterAuthority(
            reversed,
            fixture.proposal,
            new Date(timestamp + 1).toISOString(),
          ),
        /chronology|monotone|target|timestamp/iu,
      )
    })
  }
})

test("descriptor-hostile inputs fail without invoking getters", async () => {
  const fixture = await authorityFixture()
  let invoked = false
  const hostile = {}
  Object.defineProperty(hostile, "stage", {
    enumerable: true,
    get() {
      invoked = true
      throw new Error("secret getter payload")
    },
  })

  await assert.rejects(captureConsolidationAuthority(hostile), /input|descriptor|data/iu)
  assert.equal(invoked, false)
  await assert.rejects(captureConsolidationAuthority(new Proxy(fixture.input, {})), /proxy|input/iu)
  assert.equal(invoked, false)
})

test("rejects symbol, hidden, sparse, nonplain, and mutable dependency inputs", async (t) => {
  const malformedRoots = []
  const withSymbol = { stage: "pre-delete-1" }
  withSymbol[Symbol("hidden")] = true
  malformedRoots.push(["symbol", withSymbol])
  const withHidden = { stage: "pre-delete-1" }
  Object.defineProperty(withHidden, "hidden", { value: true })
  malformedRoots.push(["hidden", withHidden])
  malformedRoots.push(["nonplain", Object.create({ stage: "pre-delete-1" })])
  for (const [name, value] of malformedRoots) {
    await t.test(name, async () => {
      await assert.rejects(
        captureConsolidationAuthority(value),
        /input|field|plain|symbol|descriptor/iu,
      )
    })
  }

  await t.test("sparse", async () => {
    const fixture = await authorityFixture()
    const proposal = structuredClone(fixture.proposal)
    proposal.roles.duplicates = Array(2)
    fixture.input.proposal = proposal
    await assert.rejects(captureConsolidationAuthority(fixture.input), /dense|array|proposal/iu)
  })
  await t.test("mutable dependency", async () => {
    const fixture = await authorityFixture()
    fixture.input.adapters = {
      ...fixture.adapters,
      local: {
        async readState() {
          return fixture.localState
        },
      },
    }
    await assert.rejects(captureConsolidationAuthority(fixture.input), /adapter|facade|immutable/iu)
  })
})

test("rejects future service observations and authority that ages out during broad reads", async () => {
  const future = await authorityFixture()
  future.remainingReleases[0].updated_at = "2026-09-02T00:00:00Z"
  await assert.rejects(
    captureConsolidationAuthority(future.input),
    /future|observation|timestamp|monotone/iu,
  )

  const stale = await authorityFixture()
  let calls = 0
  stale.setClock(() => {
    calls += 1
    return new Date(BASE_TIME + (calls > 24 ? 120_001 : 0)).toISOString()
  })
  await assert.rejects(
    captureConsolidationAuthority(stale.input),
    /stale|fresh|120000|duration bound/iu,
  )
})

test("redacts dependency failures instead of exposing untrusted controls", async () => {
  const fixture = await authorityFixture()
  fixture.localState.failure = new Error("github_test_token_123\u0000payload")
  await assert.rejects(captureConsolidationAuthority(fixture.input), (error) => {
    assert.equal(error.message.includes("github_test_token_123"), false)
    assert.equal(error.message.includes("payload"), false)
    return true
  })
})

async function assertRawReleaseTraceRejected(fixture) {
  await assert.rejects(
    captureConsolidationAuthority(fixture.input),
    /release|managed|candidate|duplicate|published|trace|authority/iu,
  )
  assert.equal(
    fixture.networkOperations.some((entry) => entry.startsWith("delete:")),
    false,
  )
}

async function authorityFixture({
  stage = "pre-delete-1",
  terminalGate = null,
  deleteHook = null,
  attestationVerify = null,
} = {}) {
  const evidenceFixture = createDuplicateDraftConsolidationFixture()
  const inspected = await inspectEquivalentDrafts({
    candidate: evidenceFixture.candidate,
    survivorId: evidenceFixture.survivorId,
    duplicateIds: evidenceFixture.duplicateIds,
    releases: evidenceFixture.releases,
    github: evidenceFixture.github,
    attestations: evidenceFixture.attestations,
  })
  evidenceFixture.clearOperations()
  let nowMs = BASE_TIME
  let clockImplementation = () => new Date(nowMs).toISOString()
  const networkOperations = []
  const workflowRunUrls = []
  const expectedIds =
    stage === "pre-delete-1"
      ? [DUPLICATE_DRAFT_SURVIVOR_ID, ...DUPLICATE_DRAFT_IDS]
      : stage === "pre-delete-2"
        ? [DUPLICATE_DRAFT_SURVIVOR_ID, DUPLICATE_DRAFT_IDS[1]]
        : [DUPLICATE_DRAFT_SURVIVOR_ID]
  const remainingReleases = evidenceFixture.releases
    .filter(({ id }) => expectedIds.includes(String(id)))
    .map((release) => structuredClone(release))
  const directRelease = structuredClone(
    remainingReleases.find(
      ({ id }) =>
        String(id) === (stage === "pre-delete-2" ? DUPLICATE_DRAFT_IDS[1] : DUPLICATE_DRAFT_IDS[0]),
    ),
  )
  const repository = {
    name: "cacheplane/dawnai",
    id: REPOSITORY_ID,
    defaultBranch: "main",
  }
  const actor = { ...ACTOR }
  const githubMainSha = { value: DUPLICATE_DRAFT_CANDIDATE.commitSha }
  const workflow = {
    workflowId: WORKFLOW_ID,
    path: ".github/workflows/release.yml",
    state: "disabled_manually",
  }
  const nonterminalRuns = []
  const annotatedTag = {
    name: "v0.8.22",
    objectSha: TAG_OBJECT_SHA,
    targetSha: DUPLICATE_DRAFT_CANDIDATE.commitSha,
    objectType: "tag",
    observedAt: new Date(BASE_TIME).toISOString(),
  }
  const localState = {
    headSha: DUPLICATE_DRAFT_CANDIDATE.commitSha,
    branch: "main",
    porcelainStatus: "",
    originMainSha: DUPLICATE_DRAFT_CANDIDATE.commitSha,
  }
  const log = (operation) => {
    networkOperations.push(operation)
  }
  const proposal = deepFreeze(
    createConsolidationEnvelope("proposed", {
      schemaVersion: 1,
      repository: {
        name: "cacheplane/dawnai",
        id: REPOSITORY_ID,
        defaultBranch: "main",
        actor: { ...ACTOR },
      },
      controller: {
        headSha: DUPLICATE_DRAFT_CANDIDATE.commitSha,
        originMainSha: DUPLICATE_DRAFT_CANDIDATE.commitSha,
        githubMainSha: DUPLICATE_DRAFT_CANDIDATE.commitSha,
      },
      candidate: DUPLICATE_DRAFT_CANDIDATE,
      roles: {
        survivor: DUPLICATE_DRAFT_SURVIVOR_ID,
        duplicates: [...DUPLICATE_DRAFT_IDS],
      },
      confirmation: {
        version: "0.8.22",
        commitSha: DUPLICATE_DRAFT_CANDIDATE.commitSha,
        survivor: DUPLICATE_DRAFT_SURVIVOR_ID,
        duplicates: [...DUPLICATE_DRAFT_IDS],
        template: "Consolidate <64-lowercase-hex-digest>",
      },
      annotatedTag: { ...annotatedTag },
      workflowAuthority: {
        ...workflow,
        query: {
          statuses: ["in_progress", "pending", "queued", "requested", "waiting"],
          perPage: 100,
          maximumPages: 100,
        },
        nonterminalRuns: [],
        observedAt: new Date(BASE_TIME).toISOString(),
      },
      npmInventories: [npmInventory("inspect-initial"), npmInventory("inspect-ready")],
      releases: inspected.releases,
      payloadProof: inspected.payloadProof,
      inspectedAt: new Date(BASE_TIME).toISOString(),
    }).record,
  )
  const root = await mkdtemp(path.join(await realpath(os.tmpdir()), "dawn-authority-"))
  TEMPORARY_ROOTS.push(root)
  await mkdir(path.join(root, ".dawn", "release"), { recursive: true })
  const adapters = await createDuplicateDraftConsolidationAdapters({
    cwd: root,
    token: "github_test_token_123456789",
    environment: { HOME: root, PATH: "/tools" },
    dependencies: {
      fetchImpl: async (url, init) => {
        const parsed = new URL(url)
        if (init.method === "DELETE") {
          if (deleteHook !== null) await deleteHook()
          log(`delete:${parsed.pathname.split("/").at(-1)}`)
          return new Response(null, { status: 204 })
        }
        if (parsed.pathname === "/repos/cacheplane/dawnai") {
          log("repository")
          return jsonResponse({
            id: Number(repository.id),
            full_name: repository.name,
            default_branch: repository.defaultBranch,
          })
        }
        if (parsed.pathname === "/user") {
          log("user")
          return jsonResponse({ login: actor.login, id: Number(actor.id) })
        }
        if (parsed.pathname.endsWith("/runs")) {
          log("workflow-runs")
          workflowRunUrls.push(parsed.href)
          const workflowRuns = nonterminalRuns.map((run, index) => ({
            id: Number(run.id ?? index + 1),
            run_attempt: run.runAttempt ?? 1,
            status: run.status ?? "queued",
            event: run.event ?? "workflow_dispatch",
            head_sha: run.headSha ?? DUPLICATE_DRAFT_CANDIDATE.commitSha,
            head_branch: run.headBranch ?? "main",
          }))
          return jsonResponse({
            total_count: workflowRuns.length,
            workflow_runs: workflowRuns,
          })
        }
        throw new Error("unexpected fixture network request")
      },
      now: () => clockImplementation(),
      run: async (command, args) => {
        if (command !== "git") throw new Error("unexpected fixture command")
        if (args[0] === "symbolic-ref") {
          if (localState.branch === null) throw new Error("detached")
          return commandResult(`${localState.branch}\n`)
        }
        if (args[0] === "status") return commandResult(localState.porcelainStatus)
        if (args[0] === "rev-parse") {
          return commandResult(`${localState.originMainSha}\n`)
        }
        throw new Error("unexpected fixture git command")
      },
      createOwnerPreflightAdapters: () => ({
        git: {
          async headSha() {
            if (localState.failure !== undefined) throw localState.failure
            return localState.headSha
          },
        },
      }),
      createGitHubReader: () => ({
        async getRef({ ref }) {
          if (ref === "heads/main") {
            log("default-branch")
            return present("ref", {
              ref: "refs/heads/main",
              object: { type: "commit", sha: githubMainSha.value },
            })
          }
          log("tag-ref")
          return present("ref", {
            ref: `refs/tags/${annotatedTag.name}`,
            object: {
              type: annotatedTag.objectType,
              sha: annotatedTag.objectSha,
            },
          })
        },
        async getGitTag() {
          log("tag-object")
          return present("git-tag", {
            sha: annotatedTag.objectSha,
            tag: annotatedTag.name,
            object: { type: "commit", sha: annotatedTag.targetSha },
          })
        },
        async getWorkflow() {
          log("workflow")
          return present("workflow", {
            id: workflow.workflowId,
            path: workflow.path,
            state: workflow.state,
          })
        },
        async listReleases() {
          log("releases")
          return present("releases", structuredClone(remainingReleases))
        },
        async downloadReleaseAsset(input) {
          log(`download:${input.releaseId}:${input.assetId}`)
          return evidenceFixture.github.downloadReleaseAsset(input)
        },
        async getRelease({ releaseId }) {
          log(`get-release:${releaseId}`)
          if (terminalGate !== null) {
            terminalGate.entered()
            await terminalGate.wait
          }
          const selected =
            directRelease !== undefined && String(directRelease.id) === String(releaseId)
              ? directRelease
              : remainingReleases.find(({ id }) => String(id) === String(releaseId))
          if (selected === undefined) {
            throw new Error("fixture direct release mismatch")
          }
          return present("release", structuredClone(selected))
        },
        async listReleaseAssets({ releaseId }) {
          log(`list-assets:${releaseId}`)
          const selected =
            directRelease !== undefined && String(directRelease.id) === String(releaseId)
              ? directRelease
              : remainingReleases.find(({ id }) => String(id) === String(releaseId))
          if (selected === undefined) {
            throw new Error("fixture direct asset mismatch")
          }
          return present("release-assets", structuredClone(selected.assets))
        },
      }),
      createNpmReader: () => ({
        async observePackageVersion({ name }) {
          log(`npm:${name}`)
          nowMs += 1
          return absent()
        },
      }),
      createCliAttestationVerifier: () => ({
        verify: (input) =>
          attestationVerify === null
            ? evidenceFixture.attestations.verify(input)
            : attestationVerify(input),
      }),
    },
  })
  const input = {
    stage,
    proposal,
    targetReleaseId:
      stage === "final"
        ? null
        : stage === "pre-delete-1"
          ? DUPLICATE_DRAFT_IDS[0]
          : DUPLICATE_DRAFT_IDS[1],
    adapters,
  }
  return {
    input,
    adapters,
    root,
    journalPath: path.join(root, ".dawn", "release", "duplicate-draft-consolidation.journal.json"),
    journalHeadPath: path.join(
      root,
      ".dawn",
      "release",
      "duplicate-draft-consolidation.journal.head.json",
    ),
    proposal,
    localState,
    repository,
    actor,
    githubMainSha,
    workflow,
    nonterminalRuns,
    annotatedTag,
    remainingReleases,
    get directRelease() {
      return directRelease
    },
    get networkOperations() {
      return [...networkOperations]
    },
    get workflowRunUrls() {
      return [...workflowRunUrls]
    },
    get nowMs() {
      return nowMs
    },
    setClock(implementation) {
      clockImplementation = implementation
    },
  }
}

function npmInventory(stage) {
  return {
    stage,
    startedAt: new Date(BASE_TIME).toISOString(),
    completedAt: new Date(BASE_TIME).toISOString(),
    packages: CANONICAL_RELEASE_PACKAGE_ORDER.map((name) => ({
      name,
      version: "0.8.22",
      status: "ABSENT",
      httpStatus: 404,
      code: "E404",
      observedAt: new Date(BASE_TIME).toISOString(),
    })),
  }
}

function absent() {
  return {
    status: "ABSENT",
    operation: "package-version",
    httpStatus: 404,
    code: "E404",
  }
}

function present(operation, value) {
  return { status: "PRESENT", operation, httpStatus: 200, code: null, value }
}

function jsonResponse(value) {
  return new Response(JSON.stringify(value), {
    status: 200,
    headers: { "content-type": "application/json" },
  })
}

function commandResult(stdout) {
  return { exitCode: 0, stdout, stderr: "" }
}

async function journalIntentConsumption(captured, fixture, overrides = {}) {
  const targetReleaseId = captured.authority.targetRead.evidence.id
  const recordedAt = captured.authority.observedAt
  const proposedEnvelope = createConsolidationEnvelope("proposed", fixture.proposal)
  const confirmation = exactConfirmation(proposedEnvelope)
  const confirmationSha256 = createHash("sha256").update(confirmation, "utf8").digest("hex")
  let currentJournal = createConsolidationJournal({
    proposedEnvelope,
    confirmationSha256,
    recordedAt,
  })
  await writePrivateEnvelope(
    fixture.journalPath,
    canonicalConsolidationEnvelopeBytes("journal", currentJournal),
  )
  await writePrivateEnvelope(fixture.journalHeadPath, journalHeadBytes(fixture, currentJournal))
  currentJournal = appendJournalEvent(
    currentJournal,
    "delete-authority-observed",
    {
      targetReleaseId,
      attemptNumber: 1,
      authority: captured.authority,
    },
    recordedAt,
  )
  await writePrivateEnvelope(
    fixture.journalPath,
    canonicalConsolidationEnvelopeBytes("journal", currentJournal),
  )
  return {
    authority: captured.authority,
    proposal: fixture.proposal,
    confirmation,
    targetReleaseId,
    intentPath: fixture.journalPath,
    currentJournal,
    ...overrides,
  }
}

function exactConfirmation(proposedEnvelope) {
  const { candidate, roles } = proposedEnvelope.record
  return `CONSOLIDATE ${candidate.version} ${candidate.commitSha} SURVIVOR ${roles.survivor} DELETE ${roles.duplicates.join(",")} PROPOSAL ${proposedEnvelope.recordSha256}`
}

function journalHeadBytes(fixture, journal) {
  return Buffer.from(
    `${JSON.stringify({
      schemaVersion: 1,
      journalPath: fixture.journalPath,
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

function deepFreeze(value) {
  if (value !== null && typeof value === "object" && !Object.isFrozen(value)) {
    for (const child of Object.values(value)) deepFreeze(child)
    Object.freeze(value)
  }
  return value
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
