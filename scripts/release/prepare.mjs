import { createHash } from "node:crypto"
import * as defaultFileSystem from "node:fs/promises"
import path from "node:path"

import { assertValidReleaseInventory } from "./inventory.mjs"
import {
  CANONICAL_RELEASE_PACKAGE_ORDER,
  canonicalManifestBytes,
  manifestSha256,
  RELEASE_MANIFEST_SCHEMA_VERSION,
  validateReleaseManifest,
} from "./manifest.mjs"
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
  run,
  inspectTarball,
  smokeTarballs,
  fileSystem = defaultFileSystem,
}) {
  const identity = validateCandidate(candidate)
  const ciReceipt = validateCi(ci, identity)
  const runReceipt = validatePrepareRun(prepareRun)
  validatePreparationAuthority(preparationAuthority)
  validateDependencies({ run, inspectTarball, smokeTarballs, fileSystem })
  const rootPath = validateAbsolutePath(root, "repository root")
  const outputPath = validateAbsolutePath(outputDir, "artifact output directory")
  const realRoot = await fileSystem.realpath(rootPath)
  if (realRoot !== rootPath) throw new Error("Repository root must not resolve through a symlink")
  const outputParent = path.dirname(outputPath)
  const realOutputParent = await fileSystem.realpath(outputParent)
  if (realOutputParent !== outputParent) {
    throw new Error("Artifact output parent must not resolve through a symlink")
  }
  await assertExactCheckout({ root: realRoot, candidate: identity, run })

  const validInventory = assertValidReleaseInventory(inventory)
  if (
    validInventory.packages.length !== CANONICAL_RELEASE_PACKAGE_ORDER.length ||
    validInventory.version !== identity.version ||
    !sameSortedSet(validInventory.packages, CANONICAL_RELEASE_PACKAGE_ORDER)
  ) {
    throw new Error("Preparation inventory must contain all and only 21 fixed-group-v1 packages")
  }
  const releasePackages = inventory.workspacePackages.filter(
    (packageJson) => packageJson.private !== true,
  )
  const orderedPackages = orderReleasePackages(releasePackages)
  const packageOrder = orderedPackages.map((packageJson) => packageJson.name)
  if (!arraysEqual(packageOrder, CANONICAL_RELEASE_PACKAGE_ORDER)) {
    throw new Error("Preparation inventory does not match the canonical dependency-first order")
  }

  await assertFreshOutput(outputPath, fileSystem)
  await run("pnpm", ["build"], { cwd: realRoot })
  await fileSystem.mkdir(outputPath, { recursive: false })
  const outputStat = await fileSystem.lstat(outputPath)
  if (!outputStat.isDirectory() || outputStat.isSymbolicLink()) {
    throw new Error("Artifact output directory resolved through a symlink")
  }

  const entries = []
  const expectedTarballs = []
  for (const packageJson of orderedPackages) {
    const filename = `${tarballStem(packageJson.name)}-${identity.version}.tgz`
    const tarballPath = path.join(outputPath, filename)
    await run("pnpm", ["--filter", packageJson.name, "pack", "--pack-destination", outputPath], {
      cwd: realRoot,
    })
    expectedTarballs.push(filename)
    await assertExactOutputFiles(outputPath, expectedTarballs, fileSystem)
    const stat = await fileSystem.lstat(tarballPath)
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size <= 0) {
      throw new Error(`Packed tarball ${filename} is not one positive regular file`)
    }
    const bytes = await fileSystem.readFile(tarballPath)
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
    const inspection = await inspectTarball({
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
  const smoke = await smokeTarballs({
    candidate: identity,
    outputDir: outputPath,
    manifest,
    tarballs: manifest.packages.map((entry) => path.join(outputPath, entry.filename)),
  })
  if (
    smoke?.cleanInstall !== "passed" ||
    smoke?.typeScript !== "passed" ||
    smoke?.scaffold !== "passed"
  ) {
    throw new Error("Local tarball clean-install, TypeScript, and scaffold smokes must all pass")
  }
  for (const entry of manifest.packages) {
    const bytes = await fileSystem.readFile(path.join(outputPath, entry.filename))
    const sha256 = createHash("sha256").update(bytes).digest("hex")
    const sha512 = createHash("sha512").update(bytes).digest("hex")
    if (bytes.length !== entry.size || sha256 !== entry.sha256 || sha512 !== entry.sha512) {
      throw new Error(`Tarball ${entry.filename} changed after inspection or smoke`)
    }
  }
  await assertExactOutputFiles(outputPath, expectedTarballs, fileSystem)
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
  return Object.freeze({ ...candidate })
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
  return ci
}

function validatePrepareRun(prepareRun) {
  assertObject(prepareRun, "prepare run")
  assertExactFields(prepareRun, RUN_FIELDS, "prepare run")
  if (!isPositiveInteger(prepareRun.id) || !isPositiveInteger(prepareRun.attempt)) {
    throw new TypeError("Prepare run ID and attempt must be positive integers")
  }
  return prepareRun
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
}

async function assertExactCheckout({ root, candidate, run }) {
  const [headSource, tagSource] = await Promise.all([
    run("git", ["rev-parse", "HEAD"], { cwd: root }),
    run("git", ["rev-list", "-n", "1", `v${candidate.version}`], { cwd: root }),
  ])
  const head = normalizeCommandSha(headSource, "HEAD")
  const tag = normalizeCommandSha(tagSource, "candidate tag")
  if (head !== candidate.commitSha) throw new Error("HEAD does not match candidate SHA")
  if (tag !== candidate.commitSha) throw new Error("Candidate tag does not match candidate SHA")
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
  if (typeof value !== "string") throw new TypeError(`${label} command output is invalid`)
  const normalized = value.trim()
  if (!SHA_PATTERN.test(normalized)) throw new TypeError(`${label} did not resolve to an exact SHA`)
  return normalized
}

function validateDependencies({ run, inspectTarball, smokeTarballs, fileSystem }) {
  for (const [name, value] of [
    ["run", run],
    ["inspectTarball", inspectTarball],
    ["smokeTarballs", smokeTarballs],
  ]) {
    if (typeof value !== "function") throw new TypeError(`${name} must be a function`)
  }
  for (const method of ["lstat", "mkdir", "realpath", "readFile", "readdir", "writeFile"]) {
    if (typeof fileSystem?.[method] !== "function") {
      throw new TypeError(`Filesystem adapter must expose ${method}`)
    }
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
