#!/usr/bin/env node

import { lstat, readFile } from "node:fs/promises"
import { basename, isAbsolute, resolve } from "node:path"
import { fileURLToPath } from "node:url"

const MODES = new Set(["--cleanup", "--assert-receipt", "--prepare-artifacts"])
let sharedHelpers

async function loadSharedHelpers() {
  if (!sharedHelpers) {
    sharedHelpers = (async () => {
      const { register } = await import("tsx/esm/api")
      register()
      return await import("./vercel-native-fixture.ts")
    })()
  }
  return await sharedHelpers
}

export function createNativeVercelCleanupDependencies(overrides = {}) {
  return { loadSharedHelpers, lstat, readFile, ...overrides }
}

async function artifactDirectory(env, dependencies) {
  const artifactDir = env.DAWN_VERCEL_ARTIFACT_DIR
  if (!artifactDir || !isAbsolute(artifactDir)) {
    throw new Error("native Vercel cleanup requires an absolute artifact directory")
  }
  let stats
  try {
    stats = await dependencies.lstat(artifactDir)
  } catch {
    throw new Error("native Vercel artifact directory is unreadable")
  }
  if (stats.isSymbolicLink() || !stats.isDirectory()) {
    throw new Error("native Vercel artifact directory must be a non-symlink directory")
  }
  return artifactDir
}

async function readRegularArtifactFile(path, dependencies) {
  let stats
  try {
    stats = await dependencies.lstat(path)
  } catch {
    throw new Error("native Vercel artifact evidence is unreadable")
  }
  if (stats.isSymbolicLink() || !stats.isFile()) {
    throw new Error("native Vercel artifact evidence must be a regular non-symlink file")
  }
  return await dependencies.readFile(path, "utf8")
}

function protectedValues(env) {
  const names = [
    "DAWN_VERCEL_TOKEN",
    "DAWN_VERCEL_ORG_ID",
    "DAWN_VERCEL_PROJECT_ID",
    "DAWN_VERCEL_DATABASE_URL",
  ]
  const missing = names.filter((name) => !env[name])
  if (missing.length > 0) {
    throw new Error(`native Vercel cleanup inputs are missing: ${missing.join(", ")}`)
  }
  return names.map((name) => env[name])
}

function validateVitestResult(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("native Vercel Vitest evidence is malformed")
  }
  if (
    value.success !== true ||
    value.numFailedTestSuites !== 0 ||
    value.numFailedTests !== 0 ||
    value.numPendingTestSuites !== 0 ||
    value.numPendingTests !== 0 ||
    value.numTodoTests !== 0 ||
    !Number.isSafeInteger(value.numTotalTestSuites) ||
    value.numTotalTestSuites < 1 ||
    value.numPassedTestSuites !== value.numTotalTestSuites ||
    !Number.isSafeInteger(value.numTotalTests) ||
    value.numTotalTests < 1 ||
    !Number.isSafeInteger(value.numPassedTests) ||
    value.numPassedTests !== value.numTotalTests ||
    !Array.isArray(value.testResults) ||
    value.testResults.length !== 1 ||
    value.testResults[0]?.status !== "passed" ||
    basename(value.testResults[0]?.name ?? "") !== "vercel-native-lane.test.ts" ||
    !Array.isArray(value.testResults[0]?.assertionResults)
  ) {
    throw new Error("native Vercel Vitest evidence did not record one successful test file")
  }
  const assertions = value.testResults[0].assertionResults
  if (
    assertions.length !== value.numTotalTests ||
    assertions.some((assertion) => assertion?.status !== "passed")
  ) {
    throw new Error("native Vercel Vitest evidence contains incomplete assertions")
  }
  const nativeAssertions = assertions.filter(
    (assertion) => assertion?.title === "runs two native Vercel previews",
  )
  if (nativeAssertions.length !== 1 || nativeAssertions[0]?.status !== "passed") {
    throw new Error("native Vercel Vitest evidence lacks the exact passed native assertion")
  }
}

