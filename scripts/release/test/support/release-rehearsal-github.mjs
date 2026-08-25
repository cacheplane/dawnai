import { createHash } from "node:crypto"

import { parseReleaseMarker, releaseBodySha256 } from "../../metadata.mjs"
import { canonicalReleaseRecordBytes } from "../../release-record.mjs"

const REPOSITORY = "cacheplane/dawnai"
const AUDIT_WORKFLOW = ".github/workflows/published-artifact-verify.yml"
const SHA_PATTERN = /^[0-9a-f]{40}$/u
const SHA256_PATTERN = /^[0-9a-f]{64}$/u

export function createRehearsalArtifactUploadResult({ candidate, artifact }) {
  const identity = validateCandidate(candidate)
  if (
    artifact?.manifest?.version !== identity.version ||
    artifact.manifest.commitSha !== identity.commitSha ||
    !Array.isArray(artifact.files) ||
    artifact.files.length !== 22
  ) {
    throw new TypeError("Release rehearsal Actions upload input is invalid")
  }
  const sha256 = digest(storedZip(artifact.files))
  return Object.freeze({
    artifactId: "900",
    artifactUrl: `https://github.com/${REPOSITORY}/actions/runs/300/artifacts/900`,
    artifactDigest: sha256,
  })
}

export function createRehearsalGitHub({ candidate, gate, baseAssetNames = [], tagResolver }) {
  const identity = validateCandidate(candidate)
  if (
    gate === null ||
    typeof gate !== "object" ||
    typeof gate.around !== "function" ||
    typeof gate.checkpoint !== "function"
  ) {
    throw new TypeError("Release rehearsal fault gate is invalid")
  }
  if (
    !Array.isArray(baseAssetNames) ||
    baseAssetNames.some((name) => typeof name !== "string" || name.length === 0) ||
    new Set(baseAssetNames).size !== baseAssetNames.length ||
    ![0, 45].includes(baseAssetNames.length)
  ) {
    throw new TypeError("Release rehearsal base asset inventory is invalid")
  }
  const baseOrdinal = new Map(baseAssetNames.map((name, index) => [name, index + 1]))
  const resolveTag =
    tagResolver ??
    (async () => {
      return identity.commitSha
    })
  if (typeof resolveTag !== "function") {
    throw new TypeError("Release rehearsal tag resolver is invalid")
  }
  const state = {
    dispatchedRunIds: [],
    nextRunId: 501,
    retryAudit: false,
    release: null,
    assets: new Map(),
    nextAssetId: 1,
    prepared: null,
    publisherStarted: false,
  }

  const actionsWriter = Object.freeze({
    async dispatchWorkflowAtRef(input) {
      validateDispatchInput(input, identity)
      const transition = state.retryAudit ? "retry-audit-dispatch" : "audit-dispatch"
      return gate.around(transition, async () => {
        const workflowRunId = state.nextRunId
        state.nextRunId += 1
        state.dispatchedRunIds.push(workflowRunId)
        return Object.freeze({
          workflowRunId,
          runUrl: `https://api.github.com/repos/${REPOSITORY}/actions/runs/${workflowRunId}`,
          htmlUrl: `https://github.com/${REPOSITORY}/actions/runs/${workflowRunId}`,
        })
      })
    },
  })

  const reader = Object.freeze({
    async getCommitCheckRuns({ commitSha }) {
      if (commitSha !== identity.commitSha) return absent("commit-check-runs")
      return present("commit-check-runs", [
        {
          id: 101,
          name: "validate",
          head_sha: identity.commitSha,
          status: "completed",
          conclusion: "success",
          check_suite: { id: 100 },
        },
      ])
    },
    async listWorkflowRuns({ workflow, commitSha }) {
      if (commitSha !== identity.commitSha) return present("workflow-runs", [])
      if (workflow === "ci.yml") return present("workflow-runs", [ciRun(identity)])
      if (workflow === "release.yml") {
        return present("workflow-runs", state.prepared === null ? [] : [prepareRun(identity)])
      }
      return present("workflow-runs", [])
    },
    async listTagRefs() {
      const commitSha = await resolveTag()
      return present(
        "tag-refs",
        commitSha === null
          ? []
          : [
              {
                ref: `refs/tags/v${identity.version}`,
                object: { type: "tag", sha: "f".repeat(40) },
              },
            ],
      )
    },
    async getRef() {
      const commitSha = await resolveTag()
      if (commitSha === null) return absent("ref")
      return present("ref", {
        ref: `refs/tags/v${identity.version}`,
        object: { type: "tag", sha: "f".repeat(40) },
      })
    },
    async getGitTag() {
      const commitSha = await resolveTag()
      if (commitSha === null) return absent("git-tag")
      return present("git-tag", {
        tag: `v${identity.version}`,
        object: { type: "commit", sha: commitSha },
      })
    },
    async listReleases() {
      return present("releases", state.release === null ? [] : [cloneRelease(state.release)])
    },
    async getReleaseByTag({ tag }) {
      if (state.release === null || state.release.tag_name !== tag) return absent("release")
      return present("release", cloneRelease(state.release))
    },
    async getRelease({ releaseId }) {
      if (state.release === null || releaseId !== state.release.id) {
        throw new Error("Release rehearsal GitHub Release is missing")
      }
      const read = async () => present("release", cloneRelease(state.release))
      return state.release.draft ? read() : gate.around("immutable-reread", read)
    },
    async listReleaseAssets({ releaseId }) {
      requireReleaseId(state, releaseId)
      return present(
        "release-assets",
        [...state.assets].map(([name, asset]) => ({
          id: asset.id,
          name,
          size: asset.bytes.byteLength,
          digest: `sha256:${digest(asset.bytes)}`,
        })),
      )
    },
    async downloadReleaseAsset({ assetId }) {
      const asset = [...state.assets.values()].find((entry) => entry.id === assetId)
      if (asset === undefined) throw new Error("Release rehearsal asset is missing")
      return {
        status: "PRESENT",
        operation: "release-asset-download",
        httpStatus: 200,
        code: null,
        contentBase64: asset.bytes.toString("base64"),
      }
    },
    async listActionsArtifacts({ name }) {
      if (state.prepared === null || state.prepared.payloadMetadata.name !== name) {
        return present("actions-artifacts", [])
      }
      return present("actions-artifacts", [structuredClone(state.prepared.payloadMetadata)])
    },
    async listActionsRunArtifacts({ runId }) {
      if (state.prepared === null || Number(runId) !== 300) {
        return present("actions-run-artifacts", [])
      }
      return present("actions-run-artifacts", [
        structuredClone(state.prepared.payloadMetadata),
        structuredClone(state.prepared.handoffMetadata),
      ])
    },
    async downloadActionsArtifact({ artifactId }) {
      if (state.prepared === null) return absent("actions-artifact-download")
      const bytes = state.prepared.archives.get(String(artifactId))
      if (bytes === undefined) return absent("actions-artifact-download")
      return binary("actions-artifact-download", bytes)
    },
    async getActionsRun() {
      return absent("actions-run")
    },
    async getActionsRunAttempt({ runId, attempt }) {
      if (Number(runId) === 100 && attempt === 1) {
        return present("actions-run-attempt", ciRun(identity))
      }
      if (state.prepared !== null && Number(runId) === 300 && attempt === 1) {
        return present("actions-run-attempt", prepareRun(identity))
      }
      return absent("actions-run-attempt")
    },
    async listActionsRunJobs({ runId }) {
      if (Number(runId) === 100) return present("actions-run-jobs", [ciJob()])
      if (state.prepared !== null && Number(runId) === 300) {
        return present("actions-run-jobs", [publisherJob({ started: state.publisherStarted })])
      }
      return present("actions-run-jobs", [])
    },
  })

  const writer = Object.freeze({
    async createDraftRelease({ tag, targetSha, title, body }) {
      validateReleaseIdentity({ tag, targetSha }, identity)
      return gate.around("draft-create", async () => {
        if (state.release === null) {
          state.release = {
            id: 7,
            tag_name: tag,
            name: title,
            body,
            draft: true,
            immutable: false,
            target_commitish: "main",
            prerelease: false,
          }
          return {
            releaseId: 7,
            status: "created",
            bodySha256: releaseBodySha256(body),
          }
        }
        return {
          releaseId: state.release.id,
          status: "existing",
          bodySha256: releaseBodySha256(state.release.body),
        }
      })
    },
    async updateDraftReleaseIfCurrent({
      releaseId,
      tag,
      targetSha,
      expectedBodySha256,
      title,
      body,
    }) {
      validateReleaseIdentity({ tag, targetSha }, identity)
      requireReleaseId(state, releaseId)
      if (!state.release.draft || releaseBodySha256(state.release.body) !== expectedBodySha256) {
        throw new Error("Release rehearsal draft compare-and-swap failed")
      }
      const previous = parseReleaseMarker(state.release.body)
      const next = parseReleaseMarker(body)
      const transition = markerTransition(previous.phase, next.phase)
      const update = async () => {
        state.release.name = title
        state.release.body = body
        state.retryAudit = next.phase === "AUDIT_RETRYABLE"
        return {
          releaseId,
          status: "updated",
          bodySha256: releaseBodySha256(body),
        }
      }
      return transition === null ? update() : gate.around(transition, update)
    },
    async uploadAssetIfAbsentAndEqual({ releaseId, tag, targetSha, name, bytes, sha256 }) {
      validateReleaseIdentity({ tag, targetSha }, identity)
      requireReleaseId(state, releaseId)
      const content = Buffer.from(bytes)
      if (digest(content) !== sha256) throw new Error("Release rehearsal asset digest is invalid")
      const transition = assetTransition({ name, content, baseOrdinal })
      const upload = async () => {
        const existing = state.assets.get(name)
        if (existing !== undefined) {
          if (digest(existing.bytes) !== sha256) {
            throw new Error("Release rehearsal asset conflicts with durable state")
          }
          return { assetId: existing.id, status: "existing", sha256 }
        }
        const asset = { id: state.nextAssetId, bytes: Buffer.from(content) }
        state.nextAssetId += 1
        state.assets.set(name, asset)
        return { assetId: asset.id, status: "uploaded", sha256 }
      }
      return transition === null ? upload() : gate.around(transition, upload)
    },
    async publishReleaseIfCurrent({ releaseId, tag, targetSha, expectedBodySha256, assets }) {
      validateReleaseIdentity({ tag, targetSha }, identity)
      requireReleaseId(state, releaseId)
      if (!state.release.draft || releaseBodySha256(state.release.body) !== expectedBodySha256) {
        throw new Error("Release rehearsal publication compare-and-swap failed")
      }
      if (!Array.isArray(assets) || assets.length !== state.assets.size) {
        throw new Error("Release rehearsal publication asset set is incomplete")
      }
      return gate.around("release-publication", async () => {
        state.release.draft = false
        state.release.immutable = true
        return { releaseId, status: "published", immutable: true }
      })
    },
  })

  const releaseGitHub = Object.freeze({ reader, writer })
  const escrowReader = Object.freeze({
    async loadEscrow({ tag }) {
      if (
        tag !== `v${identity.version}` ||
        state.release === null ||
        state.release.tag_name !== tag ||
        state.assets.size !== 45
      ) {
        throw new Error("Release rehearsal escrow is incomplete")
      }
      const record = state.assets.get("release-record.json")
      if (record === undefined) throw new Error("Release rehearsal record asset is missing")
      const files = []
      const bundles = []
      for (const name of baseAssetNames) {
        if (name === "release-record.json") continue
        const asset = state.assets.get(name)
        if (asset === undefined) throw new Error("Release rehearsal escrow asset is missing")
        const file = { name, bytes: Buffer.from(asset.bytes) }
        if (name.endsWith(".intoto.jsonl")) bundles.push(file)
        else files.push(file)
      }
      return {
        status: "PRESENT",
        draft: state.release.draft,
        files,
        releaseRecordBytes: Buffer.from(record.bytes),
        bundles,
      }
    },
  })

  return Object.freeze({
    actionsWriter,
    escrowReader,
    releaseGitHub,
    recordPreparedArtifact({ record, artifact }) {
      if (
        state.prepared !== null ||
        record?.version !== identity.version ||
        record?.commitSha !== identity.commitSha ||
        record.actionsArtifact?.prepareRunId !== "300" ||
        record.actionsArtifact.prepareRunAttempt !== 1 ||
        artifact?.manifest?.version !== identity.version ||
        artifact.manifest.commitSha !== identity.commitSha ||
        !Array.isArray(artifact.files) ||
        artifact.files.length !== 22
      ) {
        throw new TypeError("Release rehearsal prepared Actions artifact is invalid")
      }
      const payloadArchive = storedZip(artifact.files)
      if (record.actionsArtifact.serviceDigest !== `sha256:${digest(payloadArchive)}`) {
        throw new Error("Release rehearsal prepared artifact service digest conflicts")
      }
      const handoffArchive = storedZip([
        { name: "release-record.json", bytes: canonicalReleaseRecordBytes(record) },
      ])
      const payloadId = Number(record.actionsArtifact.id)
      const handoffId = payloadId + 1
      const workflowRun = { id: 300, head_sha: identity.commitSha }
      state.prepared = {
        payloadMetadata: {
          id: payloadId,
          name: record.actionsArtifact.name,
          digest: record.actionsArtifact.serviceDigest,
          expired: false,
          workflow_run: workflowRun,
        },
        handoffMetadata: {
          id: handoffId,
          name: `release-record-v${identity.version}-${identity.commitSha.slice(0, 12)}`,
          digest: `sha256:${digest(handoffArchive)}`,
          expired: false,
          workflow_run: workflowRun,
        },
        archives: new Map([
          [String(payloadId), payloadArchive],
          [String(handoffId), handoffArchive],
        ]),
      }
    },
    recordPublisherStarted() {
      if (state.prepared === null) {
        throw new Error("Release rehearsal publisher cannot start before preparation")
      }
      state.publisherStarted = true
    },
    snapshot() {
      return deepFreeze({
        dispatchedRunIds: [...state.dispatchedRunIds],
        retryAudit: state.retryAudit,
        release: state.release === null ? null : cloneRelease(state.release),
        assets: [...state.assets].map(([name, asset]) => ({
          id: asset.id,
          name,
          size: asset.bytes.byteLength,
          sha256: digest(asset.bytes),
        })),
      })
    },
  })
}

