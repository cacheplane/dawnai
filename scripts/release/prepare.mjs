import { createHash } from "node:crypto"
import * as defaultFileSystem from "node:fs/promises"
import path from "node:path"
import { assertValidReleaseInventory } from "./inventory.mjs"
import { RELEASE_PAYLOAD_LIMITS } from "./limits.mjs"
import {
  CANONICAL_RELEASE_PACKAGE_ORDER,
  canonicalManifestBytes,
  manifestSha256,
  RELEASE_MANIFEST_SCHEMA_VERSION,
  validateReleaseManifest,
} from "./manifest.mjs"
import { createProductionPreparationChecks } from "./prepare-checks.mjs"
import { createReleasePreparationRunner } from "./process-runner.mjs"
import { isExactSemver, parseSemver } from "./semver.mjs"
import { orderReleasePackages } from "./topology.mjs"

const CANDIDATE_FIELDS = Object.freeze([
  "version",
  "commitSha",
  "ciWorkflow",
  "ciCheck",
  "publisherWorkflow",
])
const CI_FIELDS = Object.freeze([
  "status",
  "retryable",
  "commitSha",
  "workflow",
  "check",
  "runId",
  "runAttempt",
])
const RUN_FIELDS = Object.freeze(["id", "attempt"])
const AUTHORITY_FIELDS = Object.freeze(["state", "releaseRecord", "npm"])
const SHA_PATTERN = /^[0-9a-f]{40}$/u

