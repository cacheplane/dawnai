import assert from "node:assert/strict"
import { readFileSync, writeFileSync } from "node:fs"
import { mkdir, readFile } from "node:fs/promises"
import path from "node:path"
import {
  performDuplicateDraftConsolidation,
  performOneDuplicateDeletion,
} from "../../duplicate-draft-consolidation.mjs"
import { createDuplicateDraftConsolidationAdapters } from "../../duplicate-draft-consolidation-adapters.mjs"
import { runDuplicateDraftConsolidationCli } from "../../duplicate-draft-consolidation-cli.mjs"
import { parseConsolidationEnvelope } from "../../duplicate-draft-consolidation-schema.mjs"
import {
  createDuplicateDraftConsolidationFixture,
  DUPLICATE_DRAFT_CANDIDATE,
  DUPLICATE_DRAFT_IDS,
  DUPLICATE_DRAFT_SURVIVOR_ID,
} from "./duplicate-draft-consolidation-fixture.mjs"

const CONTROLLER_SHA = "b".repeat(40)
const PROPOSAL = ".dawn/release/duplicate-draft-consolidation.proposed.json"
const JOURNAL = ".dawn/release/duplicate-draft-consolidation.journal.json"
const RECEIPT = "scripts/release/duplicate-draft-consolidation.json"
const [mode, root, statePath, readyPath] = process.argv.slice(2)

if (mode === "init") {
  await mkdir(path.join(root, ".dawn", "release"), { recursive: true })
  await mkdir(path.join(root, "scripts", "release"), { recursive: true })
  saveState({
    armBeforeDelete: false,
    deleteEffects: [],
    deleted: [],
    nowMs: Date.now() + 60 * 60_000,
  })
  process.exit(0)
}
if (mode === "hang") await new Promise(() => setInterval(() => {}, 1_000))
if (mode === "flood") {
  process.stdout.write("x".repeat(128 * 1024))
  await new Promise(() => setInterval(() => {}, 1_000))
}

const fixture = createDuplicateDraftConsolidationFixture()
const state = () => JSON.parse(readFileSync(statePath, "utf8"))
function saveState(value) {
  writeFileSync(statePath, `${JSON.stringify(value)}\n`, { mode: 0o600 })
}
const updateState = (operation) => {
  const current = state()
  operation(current)
  saveState(current)
  return current
}
const present = (operation, value) => ({
  status: "PRESENT",
  operation,
  httpStatus: 200,
  code: null,
  value,
})
const currentReleases = () => {
  const deleted = new Set(state().deleted)
  return fixture.releases
    .filter(({ id }) => !deleted.has(String(id)))
    .map((release) => structuredClone(release))
}
const githubReader = {
  async getRef({ ref }) {
    if (ref === "heads/main") {
      return present("ref", {
        ref: "refs/heads/main",
        object: { type: "commit", sha: CONTROLLER_SHA },
      })
    }
    return present("ref", {
      ref: `refs/tags/${DUPLICATE_DRAFT_CANDIDATE.tag}`,
      object: { type: "tag", sha: "a".repeat(40) },
    })
  },
  async getGitTag({ tagSha }) {
    return present("git-tag", {
      sha: tagSha,
      tag: DUPLICATE_DRAFT_CANDIDATE.tag,
      object: { type: "commit", sha: DUPLICATE_DRAFT_CANDIDATE.commitSha },
    })
  },
  async getWorkflow() {
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
    assert.ok(release)
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
    const current = state()
    if (current.armBeforeDelete === true) {
      writeFileSync(readyPath, `${process.pid}\n`, { mode: 0o600 })
      await new Promise(() => {})
    }
    assert.equal(current.deleted.includes(releaseId), false)
    updateState((next) => {
      next.deleted.push(releaseId)
      next.deleteEffects.push(releaseId)
    })
    return new Response(null, { status: 204 })
  }
  if (target.endsWith("/repos/cacheplane/dawnai")) {
    return jsonResponse({
      id: 1_210_070_282,
      full_name: "cacheplane/dawnai",
      default_branch: "main",
    })
  }
  if (target.endsWith("/user")) return jsonResponse({ id: 61_436, login: "blove" })
  if (target.includes("/actions/workflows/") && target.includes("/runs?")) {
    return jsonResponse({ total_count: 0, workflow_runs: [] })
  }
  throw new Error(`unexpected process-loss request ${target}`)
}
const now = () => {
  const current = updateState((next) => {
    next.nowMs += 1
  })
  return new Date(current.nowMs).toISOString()
}
const run = async (_command, args) => {
  if (args[0] === "symbolic-ref") return { exitCode: 0, stdout: "main\n", stderr: "" }
  if (args[0] === "status") return { exitCode: 0, stdout: "", stderr: "" }
  if (args[0] === "rev-parse") return { exitCode: 0, stdout: `${CONTROLLER_SHA}\n`, stderr: "" }
  throw new Error(`unexpected process-loss command ${args.join(" ")}`)
}
const createAdapters = ({ cwd }) =>
  createDuplicateDraftConsolidationAdapters({
    cwd,
    token: "fixture_token_value",
    environment: { HOME: root, PATH: "/tools" },
    dependencies: {
      fetchImpl,
      run,
      now,
      createGitHubReader: () => githubReader,
      createOwnerPreflightAdapters: () => ({
        git: { headSha: async () => CONTROLLER_SHA },
      }),
      createNpmReader: () => ({
        observePackageVersion: async () => ({
          status: "ABSENT",
          operation: "package-version",
          httpStatus: 404,
          code: "E404",
        }),
      }),
      createCliAttestationVerifier: () => ({
        verify: (input) => fixture.attestations.verify(input),
      }),
    },
  })
const wait = async (milliseconds, { signal }) => {
  assert.equal(signal.aborted, false)
  updateState((next) => {
    next.nowMs += milliseconds
  })
}

const argv =
  mode === "inspect"
    ? [
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
      ]
    : mode === "verify"
      ? ["verify", "--receipt", RECEIPT]
      : [
          "perform",
          "--proposal",
          PROPOSAL,
          "--journal",
          JOURNAL,
          "--receipt",
          RECEIPT,
          "--confirmation",
          await confirmation(),
        ]

process.exitCode = await runDuplicateDraftConsolidationCli({
  argv,
  cwd: root,
  environment: {},
  stdout: process.stdout,
  stderr: process.stderr,
  dependencies: {
    createAdapters,
    now,
    wait,
    async perform(input, dependencies) {
      return performDuplicateDraftConsolidation(input, {
        ...dependencies,
        performOneDeletion(deletionInput, deletionDependencies) {
          if (mode !== "resume") {
            return performOneDuplicateDeletion(deletionInput, deletionDependencies)
          }
          const future = new Date(state().nowMs + 90_000).toISOString()
          return performOneDuplicateDeletion(deletionInput, {
            ...deletionDependencies,
            wallClockTimeline: Object.freeze(Array.from({ length: 256 }, () => future)),
          })
        },
      })
    },
  },
})

async function confirmation() {
  const proposal = parseConsolidationEnvelope("proposed", await readFile(path.join(root, PROPOSAL)))
  return `CONSOLIDATE v${proposal.record.candidate.version} ${proposal.record.candidate.commitSha} SURVIVOR ${proposal.record.roles.survivor} DELETE ${proposal.record.roles.duplicates.join(",")} PROPOSAL ${proposal.recordSha256}`
}

function jsonResponse(value) {
  return new Response(JSON.stringify(value), {
    status: 200,
    headers: { "content-type": "application/json" },
  })
}