function markerTransition(previous, next) {
  if (next === "NPM_COMPLETE") return "reconcile-npm"
  if (next === "SMOKES_COMPLETE") return "reconcile-smokes"
  if (next === "AUDIT_RETRYABLE") return "audit-retryable-cas"
  if (next === "AUDIT_VERIFIED") return "audit-verified-cas"
  if (next === "AUDIT_DISPATCHED") {
    return previous === "AUDIT_RETRYABLE" ? "retry-audit-dispatched-cas" : "audit-dispatched-cas"
  }
  return null
}

function assetTransition({ name, content, baseOrdinal }) {
  const ordinal = baseOrdinal.get(name)
  if ([1, 23, 45].includes(ordinal)) return `escrow-asset:${ordinal}`
  if (name === "audit-result.json") return "canonical-audit-success"
  if (/^audit-attempt-[1-9][0-9]*-[1-9][0-9]*\.json$/u.test(name)) {
    let conclusion
    try {
      conclusion = JSON.parse(content.toString("utf8")).conclusion
    } catch {
      throw new TypeError("Release rehearsal audit attempt bytes are invalid")
    }
    return conclusion === "failure" ? "failed-audit-attempt" : "successful-audit-attempt"
  }
  return null
}

function validateReleaseIdentity({ tag, targetSha }, candidate) {
  if (tag !== `v${candidate.version}` || targetSha !== candidate.commitSha) {
    throw new Error("Release rehearsal mutation identity is invalid")
  }
}

