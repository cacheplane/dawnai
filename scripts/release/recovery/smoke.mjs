// Dormant recovery collector. Candidate identity never comes from executor environment.
import { createHash } from "node:crypto"
import { lstat, readdir } from "node:fs/promises"
import path from "node:path"
import { publicNpmEnvironment, readBoundedRegularFile } from "../../lib/published-artifacts.mjs"
import { executeReleaseMetadataVerify } from "../../published-artifact-verify.mjs"
import { CANONICAL_RELEASE_PACKAGE_ORDER } from "../manifest.mjs"
import { executePublishedHarnessSmoke } from "../smoke/published-harness.mjs"
import { executeRuntimeTargetsSmoke } from "../smoke/runtime-targets.mjs"
import { executeScaffoldSmoke } from "../smoke/scaffold.mjs"
import { executeStorageSmoke } from "../smoke/storage.mjs"
import { createStrictSmokeProcessRunner } from "../smoke-process-runner.mjs"
import { executeSmokeOperation, writeCanonicalFileNoClobber } from "../smoke-result.mjs"
import { REQUIRED_CHECKS } from "./policy.mjs"
import {
  canonicalRecoveryBytes,
  metadataCheckName,
  parseRecovery,
  RECOVERY_LIMITS,
  snapshotRecoveryData,
} from "./schema.mjs"

const operations = Object.freeze({
  "published-harness": executePublishedHarnessSmoke,
  "runtime-targets": executeRuntimeTargetsSmoke,
  scaffold: executeScaffoldSmoke,
  storage: executeStorageSmoke,
})
const hash = (bytes) => createHash("sha256").update(bytes).digest("hex")
const byName = (a, b) => (a < b ? -1 : a > b ? 1 : 0)
const requireThat = (ok, message) => {
  if (!ok) throw new Error(message)
}

