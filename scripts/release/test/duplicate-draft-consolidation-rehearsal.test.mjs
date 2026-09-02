import assert from "node:assert/strict"
import { createHash } from "node:crypto"
import { mkdir, mkdtemp, realpath, rm, stat } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import test from "node:test"
import {
  performDuplicateDraftConsolidation,
  performOneDuplicateDeletion,
} from "../duplicate-draft-consolidation.mjs"
import { createDuplicateDraftConsolidationAdapters } from "../duplicate-draft-consolidation-adapters.mjs"
import { runDuplicateDraftConsolidationCli } from "../duplicate-draft-consolidation-cli.mjs"
import { assertEvidenceEqualsProposal } from "../duplicate-draft-consolidation-evidence.mjs"
import { readPrivateEnvelope, readTrackedReceipt } from "../duplicate-draft-consolidation-files.mjs"
import {
  DUPLICATE_DRAFT_CONSOLIDATION_LIMITS,
  parseConsolidationEnvelope,
} from "../duplicate-draft-consolidation-schema.mjs"
import {
  createDuplicateDraftConsolidationFixture,
  DUPLICATE_DRAFT_CANDIDATE,
  DUPLICATE_DRAFT_IDS,
  DUPLICATE_DRAFT_SURVIVOR_ID,
} from "./support/duplicate-draft-consolidation-fixture.mjs"

const CONTROLLER_SHA = "b".repeat(40)
const PROPOSAL = ".dawn/release/duplicate-draft-consolidation.proposed.json"
const JOURNAL = ".dawn/release/duplicate-draft-consolidation.journal.json"
const RECEIPT = "scripts/release/duplicate-draft-consolidation.json"
const INSPECT_COMMAND = Object.freeze([
  "inspect",
  "--version",
  DUPLICATE_DRAFT_CANDIDATE.version,
  "--commit-sha",
  DUPLICATE_DRAFT_CANDIDATE.commitSha,
  "--survivor",
  DUPLICATE_DRAFT_SURVIVOR_ID,
  "--duplicates",
  DUPLICATE_DRAFT_IDS.join(","),
  "--output",
  PROPOSAL,
])
const VERIFY_COMMAND = Object.freeze(["verify", "--receipt", RECEIPT])
const PROCESS_LOSS_CASES = Object.freeze([
  Object.freeze({ name: "clean completion", fault: null, expectedIntents: 2 }),
  Object.freeze({
    name: "before first intent",
    target: DUPLICATE_DRAFT_IDS[0],
    boundary: "after-authority-head",
    expectedIntents: 2,
  }),
  Object.freeze({
    name: "after first intent before DELETE",
    target: DUPLICATE_DRAFT_IDS[0],
    boundary: "before-delete",
    expectedIntents: 3,
  }),
  Object.freeze({
    name: "after server deletion before response",
    target: DUPLICATE_DRAFT_IDS[0],
    boundary: "after-delete",
    loseDeleteResponse: true,
    expectedIntents: 2,
  }),
  Object.freeze({
    name: "after first convergence",
    target: DUPLICATE_DRAFT_IDS[0],
    afterConvergence: true,
    expectedIntents: 2,
  }),
  Object.freeze({
    name: "after second intent",
    target: DUPLICATE_DRAFT_IDS[1],
    boundary: "before-delete",
    expectedIntents: 3,
  }),
  Object.freeze({
    name: "after second deletion before receipt",
    target: DUPLICATE_DRAFT_IDS[1],
    boundary: "after-delete",
    expectedIntents: 2,
  }),
  Object.freeze({
    name: "after receipt write before CLI success output",
    failSuccessOutput: true,
    expectedIntents: 2,
  }),
])

