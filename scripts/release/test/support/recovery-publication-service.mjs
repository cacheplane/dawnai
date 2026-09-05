import assert from "node:assert/strict"
import { createHash } from "node:crypto"

const digest = (value) => createHash("sha256").update(value).digest("hex")
// Test-only service driver. Callers must separately authorize a disposable repo.
// Immutable publication is retained as evidence; this driver never deletes it.
export async function runPublicationServiceProbe({
  repository,
  sourceSha,
  nonce,
  api,
  anonymousGet,
  download,
  persist = async () => {},
}) {
  assert.match(repository, /^[A-Za-z0-9-]+\/[A-Za-z0-9_.-]+$/u)
  assert.notEqual(repository.toLowerCase(), "cacheplane/dawnai")
  assert.match(sourceSha, /^[a-f0-9]{40}$/u)
  assert.match(nonce, /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/u)
  const base = `/repos/${repository}`,
    tag = `v0.0.0-recovery-contract-${nonce}`
  const owned = {
    repository,
    sourceSha,
    tag,
    tagObjectSha: null,
    releaseId: null,
    assetId: null,
    status: "preflight",
    unknownResponses: [],
  }
  const get = async (path) => {
    const r = await api("GET", path, null)
    assert.equal(r.status, 200, path)
    return r.body
  }
  const repo = await get(base)
  assert.ok(
    Number.isSafeInteger(repo.id) && repo.id > 0 && repo.id !== 1210070282,
    "disposable repository ID required",
  )
  assert.equal(repo.full_name.toLowerCase(), repository.toLowerCase(), "redirect forbidden")
  assert.equal(
    repo.private,
    false,
    "public disposable repo required for anonymous visibility probe",
  )
  assert.match(repo.default_branch, /^[A-Za-z0-9][A-Za-z0-9_-]{0,99}$/u)
  const policy = await get(`${base}/immutable-releases`)
  assert.equal(
    policy.enabled,
    true,
    "immutability must already be enabled; probe does not change policy",
  )
  const branchPath = `${base}/git/ref/heads/${repo.default_branch}`
  const branch = await get(branchPath)
  assert.equal(branch.object.type, "commit")
  const currentSha = branch.object.sha
  assert.match(currentSha, /^[a-f0-9]{40}$/u)
  assert.notEqual(currentSha, sourceSha, "publication must exercise a non-default source")
  const workflow = ".github/workflows/recovery-fence-probe.yml"
  const files = []
  for (const sha of [sourceSha, currentSha]) {
    const file = await get(`${base}/contents/${workflow}?ref=${sha}`)
    assert.equal(file.encoding, "base64")
    assert.equal(typeof file.content, "string")
    const bytes = Buffer.from(file.content, "base64")
    assert.ok(bytes.length > 0 && bytes.length < 65536)
    files.push(digest(bytes))
  }
  assert.notEqual(files[0], files[1], "distinct workflow file revisions required")
  const payload = Buffer.from(`Recovery service contract ${nonce}\nsource ${sourceSha}\n`)
  const payloadSha256 = digest(payload)
  await persist(owned)
  const object = await api("POST", `${base}/git/tags`, {
    tag,
    message: `Recovery contract ${nonce}`,
    object: sourceSha,
    type: "commit",
  })
  assert.equal(object.status, 201)
  assert.match(object.body.sha, /^[a-f0-9]{40}$/u)
  owned.tagObjectSha = object.body.sha
  await persist(owned)
  assert.equal(
    (await api("POST", `${base}/git/refs`, { ref: `refs/tags/${tag}`, sha: owned.tagObjectSha }))
      .status,
    201,
  )
  const verifyTag = async () => {
    const ref = await get(`${base}/git/ref/tags/${tag}`)
    assert.deepEqual(
      { type: ref.object.type, sha: ref.object.sha },
      { type: "tag", sha: owned.tagObjectSha },
    )
    const target = await get(`${base}/git/tags/${owned.tagObjectSha}`)
    assert.deepEqual(
      { type: target.object.type, sha: target.object.sha },
      { type: "commit", sha: sourceSha },
    )
  }
  await verifyTag()
  // An unknown create response deliberately stops: no direct ID means no owned
  // release mutation can follow and no blind retry can create a second draft.
  const created = await api("POST", `${base}/releases`, {
    tag_name: tag,
    target_commitish: sourceSha,
    name: `Recovery service contract ${nonce}`,
    body: `Disposable contract ${nonce}; payload sha256:${payloadSha256}`,
    draft: true,
    prerelease: true,
  })
  assert.equal(created.status, 201)
  assert.ok(Number.isSafeInteger(created.body.id) && created.body.id > 0)
  owned.releaseId = created.body.id
  owned.status = "draft"
  await persist(owned)
  const releasePath = `${base}/releases/${owned.releaseId}`
  const draft = await get(releasePath)
  assert.equal(draft.id, owned.releaseId)
  assert.equal(draft.draft, true)
  assert.equal(draft.name, `Recovery service contract ${nonce}`)
  assert.ok(
    draft.tag_name === tag || /^untagged-[A-Za-z0-9_-]+$/u.test(draft.tag_name),
    "observed draft tag must be recognized",
  )
  owned.observedDraftTag = draft.tag_name
  assert.equal(
    (await anonymousGet(releasePath)).status,
    404,
    "draft must be hidden from anonymous reader",
  )
  try {
    assert.equal(
      (await api("POST", `${releasePath}/assets?name=contract.txt`, payload)).status,
      201,
    )
  } catch (error) {
    if (error.uncertain !== true) throw error
    owned.unknownResponses.push("asset-upload")
    await persist(owned)
  }
  const assets = await get(`${releasePath}/assets?per_page=100&page=1`)
  assert.ok(Array.isArray(assets) && assets.length === 1, "exact owned asset inventory required")
  const asset = assets[0]
  assert.ok(Number.isSafeInteger(asset.id) && asset.id > 0)
  assert.equal(asset.name, "contract.txt")
  assert.equal(asset.size, payload.length)
  assert.equal(asset.digest, `sha256:${payloadSha256}`)
  owned.assetId = asset.id
  assert.equal(digest(await download(asset.id)), payloadSha256)
  await persist(owned)
  try {
    assert.equal(
      (
        await api("PATCH", releasePath, {
          tag_name: tag,
          target_commitish: sourceSha,
          draft: false,
          make_latest: "false",
        })
      ).status,
      200,
    )
  } catch (error) {
    if (error.uncertain !== true) throw error
    owned.unknownResponses.push("publication")
    await persist(owned)
  }
  const published = await get(releasePath)
  assert.equal(published.id, owned.releaseId)
  assert.equal(published.draft, false)
  assert.equal(published.immutable, true)
  assert.equal(published.tag_name, tag)
  const visible = await anonymousGet(releasePath)
  assert.equal(visible.status, 200)
  assert.equal(visible.body.id, owned.releaseId)
  assert.equal(digest(await download(owned.assetId)), payloadSha256)
  const finalAssets = await get(`${releasePath}/assets?per_page=100&page=1`)
  const identity = (values) =>
    values.map(({ id, name, size, digest }) => ({ id, name, size, digest }))
  assert.deepEqual(identity(finalAssets), identity(assets))
  await verifyTag()
  assert.equal(
    (await get(branchPath)).object.sha,
    currentSha,
    "default branch moved during contract",
  )
  owned.status = "published-immutable"
  await persist(owned)
  return {
    ...owned,
    repositoryId: repo.id,
    currentSha,
    workflowDigests: files,
    payloadSha256,
    retainedImmutableRelease: true,
  }
}
