import assert from "node:assert/strict"
import test from "node:test"

import {
  coordinateIndependentAudit,
  parseIndependentAuditCoordinatorArgs,
} from "../independent-audit-coordinator.mjs"
import { canonicalReleaseBody, parseReleaseMarker } from "../metadata.mjs"
import {
  COMMIT_SHA,
  MANIFEST_SHA256,
  observationForMarker,
  VERSION,
} from "./support/marker-observation.mjs"

const MAIN_SHA = "f".repeat(40)
const TAG_SHA = "e".repeat(40)

test("coordinator arguments accept only one GitHub output path", () => {
  assert.deepEqual(parseIndependentAuditCoordinatorArgs(["--github-output", "/tmp/output"]), {
    githubOutput: "/tmp/output",
  })
  assert.throws(() => parseIndependentAuditCoordinatorArgs([]), /exactly|github-output/iu)
  assert.throws(
    () => parseIndependentAuditCoordinatorArgs(["--github-output", "/tmp/output", "--extra", "x"]),
    /unknown|exactly/iu,
  )
})

test("a schedule discovers the highest managed published immutable Release and relays its exact tag", async () => {
  const older = managedRelease({
    id: 10,
    version: "0.8.21",
    commitSha: "1".repeat(40),
  })
  const latest = managedRelease({ id: 11, version: VERSION, commitSha: COMMIT_SHA })
  const calls = []
  const result = await coordinateIndependentAudit({
    eventName: "schedule",
    ref: "refs/heads/main",
    sha: MAIN_SHA,
    defaultBranch: "main",
    inputs: { version: "", commitSha: "", manifestSha256: "" },
    github: githubBoundary({ releases: [latest, older], calls }),
  })

  assert.deepEqual(result, {
    mode: "relayed",
    version: VERSION,
    commitSha: COMMIT_SHA,
    manifestSha256: MANIFEST_SHA256,
  })
  assert.deepEqual(calls, [
    {
      workflow: ".github/workflows/published-artifact-verify.yml",
      ref: `v${VERSION}`,
      inputs: { version: VERSION, commitSha: COMMIT_SHA, manifestSha256: MANIFEST_SHA256 },
    },
  ])
})

test("default-branch manual inputs still relay while branch SHA equality never enters audit mode", async () => {
  const release = managedRelease({ id: 11, version: VERSION, commitSha: COMMIT_SHA })
  const calls = []
  const result = await coordinateIndependentAudit({
    eventName: "workflow_dispatch",
    ref: "refs/heads/main",
    sha: COMMIT_SHA,
    defaultBranch: "main",
    inputs: { version: VERSION, commitSha: COMMIT_SHA, manifestSha256: MANIFEST_SHA256 },
    github: githubBoundary({ releases: [release], calls }),
  })

  assert.equal(result.mode, "relayed")
  assert.equal(calls.length, 1)
})

test("an exact annotated tag routes mutable draft and published immutable audits separately", async () => {
  const draft = managedRelease({
    id: 11,
    version: VERSION,
    commitSha: COMMIT_SHA,
    draft: true,
  })
  const published = managedRelease({ id: 11, version: VERSION, commitSha: COMMIT_SHA })

  for (const [release, mode] of [
    [draft, "draft"],
    [published, "published"],
  ]) {
    const calls = []
    const result = await coordinateIndependentAudit({
      eventName: "workflow_dispatch",
      ref: `refs/tags/v${VERSION}`,
      sha: COMMIT_SHA,
      defaultBranch: "main",
      inputs: { version: VERSION, commitSha: COMMIT_SHA, manifestSha256: MANIFEST_SHA256 },
      github: githubBoundary({ releases: [release], calls }),
    })
    assert.equal(result.mode, mode)
    assert.equal(calls.length, 0)
  }
})

test("coordinator rejects lightweight or off-target tags before routing or dispatch", async () => {
  const release = managedRelease({ id: 11, version: VERSION, commitSha: COMMIT_SHA })
  for (const readerOverride of [{ refType: "commit" }, { tagTargetSha: "d".repeat(40) }]) {
    const calls = []
    await assert.rejects(
      coordinateIndependentAudit({
        eventName: "schedule",
        ref: "refs/heads/main",
        sha: MAIN_SHA,
        defaultBranch: "main",
        inputs: { version: "", commitSha: "", manifestSha256: "" },
        github: githubBoundary({ releases: [release], calls, ...readerOverride }),
      }),
      /annotated|peel|tag/iu,
    )
    assert.equal(calls.length, 0)
  }
})

