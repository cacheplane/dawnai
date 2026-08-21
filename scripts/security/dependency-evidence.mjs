import { createHash } from "node:crypto"
import { fileURLToPath } from "node:url"

import {
  loadDependabotExpectation,
  readDependabotOpen,
  reconcileDependabot,
  sealReconciliationReceipt,
  validateDependabotExpectation,
} from "./dependabot-reconcile.mjs"
import {
  collectAuditEvidence,
  formatUtcSeconds,
  loadAuditExpectation,
} from "./dependency-audit-evidence.mjs"
import { readEvidenceInputBytes, writeCanonicalEvidenceFile } from "./evidence-file-io.mjs"
import {
  canonicalJsonBytes,
  createEvidenceBudget,
  createGhApiTransport,
  createGitHubReader,
  EvidenceError,
  runBoundedProcess,
  safeEvidenceError,
} from "./github-evidence.mjs"
import {
  collectPublicationContainment,
  verifyPublicationSnapshot,
} from "./publication-containment.mjs"

const UTC_SECONDS_PATTERN = /^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}Z$/u

export {
  collectAuditEvidence,
  formatUtcSeconds,
  loadAuditExpectation,
  normalizeAuditDocument,
  validateAuditExpectation,
} from "./dependency-audit-evidence.mjs"

function fail(code) {
  throw new EvidenceError(code)
}

export function createBaselineReceipt({
  capturedAt,
  expectedDefaultSha,
  fixture,
  open,
  publication,
  repository,
  sourceSha,
}) {
  const expectedFixture = validateDependabotExpectation(fixture)
  if (
    repository !== "cacheplane/dawnai" ||
    typeof sourceSha !== "string" ||
    !/^[0-9a-f]{40}$/u.test(sourceSha) ||
    typeof expectedDefaultSha !== "string" ||
    !/^[0-9a-f]{40}$/u.test(expectedDefaultSha) ||
    expectedFixture.defaultSha !== expectedDefaultSha ||
    !isCanonicalUtcSeconds(capturedAt)
  ) {
    fail("INVALID_BASELINE_RECEIPT")
  }
  const normalizedOpen = safeClone(open, "INVALID_BASELINE_RECEIPT")
  if (JSON.stringify(normalizedOpen) !== JSON.stringify(expectedFixture.open)) {
    fail("INVALID_BASELINE_RECEIPT")
  }
  const normalizedPublication = verifyPublicationSnapshot(publication, {
    expectedDefaultSha,
  })
  if (normalizedPublication.sourceSha !== sourceSha) fail("INVALID_BASELINE_RECEIPT")
  return safeClone(
    {
      capturedAt,
      dependabot: { defaultSha: expectedDefaultSha, open: normalizedOpen },
      kind: "dependency-security-baseline",
      publication: normalizedPublication,
      repository,
      schemaVersion: 1,
      sourceSha,
    },
    "INVALID_BASELINE_RECEIPT",
  )
}

