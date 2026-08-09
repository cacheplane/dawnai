import { compareSemver, isExactSemver, parseSemver } from "./semver.mjs"

const SHA_PATTERN = /^[0-9a-f]{40}$/u
const SHA256_PATTERN = /^[0-9a-f]{64}$/u
const PACKAGE_PATTERN = /^(?:@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*$/u
const ALLOWED_ENVELOPE_STATUSES = new Set(["PRESENT", "ABSENT", "AMBIGUOUS", "ERROR"])
const DEFAULT_CANDIDATE_POLICY = Object.freeze({
  ciWorkflow: "CI",
  ciCheck: "validate",
  publisherWorkflow: ".github/workflows/release.yml",
})

export async function discoverShadowCandidate({ ref, git, inventory }) {
  assertRef(ref)
  assertMethods(git, ["listFirstParentHistory", "firstParent"], "Git reader")
  assertMethods(inventory, ["read"], "inventory reader")

  const history = await git.listFirstParentHistory({ ref, maxCount: 1 })
  if (!Array.isArray(history) || history.length !== 1 || !SHA_PATTERN.test(history[0])) {
    throw new TypeError("Git history did not resolve the requested ref to one exact commit")
  }
  const commitSha = history[0]
  const parentSha = await git.firstParent(commitSha)
  if (typeof parentSha !== "string" || !SHA_PATTERN.test(parentSha)) {
    throw new TypeError("Git first parent is not an exact commit")
  }
  const current = normalizeDiscoveryInventory(await inventory.read({ ref: commitSha }), "current")
  const parent = normalizeDiscoveryInventory(await inventory.read({ ref: parentSha }), "parent")
  const currentNames = current.packages.map((pkg) => pkg.name)
  const parentNames = parent.packages.map((pkg) => pkg.name)
  if (!arraysEqual(currentNames, parentNames)) {
    throw new TypeError("Release inventory package set changed across the candidate commit")
  }
  if (current.version === parent.version) return null
  if (compareSemver(current.version, parent.version) <= 0) {
    throw new TypeError("Release inventory version delta must increase uniformly")
  }
  return deepFreeze({
    version: current.version,
    commitSha,
    ...DEFAULT_CANDIDATE_POLICY,
  })
}

export async function observeCandidate({ candidate, inventory, git, npm, github }) {
  const normalizedCandidate = normalizeCandidate(candidate)
  const normalizedInventory = normalizeManagedInventory(inventory, normalizedCandidate)
  assertMethods(git, ["resolveTag"], "Git reader")
  assertMethods(npm, ["observePackageVersion"], "npm reader")
  assertMethods(
    github,
    ["getCommitCheckRuns", "listWorkflowRuns", "getRef", "getReleaseByTag", "listActionsArtifacts"],
    "GitHub reader",
  )

  const tagName = `v${normalizedCandidate.version}`
  const diagnostics = []
  const ciResult = normalizeEnvelope(
    await github.getCommitCheckRuns({ commitSha: normalizedCandidate.commitSha }),
    "github",
    diagnostics,
  )
  const ciWorkflowResult = normalizeEnvelope(
    await github.listWorkflowRuns({
      workflow: "ci.yml",
      commitSha: normalizedCandidate.commitSha,
    }),
    "github",
    diagnostics,
  )
  const refResult = normalizeEnvelope(
    await github.getRef({ ref: `tags/${tagName}` }),
    "github",
    diagnostics,
  )
  let localTagSha = null
  let localTagAmbiguous = false
  try {
    localTagSha = await git.resolveTag({ tag: tagName })
    if (typeof localTagSha !== "string" || !SHA_PATTERN.test(localTagSha)) {
      throw new TypeError("malformed tag identity")
    }
  } catch (error) {
    localTagAmbiguous = true
    diagnostics.push({
      source: "git",
      operation: "resolve-tag",
      status: "AMBIGUOUS",
      httpStatus: null,
      code: safeCode(error?.code, "GIT_READ_FAILED"),
    })
  }
  const releaseResult = normalizeEnvelope(
    await github.getReleaseByTag({ tag: tagName }),
    "github",
    diagnostics,
  )
  const artifactResult = normalizeEnvelope(
    await github.listActionsArtifacts({
      name: managedArtifactName(normalizedCandidate),
    }),
    "github",
    diagnostics,
  )

  const registryPackages = []
  for (const pkg of normalizedInventory.packages) {
    const result = normalizeEnvelope(
      await npm.observePackageVersion({ name: pkg.name, version: normalizedCandidate.version }),
      "npm",
      diagnostics,
    )
    registryPackages.push(mapRegistryPackage(result, pkg, normalizedCandidate, diagnostics))
  }

  const ci = mapCi(ciResult, ciWorkflowResult, normalizedCandidate, diagnostics)
  const tag = mapTag(refResult, localTagSha, localTagAmbiguous, diagnostics)
  const artifacts = mapArtifacts(artifactResult, normalizedInventory, diagnostics)
  const escrow =
    artifacts.status === "ambiguous"
      ? { status: "ambiguous", manifestSha256: null, assets: [] }
      : { status: "absent", manifestSha256: null, assets: [] }
  const release = await mapRelease(
    releaseResult,
    normalizedInventory,
    normalizedCandidate,
    github,
    diagnostics,
  )
  const published = registryPackages.some((pkg) => pkg.status === "present")
  const observation = {
    inventory: {
      status: normalizedInventory.status,
      packages: normalizedInventory.packages,
    },
    ci,
    otherCandidates: [],
    tag,
    artifacts,
    escrow,
    registry: {
      publishJobStarted: published,
      mutationStarted: published,
      packages: registryPackages,
    },
    release,
    requiredSmokeLanes: normalizedInventory.requiredSmokeLanes,
    smokes: [],
    audit: {
      status: "none",
      version: null,
      commitSha: null,
      manifestSha256: null,
      workflowRunId: null,
      runAttempt: null,
      conclusion: null,
    },
    abandonment: { requested: false, recorded: false },
  }
  diagnostics.sort(compareDiagnostics)
  return deepFreeze({ observation, diagnostics })
}

function normalizeDiscoveryInventory(value, label) {
  if (!isRecord(value) || value.status !== "valid" || !Array.isArray(value.packages)) {
    throw new TypeError(`${label} release inventory must be valid`)
  }
  if (value.packages.length === 0) throw new TypeError(`${label} release inventory is empty`)
  const packages = value.packages.map((pkg) => {
    if (!isRecord(pkg) || !isPackageName(pkg.name) || !isReleaseVersion(pkg.version)) {
      throw new TypeError(`${label} release inventory package is invalid`)
    }
    return { name: pkg.name, version: pkg.version }
  })
  packages.sort((left, right) => compareText(left.name, right.name))
  if (new Set(packages.map((pkg) => pkg.name)).size !== packages.length) {
    throw new TypeError(`${label} release inventory package set contains duplicates`)
  }
  const versions = new Set(packages.map((pkg) => pkg.version))
  if (versions.size !== 1) throw new TypeError(`${label} release inventory version is not uniform`)
  return { packages, version: packages[0].version }
}

function normalizeManagedInventory(value, candidate) {
  if (
    !isRecord(value) ||
    !["valid", "invalid"].includes(value.status) ||
    !Array.isArray(value.packages) ||
    value.packages.length === 0 ||
    typeof value.manifestSha256 !== "string" ||
    !SHA256_PATTERN.test(value.manifestSha256) ||
    !Array.isArray(value.requiredSmokeLanes)
  ) {
    throw new TypeError("Managed inventory is incomplete")
  }
  if (!value.requiredSmokeLanes.every((lane) => typeof lane === "string" && lane.length > 0)) {
    throw new TypeError("Managed smoke lane inventory is invalid")
  }
  const packages = value.packages.map((pkg) => {
    if (
      !isRecord(pkg) ||
      !isPackageName(pkg.name) ||
      pkg.version !== candidate.version ||
      typeof pkg.filename !== "string" ||
      typeof pkg.tarballSha256 !== "string" ||
      !SHA256_PATTERN.test(pkg.tarballSha256) ||
      typeof pkg.attestationFilename !== "string" ||
      typeof pkg.attestationSha256 !== "string" ||
      !SHA256_PATTERN.test(pkg.attestationSha256) ||
      typeof pkg.integrity !== "string" ||
      !pkg.integrity.startsWith("sha512-")
    ) {
      throw new TypeError("Managed inventory package is invalid")
    }
    return {
      name: pkg.name,
      version: pkg.version,
      filename: pkg.filename,
      tarballSha256: pkg.tarballSha256,
      attestationFilename: pkg.attestationFilename,
      attestationSha256: pkg.attestationSha256,
      integrity: pkg.integrity,
    }
  })
  if (
    !arraysEqual(
      packages.map((pkg) => pkg.name),
      [...packages].map((pkg) => pkg.name).sort(),
    )
  ) {
    throw new TypeError("Managed inventory packages must use exact deterministic order")
  }
  return {
    status: value.status,
    manifestSha256: value.manifestSha256,
    requiredSmokeLanes: [...value.requiredSmokeLanes].sort(compareText),
    packages,
    releaseRecordSha256: validOptionalSha256(value.releaseRecordSha256),
    manifestAttestationSha256: validOptionalSha256(value.manifestAttestationSha256),
  }
}

function mapCi(checkResult, workflowResult, candidate, diagnostics) {
  const observed = observedCiIdentity(checkResult, workflowResult)
  if (checkResult.status !== "PRESENT" || workflowResult.status !== "PRESENT") {
    return ciIdentity("ambiguous", observed)
  }
  if (!Array.isArray(checkResult.value) || !Array.isArray(workflowResult.value)) {
    addDiagnostic(diagnostics, "github", "commit-check-runs", "ERROR", "MALFORMED_VALUE")
    return ciIdentity("ambiguous", observed)
  }
  const workflows = workflowResult.value.filter(
    (run) =>
      run?.name === candidate.ciWorkflow &&
      run?.path === ".github/workflows/ci.yml" &&
      run?.head_sha === candidate.commitSha,
  )
  const checks = checkResult.value.filter(
    (check) => check?.name === candidate.ciCheck && check?.head_sha === candidate.commitSha,
  )
  if (workflows.length !== 1 || checks.length !== 1) {
    addDiagnostic(diagnostics, "github", "ci-correlation", "AMBIGUOUS", "CI_IDENTITY_AMBIGUOUS")
    return ciIdentity("ambiguous", observed)
  }
  const [workflow] = workflows
  const [check] = checks
  const workflowSuiteId = workflow.check_suite_id
  const checkSuiteId = check.check_suite?.id
  if (
    (workflowSuiteId !== undefined || checkSuiteId !== undefined) &&
    (!isPositiveId(workflowSuiteId) ||
      !isPositiveId(checkSuiteId) ||
      String(workflowSuiteId) !== String(checkSuiteId))
  ) {
    addDiagnostic(diagnostics, "github", "ci-correlation", "AMBIGUOUS", "CI_RUN_MISMATCH")
    return ciIdentity("ambiguous", observed)
  }
  if (workflow.status !== "completed" || check.status !== "completed") {
    return ciIdentity("ambiguous", observed)
  }
  return ciIdentity(
    workflow.conclusion === "success" && check.conclusion === "success" ? "success" : "failed",
    observed,
  )
}

function observedCiIdentity(checkResult, workflowResult) {
  const workflows = Array.isArray(workflowResult.value) ? workflowResult.value : []
  const checks = Array.isArray(checkResult.value) ? checkResult.value : []
  const workflow = workflows.length === 1 ? workflows[0] : null
  const check = checks.length === 1 ? checks[0] : null
  const workflowSha = SHA_PATTERN.test(workflow?.head_sha) ? workflow.head_sha : null
  const checkSha = SHA_PATTERN.test(check?.head_sha) ? check.head_sha : null
  return {
    workflow: typeof workflow?.name === "string" ? workflow.name : null,
    check: typeof check?.name === "string" ? check.name : null,
    commitSha:
      workflowSha !== null && checkSha !== null
        ? workflowSha === checkSha
          ? workflowSha
          : null
        : (workflowSha ?? checkSha),
  }
}

function ciIdentity(status, identity) {
  return {
    status,
    workflow: identity.workflow,
    check: identity.check,
    commitSha: identity.commitSha,
  }
}

function mapTag(result, localSha, localAmbiguous, diagnostics) {
  if (result.status !== "PRESENT" || localAmbiguous) {
    return {
      status: result.status === "ABSENT" && !localAmbiguous ? "absent" : "ambiguous",
      commitSha: null,
    }
  }
  const remoteSha = peelGitHubRefSha(result.value)
  if (remoteSha === null || remoteSha !== localSha) {
    addDiagnostic(diagnostics, "github", "ref", "AMBIGUOUS", "TAG_IDENTITY_CONFLICT")
    return { status: "ambiguous", commitSha: null }
  }
  return { status: "present", commitSha: remoteSha }
}

function mapArtifacts(result, inventory, diagnostics) {
  const base = {
    status: "absent",
    manifestVersion: null,
    manifestCommitSha: null,
    manifestSha256: null,
    files: inventory.packages.map((pkg) => ({
      name: pkg.name,
      status: "pending",
      assetName: pkg.filename,
      sha256: null,
      integrity: null,
    })),
    manifestAsset: { name: "manifest.json", sha256: null },
    releaseRecordAsset: { name: "release-record.json", sha256: null },
    manifestAttestationAsset: { name: "manifest.json.intoto.jsonl", sha256: null },
    attestations: [
      ...inventory.packages.map((pkg) => ({
        name: pkg.attestationFilename,
        status: "pending",
        sha256: null,
        subjectName: pkg.filename,
        subjectSha256: pkg.tarballSha256,
      })),
      {
        name: "manifest.json.intoto.jsonl",
        status: "pending",
        sha256: null,
        subjectName: "manifest.json",
        subjectSha256: inventory.manifestSha256,
      },
    ],
  }
  if (result.status !== "PRESENT") return { ...base, status: "ambiguous" }
  if (!Array.isArray(result.value)) {
    addDiagnostic(diagnostics, "github", "actions-artifacts", "ERROR", "MALFORMED_VALUE")
    return { ...base, status: "ambiguous" }
  }
  if (result.value.length > 0) {
    // A listed archive is not proof of its contents. Download/manifest parsing is a later
    // managed observation step; this boundary fails closed instead of inventing preparation.
    addDiagnostic(
      diagnostics,
      "github",
      "actions-artifacts",
      "AMBIGUOUS",
      "ARTIFACT_CONTENT_UNREAD",
    )
    return { ...base, status: "ambiguous" }
  }
  return base
}

function mapRegistryPackage(result, expected, candidate, diagnostics) {
  if (result.status === "ABSENT") return absentRegistryPackage(expected.name)
  if (result.status !== "PRESENT") return ambiguousRegistryPackage(expected.name)
  const pkg = result.package
  if (!isRecord(pkg) || pkg.name !== expected.name || pkg.version !== candidate.version) {
    addDiagnostic(diagnostics, "npm", "package-version", "ERROR", "PACKAGE_IDENTITY_MISMATCH")
    return ambiguousRegistryPackage(expected.name)
  }
  diagnostics.push({
    source: "npm",
    operation: "signatures",
    status: "AMBIGUOUS",
    httpStatus: null,
    code: "NPM_SIGNATURE_UNVERIFIED",
    evidenceCount: Array.isArray(pkg.signatures) ? pkg.signatures.length : null,
  })
  if (!isRecord(pkg.provenance) || pkg.provenance.status !== "PRESENT") {
    addDiagnostic(diagnostics, "npm", "provenance", "AMBIGUOUS", "PROVENANCE_UNAVAILABLE")
    return ambiguousRegistryPackage(expected.name)
  }
  if (pkg.integrity !== expected.integrity) {
    // npm does not expose SHA-256. Only an exact SHA-512 match to the managed manifest
    // correlates the public tarball to its known SHA-256 without downloading it.
    addDiagnostic(diagnostics, "npm", "package-version", "AMBIGUOUS", "NPM_BYTES_MISMATCH")
    return ambiguousRegistryPackage(expected.name)
  }
  return ambiguousRegistryPackage(expected.name)
}

async function mapRelease(result, inventory, candidate, github, diagnostics) {
  if (result.status !== "PRESENT") {
    return {
      status: result.status === "ABSENT" ? "absent" : "ambiguous",
      tag: null,
      commitSha: null,
      metadataReconciled: false,
      assets: [],
    }
  }
  const release = result.value
  if (!isRecord(release) || !isPositiveId(release.id)) {
    addDiagnostic(diagnostics, "github", "release", "ERROR", "MALFORMED_VALUE")
    return ambiguousRelease()
  }
  if (typeof github.listReleaseAssets !== "function") {
    addDiagnostic(diagnostics, "github", "release-assets", "ERROR", "METHOD_UNAVAILABLE")
    return ambiguousRelease()
  }
  const assetsResult = normalizeEnvelope(
    await github.listReleaseAssets({ releaseId: release.id }),
    "github",
    diagnostics,
  )
  if (assetsResult.status !== "PRESENT" || !Array.isArray(assetsResult.value)) {
    return ambiguousRelease()
  }
  const expectedAssets = expectedReleaseAssets(inventory)
  if (expectedAssets === null) {
    addDiagnostic(
      diagnostics,
      "github",
      "release-assets",
      "AMBIGUOUS",
      "EXPECTED_DIGESTS_UNAVAILABLE",
    )
    return ambiguousRelease()
  }
  const expectedByName = new Map(expectedAssets.map((asset) => [asset.name, asset]))
  const rawAssets = [...assetsResult.value].sort(compareRemoteAssets)
  const idCounts = new Map()
  for (const asset of rawAssets) {
    const id = String(asset?.id)
    idCounts.set(id, (idCounts.get(id) ?? 0) + 1)
  }
  const duplicateIds = new Set([...idCounts].filter(([, count]) => count > 1).map(([id]) => id))
  for (const assetId of duplicateIds) {
    diagnostics.push({
      source: "github",
      operation: "release-assets",
      status: "AMBIGUOUS",
      httpStatus: null,
      code: "REMOTE_ASSET_ID_DUPLICATE",
      assetId,
    })
  }
  const assets = rawAssets.map((actual) => {
    const expected = expectedByName.get(actual?.name)
    const digest = normalizeAssetDigest(actual?.digest)
    return {
      name: actual?.name,
      status:
        duplicateIds.has(String(actual?.id)) || digest === null
          ? "ambiguous"
          : expected !== undefined && digest === expected.sha256
            ? "matching"
            : "different",
      sha256: digest,
    }
  })
  const tag = release.tag_name
  const commitSha = release.target_commitish
  if (tag !== `v${candidate.version}` || commitSha !== candidate.commitSha) {
    addDiagnostic(diagnostics, "github", "release", "AMBIGUOUS", "RELEASE_IDENTITY_MISMATCH")
    return ambiguousRelease()
  }
  return {
    status: release.draft === true ? "draft" : "published",
    tag,
    commitSha,
    metadataReconciled: false,
    assets,
  }
}

function expectedReleaseAssets(inventory) {
  if (inventory.releaseRecordSha256 === null || inventory.manifestAttestationSha256 === null) {
    return null
  }
  return [
    { name: "release-record.json", sha256: inventory.releaseRecordSha256 },
    { name: "manifest.json", sha256: inventory.manifestSha256 },
    { name: "manifest.json.intoto.jsonl", sha256: inventory.manifestAttestationSha256 },
    ...inventory.packages.map((pkg) => ({ name: pkg.filename, sha256: pkg.tarballSha256 })),
    ...inventory.packages.map((pkg) => ({
      name: pkg.attestationFilename,
      sha256: pkg.attestationSha256,
    })),
  ]
}

function normalizeEnvelope(value, source, diagnostics) {
  if (
    !isRecord(value) ||
    !ALLOWED_ENVELOPE_STATUSES.has(value.status) ||
    typeof value.operation !== "string" ||
    (value.httpStatus !== null && !Number.isInteger(value.httpStatus)) ||
    (value.code !== null && typeof value.code !== "string")
  ) {
    const result = {
      status: "ERROR",
      operation: "malformed-envelope",
      httpStatus: null,
      code: "MALFORMED_ENVELOPE",
    }
    diagnostics.push({ source, ...result })
    return result
  }
  const result = structuredClone(value)
  if (result.status !== "PRESENT" && result.status !== "ABSENT") {
    diagnostics.push({
      source,
      operation: result.operation,
      status: result.status,
      httpStatus: result.httpStatus,
      code: safeCode(result.code, "REMOTE_FAILURE"),
    })
  }
  return result
}

function absentRegistryPackage(name) {
  return {
    name,
    status: "e404",
    version: null,
    tarballSha256: null,
    integrity: null,
    latest: { status: "e404", version: null },
    signature: { status: "missing" },
    provenance: null,
  }
}

function ambiguousRegistryPackage(name) {
  return {
    name,
    status: "ambiguous",
    version: null,
    tarballSha256: null,
    integrity: null,
    latest: { status: "ambiguous", version: null },
    signature: { status: "ambiguous" },
    provenance: null,
  }
}

function ambiguousRelease() {
  return { status: "ambiguous", tag: null, commitSha: null, metadataReconciled: false, assets: [] }
}

function normalizeCandidate(value) {
  if (
    !isRecord(value) ||
    !isReleaseVersion(value.version) ||
    typeof value.commitSha !== "string" ||
    !SHA_PATTERN.test(value.commitSha) ||
    ![value.ciWorkflow, value.ciCheck, value.publisherWorkflow].every(
      (item) => typeof item === "string" && item.length > 0,
    )
  ) {
    throw new TypeError("Release candidate is invalid")
  }
  const keys = ["version", "commitSha", "ciWorkflow", "ciCheck", "publisherWorkflow"]
  if (
    Object.keys(value).some((key) => !keys.includes(key)) ||
    keys.some((key) => !Object.hasOwn(value, key))
  ) {
    throw new TypeError("Release candidate fields are invalid")
  }
  return structuredClone(value)
}

function peelGitHubRefSha(value) {
  let object = value?.object
  for (let depth = 0; depth < 2; depth += 1) {
    if (typeof object?.sha === "string" && SHA_PATTERN.test(object.sha)) return object.sha
    object = object?.object
  }
  return null
}

function managedArtifactName(candidate) {
  return `release-candidate-${candidate.version}-${candidate.commitSha}`
}

function normalizeAssetDigest(value) {
  return typeof value === "string" && /^sha256:[0-9a-f]{64}$/u.test(value) ? value.slice(7) : null
}

function compareRemoteAssets(left, right) {
  return compareText(
    `${String(left?.name)}\0${String(left?.id)}\0${String(left?.digest)}`,
    `${String(right?.name)}\0${String(right?.id)}\0${String(right?.digest)}`,
  )
}

function validOptionalSha256(value) {
  if (value === undefined) return null
  if (typeof value !== "string" || !SHA256_PATTERN.test(value)) {
    throw new TypeError("Managed optional asset digest is invalid")
  }
  return value
}

function addDiagnostic(diagnostics, source, operation, status, code) {
  diagnostics.push({ source, operation, status, httpStatus: null, code })
}

function compareDiagnostics(left, right) {
  return compareText(
    `${left.source}\0${left.operation}\0${left.code}`,
    `${right.source}\0${right.operation}\0${right.code}`,
  )
}

function assertMethods(value, methods, label) {
  if (!isRecord(value) || methods.some((method) => typeof value[method] !== "function")) {
    throw new TypeError(`${label} does not expose the required named methods`)
  }
}

function assertRef(value) {
  if (
    typeof value !== "string" ||
    !/^[A-Za-z0-9][A-Za-z0-9._+/-]*$/u.test(value) ||
    value.includes("..") ||
    value.includes("//")
  ) {
    throw new TypeError("Invalid discovery ref")
  }
}

function safeCode(value, fallback) {
  return typeof value === "string" && /^[A-Z][A-Z0-9_-]{0,63}$/u.test(value) ? value : fallback
}

function isReleaseVersion(value) {
  return isExactSemver(value) && parseSemver(value).build.length === 0
}

function isPackageName(value) {
  return typeof value === "string" && PACKAGE_PATTERN.test(value)
}

function isPositiveId(value) {
  return (
    (Number.isSafeInteger(value) && value > 0) ||
    (typeof value === "string" && /^[1-9][0-9]*$/u.test(value))
  )
}

function arraysEqual(left, right) {
  return left.length === right.length && left.every((value, index) => value === right[index])
}

function deepFreeze(value) {
  if (value !== null && typeof value === "object" && !Object.isFrozen(value)) {
    for (const child of Object.values(value)) deepFreeze(child)
    Object.freeze(value)
  }
  return value
}

function isRecord(value) {
  return value !== null && !Array.isArray(value) && typeof value === "object"
}

function compareText(left, right) {
  return left === right ? 0 : left < right ? -1 : 1
}
