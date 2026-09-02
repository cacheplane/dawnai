import { createHash } from "node:crypto"
import { mkdir, mkdtemp, realpath } from "node:fs/promises"
import os from "node:os"
import path from "node:path"

import { createDuplicateDraftConsolidationAdapters } from "../../duplicate-draft-consolidation-adapters.mjs"
import { captureConsolidationAuthority } from "../../duplicate-draft-consolidation-authority.mjs"
import { inspectEquivalentDrafts } from "../../duplicate-draft-consolidation-evidence.mjs"
import { writePrivateEnvelope } from "../../duplicate-draft-consolidation-files.mjs"
import {
  appendJournalEvent,
  createConsolidationJournal,
} from "../../duplicate-draft-consolidation-journal.mjs"
import {
  canonicalConsolidationEnvelopeBytes,
  createConsolidationEnvelope,
} from "../../duplicate-draft-consolidation-schema.mjs"
import { CANONICAL_RELEASE_PACKAGE_ORDER } from "../../manifest.mjs"
import {
  createDuplicateDraftConsolidationFixture,
  DUPLICATE_DRAFT_CANDIDATE,
  DUPLICATE_DRAFT_IDS,
  DUPLICATE_DRAFT_SURVIVOR_ID,
} from "./duplicate-draft-consolidation-fixture.mjs"

const BASE_TIME = Date.parse("2026-09-01T12:34:55.000Z")
const REPOSITORY_ID = "1210070282"
const ACTOR = Object.freeze({ login: "blove", id: "61436" })
const TAG_OBJECT_SHA = "123456789abcdef0123456789abcdef012345678"
const WORKFLOW_ID = "202458345"