export async function runDependencyEvidenceCli({
  argv = process.argv.slice(2),
  cwd = process.cwd(),
  environment = process.env,
  gitProcess = runBoundedProcess,
  githubTransport = createGhApiTransport(),
  now = Date.now,
  npmRequest,
  readInventory = readReleaseInventoryAtCommit,
  reconcile = reconcileDependabot,
  runProcess = runBoundedProcess,
  writeStdout = (value) => process.stdout.write(value),
} = {}) {
  if (
    !Array.isArray(argv) ||
    typeof cwd !== "string" ||
    typeof writeStdout !== "function" ||
    typeof reconcile !== "function"
  ) {
    fail("INVALID_CLI_REQUEST")
  }
  const { operation, options } = parseDependencyEvidenceArguments(argv)
  if (operation === "audit") {
    const expectation = await loadAuditExpectation(options.expected, {
      root: cwd,
    })
    const receipt = await collectAuditEvidence({
      cwd,
      expectation,
      runProcess,
    })
    const output = await writeCanonicalEvidenceFile(options.output, receipt, {
      cwd,
    })
    writeStdout(
      `audit receipt ${output} full=${receipt.full.records.length} production=${receipt.production.records.length}\n`,
    )
    return { output, receipt }
  }
  if (operation === "baseline") {
    const result = await collectLiveBaseline({
      cwd,
      gitProcess,
      githubTransport,
      now,
      npmRequest,
      options,
      readInventory,
    })
    const output = await writeCanonicalEvidenceFile(options.output, result.receipt, { cwd })
    writeStdout(
      `baseline receipt ${output} open=${result.receipt.dependabot.open.length} digest=${result.digest}\n`,
    )
    return { output, ...result }
  }
  if (operation === "reconcile") {
    const result = await runReconciliationCliOperation({
      cwd,
      gitProcess,
      githubTransport,
      now,
      npmRequest,
      options,
      readInventory,
      reconcile,
    })
    const output = await writeCanonicalEvidenceFile(options.output, result.receipt, { cwd })
    writeStdout(
      `reconciliation receipt ${output} fixed=${result.receipt.dependabot.fixed.length} open=${result.receipt.dependabot.open.length}\n`,
    )
    return { output, receipt: result.receipt }
  }
  if (operation === "seal-receipt") {
    const runId = parsePositiveInteger(environment?.GITHUB_RUN_ID, "INVALID_UPLOADER_RUN_ID")
    const runAttempt = parsePositiveInteger(
      environment?.GITHUB_RUN_ATTEMPT,
      "INVALID_UPLOADER_RUN_ATTEMPT",
    )
    const result = await sealReconciliationReceipt({
      expectedMainSha: options["expected-main-sha"],
      expectedMergeSha: options["expected-merge-sha"],
      expectedPrNumber: parsePositiveInteger(
        options["expected-pr-number"],
        "INVALID_RECEIPT_CORRELATION",
      ),
      expectedRepository: "cacheplane/dawnai",
      expectedReviewedBaseSha: options["expected-reviewed-base-sha"],
      expectedReviewedHeadSha: options["expected-reviewed-head-sha"],
      outputDirectory: options["output-directory"],
      outputRoot: options["output-root"],
      receiptBase64: options["receipt-base64"],
      receiptSha256: options["receipt-sha256"],
      runAttempt,
      runId,
    })
    writeStdout(
      `sealed receipt ${result.receiptPath} manifest=${result.manifestPath} digest=${result.manifest.receiptSha256}\n`,
    )
    return result
  }
  fail("UNSUPPORTED_OPERATION")
}

async function collectLiveBaseline({
  cwd,
  gitProcess,
  githubTransport,
  now,
  npmRequest,
  options,
  readInventory,
}) {
  if (
    options.repo !== "cacheplane/dawnai" ||
    options["inventory-ref"] !== "HEAD" ||
    options["current-version"] !== "0.8.21" ||
    options["target-version"] !== "0.8.22" ||
    !isSha(options["source-sha"]) ||
    !isSha(options["expected-default-sha"]) ||
    typeof githubTransport !== "function" ||
    typeof gitProcess !== "function" ||
    typeof now !== "function" ||
    typeof readInventory !== "function"
  ) {
    fail("INVALID_BASELINE_REQUEST")
  }
  const sourceSha = await readExactHead({ cwd, gitProcess })
  if (sourceSha !== options["source-sha"]) fail("INVENTORY_SOURCE_MISMATCH")
  let inventory
  try {
    inventory = await readInventory({ root: cwd, ref: sourceSha })
  } catch {
    fail("INVENTORY_UNPROVABLE")
  }
  if (inventory.version !== options["current-version"] || inventory.packages.length !== 21) {
    fail("INVENTORY_UNPROVABLE")
  }
  const fixture = await loadDependabotExpectation(options["expected-identities"], {
    root: cwd,
  })
  const expectedNumbers = parseNumberSet(options["expected-open"])
  const budget = createEvidenceBudget({
    maxBytes: 128 * 1024 * 1024,
    maxPages: 50,
    maxRecords: 10_000,
    maxRequests: 200,
    now,
    timeoutMs: 300_000,
  })
  const github = createGitHubReader({
    budget,
    repo: options.repo,
    transport: githubTransport,
  })
  const publication = await collectPublicationContainment({
    budget,
    currentVersion: options["current-version"],
    expectedDefaultSha: options["expected-default-sha"],
    github,
    inventory: {
      packages: inventory.packages,
      ref: options["inventory-ref"],
      sourceSha,
      version: inventory.version,
    },
    ...(npmRequest === undefined ? {} : { npmRequest }),
    repo: options.repo,
    sourceSha,
    targetVersion: options["target-version"],
  })
  const open = await readDependabotOpen({
    expectedDefaultSha: options["expected-default-sha"],
    expectedNumbers,
    fixture,
    github,
  })
  const closingHead = await github.object("commits/main")
  if (closingHead.sha !== options["expected-default-sha"]) fail("DEFAULT_HEAD_DRIFT")
  const capturedAt = formatUtcSeconds(now())
  const receipt = createBaselineReceipt({
    capturedAt,
    expectedDefaultSha: options["expected-default-sha"],
    fixture,
    open,
    publication,
    repository: options.repo,
    sourceSha,
  })
  return {
    digest: createHash("sha256").update(canonicalJsonBytes(receipt)).digest("hex"),
    receipt,
  }
}