function requireReleaseId(state, releaseId) {
  if (state.release === null || state.release.id !== releaseId) {
    throw new Error("Release rehearsal GitHub Release identity is invalid")
  }
}

function cloneRelease(release) {
  return { ...release }
}

function present(operation, value) {
  return { status: "PRESENT", operation, httpStatus: 200, code: null, value }
}

function absent(operation) {
  return { status: "ABSENT", operation, httpStatus: 404, code: "HTTP_404" }
}

function binary(operation, bytes) {
  return {
    status: "PRESENT",
    operation,
    httpStatus: 200,
    code: null,
    contentBase64: Buffer.from(bytes).toString("base64"),
  }
}

function ciRun(candidate) {
  return {
    id: 100,
    run_attempt: 1,
    name: "CI",
    path: ".github/workflows/ci.yml",
    head_sha: candidate.commitSha,
    head_branch: "main",
    event: "push",
    status: "completed",
    conclusion: "success",
    check_suite_id: 100,
  }
}

function ciJob() {
  return {
    id: 101,
    runAttempt: 1,
    name: "validate",
    status: "completed",
    conclusion: "success",
    startedAt: "2026-08-25T00:00:00.000Z",
    completedAt: "2026-08-25T00:01:00.000Z",
  }
}

function prepareRun(candidate) {
  return {
    id: 300,
    run_attempt: 1,
    name: "Release",
    path: candidate.publisherWorkflow,
    head_sha: candidate.commitSha,
    head_branch: `v${candidate.version}`,
    event: "workflow_dispatch",
    status: "completed",
    conclusion: "success",
  }
}