export async function runRecoverySmoke(input, overrides = {}) {
  const options = snapshotRecoveryData(input, 16 * 1024)
  requireThat(
    Object.keys(options).every((key) =>
      ["lane", "candidate", "executor", "policySha256", "result", "manifest"].includes(key),
    ),
    "Unexpected recovery smoke option",
  )
  requireThat(
    typeof options.result === "string" &&
      path.isAbsolute(options.result) &&
      options.result.length <= 4096,
    "Recovery result requires a bounded absolute path",
  )
  const identity = {
    schemaVersion: 2,
    kind: "recovery-lane",
    candidate: options.candidate,
    executor: options.executor,
    policySha256: options.policySha256,
    lane: options.lane,
  }
  const environment = {
    profile: "recovery-linux-v2",
    node: process.versions.node,
    packageManager: null,
    platform: process.platform,
    architecture: process.arch,
    dockerImages: [],
  }
  const startupTime = new Date().toISOString()
  parseRecovery({
    ...identity,
    environment,
    startedAt: startupTime,
    finishedAt: startupTime,
    checks: [{ name: "cleanup", conclusion: "skipped" }],
    resolutions: [],
    installations: [],
    conclusion: "failure",
  })
  requireThat(
    overrides.runCommand === undefined &&
      overrides.probeContainment === undefined &&
      overrides.operation === undefined,
    "Recovery command execution requires a strictRunner and controller-owned operations",
  )
  const strictRunner = overrides.strictRunner ?? createStrictSmokeProcessRunner()
  const writeEvidence =
    overrides.writeEvidence ??
    ((file, bytes) => writeCanonicalFileNoClobber(file, bytes, {}, RECOVERY_LIMITS.selectionBytes))
  const writeResult =
    overrides.writeResult ??
    ((file, receipt) => writeCanonicalFileNoClobber(file, canonicalRecoveryBytes(receipt)))
  const installations = []
  const subjects = new Map()
  const laneOptions = {
    version: options.candidate.version,
    commitSha: options.candidate.candidateSha,
    manifestSha256: options.candidate.manifestSha256,
    ...(options.manifest === undefined ? {} : { manifest: options.manifest }),
  }
  const captureInstallation = async (check, root) => {
    await collectEnvironment()
    await strictRunner.runCommand("npm", ["ls", "--all", "--json"], {
      cwd: root,
      env: publicNpmEnvironment({ home: root }),
      timeoutMs: 60_000,
      maxOutputBytes: 16 * 1024 * 1024,
    })
    const resolutions = await readInstalledResolutions(root, options.candidate)
    const sidecar = parseRecovery({
      ...identity,
      kind: "recovery-installation",
      check,
      resolutions,
    })
    const bytes = canonicalRecoveryBytes(sidecar)
    const sha256 = hash(bytes)
    const assetName = `recovery-v2-installation-${options.lane}-${check}-${sha256}.json`
    await writeEvidence(path.join(path.dirname(options.result), assetName), bytes)
    installations.push({
      check,
      assetName,
      sha256,
      size: bytes.length,
      count: resolutions.length,
    })
    for (const item of resolutions.filter((item) => item.subject)) {
      const previous = subjects.get(item.name)
      requireThat(
        previous === undefined ||
          (previous.resolved === item.resolved && previous.integrity === item.integrity),
        "Subject identity changed between install snapshots",
      )
      if (!previous || item.installPath < previous.installPath) subjects.set(item.name, item)
    }
  }
  const captureDockerImage = async (reference, digest) => {
    requireThat(
      typeof reference === "string" && /^sha256:[a-f0-9]{64}$/u.test(digest),
      "Actual Docker image identity is invalid",
    )
    const previous = environment.dockerImages.find((item) => item.reference === reference)
    requireThat(
      previous === undefined || previous.digest === digest,
      "Docker image changed during probe",
    )
    if (!previous) environment.dockerImages.push({ reference, digest })
  }
  const collectEnvironment = async () => {
    const version = await strictRunner.runCommand("npm", ["--version"], {
      cwd: process.cwd(),
      env: publicNpmEnvironment({ home: process.cwd() }),
      timeoutMs: 60_000,
      maxOutputBytes: 4096,
    })
    requireThat(/^\d+\.\d+\.\d+$/u.test(version.stdout.trim()), "Actual npm version is invalid")
    const actual = `npm@${version.stdout.trim()}`
    requireThat(
      environment.packageManager === null || environment.packageManager === actual,
      "npm version changed during lane",
    )
    environment.packageManager = actual
  }
  const completed = await executeSmokeOperation(
    async (context) => {
      const check = async (name, detail, operation) => {
        const value = await context.check(name, detail, operation)
        if (name === "containment")
          await context.check("environment", "actual toolchain captured", collectEnvironment)
        return value
      }
      if (options.lane === "metadata") {
        const result = await executeReleaseMetadataVerify(laneOptions, {
          ...overrides,
          strictRunner,
        })
        for (const item of result.checks)
          await context
            .check(metadataCheckName(item.name), item.detail, async () => {
              if (item.conclusion !== "success") throw result.failures[0] ?? new Error(item.detail)
            })
            .catch(() => {})
        if (
          result.checks.some((item) => item.name === "containment" && item.conclusion === "success")
        ) {
          await context.check("environment", "actual toolchain captured", collectEnvironment)
        }
        for (const [name, conclusion] of [
          ["official-npm-audit", result.auditConclusion],
          ["official-npm-audit-cleanup", result.cleanupConclusion],
        ]) {
          if (!result.checks.some((item) => item.name === name))
            await context
              .check(name, name, async () => {
                requireThat(conclusion === "success", `${name} did not complete`)
              })
              .catch(() => {})
        }
        await context
          .check("registry-packages", "every exact package verified", async () => {
            requireThat(
              result.packageNames.length === CANONICAL_RELEASE_PACKAGE_ORDER.length &&
                result.failures.length === 0,
              "Exact registry package verification incomplete",
            )
          })
          .catch(() => {})
        if (result.failures.length)
          throw new AggregateError(result.failures, "Metadata verification failed")
      } else {
        await operations[options.lane](
          laneOptions,
          { ...context, check, captureInstallation, captureDockerImage },
          { ...overrides, strictRunner },
        )
      }
    },
    overrides.now === undefined ? {} : { now: overrides.now },
  )
  const checks = new Map(
    completed.checks.map(({ name, conclusion }) => [name, { name, conclusion }]),
  )
  if (!checks.has("cleanup"))
    checks.set("cleanup", {
      name: "cleanup",
      conclusion: completed.checks
        .filter((item) => item.name.includes("cleanup"))
        .every((item) => item.conclusion === "success")
        ? "success"
        : "failure",
    })
  for (const name of REQUIRED_CHECKS[options.lane])
    if (!checks.has(name)) checks.set(name, { name, conclusion: "skipped" })
  environment.dockerImages.sort((a, b) => byName(a.reference, b.reference))
  const receipt = parseRecovery({
    ...identity,
    environment,
    startedAt: completed.startedAt,
    finishedAt: completed.finishedAt,
    checks: [...checks.values()].sort((a, b) => byName(a.name, b.name)),
    resolutions: [...subjects.values()].sort((a, b) => byName(a.installPath, b.installPath)),
    installations: installations.sort((a, b) => byName(a.check, b.check)),
    conclusion: [...checks.values()].every((item) => item.conclusion === "success")
      ? "success"
      : "failure",
  })
  await writeResult(options.result, receipt)
  if (completed.errors.length === 1) throw completed.errors[0]
  if (completed.errors.length) throw new AggregateError(completed.errors, "Recovery smoke failed")
  requireThat(receipt.conclusion === "success", "Recovery mandatory checks incomplete")
  return receipt
}

export { metadataCheckName } from "./schema.mjs"