test("coordinator rejects a relay receipt whose run URLs do not bind the returned ID", async () => {
  const release = managedRelease({ id: 11, version: VERSION, commitSha: COMMIT_SHA })
  const github = githubBoundary({ releases: [release], calls: [] })
  github.writer.dispatchWorkflowAtRef = async () => ({
    workflowRunId: 100,
    runUrl: "https://api.github.com/repos/cacheplane/dawnai/actions/runs/99",
    htmlUrl: "https://github.com/cacheplane/dawnai/actions/runs/100",
  })
  await assert.rejects(
    coordinateIndependentAudit({
      eventName: "schedule",
      ref: "refs/heads/main",
      sha: MAIN_SHA,
      defaultBranch: "main",
      inputs: { version: "", commitSha: "", manifestSha256: "" },
      github,
    }),
    /receipt|URL|run/iu,
  )
})

function managedRelease({ id, version, commitSha, draft = false }) {
  const marker = structuredClone(
    observationForMarker({
      phase: draft ? "SMOKES_COMPLETE" : "AUDIT_VERIFIED",
      releaseStatus: draft ? "draft" : "published",
    }).release.marker,
  )
  marker.version = version
  marker.commitSha = commitSha
  marker.tag = `v${version}`
  marker.attestationSet.sourceRef = `refs/tags/v${version}`
  marker.attestationSet.commitSha = commitSha
  return {
    id,
    name: `Dawn v${version}`,
    tag_name: draft ? "untagged-opaque" : `v${version}`,
    target_commitish: "main",
    draft,
    immutable: !draft,
    prerelease: false,
    body: canonicalReleaseBody({ marker, manifest: null }),
  }
}

function githubBoundary({ releases, calls, refType = "tag", tagTargetSha }) {
  let selectedTag = releases.at(-1)?.tag_name
  return {
    reader: {
      async listReleaseAssets() {
        return present("release-assets", [])
      },
      async listReleases() {
        return present("releases", releases)
      },
      async getReleaseByTag({ tag }) {
        // Real GitHub resolves a Release by tag only once it is published: a draft
        // carries an opaque `untagged-<id>` name and 404s here however its marker
        // reads. Matching a draft's marker tag would make this fake more capable
        // than the API it stands in for, which is exactly how a coordinator that
        // could not observe its own draft reached production.
        const found = releases.find((release) => release.draft !== true && release.tag_name === tag)
        return found === undefined ? absent("release") : present("release", found)
      },
      async getRef({ ref }) {
        selectedTag = ref.replace(/^tags\//u, "")
        return present("ref", { object: { type: refType, sha: TAG_SHA } })
      },
      async getGitTag() {
        const release = releases.find(
          (candidate) =>
            candidate.tag_name === selectedTag ||
            parseReleaseMarker(candidate.body).tag === selectedTag,
        )
        return present("git-tag", {
          tag: selectedTag,
          object: {
            type: "commit",
            sha: tagTargetSha ?? parseReleaseMarker(release.body).commitSha,
          },
        })
      },
    },
    writer: {
      async dispatchWorkflowAtRef(input) {
        calls.push(input)
        return {
          workflowRunId: 100,
          runUrl: "https://api.github.com/repos/cacheplane/dawnai/actions/runs/100",
          htmlUrl: "https://github.com/cacheplane/dawnai/actions/runs/100",
        }
      },
    },
  }
}

function present(operation, value) {
  return { status: "PRESENT", operation, httpStatus: 200, code: null, value }
}

function absent(operation) {
  return { status: "ABSENT", operation, httpStatus: 404, code: "NOT_FOUND", value: null }
}

test("scheduled legacy audit ignores older recovery history when the newest release is legacy", async () => {
  const older = managedRelease({ id: 10, version: "0.8.21", commitSha: "1".repeat(40) })
  older.body = "edited recovery display"
  const latest = managedRelease({ id: 11, version: VERSION, commitSha: COMMIT_SHA })
  const calls = []
  const github = githubBoundary({ releases: [latest, older], calls })
  github.reader.listReleaseAssets = async ({ releaseId }) =>
    present("release-assets", releaseId === 10 ? [{ name: "recovery-v2-finalization.json" }] : [])
  const result = await coordinateIndependentAudit({
    eventName: "schedule",
    ref: "refs/heads/main",
    sha: MAIN_SHA,
    defaultBranch: "main",
    inputs: { version: "", commitSha: "", manifestSha256: "" },
    github,
  })
  assert.equal(result.mode, "relayed")
  assert.equal(calls.length, 1)
  assert.equal(calls[0].ref, `v${VERSION}`)
})
