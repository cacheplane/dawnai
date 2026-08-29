import assert from "node:assert/strict"
import test from "node:test"
import { planRelease } from "../planner.mjs"
import { runPostPublicationAudit } from "../post-publication-audit.mjs"
import {
  COMMIT_SHA,
  MANIFEST_SHA256,
  observationForMarker,
  VERSION,
} from "./support/marker-observation.mjs"

test("post-publication audit accepts only the exact published immutable terminal observation", async () => {
  const written = []
  const observation = observationForMarker({ phase: "AUDIT_VERIFIED", releaseStatus: "published" })
  const result = await runPostPublicationAudit(argv(), {
    cwd: "/tmp/dawn-post-publication-audit",
    environment: environment(),
    now: fixedTimestamps(),
    createRuntime: async () => runtime(observation),
    writeResult: async (path, value) => written.push({ path, value }),
  })

  assert.equal(result.conclusion, "success")
  assert.deepEqual(
    result.checks.map(({ name, conclusion }) => [name, conclusion]),
    [
      ["production-observation", "success"],
      ["production-plan", "success"],
    ],
  )
  assert.equal(written.length, 1)
  assert.deepEqual(written[0].value, result)
})

test("post-publication audit writes a failure result for a mutable or draft Release", async () => {
  for (const observation of [
    observationForMarker({ phase: "AUDIT_VERIFIED", releaseStatus: "draft" }),
    {
      ...observationForMarker({ phase: "AUDIT_VERIFIED", releaseStatus: "published" }),
      release: {
        ...observationForMarker({ phase: "AUDIT_VERIFIED", releaseStatus: "published" }).release,
        immutable: false,
      },
    },
  ]) {
    const written = []
    await assert.rejects(
      runPostPublicationAudit(argv(), {
        cwd: "/tmp/dawn-post-publication-audit",
        environment: environment(),
        now: fixedTimestamps(),
        createRuntime: async () => runtime(observation),
        writeResult: async (_path, value) => written.push(value),
      }),
      /post-publication audit failed/iu,
    )
    assert.equal(written.length, 1)
    assert.equal(written[0].conclusion, "failure")
  }
})

test("post-publication audit rejects a planner result that is not a mutation-free AUDIT_COMPLETE no-op", async () => {
  const observation = observationForMarker({ phase: "AUDIT_VERIFIED", releaseStatus: "published" })
  const written = []
  await assert.rejects(
    runPostPublicationAudit(argv(), {
      cwd: "/tmp/dawn-post-publication-audit",
      environment: environment(),
      now: fixedTimestamps(),
      createRuntime: async () =>
        runtime(observation, {
          state: "AUDIT_VERIFIED",
          disposition: "would-transition",
          nextTransition: "publish-github-release",
          conflicts: [],
          proposedMutations: [
            { type: "publish-github-release", version: VERSION, commitSha: COMMIT_SHA },
          ],
        }),
      writeResult: async (_path, value) => written.push(value),
    }),
    /post-publication audit failed/iu,
  )
  assert.equal(written[0].conclusion, "failure")
})

function argv() {
  return [
    "--version",
    VERSION,
    "--commit-sha",
    COMMIT_SHA,
    "--manifest-sha256",
    MANIFEST_SHA256,
    "--result",
    "result.json",
  ]
}

function environment() {
  return {
    GITHUB_REPOSITORY: "cacheplane/dawnai",
    GITHUB_EVENT_NAME: "workflow_dispatch",
    GITHUB_WORKFLOW_REF: `cacheplane/dawnai/.github/workflows/published-artifact-verify.yml@refs/tags/v${VERSION}`,
    GITHUB_REF: `refs/tags/v${VERSION}`,
    GITHUB_SHA: COMMIT_SHA,
    GITHUB_RUN_ID: "700",
    GITHUB_RUN_ATTEMPT: "1",
  }
}

function runtime(observation, plan = planRelease) {
  return {
    inventory: {
      async read() {
        return observation.inventory
      },
    },
    async observeProductionCandidate() {
      return { observation, diagnostics: [] }
    },
    async planRelease(input) {
      return typeof plan === "function" ? plan(input) : plan
    },
  }
}

function fixedTimestamps() {
  const values = [new Date("2026-08-25T10:00:00.000Z"), new Date("2026-08-25T10:01:00.000Z")]
  return () => values.shift()
}