export async function assertNativeVercelReceipt({ env, dependencies = {} }) {
  const resolved = createNativeVercelCleanupDependencies(dependencies)
  const artifactDir = await artifactDirectory(env, resolved)
  const helpers = await resolved.loadSharedHelpers()
  let receipt
  let vitest
  let manifest
  try {
    receipt = JSON.parse(
      await readRegularArtifactFile(resolve(artifactDir, "receipt.json"), resolved),
    )
    vitest = JSON.parse(
      await readRegularArtifactFile(resolve(artifactDir, "vitest.json"), resolved),
    )
    manifest = JSON.parse(
      await readRegularArtifactFile(resolve(artifactDir, "cleanup-manifest.json"), resolved),
    )
  } catch {
    throw new Error("native Vercel final receipt or Vitest evidence is unreadable")
  }
  const parsedReceipt = helpers.parseNativeReceipt(receipt)
  const closed = helpers.parseNativeCleanupManifest(manifest)
  const receiptDeployments = new Map(
    parsedReceipt.deployments.map((deployment) => [deployment.kind, deployment]),
  )
  const receiptManifestMismatch = closed.attempts.some(
    ({ attempt, binding, deploymentReceipt, reconciliation }) => {
      const receiptDeployment = receiptDeployments.get(attempt.kind)
      return (
        reconciliation?.zeroLive !== false ||
        !binding ||
        !deploymentReceipt ||
        !receiptDeployment ||
        binding.deploymentId !== receiptDeployment.deploymentId ||
        binding.canonicalOrigin !== receiptDeployment.canonicalOrigin ||
        deploymentReceipt.deploymentId !== receiptDeployment.deploymentId ||
        deploymentReceipt.canonicalOrigin !== receiptDeployment.canonicalOrigin
      )
    },
  )
  if (receiptManifestMismatch) {
    throw new Error("native Vercel receipt does not match cleanup manifest")
  }
  if (
    !closed.projectBindingVerified ||
    !closed.databaseRowsAbsent ||
    closed.attempts.length !== 2 ||
    new Set(closed.attempts.map(({ attempt }) => attempt.kind)).size !== 2 ||
    closed.attempts.some(
      ({ additionalDeployments, cleaned, reconciliation }) =>
        !cleaned ||
        reconciliation?.expectedCardinality !== true ||
        additionalDeployments?.some((deployment) => !deployment.cleaned),
    ) ||
    closed.barriers.some(({ cleaned }) => !cleaned) ||
    closed.threads.some(({ cleaned }) => !cleaned)
  ) {
    throw new Error("native Vercel cleanup manifest is not fully closed")
  }
  validateVitestResult(vitest)
  return { mode: "assert-receipt" }
}

export async function prepareNativeVercelArtifacts({ env, dependencies = {} }) {
  const resolved = createNativeVercelCleanupDependencies(dependencies)
  const artifactDir = await artifactDirectory(env, resolved)
  const values = protectedValues(env)
  await readRegularArtifactFile(resolve(artifactDir, "vitest.json"), resolved)
  const helpers = await resolved.loadSharedHelpers()
  const prepared = await helpers.prepareNativeArtifactUpload({
    artifactDir,
    protectedValues: values,
  })
  return { ...prepared, mode: "prepare-artifacts" }
}

export async function runNativeVercelCleanup({ env, dependencies = {} }) {
  const resolved = createNativeVercelCleanupDependencies(dependencies)
  const helpers = await resolved.loadSharedHelpers()
  const environment = helpers.readNativeLaneEnvironment(env)
  await artifactDirectory(env, resolved)
  const values = protectedValues(env)
  let store
  let postgres
  try {
    store = await helpers.createNativeEvidenceStore({
      artifactDir: environment.artifactDir,
      protectedValues: values,
    })
    postgres = await (resolved.createDatabase ?? helpers.createNativePostgresDatabase)(
      environment.databaseUrl,
    )
  } catch {
    throw new Error("native Vercel cleanup initialization failed")
  }
  const cleanupEvidenceStore = resolved.cleanupEvidenceStore ?? helpers.cleanupNativeEvidenceStore
  return await helpers.runNativeOwnedOperation({
    close: postgres.close,
    closeTimeoutMs: 10_000,
    operation: async () => {
      let apiClient
      try {
        const fetchAdapters = (resolved.createFetchAdapters ?? helpers.createNativeFetchAdapters)()
        apiClient = (resolved.createApiClient ?? helpers.createNativeVercelApiClient)({
          token: environment.token,
          transport: fetchAdapters.apiTransport,
        })
      } catch {
        throw new Error("native Vercel cleanup initialization failed")
      }
      try {
        await cleanupEvidenceStore({
          apiClient,
          clock: {
            now: Date.now,
            sleep: (milliseconds) =>
              new Promise((resolveSleep) => setTimeout(resolveSleep, milliseconds)),
          },
          database: postgres.database,
          orgId: environment.orgId,
          projectId: environment.projectId,
          store,
        })
        const partial = JSON.parse(
          await resolved.readFile(resolve(environment.artifactDir, "receipt.partial.json"), "utf8"),
        )
        const deployments = partial?.deployments
        const complete =
          deployments &&
          typeof deployments === "object" &&
          !Array.isArray(deployments) &&
          Object.hasOwn(deployments, "source") &&
          Object.hasOwn(deployments, "prebuilt")
        if (complete) await store.finalizeReceipt()
        return { finalized: Boolean(complete), mode: "cleanup" }
      } catch {
        throw new Error("native Vercel workflow cleanup failed")
      }
    },
  })
}

export async function runNativeVercelCleanupCli({ argv, env, dependencies = {} }) {
  if (!Array.isArray(argv) || argv.length !== 1 || !MODES.has(argv[0])) {
    throw new Error(
      "native Vercel cleanup requires exactly one exclusive mode: --cleanup, --assert-receipt, or --prepare-artifacts",
    )
  }
  if (argv[0] === "--cleanup") return await runNativeVercelCleanup({ dependencies, env })
  if (argv[0] === "--assert-receipt") {
    return await assertNativeVercelReceipt({ dependencies, env })
  }
  return await prepareNativeVercelArtifacts({ dependencies, env })
}

const isMain = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)
if (isMain) {
  try {
    const result = await runNativeVercelCleanupCli({
      argv: process.argv.slice(2),
      env: process.env,
    })
    process.stdout.write(`${JSON.stringify(result)}\n`)
  } catch {
    process.stderr.write("native Vercel cleanup command failed\n")
    process.exitCode = 1
  }
}