// The hidden lock describes physical paths. Independently enumerate every installed
// package and correlate both sets, identities and incoming selectors before cleanup.
export async function readInstalledResolutions(root, candidate) {
  let readBytes = 0
  const readJson = async (file) => {
    const maximum = file.endsWith("/.package-lock.json") ? 8 * 1024 * 1024 : 256 * 1024
    const bytes = await readBoundedRegularFile(file, maximum, "Installed dependency evidence")
    readBytes += bytes.length
    requireThat(readBytes <= 24 * 1024 * 1024, "Installed evidence aggregate input byte limit")
    return JSON.parse(bytes)
  }
  const lock = await readJson(path.join(root, "node_modules/.package-lock.json"))
  requireThat(
    lock.lockfileVersion === 3 && lock.packages && !Array.isArray(lock.packages),
    "Complete npm hidden lock v3 is required",
  )
  const manifests = new Map()
  let directoryEntries = 0
  const walk = async (relative, depth = 0, scope = false) => {
    requireThat(depth <= 64 && relative.length <= 2048, "Installed inventory path/depth limit")
    const directory = path.join(root, relative)
    requireThat((await lstat(directory)).isDirectory(), "Physical node_modules must be a directory")
    const entries = await readdir(directory, { withFileTypes: true })
    directoryEntries += entries.length
    requireThat(directoryEntries <= 8192, "Installed directory entry count limit")
    for (const entry of entries.sort((a, b) => byName(a.name, b.name))) {
      if (entry.name === ".bin" || entry.name === ".package-lock.json") continue
      requireThat(!entry.name.startsWith("."), "Unexpected hidden installed package")
      const installedPath = `${relative}/${entry.name}`
      requireThat(
        entry.isDirectory() && !entry.isSymbolicLink(),
        "Installed packages must be physical directories",
      )
      if (entry.name.startsWith("@")) {
        requireThat(
          !scope && /^@[a-z0-9][a-z0-9._-]*$/u.test(entry.name),
          "Malformed installed scope path",
        )
        await walk(installedPath, depth + 1, true)
        continue
      }
      requireThat(
        manifests.size < RECOVERY_LIMITS.installationResolutions,
        "Installed dependency count exceeds limit",
      )
      const manifest = await readJson(path.join(root, installedPath, "package.json"))
      manifests.set(installedPath, manifest)
      try {
        await lstat(path.join(root, installedPath, "node_modules"))
        await walk(`${installedPath}/node_modules`, depth + 1)
      } catch (error) {
        if (error.code !== "ENOENT") throw error
      }
    }
  }
  await walk("node_modules")
  const paths = [...manifests.keys()].sort(byName)
  requireThat(
    JSON.stringify(paths) === JSON.stringify(Object.keys(lock.packages).sort(byName)),
    "Physical inventory differs from lock paths",
  )
  const requests = new Map(paths.map((key) => [key, new Set()]))
  const owners = [["", await readJson(path.join(root, "package.json"))], ...manifests.entries()]
  for (const [owner, manifest] of owners) {
    const dependencies = [
      manifest.dependencies,
      manifest.optionalDependencies,
      manifest.peerDependencies,
      ...(owner === "" ? [manifest.devDependencies] : []),
    ].flatMap((group) => Object.entries(group ?? {}))
    for (const [name, selector] of dependencies) {
      let search = owner
      let found = false
      while (true) {
        const target = `${search ? `${search}/` : ""}node_modules/${name}`
        if (requests.has(target)) {
          requireThat(typeof selector === "string", "Dependency selector must be text")
          requests.get(target).add(selector)
          found = true
          break
        }
        if (!search) break
        const parent = search.lastIndexOf("/node_modules/")
        search = parent < 0 ? "" : search.slice(0, parent)
      }
      const optional =
        Object.hasOwn(manifest.optionalDependencies ?? {}, name) ||
        (Object.hasOwn(manifest.peerDependencies ?? {}, name) &&
          manifest.peerDependenciesMeta?.[name]?.optional === true &&
          !Object.hasOwn(manifest.dependencies ?? {}, name))
      requireThat(found || optional, `Installed required dependency is missing: ${name}`)
    }
  }
  const lockAgain = await readJson(path.join(root, "node_modules/.package-lock.json"))
  requireThat(
    JSON.stringify(lockAgain) === JSON.stringify(lock),
    "Installed lock changed during evidence capture",
  )
  return paths.map((installPath) => {
    const manifest = manifests.get(installPath)
    const entry = lock.packages[installPath]
    requireThat(
      entry &&
        !entry.link &&
        entry.version === manifest.version &&
        (entry.name === undefined || entry.name === manifest.name),
      "Installed identity differs from lock",
    )
    requireThat(
      typeof entry.resolved === "string" &&
        entry.resolved.startsWith("https://registry.npmjs.org/") &&
        !entry.resolved.includes("?"),
      "Installed package must resolve from public npm",
    )
    const selectors = [...requests.get(installPath)].sort(byName)
    requireThat(selectors.length > 0, "Installed package has no observed incoming request")
    const requested = selectors.length === 1 ? selectors[0] : selectors
    const subject = CANONICAL_RELEASE_PACKAGE_ORDER.includes(manifest.name)
    if (subject)
      requireThat(
        selectors.every((selector) => selector === candidate.version),
        "Subject request must use exact candidate version",
      )
    return {
      installPath,
      subject,
      name: manifest.name,
      requested: subject ? candidate.version : requested,
      resolved: manifest.version,
      source: "registry",
      integrity: entry.integrity,
    }
  })
}