function publisherJob({ started }) {
  return {
    id: 201,
    runAttempt: 1,
    name: "publish-npm",
    status: "completed",
    conclusion: started ? "success" : "skipped",
    startedAt: "2026-08-25T00:02:00.000Z",
    completedAt: "2026-08-25T00:03:00.000Z",
  }
}

function storedZip(files) {
  const locals = []
  const centrals = []
  let offset = 0
  for (const file of files) {
    const name = Buffer.from(file.name)
    const bytes = Buffer.from(file.bytes)
    const local = Buffer.alloc(30 + name.length + bytes.length)
    local.writeUInt32LE(0x04034b50, 0)
    local.writeUInt16LE(20, 4)
    local.writeUInt16LE(0, 6)
    local.writeUInt16LE(0, 8)
    local.writeUInt32LE(bytes.length, 18)
    local.writeUInt32LE(bytes.length, 22)
    local.writeUInt16LE(name.length, 26)
    name.copy(local, 30)
    bytes.copy(local, 30 + name.length)
    locals.push(local)

    const central = Buffer.alloc(46 + name.length)
    central.writeUInt32LE(0x02014b50, 0)
    central.writeUInt16LE(20, 4)
    central.writeUInt16LE(20, 6)
    central.writeUInt16LE(0, 8)
    central.writeUInt16LE(0, 10)
    central.writeUInt32LE(bytes.length, 20)
    central.writeUInt32LE(bytes.length, 24)
    central.writeUInt16LE(name.length, 28)
    central.writeUInt32LE(offset, 42)
    name.copy(central, 46)
    centrals.push(central)
    offset += local.length
  }
  const centralSize = centrals.reduce((total, entry) => total + entry.length, 0)
  const end = Buffer.alloc(22)
  end.writeUInt32LE(0x06054b50, 0)
  end.writeUInt16LE(files.length, 8)
  end.writeUInt16LE(files.length, 10)
  end.writeUInt32LE(centralSize, 12)
  end.writeUInt32LE(offset, 16)
  return Buffer.concat([...locals, ...centrals, end])
}