export async function createAuthorizedDeleteHarness({ fetchImpl, deleteNow }) {
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
  let clock = () => new Date(nowMs).toISOString()
  const remainingReleases = evidenceFixture.releases.map((release) => structuredClone(release))
  const directRelease = structuredClone(
    remainingReleases.find(({ id }) => String(id) === DUPLICATE_DRAFT_IDS[0]),
  )
  const annotatedTag = {
    name: DUPLICATE_DRAFT_CANDIDATE.tag,
    objectSha: TAG_OBJECT_SHA,
    targetSha: DUPLICATE_DRAFT_CANDIDATE.commitSha,
    objectType: "tag",
    observedAt: new Date(BASE_TIME).toISOString(),
  }
  const proposal = createConsolidationEnvelope("proposed", {
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
      version: DUPLICATE_DRAFT_CANDIDATE.version,
      commitSha: DUPLICATE_DRAFT_CANDIDATE.commitSha,
      survivor: DUPLICATE_DRAFT_SURVIVOR_ID,
      duplicates: [...DUPLICATE_DRAFT_IDS],
      template: "Consolidate <64-lowercase-hex-digest>",
    },
    annotatedTag,
    workflowAuthority: {
      workflowId: WORKFLOW_ID,
      path: ".github/workflows/release.yml",
      state: "disabled_manually",
      query: workflowQuery(),
      nonterminalRuns: [],
      observedAt: new Date(BASE_TIME).toISOString(),
    },
    npmInventories: [npmInventory("inspect-initial"), npmInventory("inspect-ready")],
    releases: inspected.releases,
    payloadProof: inspected.payloadProof,
    inspectedAt: new Date(BASE_TIME).toISOString(),
  })
  const root = await mkdtemp(path.join(await realpath(os.tmpdir()), "dawn-authorized-delete-"))
  await mkdir(path.join(root, ".dawn", "release"), { recursive: true })
  const adapters = await createDuplicateDraftConsolidationAdapters({
    cwd: root,
    token: "github_test_token_123456789",
    environment: { HOME: root, PATH: "/tools" },
    dependencies: {
      fetchImpl: async (url, init) => {
        const parsed = new URL(url)
        if (init.method === "DELETE") return fetchImpl(url, init)
        if (parsed.pathname === "/repos/cacheplane/dawnai") {
          return jsonResponse({
            id: Number(REPOSITORY_ID),
            full_name: "cacheplane/dawnai",
            default_branch: "main",
          })
        }
        if (parsed.pathname === "/user") {
          return jsonResponse({ login: ACTOR.login, id: Number(ACTOR.id) })
        }
        if (parsed.pathname.endsWith("/runs")) {
          return jsonResponse({ total_count: 0, workflow_runs: [] })
        }
        throw new Error("unexpected authorized-delete network request")
      },
      now: () => clock(),
      run: async (command, args) => {
        if (command !== "git") throw new Error("unexpected command")
        if (args[0] === "symbolic-ref") return commandResult("main\n")
        if (args[0] === "status") return commandResult("")
        if (args[0] === "rev-parse") {
          return commandResult(`${DUPLICATE_DRAFT_CANDIDATE.commitSha}\n`)
        }
        throw new Error("unexpected git command")
      },
      createOwnerPreflightAdapters: () => ({
        git: { headSha: async () => DUPLICATE_DRAFT_CANDIDATE.commitSha },
      }),
      createGitHubReader: () => ({
        async getRef({ ref }) {
          if (ref === "heads/main") {
            return present("ref", {
              ref: "refs/heads/main",
              object: {
                type: "commit",
                sha: DUPLICATE_DRAFT_CANDIDATE.commitSha,
              },
            })
          }
          return present("ref", {
            ref: `refs/tags/${annotatedTag.name}`,
            object: { type: "tag", sha: annotatedTag.objectSha },
          })
        },
        async getGitTag() {
          return present("git-tag", {
            sha: annotatedTag.objectSha,
            tag: annotatedTag.name,
            object: {
              type: "commit",
              sha: annotatedTag.targetSha,
            },
          })
        },
        async getWorkflow() {
          return present("workflow", {
            id: WORKFLOW_ID,
            path: ".github/workflows/release.yml",
            state: "disabled_manually",
          })
        },
        async listReleases() {
          return present("releases", structuredClone(remainingReleases))
        },
        async downloadReleaseAsset(input) {
          return evidenceFixture.github.downloadReleaseAsset(input)
        },
        async getRelease({ releaseId }) {
          if (String(releaseId) !== DUPLICATE_DRAFT_IDS[0]) {
            throw new Error("unexpected direct target")
          }
          return present("release", structuredClone(directRelease))
        },
        async listReleaseAssets({ releaseId }) {
          const selected = remainingReleases.find(({ id }) => String(id) === String(releaseId))
          if (selected === undefined) throw new Error("unexpected Release assets")
          return present("release-assets", structuredClone(selected.assets))
        },
      }),
      createNpmReader: () => ({
        async observePackageVersion() {
          nowMs += 1
          return absent()
        },
      }),
      createCliAttestationVerifier: () => ({
        verify: (input) => evidenceFixture.attestations.verify(input),
      }),
    },
  })
  const captured = await captureConsolidationAuthority({
    stage: "pre-delete-1",
    proposal: proposal.record,
    targetReleaseId: DUPLICATE_DRAFT_IDS[0],
    adapters,
  })
  const confirmation = exactConfirmation(proposal)
  const confirmationSha256 = createHash("sha256").update(confirmation, "utf8").digest("hex")
  let journal = createConsolidationJournal({
    proposedEnvelope: proposal,
    confirmationSha256,
    recordedAt: captured.authority.observedAt,
  })
  const journalPath = path.join(
    root,
    ".dawn",
    "release",
    "duplicate-draft-consolidation.journal.json",
  )
  const journalHeadPath = path.join(
    root,
    ".dawn",
    "release",
    "duplicate-draft-consolidation.journal.head.json",
  )
  await writePrivateEnvelope(journalPath, canonicalConsolidationEnvelopeBytes("journal", journal))
  await writePrivateEnvelope(journalHeadPath, journalHeadBytes(journalPath, journal))
  journal = appendJournalEvent(
    journal,
    "delete-authority-observed",
    {
      targetReleaseId: DUPLICATE_DRAFT_IDS[0],
      attemptNumber: 1,
      authority: captured.authority,
    },
    captured.authority.observedAt,
  )
  await writePrivateEnvelope(journalPath, canonicalConsolidationEnvelopeBytes("journal", journal))
  const permit = await captured.networkEpoch.consume({
    authority: captured.authority,
    proposal: proposal.record,
    confirmation,
    targetReleaseId: DUPLICATE_DRAFT_IDS[0],
    intentPath: journalPath,
    currentJournal: journal,
  })
  clock = deleteNow
  return { adapters, permit, root }
}

function exactConfirmation(proposal) {
  const { candidate, roles } = proposal.record
  return `CONSOLIDATE v${candidate.version} ${candidate.commitSha} SURVIVOR ${roles.survivor} DELETE ${roles.duplicates.join(",")} PROPOSAL ${proposal.recordSha256}`
}

function journalHeadBytes(journalPath, journal) {
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

function workflowQuery() {
  return {
    statuses: ["in_progress", "pending", "queued", "requested", "waiting"],
    perPage: 100,
    maximumPages: 100,
  }
}

function npmInventory(stage) {
  return {
    stage,
    startedAt: new Date(BASE_TIME).toISOString(),
    completedAt: new Date(BASE_TIME).toISOString(),
    packages: CANONICAL_RELEASE_PACKAGE_ORDER.map((name) => ({
      name,
      version: DUPLICATE_DRAFT_CANDIDATE.version,
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