export async function prepareReleaseArtifacts({
  candidate,
  inventory,
  root,
  outputDir,
  ci,
  prepareRun,
  preparationAuthority,
  sourceRef,
  run,
  inspectTarball,
  smokeTarballs,
  createProductionChecks = createProductionPreparationChecks,
  fileSystem = defaultFileSystem,
}) {
  const snapshots = snapshotPreparationInputs({
    candidate,
    ci,
    prepareRun,
    preparationAuthority,
    inventory,
  })
  const identity = validateCandidate(snapshots.candidate)
  // Provenance verification later requires this exact tag ref; preparation from main is invalid.
  validateSourceRef(sourceRef, identity)
  const ciReceipt = validateCi(snapshots.ci, identity)
  const runReceipt = validatePrepareRun(snapshots.prepareRun)
  validatePreparationAuthority(snapshots.preparationAuthority)
  const commandRunner = run ?? createReleasePreparationRunner()
  validateDependencies({ run: commandRunner, createProductionChecks, fileSystem })
  const rootPath = validateAbsolutePath(root, "repository root")
  const outputPath = validateAbsolutePath(outputDir, "artifact output directory")
  const validInventory = assertValidReleaseInventory(snapshots.inventory)
  if (
    validInventory.packages.length !== CANONICAL_RELEASE_PACKAGE_ORDER.length ||
    validInventory.version !== identity.version ||
    !sameSortedSet(validInventory.packages, CANONICAL_RELEASE_PACKAGE_ORDER)
  ) {
    throw new Error("Preparation inventory must contain all and only 21 fixed-group-v1 packages")
  }
  const releasePackages = snapshots.inventory.workspacePackages.filter(
    (packageJson) => packageJson.private !== true,
  )
  const orderedPackages = orderReleasePackages(releasePackages)
  const packageOrder = orderedPackages.map((packageJson) => packageJson.name)
  if (!arraysEqual(packageOrder, CANONICAL_RELEASE_PACKAGE_ORDER)) {
    throw new Error("Preparation inventory does not match the canonical dependency-first order")
  }

  const realRoot = await fileSystem.realpath(rootPath)
  if (realRoot !== rootPath) throw new Error("Repository root must not resolve through a symlink")
  const outputParent = path.dirname(outputPath)
  const realOutputParent = await fileSystem.realpath(outputParent)
  if (realOutputParent !== outputParent) {
    throw new Error("Artifact output parent must not resolve through a symlink")
  }
  if (isWithinPath(realRoot, outputPath)) {
    throw new Error("Artifact output directory must be outside the canonical repository root")
  }
  await assertExactCheckout({ root: realRoot, candidate: identity, run: commandRunner })

  const productionChecks =
    inspectTarball === undefined || smokeTarballs === undefined
      ? createProductionChecks({
          root: realRoot,
          outputDir: outputPath,
          candidate: identity,
          inventory: snapshots.inventory,
          run: commandRunner,
          fileSystem,
        })
      : null
  const inspect = inspectTarball ?? productionChecks?.inspectTarball
  const smoke = smokeTarballs ?? productionChecks?.smokeTarballs
  if (typeof inspect !== "function" || typeof smoke !== "function") {
    throw new TypeError("Production preparation checks must provide inspection and smoke functions")
  }

  await assertFreshOutput(outputPath, fileSystem)
  await commandRunner("pnpm", ["build"], { cwd: realRoot })
  await fileSystem.mkdir(outputPath, { recursive: false })
  const outputStat = await fileSystem.lstat(outputPath)
  if (!outputStat.isDirectory() || outputStat.isSymbolicLink()) {
    throw new Error("Artifact output directory resolved through a symlink")
  }

  const entries = []
  const expectedTarballs = []
  let totalTarballBytes = 0
  for (const packageJson of orderedPackages) {
    const filename = `${tarballStem(packageJson.name)}-${identity.version}.tgz`
    const tarballPath = path.join(outputPath, filename)
    await commandRunner(
      "pnpm",
      ["--filter", packageJson.name, "pack", "--pack-destination", outputPath],
      { cwd: realRoot },
    )
    expectedTarballs.push(filename)
    await assertExactOutputFiles(outputPath, expectedTarballs, fileSystem)
    const stat = await fileSystem.lstat(tarballPath)
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size <= 0) {
      throw new Error(`Packed tarball ${filename} is not one positive regular file`)
    }
    if (stat.size > RELEASE_PAYLOAD_LIMITS.tarballBytes) {
      throw new Error(`Packed tarball ${filename} exceeds its byte limit`)
    }
    totalTarballBytes += stat.size
    if (totalTarballBytes > RELEASE_PAYLOAD_LIMITS.preparedTarballsBytes) {
      throw new Error("Cumulative prepared tarball payload exceeds its byte limit")
    }
    const bytes = await readExactTarball(fileSystem, tarballPath, stat, filename)
    const sha256 = createHash("sha256").update(bytes).digest("hex")
    const sha512 = createHash("sha512").update(bytes).digest("hex")
    const access = packageJson.publishConfig?.access ?? "public"
    const entry = Object.freeze({
      name: packageJson.name,
      version: packageJson.version,
      filename,
      size: bytes.length,
      sha256,
      sha512,
      npmIntegrity: `sha512-${Buffer.from(sha512, "hex").toString("base64")}`,
      access,
    })
    const inspection = await inspect({
      packageJson,
      tarballPath,
      entry,
      bytes: Buffer.from(bytes),
    })
    if (inspection?.status !== "verified") {
      throw new Error(`Local pack inspection did not verify ${packageJson.name}`)
    }
    entries.push(entry)
  }

  const artifactName = `release-v${identity.version}-${identity.commitSha.slice(0, 12)}`
  const manifest = validateReleaseManifest(
    {
      schemaVersion: RELEASE_MANIFEST_SCHEMA_VERSION,
      version: identity.version,
      commitSha: identity.commitSha,
      ci: {
        workflow: ciReceipt.workflow,
        runId: ciReceipt.runId,
        runAttempt: ciReceipt.runAttempt,
      },
      artifact: {
        name: artifactName,
        prepareRunId: runReceipt.id,
        prepareRunAttempt: runReceipt.attempt,
      },
      packageOrder,
      packages: entries,
    },
    { packages: releasePackages },
  )
  const smokeResult = await smoke({
    candidate: identity,
    outputDir: outputPath,
    manifest,
    tarballs: manifest.packages.map((entry) => path.join(outputPath, entry.filename)),
  })
  if (
    smokeResult?.cleanInstall !== "passed" ||
    smokeResult?.typeScript !== "passed" ||
    smokeResult?.scaffold !== "passed"
  ) {
    throw new Error("Local tarball clean-install, TypeScript, and scaffold smokes must all pass")
  }
  for (const entry of manifest.packages) {
    const tarballPath = path.join(outputPath, entry.filename)
    const stat = await fileSystem.lstat(tarballPath)
    if (
      !stat.isFile() ||
      stat.isSymbolicLink() ||
      stat.size !== entry.size ||
      stat.size > RELEASE_PAYLOAD_LIMITS.tarballBytes
    ) {
      throw new Error(`Tarball ${entry.filename} changed after inspection or smoke`)
    }
    const bytes = await readExactTarball(fileSystem, tarballPath, stat, entry.filename)
    const sha256 = createHash("sha256").update(bytes).digest("hex")
    const sha512 = createHash("sha512").update(bytes).digest("hex")
    if (bytes.length !== entry.size || sha256 !== entry.sha256 || sha512 !== entry.sha512) {
      throw new Error(`Tarball ${entry.filename} changed after inspection or smoke`)
    }
  }
  await assertExactOutputFiles(outputPath, expectedTarballs, fileSystem)
  await assertExactCheckout({ root: realRoot, candidate: identity, run: commandRunner })
  const manifestBytes = canonicalManifestBytes(manifest)
  await fileSystem.writeFile(path.join(outputPath, "manifest.json"), manifestBytes, { flag: "wx" })
  return Object.freeze({
    artifactName,
    manifest,
    manifestSha256: manifestSha256(manifest),
  })
}

