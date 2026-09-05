import assert from "node:assert/strict"
import { renderRecoveryReleaseBody } from "../../recovery/metadata.mjs"
import { canonicalRecoveryBytes } from "../../recovery/schema.mjs"
import { digest } from "./recovery-fixture.mjs"
import { recoveryWriteRemote } from "./recovery-write-fixture.mjs"

const present = (value) => ({ status: "PRESENT", value })
const artifactName = (lane) =>
  `recovery-v2-lane-${lane.lane}-${lane.executor.runId}-${lane.executor.runAttempt}-${lane.executor.jobId}`

export async function evidenceRemote() {
  const r = await recoveryWriteRemote()
  r.activate([...r.baseAssets, r.adoption.archive, r.adoptionRef])
  r.release.body = renderRecoveryReleaseBody({ marker: r.marker, body: "Original notes" })
  const time = Date.parse("2026-09-04T10:04:00.000Z")
  r.dependencies.authority.now = () => time
  const originalFence = r.dependencies.authority.observeLegacyFence
  r.dependencies.authority.observeLegacyFence = async () => ({
    ...(await originalFence()),
    observedAt: time,
    expiresAt: time + 30000,
  })
  const github = r.args.github
  const originalJobs = github.listActionsRunJobs
  const originalRun = github.getActionsRunAttempt
  const jobs = Object.values(r.lanes).map((lane) => ({
    id: Number(lane.executor.jobId),
    runAttempt: Number(lane.executor.runAttempt),
    name: `recovery-${lane.lane}`,
    status: "completed",
    conclusion: "success",
    startedAt: "2026-09-04T10:00:00.000Z",
    completedAt: "2026-09-04T10:03:00.000Z",
  }))
  const archives = new Map()
  const artifacts = Object.values(r.lanes).map((lane, index) => {
    const files = [
      { name: `${artifactName(lane)}.json`, bytes: canonicalRecoveryBytes(lane) },
      ...lane.installations.map((d) => ({ name: d.assetName, bytes: r.raws.get(d.assetName) })),
    ]
    const bytes = zip(files)
    archives.set(String(200 + index), { bytes, files })
    return {
      id: 200 + index,
      name: artifactName(lane),
      size_in_bytes: bytes.length,
      digest: `sha256:${digest(bytes)}`,
      expired: false,
      created_at: "2026-09-04T10:02:00.000Z",
      updated_at: "2026-09-04T10:02:00.000Z",
      workflow_run: {
        id: Number(r.e.runId),
        repository_id: 901,
        head_repository_id: 901,
        head_branch: "main",
        head_sha: r.e.controllerSha,
      },
    }
  })
  const run = { ...(await originalRun({ runId: r.e.runId })).value }
  github.getActionsRunAttempt = async (a) => (a.runId === r.e.runId ? present(run) : originalRun(a))
  github.listActionsRunJobs = async (a) => {
    const result = await originalJobs(a)
    return a.runId === r.e.runId
      ? present([
          ...result.value.map((j) => ({
            ...j,
            name: "recovery-evidence",
            startedAt: "2026-09-04T10:03:30.000Z",
            completedAt: null,
          })),
          ...jobs,
        ])
      : result
  }
  github.listActionsRunArtifacts = async () => present(artifacts)
  github.getActionsArtifact = async ({ artifactId }) =>
    present(artifacts.find((a) => String(a.id) === artifactId))
  let downloads = 0
  github.downloadActionsArtifact = async ({ artifactId, maximumBytes }) => {
    downloads++
    const bytes = archives.get(artifactId).bytes
    assert.ok(bytes.length <= maximumBytes)
    return { status: "PRESENT", contentBase64: bytes.toString("base64") }
  }
  return {
    ...r,
    artifacts,
    archives,
    jobs,
    run,
    downloads: () => downloads,
    replaceFiles(lane, files) {
      const a = artifacts.find((a) => a.name === artifactName(r.lanes[lane]))
      const bytes = zip(files)
      archives.set(String(a.id), { bytes, files })
      a.digest = `sha256:${digest(bytes)}`
      a.size_in_bytes = bytes.length
    },
  }
}

// Stored ZIP fixture: the production shared extractor validates its directory and bounds.
function zip(files) {
  const locals = [],
    centrals = []
  let offset = 0
  for (const { name, bytes } of files) {
    const n = Buffer.from(name),
      local = Buffer.alloc(30),
      central = Buffer.alloc(46)
    local.writeUInt32LE(0x04034b50)
    local.writeUInt32LE(bytes.length, 18)
    local.writeUInt32LE(bytes.length, 22)
    local.writeUInt16LE(n.length, 26)
    central.writeUInt32LE(0x02014b50)
    central.writeUInt32LE(bytes.length, 20)
    central.writeUInt32LE(bytes.length, 24)
    central.writeUInt16LE(n.length, 28)
    central.writeUInt32LE(offset, 42)
    locals.push(local, n, bytes)
    centrals.push(central, n)
    offset += local.length + n.length + bytes.length
  }
  const c = Buffer.concat(centrals),
    end = Buffer.alloc(22)
  end.writeUInt32LE(0x06054b50)
  end.writeUInt16LE(files.length, 8)
  end.writeUInt16LE(files.length, 10)
  end.writeUInt32LE(c.length, 12)
  end.writeUInt32LE(offset, 16)
  return Buffer.concat([...locals, c, end])
}