function digest(bytes) {
  return createHash("sha256").update(bytes).digest("hex")
}

function validateCandidate(value) {
  if (
    value === null ||
    Array.isArray(value) ||
    typeof value !== "object" ||
    Object.keys(value).sort().join(",") !==
      "ciCheck,ciWorkflow,commitSha,publisherWorkflow,version" ||
    typeof value.version !== "string" ||
    !SHA_PATTERN.test(value.commitSha) ||
    value.ciWorkflow !== "CI" ||
    value.ciCheck !== "validate" ||
    value.publisherWorkflow !== ".github/workflows/release.yml"
  ) {
    throw new TypeError("Release rehearsal candidate is invalid")
  }
  return deepFreeze(structuredClone(value))
}

function validateDispatchInput(value, candidate) {
  if (
    value === null ||
    Array.isArray(value) ||
    typeof value !== "object" ||
    Object.keys(value).sort().join(",") !== "inputs,ref,workflow" ||
    value.workflow !== AUDIT_WORKFLOW ||
    value.ref !== `v${candidate.version}` ||
    value.inputs === null ||
    Array.isArray(value.inputs) ||
    typeof value.inputs !== "object" ||
    Object.keys(value.inputs).sort().join(",") !== "commitSha,manifestSha256,version" ||
    value.inputs.version !== candidate.version ||
    value.inputs.commitSha !== candidate.commitSha ||
    !SHA256_PATTERN.test(value.inputs.manifestSha256)
  ) {
    throw new TypeError("Release rehearsal audit dispatch is invalid")
  }
}

function deepFreeze(value) {
  if (value !== null && typeof value === "object" && !Object.isFrozen(value)) {
    for (const child of Object.values(value)) deepFreeze(child)
    Object.freeze(value)
  }
  return value
}