function validateCandidate(candidate) {
  assertObject(candidate, "candidate")
  assertExactFields(candidate, CANDIDATE_FIELDS, "candidate")
  if (!isReleaseVersion(candidate.version)) throw new TypeError("Candidate version is invalid")
  if (!SHA_PATTERN.test(candidate.commitSha)) throw new TypeError("Candidate SHA is invalid")
  if (
    candidate.ciWorkflow !== "CI" ||
    candidate.ciCheck !== "validate" ||
    candidate.publisherWorkflow !== ".github/workflows/release.yml"
  ) {
    throw new TypeError("Candidate release policy is invalid")
  }
  return Object.freeze({
    version: candidate.version,
    commitSha: candidate.commitSha,
    ciWorkflow: candidate.ciWorkflow,
    ciCheck: candidate.ciCheck,
    publisherWorkflow: candidate.publisherWorkflow,
  })
}

function validateCi(ci, candidate) {
  assertObject(ci, "CI receipt")
  assertExactFields(ci, CI_FIELDS, "CI receipt")
  if (
    ci.status !== "success" ||
    ci.retryable !== false ||
    ci.commitSha !== candidate.commitSha ||
    ci.workflow !== candidate.ciWorkflow ||
    ci.check !== candidate.ciCheck ||
    !isPositiveInteger(ci.runId) ||
    !isPositiveInteger(ci.runAttempt)
  ) {
    throw new Error("CI receipt must prove exact candidate success")
  }
  return Object.freeze({
    status: ci.status,
    retryable: ci.retryable,
    commitSha: ci.commitSha,
    workflow: ci.workflow,
    check: ci.check,
    runId: ci.runId,
    runAttempt: ci.runAttempt,
  })
}

function validatePrepareRun(prepareRun) {
  assertObject(prepareRun, "prepare run")
  assertExactFields(prepareRun, RUN_FIELDS, "prepare run")
  if (!isPositiveInteger(prepareRun.id) || !isPositiveInteger(prepareRun.attempt)) {
    throw new TypeError("Prepare run ID and attempt must be positive integers")
  }
  return Object.freeze({ id: prepareRun.id, attempt: prepareRun.attempt })
}

function validatePreparationAuthority(authority) {
  assertObject(authority, "preparation authority")
  assertExactFields(authority, AUTHORITY_FIELDS, "preparation authority")
  if (
    authority.state !== "CANDIDATE_TAGGED" ||
    authority.releaseRecord !== "absent" ||
    authority.npm !== "absent"
  ) {
    throw new Error(
      "Preparation authority requires candidate-tag-only state with no durable record or npm state",
    )
  }
  return Object.freeze({
    state: authority.state,
    releaseRecord: authority.releaseRecord,
    npm: authority.npm,
  })
}