test("full inspect, perform, and verify rehearsal survives every approved process-loss point", async (t) => {
  for (const scenario of PROCESS_LOSS_CASES) {
    await t.test(scenario.name, async (t) => {
      const harness = await createRehearsal(t)
      assertThreeDistinctEquivalentDrafts(harness)

      const inspectStdout = memorySink()
      const inspectStderr = memorySink()
      assert.equal(
        await runDuplicateDraftConsolidationCli(
          harness.cli(INSPECT_COMMAND, inspectStdout, inspectStderr),
        ),
        0,
        inspectStderr.value,
      )
      assert.equal(inspectStderr.value, "")
      const inspectReport = JSON.parse(inspectStdout.value)
      const proposalPath = path.join(harness.root, PROPOSAL)
      const originalProposalBytes = await readPrivateEnvelope(
        proposalPath,
        DUPLICATE_DRAFT_CONSOLIDATION_LIMITS.proposedBytes,
      )
      const proposal = parseConsolidationEnvelope("proposed", originalProposalBytes)
      assert.deepEqual(inspectReport, {
        proposalSha256: proposal.recordSha256,
        version: DUPLICATE_DRAFT_CANDIDATE.version,
        commitSha: DUPLICATE_DRAFT_CANDIDATE.commitSha,
        survivor: DUPLICATE_DRAFT_SURVIVOR_ID,
        duplicates: [...DUPLICATE_DRAFT_IDS],
        output: PROPOSAL,
      })

      const confirmation = exactConfirmation(proposal)

      const performCommand = [
        "perform",
        "--proposal",
        PROPOSAL,
        "--journal",
        JOURNAL,
        "--receipt",
        RECEIPT,
        "--confirmation",
        confirmation,
      ]
      const firstStdout = scenario.failSuccessOutput ? throwingSink() : memorySink()
      const firstStderr = memorySink()
      if (scenario.loseDeleteResponse === true) {
        harness.loseNextDeleteResponse(scenario.target)
      }
      const firstCode = await runDuplicateDraftConsolidationCli(
        harness.cli(
          performCommand,
          firstStdout,
          firstStderr,
          performFaultInjection(scenario, harness),
        ),
      )

      let performReport
      if (scenario.fault === null) {
        if (firstCode !== 0) {
          const journal = parseConsolidationEnvelope(
            "journal",
            await readPrivateEnvelope(
              path.join(harness.root, JOURNAL),
              DUPLICATE_DRAFT_CONSOLIDATION_LIMITS.journalBytes,
            ),
          )
          assert.fail(
            `${firstStderr.value} journal events: ${journal.record.events
              .map(({ event }) => event.type)
              .join(",")}`,
          )
        }
        assert.equal(firstCode, 0, firstStderr.value)
        assert.equal(firstStderr.value, "")
        performReport = JSON.parse(firstStdout.value)
      } else {
        assert.equal(firstCode, 1)
        assert.equal(firstStderr.value, "Duplicate-draft perform failed.\n")
        const resumedStdout = memorySink()
        const resumedStderr = memorySink()
        const resumedCode = await runDuplicateDraftConsolidationCli(
          harness.cli(
            performCommand,
            resumedStdout,
            resumedStderr,
            performFaultInjection({ fault: null }, harness),
          ),
        )
        if (resumedCode !== 0) {
          const journal = parseConsolidationEnvelope(
            "journal",
            await readPrivateEnvelope(
              path.join(harness.root, JOURNAL),
              DUPLICATE_DRAFT_CONSOLIDATION_LIMITS.journalBytes,
            ),
          )
          assert.fail(
            `${resumedStderr.value} resumed journal events: ${journal.record.events
              .map(
                ({ event }) =>
                  `${event.type}:${event.payload.targetReleaseId ?? "final"}:${event.payload.attemptNumber ?? "-"}`,
              )
              .join(",")}`,
          )
        }
        assert.equal(resumedCode, 0, resumedStderr.value)
        assert.equal(resumedStderr.value, "")
        performReport = JSON.parse(resumedStdout.value)
      }

      assert.deepEqual(harness.deleteEffects, [...DUPLICATE_DRAFT_IDS])
      assert.deepEqual(harness.remainingReleaseIds(), [DUPLICATE_DRAFT_SURVIVOR_ID])
      assert.deepEqual(
        await readPrivateEnvelope(proposalPath, DUPLICATE_DRAFT_CONSOLIDATION_LIMITS.proposedBytes),
        originalProposalBytes,
      )

      const receiptPath = path.join(harness.root, RECEIPT)
      const receipt = parseConsolidationEnvelope(
        "final",
        await readTrackedReceipt(
          receiptPath,
          DUPLICATE_DRAFT_CONSOLIDATION_LIMITS.finalReceiptBytes,
        ),
      )
      assert.deepEqual(performReport, {
        status: "complete",
        survivor: DUPLICATE_DRAFT_SURVIVOR_ID,
        deleted: [...DUPLICATE_DRAFT_IDS],
        receipt: RECEIPT,
        receiptSha256: receipt.recordSha256,
      })
      assert.equal((await stat(receiptPath)).mode & 0o777, 0o644)
      assert.equal(receipt.record.proposedEnvelope.recordSha256, proposal.recordSha256)
      assertEvidenceEqualsProposal(receipt.record.finalSurvivor, proposal.record.releases[0])
      await assertJournalRecovery(harness.root, receipt, scenario.expectedIntents)
      assertStableAuthority(receipt, proposal)

      const verifyStdout = memorySink()
      const verifyStderr = memorySink()
      const deletesBeforeVerify = [...harness.deleteEffects]
      assert.equal(
        await runDuplicateDraftConsolidationCli(
          harness.cli(VERIFY_COMMAND, verifyStdout, verifyStderr),
        ),
        0,
        verifyStderr.value,
      )
      assert.equal(verifyStderr.value, "")
      assert.deepEqual(harness.deleteEffects, deletesBeforeVerify)
      assert.deepEqual(JSON.parse(verifyStdout.value), {
        status: "verified",
        survivor: DUPLICATE_DRAFT_SURVIVOR_ID,
        deleted: [...DUPLICATE_DRAFT_IDS],
        receipt: RECEIPT,
        receiptSha256: receipt.recordSha256,
        historicalParity:
          "Historical duplicate payload parity is supported by embedded pre-delete evidence plus the currently reverified survivor; deleted bytes were not independently re-downloaded.",
      })
    })
  }
})