async function runReconciliationCliOperation({
  cwd,
  gitProcess,
  githubTransport,
  now,
  npmRequest,
  options,
  readInventory,
  reconcile,
}) {
  if (
    options.repo !== "cacheplane/dawnai" ||
    options["inventory-ref"] !== "HEAD" ||
    options["current-version"] !== "0.8.21" ||
    options["target-version"] !== "0.8.22" ||
    !isSha(options["reviewed-base-sha"]) ||
    !isSha(options["reviewed-head-sha"]) ||
    !isSha(options["merge-sha"]) ||
    !isSha(options["observation-head-sha"]) ||
    typeof githubTransport !== "function" ||
    typeof gitProcess !== "function" ||
    typeof now !== "function" ||
    typeof readInventory !== "function"
  ) {
    fail("INVALID_RECONCILIATION_CLI_REQUEST")
  }
  const prNumber = parsePositiveInteger(options.pr, "INVALID_RECONCILIATION_CLI_REQUEST")
  const timeoutMs = parsePositiveInteger(
    options["wait-timeout-ms"],
    "INVALID_RECONCILIATION_CLI_REQUEST",
  )
  const intervalMs = parsePositiveInteger(
    options["poll-interval-ms"],
    "INVALID_RECONCILIATION_CLI_REQUEST",
  )
  const maxAttempts = parsePositiveInteger(
    options["max-attempts"],
    "INVALID_RECONCILIATION_CLI_REQUEST",
  )
  if (timeoutMs !== 900_000 || intervalMs !== 15_000 || maxAttempts !== 61) {
    fail("INVALID_RECONCILIATION_CLI_REQUEST")
  }
  const expectedFixedNumbers = parseNumberSet(options["expected-fixed"])
  const expectedOpenNumbers = parseNumberSet(options["expected-open"])
  const sourceSha = await readExactHead({ cwd, gitProcess })
  if (sourceSha !== options["observation-head-sha"]) fail("INVENTORY_SOURCE_MISMATCH")
  let inventory
  try {
    inventory = await readInventory({ root: cwd, ref: sourceSha })
  } catch {
    fail("INVENTORY_UNPROVABLE")
  }
  if (inventory.version !== options["current-version"] || inventory.packages.length !== 21) {
    fail("INVENTORY_UNPROVABLE")
  }
  const [
    auditExpectationFixtureBytes,
    auditReceiptBytes,
    baselineReceiptBytes,
    dependabotIdentitiesFixtureBytes,
  ] = await Promise.all([
    readEvidenceInputBytes(options["audit-expectation"], {
      cwd,
      contained: true,
    }),
    readEvidenceInputBytes(options["audit-receipt"], { cwd, contained: false }),
    readEvidenceInputBytes(options["baseline-receipt"], {
      cwd,
      contained: true,
    }),
    readEvidenceInputBytes(options["expected-identities"], {
      cwd,
      contained: true,
    }),
  ])
  const budget = createEvidenceBudget({
    maxBytes: 256 * 1024 * 1024,
    maxPages: 800,
    maxRecords: 100_000,
    maxRequests: 3_000,
    now,
    timeoutMs,
  })
  const github = createGitHubReader({
    budget,
    repo: options.repo,
    transport: githubTransport,
  })
  const collectPublication = () =>
    collectPublicationContainment({
      budget,
      currentVersion: options["current-version"],
      expectedDefaultSha: options["observation-head-sha"],
      github,
      inventory: {
        packages: inventory.packages,
        ref: options["inventory-ref"],
        sourceSha,
        version: inventory.version,
      },
      ...(npmRequest === undefined ? {} : { npmRequest }),
      repo: options.repo,
      sourceSha,
      targetVersion: options["target-version"],
    })
  const receipt = await reconcile({
    auditExpectationFixtureBytes,
    auditReceiptBytes,
    baselineReceiptBytes,
    collectPublication,
    dependabotIdentitiesFixtureBytes,
    expectedFixedNumbers,
    expectedMergeSha: options["merge-sha"],
    expectedObservationHeadSha: options["observation-head-sha"],
    expectedOpenNumbers,
    expectedReviewedBaseSha: options["reviewed-base-sha"],
    expectedReviewedHeadSha: options["reviewed-head-sha"],
    github,
    intervalMs,
    maxAttempts,
    now,
    prNumber,
    repo: options.repo,
    timeoutMs,
  })
  return { receipt }
}

async function readReleaseInventoryAtCommit({ root, ref }) {
  const { assertValidReleaseInventory, readReleaseInventory } = await import(
    "../release/inventory.mjs"
  )
  return assertValidReleaseInventory(await readReleaseInventory({ root, ref }))
}