async function assertExactCheckout({ root, candidate, run }) {
  const [headSource, tagSource, statusSource] = await Promise.all([
    run("git", ["rev-parse", "HEAD"], { cwd: root }),
    run("git", ["rev-list", "-n", "1", `v${candidate.version}`], { cwd: root }),
    run("git", ["status", "--porcelain=v1", "--untracked-files=all"], { cwd: root }),
  ])
  const head = normalizeCommandSha(headSource, "HEAD")
  const tag = normalizeCommandSha(tagSource, "candidate tag")
  const status = normalizeCommandStdout(statusSource, "checkout status")
  if (head !== candidate.commitSha) throw new Error("HEAD does not match candidate SHA")
  if (tag !== candidate.commitSha) throw new Error("Candidate tag does not match candidate SHA")
  if (status !== "") {
    throw new Error("Preparation requires a clean checkout with no dirty or untracked files")
  }
}

async function assertFreshOutput(outputDir, fileSystem) {
  try {
    await fileSystem.lstat(outputDir)
  } catch (error) {
    if (error?.code === "ENOENT") return
    throw error
  }
  throw new Error("Artifact output directory must be fresh and absent")
}

function normalizeCommandSha(value, label) {
  const normalized = normalizeCommandStdout(value, label).trim()
  if (!SHA_PATTERN.test(normalized)) throw new TypeError(`${label} did not resolve to an exact SHA`)
  return normalized
}

function normalizeCommandStdout(value, label) {
  if (typeof value === "string") return value
  if (value !== null && !Array.isArray(value) && typeof value === "object") {
    const descriptor = Object.getOwnPropertyDescriptor(value, "stdout")
    if (
      descriptor?.enumerable === true &&
      "value" in descriptor &&
      typeof descriptor.value === "string"
    ) {
      return descriptor.value
    }
  }
  throw new TypeError(`${label} command output is invalid`)
}

function validateDependencies({ run, createProductionChecks, fileSystem }) {
  for (const [name, value] of [
    ["run", run],
    ["createProductionChecks", createProductionChecks],
  ]) {
    if (typeof value !== "function") throw new TypeError(`${name} must be a function`)
  }
  for (const method of ["lstat", "mkdir", "realpath", "readFile", "readdir", "writeFile"]) {
    if (typeof fileSystem?.[method] !== "function") {
      throw new TypeError(`Filesystem adapter must expose ${method}`)
    }
  }
}

function validateSourceRef(sourceRef, candidate) {
  if (sourceRef !== `refs/tags/v${candidate.version}`) {
    throw new Error(`Preparation source ref must be refs/tags/v${candidate.version}`)
  }
}

async function assertExactOutputFiles(outputDir, expected, fileSystem) {
  const actual = (await fileSystem.readdir(outputDir)).sort()
  const canonicalExpected = [...expected].sort()
  if (!arraysEqual(actual, canonicalExpected)) {
    throw new Error("Artifact output file set contains a missing or extra tarball")
  }
}

function validateAbsolutePath(value, label) {
  if (typeof value !== "string" || !path.isAbsolute(value) || path.resolve(value) !== value) {
    throw new TypeError(`${label} must be an absolute normalized path`)
  }
  return value
}

function tarballStem(name) {
  return name.startsWith("@") ? name.slice(1).replaceAll("/", "-") : name
}

function assertObject(value, label) {
  if (value === null || Array.isArray(value) || typeof value !== "object") {
    throw new TypeError(`${label} must be an object`)
  }
}

function assertExactFields(value, fields, label) {
  for (const field of fields) {
    if (!Object.hasOwn(value, field)) throw new TypeError(`${label} is missing field ${field}`)
  }
  const unknown = Object.keys(value)
    .filter((field) => !fields.includes(field))
    .sort()
  if (unknown.length > 0) throw new TypeError(`${label} contains unknown field ${unknown[0]}`)
}