async function createRehearsal(t) {
  const root = await realpath(
    await mkdtemp(path.join(os.tmpdir(), "dawn-consolidation-rehearsal-")),
  )
  t.after(() => rm(root, { recursive: true, force: true }))
  await mkdir(path.join(root, ".dawn", "release"), { recursive: true })
  await mkdir(path.join(root, "scripts", "release"), { recursive: true })

  const fixture = createDuplicateDraftConsolidationFixture()
  const deleted = new Set()
  const deleteEffects = []
  let droppedResponseTarget = null
  let nowMs = Date.now() + 60 * 60_000
  const now = () => new Date(nowMs++).toISOString()
  const present = (operation, value) => ({
    status: "PRESENT",
    operation,
    httpStatus: 200,
    code: null,
    value,
  })
  const currentReleases = () =>
    fixture.releases
      .filter(({ id }) => !deleted.has(String(id)))
      .map((release) => structuredClone(release))

  const githubReader = {
    async getRef({ ref }) {
      if (ref === "heads/main") {
        return present("ref", {
          ref: "refs/heads/main",
          object: { type: "commit", sha: CONTROLLER_SHA },
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
      assert.equal(workflow, "release.yml")
      return present("workflow", {
        id: 202_458_345,
        path: ".github/workflows/release.yml",
        state: "disabled_manually",
      })
    },
    async listReleases() {
      return present("releases", currentReleases())
    },
    async getRelease({ releaseId }) {
      const release = currentReleases().find(({ id }) => String(id) === String(releaseId))
      return release === undefined
        ? {
            status: "AMBIGUOUS",
            operation: "release",
            httpStatus: 404,
            code: "NOT_FOUND",
          }
        : present("release", release)
    },
    async listReleaseAssets({ releaseId }) {
      const release = currentReleases().find(({ id }) => String(id) === String(releaseId))
      if (release === undefined) throw new Error("deleted fixture Release has no assets")
      return present("release-assets", release.assets)
    },
    async downloadReleaseAsset(input) {
      return fixture.github.downloadReleaseAsset(input)
    },
  }

  const fetchImpl = async (url, init = {}) => {
    const target = String(url)
    if (init.method === "DELETE") {
      const releaseId = target.split("/").at(-1)
      assert.equal(DUPLICATE_DRAFT_IDS.includes(releaseId), true)
      assert.equal(deleted.has(releaseId), false, "a bounded resume must not repeat DELETE")
      deleted.add(releaseId)
      deleteEffects.push(releaseId)
      if (droppedResponseTarget === releaseId) {
        droppedResponseTarget = null
        throw new Error("fixture process lost the response after the server deleted the Release")
      }
      return new Response(null, { status: 204 })
    }
    if (target === "https://api.github.com/repos/cacheplane/dawnai") {
      return jsonResponse({
        id: 1_210_070_282,
        full_name: "cacheplane/dawnai",
        default_branch: "main",
      })
    }
    if (target === "https://api.github.com/user") {
      return jsonResponse({ id: 61_436, login: "blove" })
    }
    if (target.includes("/actions/workflows/") && target.includes("/runs?")) {
      return jsonResponse({ total_count: 0, workflow_runs: [] })
    }
    throw new Error(`unexpected rehearsal request ${target}`)
  }
  const run = async (_command, args) => {
    if (args[0] === "symbolic-ref") return { exitCode: 0, stdout: "main\n", stderr: "" }
    if (args[0] === "status") return { exitCode: 0, stdout: "", stderr: "" }
    if (args[0] === "rev-parse" && args.at(-1).startsWith("refs/remotes/origin/main")) {
      return { exitCode: 0, stdout: `${CONTROLLER_SHA}\n`, stderr: "" }
    }
    throw new Error(`unexpected rehearsal command ${args.join(" ")}`)
  }
  const createAdapters = ({ cwd }) =>
    createDuplicateDraftConsolidationAdapters({
      cwd,
      token: "ghp_fixture_token_1234567890",
      environment: { HOME: root, PATH: "/tools" },
      dependencies: {
        fetchImpl,
        run,
        now,
        createGitHubReader() {
          return githubReader
        },
        createOwnerPreflightAdapters() {
          return {
            git: {
              async headSha() {
                return CONTROLLER_SHA
              },
            },
          }
        },
        createNpmReader() {
          return {
            async observePackageVersion() {
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
              return fixture.attestations.verify(input)
            },
          }
        },
      },
    })
  const wait = async (milliseconds, { signal }) => {
    assert.equal(signal instanceof AbortSignal, true)
    assert.equal(signal.aborted, false)
    nowMs += milliseconds
  }

  return {
    root,
    fixture,
    deleteEffects,
    remainingReleaseIds() {
      return currentReleases().map(({ id }) => String(id))
    },
    loseNextDeleteResponse(releaseId) {
      assert.equal(droppedResponseTarget, null)
      droppedResponseTarget = releaseId
    },
    wallClockTimeline() {
      const value = new Date(nowMs + 90_000).toISOString()
      return Object.freeze(Array.from({ length: 256 }, () => value))
    },
    cli(argv, stdout, stderr, perform = undefined) {
      return {
        argv: [...argv],
        cwd: root,
        environment: {},
        stdout,
        stderr,
        dependencies: {
          createAdapters,
          now,
          wait,
          ...(perform === undefined ? {} : { perform }),
        },
      }
    },
  }
}

function performFaultInjection(scenario, harness) {
  let injected = false
  return async (input, dependencies) =>
    performDuplicateDraftConsolidation(input, {
      ...dependencies,
      async performOneDeletion(deletionInput, deletionDependencies) {
        const selected = !injected && deletionInput.targetReleaseId === scenario.target
        if (!selected) {
          return performOneDuplicateDeletion(deletionInput, {
            ...deletionDependencies,
            wallClockTimeline: harness.wallClockTimeline(),
          })
        }
        injected = true
        const result = await performOneDuplicateDeletion(deletionInput, {
          ...deletionDependencies,
          ...(scenario.boundary === undefined ? {} : { faultAt: scenario.boundary }),
          wallClockTimeline: harness.wallClockTimeline(),
        })
        if (scenario.afterConvergence === true) {
          throw new Error("fixture process loss after durable convergence")
        }
        return result
      },
    })
}

function assertThreeDistinctEquivalentDrafts(harness) {
  const releases = harness.fixture.releases
  assert.deepEqual(
    releases.map(({ id }) => String(id)),
    [DUPLICATE_DRAFT_SURVIVOR_ID, ...DUPLICATE_DRAFT_IDS],
  )
  assert.equal(new Set(releases.map(({ id }) => String(id))).size, 3)
  assert.deepEqual(
    releases.map(({ assets }) => assets.length),
    [45, 45, 45],
  )
  for (let index = 0; index < releases[0].assets.length; index += 1) {
    const assets = releases.map(({ assets: entries }) => entries[index])
    assert.equal(new Set(assets.map(({ id }) => String(id))).size, 3)
    assert.equal(new Set(assets.map(({ name }) => name)).size, 1)
    const bytes = releases.map(({ id }) => harness.fixture.assetBytes(String(id), assets[0].name))
    assert.deepEqual(bytes[1], bytes[0])
    assert.deepEqual(bytes[2], bytes[0])
  }
}

async function assertJournalRecovery(root, receipt, expectedIntents) {
  const journal = receipt.record.journalEnvelope
  const confirmation = exactConfirmation(receipt.record.proposedEnvelope)
  assert.equal(
    journal.record.confirmationSha256,
    createHash("sha256").update(confirmation, "utf8").digest("hex"),
  )
  assert.equal(
    journal.record.events.filter(({ event }) => event.type === "delete-intent").length,
    expectedIntents,
  )
  assert.deepEqual(
    journal.record.events
      .filter(({ event }) => event.type === "absence-converged")
      .map(({ event }) => event.payload.targetReleaseId),
    [...DUPLICATE_DRAFT_IDS],
  )
  assert.equal(journal.record.events.at(-1).event.type, "final-authority-observed")
  const journalPath = path.join(root, JOURNAL)
  const durableJournal = parseConsolidationEnvelope(
    "journal",
    await readPrivateEnvelope(journalPath, DUPLICATE_DRAFT_CONSOLIDATION_LIMITS.journalBytes),
  )
  assert.deepEqual(durableJournal, journal)
  const headPath = journalPath.replace(/journal\.json$/u, "journal.head.json")
  const head = JSON.parse(await readPrivateEnvelope(headPath, 16 * 1024))
  assert.deepEqual(head, {
    schemaVersion: 1,
    journalPath,
    repository: journal.record.repository,
    proposedRecordSha256: journal.record.proposedRecordSha256,
    journalRecordSha256: journal.recordSha256,
    lastEventSha256: journal.record.events.at(-1).eventSha256,
    sequence: journal.record.events.length,
    updatedAt: journal.record.updatedAt,
  })
}

function assertStableAuthority(receipt, proposal) {
  assert.deepEqual(proposal.record.controller, {
    headSha: CONTROLLER_SHA,
    originMainSha: CONTROLLER_SHA,
    githubMainSha: CONTROLLER_SHA,
  })
  const authorities = receipt.record.journalEnvelope.record.events.flatMap(({ event }) =>
    event.type === "delete-authority-observed" || event.type === "final-authority-observed"
      ? [event.payload.authority]
      : [],
  )
  assert.ok(authorities.length >= 3)
  for (const authority of authorities) {
    assert.deepEqual(authority.controller, proposal.record.controller)
    assert.equal(authority.workflowAuthority.state, "disabled_manually")
    assert.deepEqual(authority.workflowAuthority.nonterminalRuns, [])
    assert.equal(authority.annotatedTag.targetSha, DUPLICATE_DRAFT_CANDIDATE.commitSha)
  }
}

function exactConfirmation(proposal) {
  return `CONSOLIDATE v${proposal.record.candidate.version} ${proposal.record.candidate.commitSha} SURVIVOR ${proposal.record.roles.survivor} DELETE ${proposal.record.roles.duplicates.join(",")} PROPOSAL ${proposal.recordSha256}`
}

function jsonResponse(value) {
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

function throwingSink() {
  return {
    write() {
      throw new Error("fixture process loss before CLI success output")
    },
  }
}