async function readExactHead({ cwd, gitProcess }) {
  let result
  try {
    result = await gitProcess({
      args: ["rev-parse", "--verify", "HEAD^{commit}"],
      command: "git",
      cwd,
      maxBytes: 1024,
      timeoutMs: 15_000,
    })
  } catch {
    fail("INVENTORY_SOURCE_UNPROVABLE")
  }
  if (
    !isRecord(result) ||
    result.exitCode !== 0 ||
    typeof result.stdout !== "string" ||
    typeof result.stderr !== "string"
  ) {
    fail("INVENTORY_SOURCE_UNPROVABLE")
  }
  const sourceSha = result.stdout.endsWith("\n") ? result.stdout.slice(0, -1) : result.stdout
  if (!isSha(sourceSha)) fail("INVENTORY_SOURCE_UNPROVABLE")
  return sourceSha
}

function parseNumberSet(value) {
  if (typeof value !== "string" || !/^[1-9][0-9]*(?:,[1-9][0-9]*)*$/u.test(value)) {
    fail("INVALID_NUMBER_SET")
  }
  const numbers = value.split(",").map(Number)
  if (
    numbers.some((number) => !Number.isSafeInteger(number)) ||
    new Set(numbers).size !== numbers.length ||
    numbers.some((number, index) => index > 0 && number <= numbers[index - 1])
  ) {
    fail("INVALID_NUMBER_SET")
  }
  return numbers
}

function parsePositiveInteger(value, code) {
  if (typeof value !== "string" || !/^[1-9][0-9]*$/u.test(value)) fail(code)
  const number = Number(value)
  if (!Number.isSafeInteger(number)) fail(code)
  return number
}

function isSha(value) {
  return typeof value === "string" && /^[0-9a-f]{40}$/u.test(value)
}

export function parseDependencyEvidenceArguments(argv) {
  if (!Array.isArray(argv)) fail("INVALID_CLI_ARGUMENTS")
  const [operation, ...tokens] = argv
  const requiredByOperation = {
    audit: ["expected", "output"],
    baseline: [
      "repo",
      "inventory-ref",
      "source-sha",
      "expected-default-sha",
      "current-version",
      "target-version",
      "expected-identities",
      "expected-open",
      "output",
    ],
    reconcile: [
      "repo",
      "pr",
      "reviewed-base-sha",
      "reviewed-head-sha",
      "merge-sha",
      "observation-head-sha",
      "inventory-ref",
      "current-version",
      "target-version",
      "expected-identities",
      "expected-fixed",
      "expected-open",
      "baseline-receipt",
      "audit-expectation",
      "audit-receipt",
      "wait-timeout-ms",
      "poll-interval-ms",
      "max-attempts",
      "output",
    ],
    "seal-receipt": [
      "expected-main-sha",
      "expected-pr-number",
      "expected-reviewed-base-sha",
      "expected-reviewed-head-sha",
      "expected-merge-sha",
      "receipt-base64",
      "receipt-sha256",
      "output-root",
      "output-directory",
    ],
  }
  const required = requiredByOperation[operation]
  if (required === undefined || tokens.length !== required.length * 2) {
    fail("INVALID_CLI_ARGUMENTS")
  }
  const options = Object.create(null)
  for (let index = 0; index < tokens.length; index += 2) {
    const flag = tokens[index]
    const value = tokens[index + 1]
    if (
      typeof flag !== "string" ||
      typeof value !== "string" ||
      !flag.startsWith("--") ||
      value.length === 0
    ) {
      fail("INVALID_CLI_ARGUMENTS")
    }
    const key = flag.slice(2)
    if (!required.includes(key) || Object.hasOwn(options, key)) fail("INVALID_CLI_ARGUMENTS")
    options[key] = value
  }
  if (required.some((key) => !Object.hasOwn(options, key))) fail("INVALID_CLI_ARGUMENTS")
  return { operation, options: { ...options } }
}

function isCanonicalUtcSeconds(value) {
  if (typeof value !== "string" || !UTC_SECONDS_PATTERN.test(value)) return false
  const milliseconds = Date.parse(value)
  if (!Number.isFinite(milliseconds)) return false
  try {
    return new Date(milliseconds).toISOString().replace(".000Z", "Z") === value
  } catch {
    return false
  }
}

function safeClone(value, code) {
  try {
    return JSON.parse(canonicalJsonBytes(value).toString("utf8"))
  } catch {
    fail(code)
  }
}

function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value)
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  try {
    await runDependencyEvidenceCli()
  } catch (error) {
    console.error(safeEvidenceError(error))
    process.exitCode = 1
  }
}