function isReleaseVersion(value) {
  return isExactSemver(value) && parseSemver(value).build.length === 0
}

function isPositiveInteger(value) {
  return Number.isSafeInteger(value) && value > 0
}

function sameSortedSet(left, right) {
  return arraysEqual([...left].sort(), [...right].sort())
}

function arraysEqual(left, right) {
  return left.length === right.length && left.every((value, index) => value === right[index])
}

function snapshotPreparationInputs({ candidate, ci, prepareRun, preparationAuthority, inventory }) {
  const snapshots = {
    candidate: snapshotPreparationData(candidate, "candidate"),
    ci: snapshotPreparationData(ci, "CI receipt"),
    prepareRun: snapshotPreparationData(prepareRun, "prepare run"),
    preparationAuthority: snapshotPreparationData(preparationAuthority, "preparation authority"),
    inventory: snapshotPreparationData(inventory, "release inventory"),
  }
  assertObject(snapshots.inventory, "release inventory")
  assertExactFields(snapshots.inventory, ["fixedGroups", "workspacePackages"], "release inventory")
  return deepFreeze(snapshots)
}

function snapshotPreparationData(value, label, ancestors = new Set()) {
  if (
    value === null ||
    typeof value === "string" ||
    typeof value === "boolean" ||
    (typeof value === "number" && Number.isFinite(value))
  ) {
    return value
  }
  if (typeof value !== "object") throw new TypeError(`${label} snapshot contains non-JSON data`)
  if (ancestors.has(value)) throw new TypeError(`${label} snapshot contains a cycle`)
  const prototype = Object.getPrototypeOf(value)
  if (!Array.isArray(value) && prototype !== Object.prototype && prototype !== null) {
    throw new TypeError(`${label} snapshot contains an unsafe prototype`)
  }
  const next = new Set(ancestors).add(value)
  if (Array.isArray(value)) {
    const keys = Reflect.ownKeys(value)
    const expected = new Set([
      "length",
      ...Array.from({ length: value.length }, (_, i) => String(i)),
    ])
    if (keys.some((key) => typeof key !== "string" || !expected.has(key))) {
      throw new TypeError(`${label} snapshot contains an unknown or symbol array field`)
    }
    return Array.from({ length: value.length }, (_unused, index) => {
      const descriptor = Object.getOwnPropertyDescriptor(value, String(index))
      if (descriptor === undefined || !descriptor.enumerable || !("value" in descriptor)) {
        throw new TypeError(`${label} snapshot contains an accessor or sparse array`)
      }
      return snapshotPreparationData(descriptor.value, label, next)
    })
  }
  const snapshot = Object.create(null)
  for (const key of Reflect.ownKeys(value)) {
    if (typeof key !== "string" || ["__proto__", "constructor", "prototype"].includes(key)) {
      throw new TypeError(`${label} snapshot contains an unsafe or symbol field`)
    }
    const descriptor = Object.getOwnPropertyDescriptor(value, key)
    if (descriptor === undefined || !descriptor.enumerable || !("value" in descriptor)) {
      throw new TypeError(`${label} snapshot contains an accessor or non-enumerable field`)
    }
    snapshot[key] = snapshotPreparationData(descriptor.value, label, next)
  }
  return snapshot
}

function deepFreeze(value) {
  if (value !== null && typeof value === "object" && !Object.isFrozen(value)) {
    for (const child of Object.values(value)) deepFreeze(child)
    Object.freeze(value)
  }
  return value
}

function isWithinPath(root, target) {
  const relative = path.relative(root, target)
  return relative === "" || (relative !== ".." && !relative.startsWith(`..${path.sep}`))
}

async function readExactTarball(fileSystem, target, stat, filename) {
  const bytes = await fileSystem.readFile(target)
  if (!(bytes instanceof Uint8Array) || bytes.byteLength !== stat.size) {
    throw new Error(`Packed tarball ${filename} changed while being read`)
  }
  return bytes
}
