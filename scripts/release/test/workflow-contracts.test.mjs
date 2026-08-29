import assert from "node:assert/strict"
import { createHash } from "node:crypto"
import {
  lstat,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  realpath,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import test from "node:test"
import { fileURLToPath } from "node:url"

import { parse } from "yaml"

import { classifyReleaseWorkflowAbandonment } from "../abandonment-reachability.mjs"
import { ARTIFACT_STORE_SPARSE_FILES } from "../artifact-store.mjs"
import { readBoundedFixture } from "../fixture-io.mjs"
import { PUBLISHER_SPARSE_FILES } from "../publisher.mjs"
import { REQUIRED_RELEASE_SMOKE_LANES } from "../smoke-result.mjs"

const ROOT = fileURLToPath(new URL("../../..", import.meta.url))
const WORKFLOWS = path.join(ROOT, ".github/workflows")
const CONTROLLER_SCHEMA_PATH = path.join(ROOT, "scripts/release/controller-schema.json")
const ENTRYPOINT_ALLOWLIST_PATH = path.join(
  ROOT,
  "scripts/release/test/fixtures/workflow-entrypoints.json",
)
const EXECUTABLE_ALLOWLIST_PATH = path.join(
  ROOT,
  "scripts/release/test/fixtures/workflow-safe-executables.json",
)
const EXECUTABLE_ALLOWLIST = JSON.parse(
  await readBoundedFixture(EXECUTABLE_ALLOWLIST_PATH, { root: ROOT }),
)
const SCRIPT_PIN_FIXTURE = "scripts/release/test/fixtures/release-script-hashes.json"
const SCRIPT_PIN_PATH = path.join(ROOT, SCRIPT_PIN_FIXTURE)
const SHA256_HEX = /^[0-9a-f]{64}$/u
const workflowExpression = (value) => `\${{ ${value} }}`
const SCRIPT_REFERENCE = /(?:^|[\s;&|"'(])(scripts\/[\w.-]+(?:\/[\w.-]+)*)/gu
const PNPM_REFERENCE = /(?:^|[\s;&|"'(])pnpm\s+(?:run\s+)?(?!-)([\w:.-]+)/gu
const ACTIONS = Object.freeze({
  attest: "actions/attest-build-provenance@4d101475d8b20a2381f78447822ac1eab6504dd8",
  changesets: "changesets/action@a45c4d594aa4e2c509dc14a9f2b3b67ba3780d0d",
  checkout: "actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1",
  download: "actions/download-artifact@3e5f45b2cfb9172054b4087a40e8e0b5a5461e7c",
  node: "actions/setup-node@820762786026740c76f36085b0efc47a31fe5020",
  pnpm: "pnpm/action-setup@0977fd99725f1db4007ccb2928dbb4e90d06cc86",
  upload: "actions/upload-artifact@043fb46d1a93c77aae656e7c1c64a875d1fc6a0a",
})
const FINAL_WORKFLOW_FILES = Object.freeze([
  "published-artifact-verify.yml",
  "release.yml",
  "version-pr.yml",
])
const LEGACY_RELEASE_FILES = Object.freeze([
  "scripts/backfill-release-tags.mjs",
  "scripts/backfill-release-tags.test.mjs",
  "scripts/release-publish.mjs",
  "scripts/release-publish.test.mjs",
  "scripts/upload-release-assets.mjs",
  "scripts/upload-release-assets.test.mjs",
])
const LEGACY_PACKAGE_COMMANDS = Object.freeze([
  "release:publish",
  "release:shadow",
  "test:backfill-release-tags",
  "test:release-publish",
  "test:upload-release-assets",
])
const SMOKE_JOB_BY_LANE = Object.freeze(
  Object.fromEntries(REQUIRED_RELEASE_SMOKE_LANES.map((lane) => [lane, `smoke-${lane}`])),
)
const NORMAL_EXACT_TAG_JOBS = Object.freeze([
  "prepare",
  "hydrate",
  "attest",
  "escrow",
  "publish-npm",
  "reconcile-npm",
  ...Object.values(SMOKE_JOB_BY_LANE),
  "reconcile-smokes",
  "dispatch-audit",
  "record-audit-dispatch",
  "correlate-audit",
  "publish-release",
])
const FINAL_RELEASE_JOB_IDS = Object.freeze(["detect", "tag", ...NORMAL_EXACT_TAG_JOBS])

test("final release ownership is switched atomically and legacy owners are absent", async () => {
  const sources = await readWorkflowSourcesFromRoot(ROOT)
  const packageJson = JSON.parse(
    await readBoundedFixture(path.join(ROOT, "package.json"), { root: ROOT }),
  )

  for (const file of FINAL_WORKFLOW_FILES) {
    assert.equal(typeof sources[file], "string", `${file} must exist in the atomic switch`)
    assert.doesNotThrow(() => parseWorkflowSource(sources[file], file))
  }
  assert.equal(sources["release-shadow.yml"], undefined, "release-shadow.yml must be deleted")
  for (const file of LEGACY_RELEASE_FILES) {
    await assert.rejects(lstat(path.join(ROOT, file)), { code: "ENOENT" })
  }
  for (const command of LEGACY_PACKAGE_COMMANDS) {
    assert.equal(packageJson.scripts?.[command], undefined, `${command} must be removed`)
  }
  assert.doesNotMatch(
    packageJson.scripts?.["ci:validate"] ?? "",
    /(?:release-publish|upload-release-assets|backfill-release-tags)/u,
  )

  const ci = parseWorkflowSource(sources["ci.yml"], "ci.yml")
  assert.ok(ci.jobs["vercel-native"], "the real Vercel deployment lane is required")
  assert.ok(ci.jobs["copilotkit-examples-e2e"], "the CopilotKit example e2e lane is required")
  assert.equal(typeof sources["publish-chart.yml"], "string", "chart publication remains owned")
})

test("version-pr.yml is version-only and uses only RELEASE_GITHUB_TOKEN", async () => {
  const { source, workflow } = await readRequiredWorkflow("version-pr.yml")
  const packageJson = JSON.parse(
    await readBoundedFixture(path.join(ROOT, "package.json"), { root: ROOT }),
  )
  assert.deepEqual(workflow.on, { push: { branches: ["main"] } })
  assert.deepEqual(workflow.permissions, {
    contents: "write",
    "pull-requests": "write",
  })
  assert.deepEqual(Object.keys(workflow.jobs), ["version"])

  const version = requiredJob(workflow, "version")
  assertReadOrWritePermissions(version.permissions, {
    contents: "write",
    "pull-requests": "write",
  })
  const changesets = onlyStepUsing(version, ACTIONS.changesets)
  const pnpm = onlyStepUsing(version, ACTIONS.pnpm)
  assert.deepEqual(pnpm.with, { version: "10.33.0" })
  assert.deepEqual(changesets.with, {
    commit: "Version Packages",
    title: "Version Packages",
    version: "pnpm run version",
  })
  assert.deepEqual(changesets.env, {
    GITHUB_TOKEN: workflowExpression("secrets.RELEASE_GITHUB_TOKEN"),
  })
  assert.equal(
    packageJson.scripts?.version,
    "changeset version && node scripts/sync-chart-appversion.mjs",
    "Version Packages must advance fixed-package and chart versions in one commit",
  )

  assert.doesNotMatch(
    source,
    /\|\||secrets\.GITHUB_TOKEN|\bpublish\s*:|createGithubReleases|registry-url/iu,
  )
  assert.doesNotMatch(
    source,
    /id-token|attestations|publisher\.mjs|npm\s+publish|gh\s+release|\/releases/iu,
  )
  assertPinnedToolchain(version)
})

test("release.yml has exact triggers and one repository-global non-cancelling queue", async () => {
  const { workflow } = await readRequiredWorkflow("release.yml")
  assert.deepEqual(Object.keys(workflow.on).sort(), ["push", "schedule", "workflow_dispatch"])
  assert.deepEqual(workflow.on.push, { branches: ["main"] })
  assert.ok(Array.isArray(workflow.on.schedule) && workflow.on.schedule.length === 1)
  assert.match(workflow.on.schedule[0].cron, /^[\d*/,-]+(?: [\d*/,-]+){4}$/u)
  assert.deepEqual(Object.keys(workflow.on.workflow_dispatch.inputs).sort(), [
    "commitSha",
    "operation",
    "version",
  ])
  assertDispatchIdentityInput(workflow.on.workflow_dispatch.inputs.version)
  assertDispatchIdentityInput(workflow.on.workflow_dispatch.inputs.commitSha)
  assert.deepEqual(dispatchInputContract(workflow.on.workflow_dispatch.inputs.operation), {
    default: "reconcile",
    options: ["reconcile"],
    required: true,
    type: "choice",
  })
  assert.equal(
    workflow.on.workflow_dispatch.inputs.operation.description,
    "Reconcile this candidate",
  )

  assert.equal(typeof workflow.concurrency?.group, "string")
  assert.match(workflow.concurrency.group, /release/iu)
  assert.doesNotMatch(workflow.concurrency.group, /\$\{\{/u, "the release lock must be global")
  assert.equal(workflow.concurrency.queue, "max")
  assert.equal(workflow.concurrency["cancel-in-progress"], false)
  assert.deepEqual(Object.keys(workflow.jobs).sort(), [...FINAL_RELEASE_JOB_IDS].sort())
  assert.equal(Object.keys(workflow.jobs).length, 18)
})

test("final release workflows pin every action and the exact Node, pnpm, and npm toolchain", async () => {
  const sources = await readFinalWorkflowSources()
  const allowedActions = new Set(Object.values(ACTIONS))
  let pnpmSetups = 0
  let npmChecks = 0
  for (const [file, source] of Object.entries(sources)) {
    const workflow = parseWorkflowSource(source, file)
    for (const entry of workflowExecutables(workflow).filter(({ kind }) => kind === "step-uses")) {
      assert.match(entry.value, /^[^@\s]+@[0-9a-f]{40}$/u, `${file}: ${entry.value}`)
      assert.ok(allowedActions.has(entry.value), `${file}: unreviewed action ${entry.value}`)
    }
    for (const job of Object.values(workflow.jobs)) {
      const runs = runSource(job)
      if (
        /\bnode\s+scripts\//u.test(runs) ||
        job.steps?.some((step) => step.uses === ACTIONS.changesets)
      ) {
        assertPinnedToolchain(job)
      }
      pnpmSetups += job.steps?.filter((step) => step.uses === ACTIONS.pnpm).length ?? 0
      if (/npm\s+--version[\s\S]*11\.17\.0|11\.17\.0[\s\S]*npm\s+--version/u.test(runs)) {
        npmChecks += 1
      }
    }
  }
  assert.ok(pnpmSetups > 0, "the exact pnpm runtime must be installed where versioning uses it")
  assert.ok(npmChecks > 0, "the exact npm runtime must be asserted before release verification")
})

test("detect invokes the sole production observer and exports only validated controller outputs", async () => {
  const { source, workflow } = await readRequiredWorkflow("release.yml")
  const detect = requiredJob(workflow, "detect")
  assert.deepEqual(normalizeNeeds(detect.needs), [])
  assertNoWriteOrOidc(detect)
  assert.equal(detect.permissions?.checks, "read")
  const observe = onlyRunStepMatching(detect, /node scripts\/release\/cli\.mjs observe\b/u)
  assert.equal(observe.id, "observe")
  assert.equal(observe["continue-on-error"], undefined)
  assertCommandFlags(observe.run, "node scripts/release/cli.mjs observe", [
    "--event",
    "--report",
    "--github-output",
  ])
  assert.match(observe.run, /--github-output\s+["']?\$GITHUB_OUTPUT["']?/u)
  assert.deepEqual(detect.outputs, {
    candidate_sha: workflowExpression("steps.observe.outputs.candidate_sha"),
    candidate_version: workflowExpression("steps.observe.outputs.candidate_version"),
    disposition: workflowExpression("steps.observe.outputs.disposition"),
    next_transition: workflowExpression("steps.observe.outputs.next_transition"),
    observation_artifact_id: workflowExpression("steps.observation.outputs.artifact-id"),
    state: workflowExpression("steps.observe.outputs.state"),
  })
  const observationUpload = detect.steps.find(
    (step) => step.id === "observation" && step.uses === ACTIONS.upload,
  )
  assert.ok(observationUpload)
  assert.equal(
    observationUpload.with?.name,
    `production-observation-${workflowExpression("github.run_id")}-${workflowExpression("github.run_attempt")}`,
  )
  assert.equal(observationUpload.with?.overwrite, false)
  assert.doesNotMatch(observe.run, /\|\||continue-on-error|shadow|fallback/iu)
  assert.equal(countMatches(source, /scripts\/release\/cli\.mjs observe\b/gu), 1)
  assert.doesNotMatch(source, /release:shadow|shadow-reconcile|release-shadow/iu)

  const checkout = onlyStepUsing(detect, ACTIONS.checkout)
  assert.equal(checkout.with?.ref, workflowExpression("github.event.repository.default_branch"))
  assert.equal(checkout.with?.["fetch-depth"], 0)
  assert.equal(checkout.with?.["persist-credentials"], false)
  assert.doesNotMatch(source, /RELEASE_ADMIN_READ_TOKEN|immutable-releases-gate/iu)
})

test("tag is the sole coordinator relay and exact-tag identity requires both ref and SHA", async () => {
  const { source, workflow } = await readRequiredWorkflow("release.yml")
  const tag = requiredJob(workflow, "tag")
  assert.deepEqual(normalizeNeeds(tag.needs), ["detect"])
  assertReadOrWritePermissions(tag.permissions, {
    actions: "write",
    contents: "write",
  })
  assert.deepEqual(Object.keys(tag.outputs), ["continue"])
  assert.match(tag.outputs.continue, /^\$\{\{ steps\.[\w-]+\.outputs\.continue \}\}$/u)
  onlyRunStepMatching(tag, /node scripts\/release\/cli\.mjs tag --candidate\b/u)
  const relay = onlyRunStepMatching(tag, /2026-03-10/u)
  assert.match(relay.run, /\.github\/workflows\/release\.yml/u)
  assert.match(relay.run, /refs\/tags\/v/u)
  assert.match(relay.run, /workflow_dispatch|dispatches/iu)
  assert.match(relay.run, /operation[\s"'=:]+reconcile/iu)
  assert.deepEqual(relay.env?.GITHUB_TOKEN, workflowExpression("github.token"))
  assert.equal(relay.env?.OPERATION, undefined)
  assert.doesNotMatch(relay.run, /list.*runs|runs\/\?|poll|wait|sleep/iu)
  assert.doesNotMatch(relay.run, /abandon/iu)
  assert.doesNotMatch(source, /target_commitish|git\s+tag\s+(?!-a|-s)|createGithubReleases/iu)

  for (const id of NORMAL_EXACT_TAG_JOBS) {
    assertExactTagAndOperationGate(requiredJob(workflow, id), {
      operation: "reconcile",
    })
  }
})

test("prepare, attestation, and ATTACHING-to-45-base escrow have one ordered authority path", async () => {
  const { source, workflow } = await readRequiredWorkflow("release.yml")
  const prepare = requiredJob(workflow, "prepare")
  const hydrate = requiredJob(workflow, "hydrate")
  const attest = requiredJob(workflow, "attest")
  const escrow = requiredJob(workflow, "escrow")
  assert.deepEqual(normalizeNeeds(prepare.needs), ["detect", "tag"])
  assert.deepEqual(normalizeNeeds(hydrate.needs), ["detect", "prepare", "tag"])
  assert.deepEqual(normalizeNeeds(attest.needs), ["detect", "hydrate", "tag"])
  assert.deepEqual(normalizeNeeds(escrow.needs), ["attest", "detect", "hydrate", "tag"])
  assertNoWriteOrOidc(prepare)
  assertNoWriteOrOidc(hydrate)
  assertReadOrWritePermissions(attest.permissions, {
    actions: "read",
    attestations: "write",
    contents: "read",
    "id-token": "write",
  })
  assert.equal(escrow.permissions?.contents, "write")
  assert.notEqual(escrow.permissions?.actions, "write")

  const handoff = onlyRunStepMatching(prepare, /node scripts\/release\/workflow-handoff\.mjs\b/u)
  assertCommandFlags(handoff.run, "node scripts/release/workflow-handoff.mjs", [
    "--report",
    "--root",
    "--output",
  ])
  const prepareStep = onlyRunStepMatching(prepare, /node scripts\/release\/cli\.mjs prepare\b/u)
  assert.ok(prepare.steps.indexOf(handoff) < prepare.steps.indexOf(prepareStep))
  assertCommandFlags(prepareStep.run, "node scripts/release/cli.mjs prepare", [
    "--handoff",
    "--root",
    "--output-dir",
    "--candidate-output",
  ])

  const uploads = prepare.steps.filter((step) => step.uses === ACTIONS.upload)
  assert.equal(uploads.length, 2, "prepare must upload payload and handoff separately")
  const payload = uploads.find((step) => step.id === "payload")
  const handoffUpload = uploads.find((step) => step.id === "handoff")
  assert.ok(payload, "prepare must expose the immutable payload upload")
  assert.ok(handoffUpload, "prepare must expose the small handoff upload")
  assert.equal(payload.id, "payload")
  assert.equal(payload.with?.["if-no-files-found"], "error")
  assert.equal(payload.with?.overwrite, false)
  const record = onlyRunStepMatching(prepare, /node scripts\/release\/cli\.mjs record-artifact\b/u)
  assertCommandFlags(record.run, "node scripts/release/cli.mjs record-artifact", [
    "--candidate",
    "--manifest",
    "--artifact-upload-result",
    "--output",
  ])
  assert.match(record.run, /steps\.payload\.outputs\.artifact-id/u)
  assert.match(record.run, /steps\.payload\.outputs\.artifact-url/u)
  assert.match(record.run, /steps\.payload\.outputs\.artifact-digest/u)
  assert.doesNotMatch(record.run, /steps\.payload\.outputs\.artifact-name/u)
  assert.deepEqual(workflowArtifactBasenames(handoffUpload.with?.path), ["release-record.json"])
  assert.equal(handoffUpload.with?.name, workflowExpression("steps.identity.outputs.handoff_name"))
  const identity = onlyRunStepMatching(prepare, /handoff_name=release-record-v/u)
  assert.match(identity.run, /j\.version/u)
  assert.match(identity.run, /j\.commitSha\.slice\(0,12\)/u)
  assert.equal(handoffUpload.with?.["if-no-files-found"], "error")
  assert.equal(handoffUpload.with?.overwrite, false)
  assert.ok(prepare.steps.indexOf(prepareStep) < prepare.steps.indexOf(payload))
  assert.ok(prepare.steps.indexOf(payload) < prepare.steps.indexOf(record))
  assert.ok(prepare.steps.indexOf(record) < prepare.steps.indexOf(handoffUpload))

  const recovery = onlyRunStepMatching(hydrate, /node scripts\/release\/workflow-recovery\.mjs\b/u)
  assertCommandFlags(recovery.run, "node scripts/release/workflow-recovery.mjs", [
    "--report",
    "--output-dir",
  ])
  const resolver = onlyRunStepMatching(
    hydrate,
    /node scripts\/release\/artifact-store\.mjs resolve\b/u,
  )
  assertCommandFlags(resolver.run, "node scripts/release/artifact-store.mjs resolve", [
    "--record",
    "--output-dir",
  ])
  assert.match(resolver.if, /next_transition != 'attest-artifacts'/u)
  const recoveredIdentity = onlyRunStepMatching(hydrate, /actionsArtifact\.id/u)
  assert.equal(recoveredIdentity.id, "recovered-artifact")
  assert.match(recoveredIdentity.run, /actionsArtifact\.prepareRunId/u)
  assert.equal(
    recoveredIdentity.if,
    workflowExpression("needs.detect.outputs.next_transition == 'attest-artifacts'"),
  )
  const preparedDownload = hydrate.steps.find(
    (step) =>
      step.uses === ACTIONS.download &&
      step.with?.["artifact-ids"] ===
        workflowExpression("steps.recovered-artifact.outputs.artifact_id"),
  )
  assert.ok(preparedDownload)
  assert.equal(
    preparedDownload.if,
    workflowExpression("needs.detect.outputs.next_transition == 'attest-artifacts'"),
  )
  assert.equal(preparedDownload.with?.["github-token"], workflowExpression("github.token"))
  assert.equal(
    preparedDownload.with?.["run-id"],
    workflowExpression("steps.recovered-artifact.outputs.prepare_run_id"),
  )
  assert.equal(preparedDownload.with?.path, `${workflowExpression("runner.temp")}/runtime/payload`)
  assert.match(hydrate.if, /next_transition/u)
  assert.match(hydrate.if, /prepare-artifacts/u)
  assert.match(hydrate.if, /publish-github-release/u)

  onlyStepUsing(attest, ACTIONS.attest)
  const escrowStep = onlyRunStepMatching(escrow, /node scripts\/release\/cli\.mjs escrow\b/u)
  assertCommandFlags(escrowStep.run, "node scripts/release/cli.mjs escrow", [
    "--candidate",
    "--record",
    "--artifact-dir",
    "--attestation-set",
    "--attestation-bundles-dir",
  ])
  assert.equal(countMatches(source, /node scripts\/release\/cli\.mjs escrow\b/gu), 1)
  assert.doesNotMatch(source, /gh\s+release\s+(?:create|upload|edit)|target_commitish/iu)
})

test("publish-npm is exact-tag, sparse, dependency-free, and schema-bound", async () => {
  const { workflow } = await readRequiredWorkflow("release.yml")
  const schema = JSON.parse(await readBoundedFixture(CONTROLLER_SCHEMA_PATH, { root: ROOT }))
  const publish = requiredJob(workflow, "publish-npm")
  assert.deepEqual(normalizeNeeds(publish.needs), ["detect", "escrow", "hydrate", "tag"])
  assertReadOrWritePermissions(publish.permissions, {
    actions: "read",
    attestations: "read",
    contents: "read",
    "id-token": "write",
  })
  if (schema.npmTrustedPublisherEnvironment === null) {
    assert.equal(publish.environment, undefined)
  } else {
    assert.equal(publish.environment, schema.npmTrustedPublisherEnvironment)
  }

  const checkout = onlyStepUsing(publish, ACTIONS.checkout)
  assert.equal(checkout.with?.ref, workflowExpression("needs.detect.outputs.candidate_sha"))
  assert.equal(checkout.with?.["persist-credentials"], false)
  assert.equal(checkout.with?.["sparse-checkout-cone-mode"], false)
  const sparseFiles = String(checkout.with?.["sparse-checkout"] ?? "")
    .split(/\r?\n/u)
    .map((entry) => entry.trim())
    .filter(Boolean)
    .sort()
  assert.deepEqual(
    sparseFiles,
    [...new Set([...ARTIFACT_STORE_SPARSE_FILES, ...PUBLISHER_SPARSE_FILES])].sort(),
  )
  assert.equal(
    sparseFiles.some((file) => /(?:^|\/)cli\.mjs$|package\.json|pnpm-lock|packages\//u.test(file)),
    false,
  )

  const publisher = onlyRunStepMatching(publish, /node scripts\/release\/publisher\.mjs\b/u)
  const runtime = onlyStepUsing(publish, ACTIONS.download)
  assert.match(String(runtime.with?.["artifact-ids"]), /needs\.hydrate\.outputs\.artifact_id/u)
  assert.ok(publish.steps.indexOf(runtime) < publish.steps.indexOf(publisher))
  assertCommandFlags(publisher.run, "node scripts/release/publisher.mjs", [
    "--candidate",
    "--record",
    "--artifact-dir",
    "--report",
    "--github-output",
  ])
  const runs = runSource(publish)
  assert.doesNotMatch(
    runs,
    /(?:pnpm|npm|yarn)\s+(?:install|ci)|\b(?:build|test|pack)\b|node_modules|packages\//iu,
  )
  assert.doesNotMatch(runs, /cli\.mjs|npm\s+publish/iu, "publisher.mjs owns the only npm mutation")
})

test("npm reconciliation and five controller-owned smoke lanes are separate and fail closed", async () => {
  const { workflow } = await readRequiredWorkflow("release.yml")
  assert.deepEqual(REQUIRED_RELEASE_SMOKE_LANES, [
    "metadata",
    "published-harness",
    "runtime-targets",
    "scaffold",
    "storage",
  ])

  const reconcileNpm = requiredJob(workflow, "reconcile-npm")
  assert.deepEqual(normalizeNeeds(reconcileNpm.needs), ["detect", "hydrate", "publish-npm", "tag"])
  assert.equal(reconcileNpm.permissions?.contents, "write")
  assert.equal(reconcileNpm.permissions?.actions, "read")
  onlyRunStepMatching(reconcileNpm, /node scripts\/release\/cli\.mjs reconcile-npm\b/u)

  for (const lane of REQUIRED_RELEASE_SMOKE_LANES) {
    const id = SMOKE_JOB_BY_LANE[lane]
    const smoke = requiredJob(workflow, id)
    assert.deepEqual(normalizeNeeds(smoke.needs), ["detect", "hydrate", "reconcile-npm", "tag"])
    assertNoWriteOrOidc(smoke)
    assert.equal(smoke["runs-on"], "ubuntu-24.04")
    const entrypoint =
      lane === "metadata"
        ? /node scripts\/published-artifact-verify\.mjs\b[\s\S]*--release-mode\b/u
        : new RegExp(`node scripts/release/smoke/${escapeRegExp(lane)}\\.mjs\\b`, "u")
    const execute = onlyRunStepMatching(smoke, entrypoint)
    assertCommandHasFlag(execute.run, "--result")
    const upload = onlyStepUsing(smoke, ACTIONS.upload)
    assert.equal(upload.id, "result")
    assert.equal(upload.if, workflowExpression("always()"))
    assert.equal(
      upload.with?.name,
      `smoke-result-${lane}-${workflowExpression("github.run_id")}-${workflowExpression("github.run_attempt")}`,
    )
    assert.equal(upload.with?.["if-no-files-found"], "error")
    assert.deepEqual(smoke.outputs, {
      artifact_id: workflowExpression(`steps.result.outputs.artifact-id`),
    })
  }

  const reconcile = requiredJob(workflow, "reconcile-smokes")
  assert.deepEqual(
    normalizeNeeds(reconcile.needs),
    [
      "detect",
      "hydrate",
      "publish-npm",
      "reconcile-npm",
      "tag",
      ...Object.values(SMOKE_JOB_BY_LANE),
    ].sort(),
  )
  assert.equal(reconcile.permissions?.contents, "write")
  assert.equal(reconcile.permissions?.actions, "read")
  assert.match(reconcile.if, /always\(\)/u)
  for (const id of Object.values(SMOKE_JOB_BY_LANE)) {
    assert.match(reconcile.if, new RegExp(`needs\\.${escapeRegExp(id)}\\.result == 'success'`, "u"))
  }
  const download = reconcile.steps.find(
    (step) => step.uses === ACTIONS.download && step.with?.["merge-multiple"] === true,
  )
  assert.ok(download, "smoke reconciliation must merge the exact five result artifacts")
  const artifactIds = String(download.with?.["artifact-ids"] ?? "")
  for (const id of Object.values(SMOKE_JOB_BY_LANE)) {
    assert.match(
      artifactIds,
      new RegExp(`needs\\.${escapeRegExp(id)}\\.outputs\\.artifact_id`, "u"),
    )
  }
  assert.equal(download.with?.["merge-multiple"], true)
  const command = onlyRunStepMatching(
    reconcile,
    /node scripts\/release\/cli\.mjs reconcile-smokes\b/u,
  )
  assertCommandHasFlag(command.run, "--smoke-results")
  assert.doesNotMatch(command.run, /required-lanes|lane-set/iu)
})

test("audit dispatch, receipt recording, correlation, and immutable publication stay split", async () => {
  const { source, workflow } = await readRequiredWorkflow("release.yml")
  const dispatch = requiredJob(workflow, "dispatch-audit")
  const record = requiredJob(workflow, "record-audit-dispatch")
  const correlate = requiredJob(workflow, "correlate-audit")
  const publish = requiredJob(workflow, "publish-release")
  assert.deepEqual(normalizeNeeds(dispatch.needs), ["detect", "hydrate", "reconcile-smokes", "tag"])
  assert.equal(dispatch.permissions?.actions, "write")
  assert.notEqual(dispatch.permissions?.contents, "write")
  const dispatchStep = onlyRunStepMatching(
    dispatch,
    /node scripts\/release\/cli\.mjs dispatch-audit\b/u,
  )
  assertCommandFlags(dispatchStep.run, "node scripts/release/cli.mjs dispatch-audit", [
    "--version",
    "--commit-sha",
    "--manifest-sha256",
    "--output",
  ])
  assert.doesNotMatch(dispatchStep.run, /return_run_details|list.*runs|runs\/\?/iu)

  assert.deepEqual(normalizeNeeds(record.needs), ["detect", "dispatch-audit", "hydrate", "tag"])
  assert.equal(record.permissions?.contents, "write")
  assert.notEqual(record.permissions?.actions, "write")
  onlyRunStepMatching(record, /node scripts\/release\/cli\.mjs record-audit-dispatch\b/u)

  assert.deepEqual(normalizeNeeds(correlate.needs), [
    "detect",
    "hydrate",
    "record-audit-dispatch",
    "tag",
  ])
  assert.equal(correlate.permissions?.actions, "read")
  assert.equal(correlate.permissions?.contents, "write")
  onlyRunStepMatching(correlate, /node scripts\/release\/cli\.mjs wait-audit\b/u)
  onlyRunStepMatching(correlate, /node scripts\/release\/cli\.mjs correlate-audit\b/u)

  assert.deepEqual(normalizeNeeds(publish.needs), ["correlate-audit", "detect", "hydrate", "tag"])
  assert.equal(publish.permissions?.contents, "write")
  assert.notEqual(publish.permissions?.actions, "write")
  const publishStep = onlyRunStepMatching(
    publish,
    /node scripts\/release\/cli\.mjs publish-release\b/u,
  )
  assertCommandFlags(publishStep.run, "node scripts/release/cli.mjs publish-release", [
    "--candidate",
    "--record",
    "--audit-result",
  ])
  const closure = transitiveNeeds(workflow, "publish-release")
  for (const id of Object.values(SMOKE_JOB_BY_LANE)) assert.ok(closure.has(id), id)
  assert.ok(closure.has("dispatch-audit"))
  assert.ok(closure.has("record-audit-dispatch"))
  assert.ok(closure.has("correlate-audit"))
  assert.equal(
    Object.entries(workflow.jobs).some(
      ([id, job]) =>
        id !== "publish-release" && normalizeNeeds(job.needs).includes("publish-release"),
    ),
    false,
    "no post-publication job may receive mutation authority",
  )
  assert.equal(countMatches(source, /node scripts\/release\/cli\.mjs publish-release\b/gu), 1)
  assert.doesNotMatch(source, /gh\s+release\s+edit|target_commitish|"draft"\s*:\s*false/iu)
})

test("release.yml makes workflow abandonment unreachable", async () => {
  const { source, workflow } = await readRequiredWorkflow("release.yml")
  const schema = JSON.parse(await readBoundedFixture(CONTROLLER_SCHEMA_PATH, { root: ROOT }))
  assert.equal(schema.abandonmentEnvironment, "release-abandonment")
  const liveBytes = await readFile(path.join(WORKFLOWS, "release.yml"))
  const disabledBytes = await readFile(
    path.join(ROOT, "scripts/release/test/fixtures/release-workflow-disabled.yml"),
  )
  assert.deepEqual(liveBytes, disabledBytes)
  assert.equal(
    classifyReleaseWorkflowAbandonment(liveBytes, {
      abandonmentEnvironment: schema.abandonmentEnvironment,
    }),
    "disabled",
  )
  assert.equal(workflow.jobs.abandon, undefined)
  assert.equal(
    Object.values(workflow.jobs).some((job) => job.environment === schema.abandonmentEnvironment),
    false,
  )
  assert.equal(
    workflowExecutables(workflow).some(({ value }) =>
      /node scripts\/release\/cli\.mjs (?:abandonment-context|abandon)\b/u.test(value),
    ),
    false,
  )
  assert.doesNotMatch(source, /inputs\.reason|Validate manual intent|release-abandonment/u)
  assert.doesNotMatch(source, /abandonment must be dispatched|inputs\.operation == 'abandon'/u)
})

test("the independent workflow relays default-branch audits and verifies exact tags in isolated modes", async () => {
  const { source, workflow } = await readRequiredWorkflow("published-artifact-verify.yml")
  assert.deepEqual(Object.keys(workflow.on).sort(), ["schedule", "workflow_dispatch"])
  assert.deepEqual(Object.keys(workflow.on.workflow_dispatch.inputs).sort(), [
    "commitSha",
    "manifestSha256",
    "version",
  ])
  for (const input of Object.values(workflow.on.workflow_dispatch.inputs)) {
    assertDispatchIdentityInput(input)
  }
  assert.equal(hasWritePermission(workflow.permissions), false)

  const coordinator = requiredJob(workflow, "coordinate")
  assert.equal(coordinator.permissions?.actions, "write")
  assert.notEqual(coordinator.permissions?.contents, "write")
  assert.match(coordinator.if, /github\.event\.repository\.default_branch/u)
  const coordinatorCheckout = onlyStepUsing(coordinator, ACTIONS.checkout)
  assert.equal(
    coordinatorCheckout.with?.ref,
    workflowExpression("github.event.repository.default_branch"),
  )
  assert.equal(coordinatorCheckout.with?.["persist-credentials"], false)
  const relay = onlyRunStepMatching(
    coordinator,
    /node scripts\/release\/independent-audit-coordinator\.mjs\b/u,
  )
  assertCommandFlags(relay.run, "node scripts/release/independent-audit-coordinator.mjs", [
    "--github-output",
  ])
  assert.doesNotMatch(relay.run, /return_run_details|list.*runs|runs\/\?|poll|wait|sleep/iu)

  const draft = requiredJob(workflow, "verify-draft")
  assert.equal(draft.name, "verify")
  assert.deepEqual(normalizeNeeds(draft.needs), ["coordinate"])
  assert.equal(hasWritePermission(draft.permissions), false)
  assert.equal(draft.permissions?.checks, "read")
  assertExactIndependentTagGate(draft, "draft")
  const checkout = onlyStepUsing(draft, ACTIONS.checkout)
  assert.equal(checkout.with?.ref, workflowExpression("github.ref"))
  assert.equal(checkout.with?.["fetch-depth"], 0)
  assert.equal(checkout.with?.["persist-credentials"], false)
  const execute = onlyRunStepMatching(draft, /node scripts\/release\/independent-audit\.mjs\b/u)
  assertCommandFlags(execute.run, "node scripts/release/independent-audit.mjs", [
    "--version",
    "--commit-sha",
    "--manifest-sha256",
    "--result",
  ])
  const resultUploads = draft.steps.filter((step) => step.uses === ACTIONS.upload)
  assert.equal(resultUploads.length, 1)
  assert.equal(resultUploads[0].id, "result")
  assert.equal(resultUploads[0].if, workflowExpression("always()"))
  assert.equal(
    resultUploads[0].with?.name,
    `audit-result-${workflowExpression("github.run_id")}-${workflowExpression("github.run_attempt")}`,
  )
  assert.equal(resultUploads[0].with?.["if-no-files-found"], "error")

  const published = requiredJob(workflow, "verify-published")
  assert.deepEqual(normalizeNeeds(published.needs), ["coordinate"])
  assert.equal(hasWritePermission(published.permissions), false)
  assert.equal(published.permissions?.checks, "read")
  assertExactIndependentTagGate(published, "published")
  const publishedCheckout = onlyStepUsing(published, ACTIONS.checkout)
  assert.equal(publishedCheckout.with?.ref, workflowExpression("github.ref"))
  assert.equal(publishedCheckout.with?.["fetch-depth"], 0)
  const publishedExecute = onlyRunStepMatching(
    published,
    /node scripts\/release\/post-publication-audit\.mjs\b/u,
  )
  assertCommandFlags(publishedExecute.run, "node scripts/release/post-publication-audit.mjs", [
    "--version",
    "--commit-sha",
    "--manifest-sha256",
    "--result",
  ])
  const publishedUploads = published.steps.filter((step) => step.uses === ACTIONS.upload)
  assert.equal(publishedUploads.length, 1)
  assert.equal(publishedUploads[0].if, workflowExpression("always()"))
  assert.doesNotMatch(
    source,
    /runOpenAI|runPgvector|packageSet|return_run_details|list.*workflow.*runs/iu,
  )
  assert.doesNotMatch(source, /contents\s*:\s*write|gh\s+release|\/releases\/.+(?:PATCH|DELETE)/iu)
})

test("release.yml is the only trusted npm publisher and chart publication remains separate", async () => {
  const sources = await readWorkflowSourcesFromRoot(ROOT)
  const owners = []
  for (const [file, source] of Object.entries(sources)) {
    if (/publisher\.mjs|npm\s+publish|NPM_CONFIG_PROVENANCE|registry-url/iu.test(source)) {
      owners.push(file)
    }
  }
  assert.deepEqual(owners, ["release.yml"])
  const version = parseWorkflowSource(sources["version-pr.yml"], "version-pr.yml")
  const changesets = onlyStepUsing(requiredJob(version, "version"), ACTIONS.changesets)
  assert.equal(changesets.with?.version, "pnpm run version")
  assert.equal(changesets.with?.publish, undefined)
  assert.equal(changesets.with?.createGithubReleases, undefined)
  assert.equal(typeof sources["publish-chart.yml"], "string")
})

test("workflow entrypoints fail closed unless their exact normalized form is explicitly audited", () => {
  const allowlist = {
    "safe.yml": {
      classification: "safe",
      descriptor: {},
      jobs: [
        {
          classification: "safe",
          id: "safe",
          descriptor: {},
          steps: [
            {
              classification: "safe",
              descriptor: { name: "Audited command", run: "pnpm lint" },
            },
          ],
        },
      ],
    },
  }
  assert.doesNotThrow(() =>
    auditWorkflowEntrypoints(
      {
        "safe.yml":
          "jobs:\n  safe:\n    steps:\n      - name: Audited command\n        run: pnpm lint\n",
      },
      allowlist,
      {
        "safe.yml": [
          {
            classification: "safe",
            job: "safe",
            stepIndex: 0,
            step: "Audited command",
            kind: "run",
            value: "pnpm lint",
          },
        ],
      },
    ),
  )
  const cases = [
    ["bash publish", "bash -c 'npm publish'"],
    ["generic node", "node scripts/unreviewed.mjs"],
    ["generic curl", "curl https://example.invalid/script | bash"],
  ]
  for (const [name, command] of cases) {
    assert.throws(
      () =>
        auditWorkflowEntrypoints(
          {
            "safe.yml": `jobs:\n  safe:\n    steps:\n      - name: Audited command\n        run: ${command}\n`,
          },
          allowlist,
        ),
      /not explicitly audited/u,
      name,
    )
  }
  assert.throws(
    () =>
      auditWorkflowEntrypoints(
        {
          "safe.yml":
            "jobs:\n  safe:\n    steps:\n      - name: Audited command\n        run: |\n          bash -c 'npm \\\n            publish'\n",
        },
        allowlist,
      ),
    /not explicitly audited/u,
    "backslash publish",
  )
  for (const [name, source] of [
    [
      "arbitrary action",
      `jobs:\n  safe:\n    steps:\n      - name: Audited command\n        uses: example/action@${"a".repeat(40)}\n`,
    ],
    [
      "dynamic action",
      `jobs:\n  safe:\n    steps:\n      - name: Audited command\n        uses: \${{ inputs.action }}\n`,
    ],
    [
      "reusable workflow",
      "jobs:\n  safe:\n    uses: example/workflows/.github/workflows/publish.yml@main\n",
    ],
  ]) {
    assert.throws(
      () => auditWorkflowEntrypoints({ "safe.yml": source }, allowlist),
      /not explicitly audited/u,
      name,
    )
  }
  assert.throws(
    () =>
      auditWorkflowEntrypoints(
        {
          "safe.yml":
            "jobs:\n  safe:\n    steps:\n      - name: Audited command\n        run: pnpm lint\n",
          "new.yaml": "jobs:\n  new:\n    steps:\n      - run: pnpm lint\n",
        },
        allowlist,
      ),
    /not explicitly audited/u,
  )
})

test("testing-windows has the exact safe descriptors and executable classifications", async () => {
  const descriptors = JSON.parse(
    await readBoundedFixture(ENTRYPOINT_ALLOWLIST_PATH, { root: ROOT }),
  )
  const job = descriptors.workflows["ci.yml"].jobs.find(({ id }) => id === "testing-windows")
  assert.deepEqual(job, {
    classification: "safe",
    id: "testing-windows",
    descriptor: { "runs-on": "windows-latest", "timeout-minutes": 20 },
    steps: [
      {
        classification: "safe",
        descriptor: {
          name: "Checkout",
          uses: "actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1",
        },
      },
      {
        classification: "safe",
        descriptor: {
          name: "Setup pnpm",
          uses: "pnpm/action-setup@0ebf47130e4866e96fce0953f49152a61190b271",
          with: { version: "10.33.0" },
        },
      },
      {
        classification: "safe",
        descriptor: {
          name: "Setup Node.js",
          uses: "actions/setup-node@820762786026740c76f36085b0efc47a31fe5020",
          with: { "node-version": "24.17.0", cache: "pnpm" },
        },
      },
      {
        classification: "safe",
        descriptor: { name: "Install", run: "pnpm install --frozen-lockfile" },
      },
      {
        classification: "safe",
        descriptor: {
          name: "Build testing dependency closure",
          run: "pnpm --filter @dawn-ai/testing... build",
        },
      },
      {
        classification: "safe",
        descriptor: {
          name: "Native Windows subprocess shutdown tests",
          run: 'pnpm --filter @dawn-ai/testing exec vitest --run --config vitest.config.ts test/subprocess.test.ts --testNamePattern "Windows process tree|injected Windows tree kill"',
        },
      },
      {
        classification: "safe",
        descriptor: {
          name: "Dependency security regressions",
          run: "pnpm exec vitest --run --config test/security-dependencies/vitest.config.ts test/security-dependencies/dependency-resolution.test.ts test/security-dependencies/hono-serve-static-windows.test.ts",
        },
      },
    ],
  })
  assert.deepEqual(
    EXECUTABLE_ALLOWLIST.workflows["ci.yml"].filter(({ job }) => job === "testing-windows"),
    job.steps.map(({ descriptor }, stepIndex) => ({
      classification: "safe",
      job: "testing-windows",
      stepIndex,
      step: descriptor.name,
      kind: descriptor.run === undefined ? "step-uses" : "run",
      value: descriptor.run ?? descriptor.uses,
    })),
  )

  const sources = await readWorkflowSourcesFromRoot(ROOT)
  const mutated = sources["ci.yml"].replace(
    "pnpm --filter @dawn-ai/testing... build",
    "pnpm --filter @dawn-ai/testing... build && echo bypass",
  )
  assert.throws(
    () => auditWorkflowEntrypoints({ ...sources, "ci.yml": mutated }, descriptors.workflows),
    /not explicitly audited/u,
  )
})

test("dependency-security-browser has one exact isolated read-only descriptor", async () => {
  const descriptors = JSON.parse(
    await readBoundedFixture(ENTRYPOINT_ALLOWLIST_PATH, { root: ROOT }),
  )
  const job = descriptors.workflows["ci.yml"].jobs.find(
    ({ id }) => id === "dependency-security-browser",
  )
  assert.deepEqual(job, {
    classification: "safe",
    id: "dependency-security-browser",
    descriptor: {
      permissions: { contents: "read" },
      "runs-on": "ubuntu-latest",
      "timeout-minutes": 15,
    },
    steps: [
      {
        classification: "safe",
        descriptor: {
          name: "Checkout",
          uses: "actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1",
        },
      },
      {
        classification: "safe",
        descriptor: {
          name: "Setup pnpm",
          uses: "pnpm/action-setup@0ebf47130e4866e96fce0953f49152a61190b271",
          with: { version: "10.33.0" },
        },
      },
      {
        classification: "safe",
        descriptor: {
          name: "Setup Node.js",
          uses: "actions/setup-node@820762786026740c76f36085b0efc47a31fe5020",
          with: { "node-version": "24.17.0", cache: "pnpm" },
        },
      },
      {
        classification: "safe",
        descriptor: { name: "Install", run: "pnpm install --frozen-lockfile" },
      },
      {
        classification: "safe",
        descriptor: {
          name: "Install Chromium",
          run: "pnpm exec playwright install --with-deps chromium",
        },
      },
      {
        classification: "safe",
        descriptor: {
          name: "Dependency security browser regressions",
          run: "pnpm exec tsc -p test/security-dependencies/tsconfig.json --noEmit\npnpm exec playwright test --config test/security-dependencies/playwright.config.ts\n",
        },
      },
    ],
  })
  assert.deepEqual(
    EXECUTABLE_ALLOWLIST.workflows["ci.yml"].filter(
      ({ job: executableJob }) => executableJob === "dependency-security-browser",
    ),
    job.steps.map(({ descriptor }, stepIndex) => ({
      classification: "safe",
      job: "dependency-security-browser",
      stepIndex,
      step: descriptor.name,
      kind: descriptor.run === undefined ? "step-uses" : "run",
      value: descriptor.run ?? descriptor.uses,
    })),
  )
})

test("dependency security receipt uploader is exact, offline, read-only, and write-once", async () => {
  const source = await readBoundedFixture(path.join(WORKFLOWS, "dependency-security-receipt.yml"), {
    root: ROOT,
  })
  const workflow = parse(source, { maxAliasCount: 0, uniqueKeys: true })
  const expectedMainInput = workflowExpression("inputs.expectedMainSha")
  const expectedPrInput = workflowExpression("inputs.expectedPrNumber")
  const expectedReviewedBaseInput = workflowExpression("inputs.expectedReviewedBaseSha")
  const expectedReviewedHeadInput = workflowExpression("inputs.expectedReviewedHeadSha")
  const expectedMergeInput = workflowExpression("inputs.expectedMergeSha")
  const receiptGzipBase64Input = workflowExpression("inputs.receiptGzipBase64")
  const receiptSha256Input = workflowExpression("inputs.receiptSha256")
  const runnerTemp = workflowExpression("runner.temp")
  const githubToken = workflowExpression("github.token")

  assert.deepEqual(Object.keys(workflow).sort(), ["jobs", "name", "on", "run-name"])
  assert.equal(workflow.name, "Dependency Security Receipt")
  assert.equal(workflow["run-name"], `Dependency security receipt ${receiptSha256Input}`)
  assert.deepEqual(Object.keys(workflow.on), ["workflow_dispatch"])
  const inputs = workflow.on.workflow_dispatch.inputs
  assert.deepEqual(Object.keys(inputs), [
    "expectedMainSha",
    "expectedPrNumber",
    "expectedReviewedBaseSha",
    "expectedReviewedHeadSha",
    "expectedMergeSha",
    "receiptGzipBase64",
    "receiptSha256",
  ])
  for (const input of Object.values(inputs)) {
    assert.equal(input.required, true)
    assert.equal(input.type, "string")
    assert.deepEqual(Object.keys(input).sort(), ["description", "required", "type"])
  }

  assert.deepEqual(Object.keys(workflow.jobs), ["upload"])
  const job = workflow.jobs.upload
  assert.deepEqual(job.permissions, { contents: "read" })
  assert.equal(job["runs-on"], "ubuntu-latest")
  assert.equal(job["timeout-minutes"], 10)
  assert.equal(job.environment, undefined)
  assert.equal(job.secrets, undefined)
  assert.equal(job.env, undefined)
  assert.deepEqual(
    job.steps.map(({ name }) => name),
    [
      "Validate receipt correlation inputs",
      "Checkout exact observation",
      "Setup Node.js",
      "Require unchanged default branch head",
      "Prepare sealed receipt directory",
      "Seal canonical receipt",
      "Upload sealed receipt",
    ],
  )

  const [validate, checkout, setupNode, requireHead, prepare, seal, upload] = job.steps
  assert.match(validate.run, /\^\[0-9a-f\]\{40\}\$/u)
  assert.match(validate.run, /\^\[1-9\]\[0-9\]\{0,14\}\$/u)
  assert.match(validate.run, /\^\[0-9a-f\]\{64\}\$/u)
  assert.deepEqual(checkout, {
    name: "Checkout exact observation",
    uses: "actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1",
    with: {
      ref: expectedMainInput,
      "persist-credentials": false,
    },
  })
  assert.deepEqual(setupNode, {
    name: "Setup Node.js",
    uses: "actions/setup-node@820762786026740c76f36085b0efc47a31fe5020",
    with: { "node-version": "24.17.0" },
  })
  assert.deepEqual(requireHead.env, {
    EXPECTED_MAIN_SHA: expectedMainInput,
    GH_TOKEN: githubToken,
  })
  assert.match(requireHead.run, /GITHUB_SHA/u)
  assert.match(requireHead.run, /repos\/cacheplane\/dawnai\/git\/ref\/heads\/main/u)
  assert.deepEqual(prepare.env, {
    RECEIPT_OUTPUT_ROOT: `${runnerTemp}/dependency-security-receipt-root`,
  })
  assert.equal(prepare.run, 'install -d -m 0700 -- "$RECEIPT_OUTPUT_ROOT"')
  assert.deepEqual(seal.env, {
    EXPECTED_MAIN_SHA: expectedMainInput,
    EXPECTED_PR_NUMBER: expectedPrInput,
    EXPECTED_REVIEWED_BASE_SHA: expectedReviewedBaseInput,
    EXPECTED_REVIEWED_HEAD_SHA: expectedReviewedHeadInput,
    EXPECTED_MERGE_SHA: expectedMergeInput,
    RECEIPT_GZIP_BASE64: receiptGzipBase64Input,
    RECEIPT_SHA256: receiptSha256Input,
    RECEIPT_OUTPUT_ROOT: `${runnerTemp}/dependency-security-receipt-root`,
    RECEIPT_OUTPUT_DIRECTORY: `${runnerTemp}/dependency-security-receipt-root/sealed`,
  })
  assert.equal(
    seal.run,
    'node scripts/security/dependency-evidence.mjs seal-receipt \\\n  --expected-main-sha "$EXPECTED_MAIN_SHA" \\\n  --expected-pr-number "$EXPECTED_PR_NUMBER" \\\n  --expected-reviewed-base-sha "$EXPECTED_REVIEWED_BASE_SHA" \\\n  --expected-reviewed-head-sha "$EXPECTED_REVIEWED_HEAD_SHA" \\\n  --expected-merge-sha "$EXPECTED_MERGE_SHA" \\\n  --receipt-gzip-base64 "$RECEIPT_GZIP_BASE64" \\\n  --receipt-sha256 "$RECEIPT_SHA256" \\\n  --output-root "$RECEIPT_OUTPUT_ROOT" \\\n  --output-directory "$RECEIPT_OUTPUT_DIRECTORY"\n',
  )
  assert.deepEqual(upload, {
    name: "Upload sealed receipt",
    uses: "actions/upload-artifact@043fb46d1a93c77aae656e7c1c64a875d1fc6a0a",
    with: {
      name: `dependency-security-receipt-${expectedMainInput}-${receiptSha256Input}`,
      path: `${runnerTemp}/dependency-security-receipt-root/sealed/dependency-security-reconciliation.json\n${runnerTemp}/dependency-security-receipt-root/sealed/uploader-manifest.json\n`,
      "if-no-files-found": "error",
      "retention-days": 90,
    },
  })

  const actionSteps = job.steps.filter(({ uses }) => uses !== undefined)
  assert.deepEqual(
    actionSteps.map(({ uses }) => uses),
    [
      "actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1",
      "actions/setup-node@820762786026740c76f36085b0efc47a31fe5020",
      "actions/upload-artifact@043fb46d1a93c77aae656e7c1c64a875d1fc6a0a",
    ],
  )
  for (const step of job.steps) {
    assert.equal(step.env?.GH_TOKEN, step === requireHead ? githubToken : undefined)
  }
  const runs = job.steps
    .filter(({ run }) => run !== undefined)
    .map(({ run }) => run)
    .join("\n")
  assert.doesNotMatch(runs, /(?:npm|pnpm)\s+install/u)
  assert.doesNotMatch(source, /secrets\.|id-token\s*:\s*write|contents\s*:\s*write/iu)
})

test("dependency security workflow mutations fail closed", async (t) => {
  const descriptors = JSON.parse(
    await readBoundedFixture(ENTRYPOINT_ALLOWLIST_PATH, { root: ROOT }),
  )
  const sources = await readWorkflowSourcesFromRoot(ROOT)
  const mutateBrowser = (source, mutate) => {
    const start = source.indexOf("  dependency-security-browser:\n")
    const end = source.indexOf("\n  sandbox-docker:\n", start)
    assert.notEqual(start, -1)
    assert.notEqual(end, -1)
    return `${source.slice(0, start)}${mutate(source.slice(start, end))}${source.slice(end)}`
  }
  const cases = [
    [
      "browser permissions",
      "ci.yml",
      (source) => mutateBrowser(source, (job) => job.replace("contents: read", "contents: write")),
    ],
    [
      "browser path",
      "ci.yml",
      (source) =>
        mutateBrowser(source, (job) =>
          job.replace(
            "test/security-dependencies/playwright.config.ts",
            "test/security-dependencies/vitest.config.ts",
          ),
        ),
    ],
    [
      "browser shell operator",
      "ci.yml",
      (source) =>
        mutateBrowser(source, (job) =>
          job.replace(
            "pnpm exec playwright install --with-deps chromium",
            "pnpm exec playwright install --with-deps chromium && echo bypass",
          ),
        ),
    ],
    [
      "broadened Windows test command",
      "ci.yml",
      (source) =>
        source.replace(
          "test/security-dependencies/dependency-resolution.test.ts test/security-dependencies/hono-serve-static-windows.test.ts",
          "test/security-dependencies",
        ),
    ],
    [
      "browser install without frozen lockfile",
      "ci.yml",
      (source) =>
        mutateBrowser(source, (job) =>
          job.replace("pnpm install --frozen-lockfile", "pnpm install"),
        ),
    ],
    [
      "receipt trigger expansion",
      "dependency-security-receipt.yml",
      (source) =>
        source.replace(
          "  workflow_dispatch:\n",
          '  schedule:\n    - cron: "0 0 * * *"\n  workflow_dispatch:\n',
        ),
    ],
    [
      "receipt pull-request trigger",
      "dependency-security-receipt.yml",
      (source) =>
        source.replace("  workflow_dispatch:\n", "  pull_request:\n  workflow_dispatch:\n"),
    ],
    [
      "receipt input removal",
      "dependency-security-receipt.yml",
      (source) =>
        source.replace(
          "      receiptSha256:\n        description: SHA-256 of the canonical reconciliation receipt\n        required: true\n        type: string\n",
          "",
        ),
    ],
    [
      "receipt input expansion",
      "dependency-security-receipt.yml",
      (source) =>
        source.replace(
          "      expectedMainSha:\n",
          "      command:\n        description: Unsafe dynamic command\n        required: true\n        type: string\n      expectedMainSha:\n",
        ),
    ],
    [
      "receipt permission expansion",
      "dependency-security-receipt.yml",
      (source) => source.replace("      contents: read", "      contents: write"),
    ],
    [
      "receipt OIDC permission",
      "dependency-security-receipt.yml",
      (source) =>
        source.replace("      contents: read", "      contents: read\n      id-token: write"),
    ],
    [
      "receipt secret access",
      "dependency-security-receipt.yml",
      (source) =>
        source.replace(
          `          RECEIPT_SHA256: ${workflowExpression("inputs.receiptSha256")}\n        run:`,
          `          RECEIPT_SHA256: ${workflowExpression("inputs.receiptSha256")}\n          UNSAFE_SECRET: ${workflowExpression("secrets.UNSAFE")}\n        run:`,
        ),
    ],
    [
      "unpinned receipt action",
      "dependency-security-receipt.yml",
      (source) =>
        source.replace(
          "uses: actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1",
          "uses: actions/checkout@v7",
        ),
    ],
    [
      "dynamic receipt action",
      "dependency-security-receipt.yml",
      (source) =>
        source.replace(
          "uses: actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1",
          `uses: ${workflowExpression("inputs.action")}`,
        ),
    ],
    [
      "persisted checkout credentials",
      "dependency-security-receipt.yml",
      (source) =>
        source.replace(
          "          persist-credentials: false",
          "          persist-credentials: true",
        ),
    ],
    [
      "receipt dependency installation",
      "dependency-security-receipt.yml",
      (source) =>
        source.replace(
          "      - name: Setup Node.js\n",
          "      - name: Install dependencies\n        run: pnpm install --frozen-lockfile\n\n      - name: Setup Node.js\n",
        ),
    ],
    [
      "dynamic receipt command",
      "dependency-security-receipt.yml",
      (source) =>
        source.replace(
          "node scripts/security/dependency-evidence.mjs seal-receipt",
          `node "${workflowExpression("inputs.command")}" seal-receipt`,
        ),
    ],
    [
      "default branch head drift",
      "dependency-security-receipt.yml",
      (source) =>
        source.replace(
          "repos/cacheplane/dawnai/git/ref/heads/main",
          "repos/cacheplane/dawnai/git/ref/heads/reviewed-head",
        ),
    ],
    [
      "extra receipt archive file",
      "dependency-security-receipt.yml",
      (source) =>
        source.replace(
          `            ${workflowExpression("runner.temp")}/dependency-security-receipt-root/sealed/uploader-manifest.json\n`,
          `            ${workflowExpression("runner.temp")}/dependency-security-receipt-root/sealed/uploader-manifest.json\n            ${workflowExpression("runner.temp")}/dependency-security-receipt-root/sealed/extra.json\n`,
        ),
    ],
  ]
  for (const [name, file, mutate] of cases) {
    await t.test(name, () => {
      assert.throws(
        () =>
          auditWorkflowEntrypoints(
            { ...sources, [file]: mutate(sources[file]) },
            descriptors.workflows,
          ),
        /not explicitly audited/u,
      )
    })
  }
})

test("every workflow executable entrypoint matches the readable audited allowlist", async () => {
  const allowlist = JSON.parse(await readBoundedFixture(ENTRYPOINT_ALLOWLIST_PATH, { root: ROOT }))
  const sources = await readWorkflowSourcesFromRoot(ROOT)

  assert.deepEqual(Object.keys(allowlist).sort(), ["schemaVersion", "workflows"])
  assert.equal(allowlist.schemaVersion, 2)
  assert.doesNotThrow(() => auditWorkflowEntrypoints(sources, allowlist.workflows))
})

test("workflow audit binds complete execution descriptors and byte-exact run strings", async (t) => {
  const allowlist = JSON.parse(await readBoundedFixture(ENTRYPOINT_ALLOWLIST_PATH, { root: ROOT }))
  const sources = await readWorkflowSourcesFromRoot(ROOT)
  const cases = [
    [
      "workflow permissions",
      "dependency-security-receipt.yml",
      (source) => source.replace("contents: read", "contents: write"),
    ],
    [
      "job runner",
      "dependency-security-receipt.yml",
      (source) => source.replace("ubuntu-latest", "self-hosted"),
    ],
    [
      "checkout inputs",
      "dependency-security-receipt.yml",
      (source) => source.replace("persist-credentials: false", "persist-credentials: true"),
    ],
    [
      "action inputs",
      "dependency-security-receipt.yml",
      (source) => source.replace("node-version: 24.17.0", "node-version: 24.16.0"),
    ],
    [
      "action environment",
      "dependency-security-receipt.yml",
      (source) =>
        source.replace(
          "      - name: Setup Node.js\n",
          "      - name: Setup Node.js\n        env:\n          BASH_ENV: scripts/bypass.sh\n",
        ),
    ],
    [
      "action condition",
      "dependency-security-receipt.yml",
      (source) =>
        source.replace(
          "      - name: Setup Node.js\n",
          "      - name: Setup Node.js\n        if: always()\n",
        ),
    ],
    [
      "unknown step key",
      "dependency-security-receipt.yml",
      (source) =>
        source.replace(
          "      - name: Setup Node.js\n",
          "      - name: Setup Node.js\n        unexpected: true\n",
        ),
    ],
  ]
  for (const [name, file, mutate] of cases) {
    await t.test(name, () => {
      assert.throws(
        () =>
          auditWorkflowEntrypoints(
            { ...sources, [file]: mutate(sources[file]) },
            allowlist.workflows,
          ),
        /not explicitly audited/u,
      )
    })
  }

  const backslash = "\\"
  const line = `DAWN_TEST_WORKERD=1 pnpm --filter @dawn-ai/cli test workerd-lane ${backslash}\n`
  assert.ok(sources["ci.yml"].includes(line))
  assert.throws(
    () =>
      auditWorkflowEntrypoints(
        {
          ...sources,
          "ci.yml": sources["ci.yml"].replace(
            line,
            line.replace(`${backslash}\n`, `${backslash}  \n`),
          ),
        },
        allowlist.workflows,
      ),
    /not explicitly audited/u,
  )
})

test("workflow classifications are explicit safe or release-only publication", async () => {
  const allowlist = JSON.parse(await readBoundedFixture(ENTRYPOINT_ALLOWLIST_PATH, { root: ROOT }))

  assert.doesNotMatch(JSON.stringify(allowlist), /"audited"/u)
  assert.deepEqual(Object.keys(EXECUTABLE_ALLOWLIST).sort(), ["schemaVersion", "workflows"])
  assert.equal(EXECUTABLE_ALLOWLIST.schemaVersion, 1)
  assert.doesNotMatch(JSON.stringify(EXECUTABLE_ALLOWLIST), /"audited"/u)
  const publication = Object.entries(EXECUTABLE_ALLOWLIST.workflows).flatMap(([file, entries]) =>
    entries
      .filter(({ classification }) => classification === "publication")
      .map((entry) => ({ file, ...entry })),
  )
  assert.ok(publication.length > 0, "the final release workflow must retain explicit mutations")
  assert.ok(publication.every(({ file }) => file === "release.yml"))
  assert.ok(publication.some(({ value }) => /publisher\.mjs/u.test(value)))
  assert.equal(
    publication.some(({ value }) =>
      /release-publish|backfill-release-tags|upload-release-assets/iu.test(value),
    ),
    false,
  )
})

test("matching descriptor inventory cannot classify a new executable as safe", () => {
  const cases = [
    ["npm publish", "jobs:\n  new:\n    steps:\n      - run: npm publish\n"],
    ["bash wrapper", "jobs:\n  new:\n    steps:\n      - run: bash -c 'npm publish'\n"],
    [
      "publishing action",
      `jobs:\n  new:\n    steps:\n      - uses: example/publish@${"a".repeat(40)}\n`,
    ],
    [
      "local release reusable workflow",
      "jobs:\n  new:\n    uses: ./.github/workflows/release.yml\n",
    ],
  ]
  for (const [name, source] of cases) {
    const workflow = parse(source)
    const classifications = new Map(
      workflowExecutables(workflow).map((entry) => [executableIdentity(entry), "safe"]),
    )
    const inventory = {
      "new.yaml": workflowDescriptor(workflow, classifications),
    }
    const executables = {
      "new.yaml": workflowExecutables(workflow).map((entry) => ({
        classification: "safe",
        ...entry,
      })),
    }
    assert.throws(
      () => auditWorkflowEntrypoints({ "new.yaml": source }, inventory, executables),
      /not explicitly audited/u,
      name,
    )
  }
})

test("workflow parsing rejects duplicate keys, aliases, accessors, sparse data, and unknown fields", () => {
  const descriptor = {
    "safe.yml": {
      classification: "safe",
      descriptor: {},
      jobs: [
        {
          classification: "safe",
          id: "safe",
          descriptor: {},
          steps: [
            {
              classification: "safe",
              descriptor: { name: "Safe", run: "pnpm lint" },
            },
          ],
        },
      ],
    },
  }
  for (const source of [
    "jobs:\n  safe:\n    steps:\n      - name: Safe\n        run: pnpm lint\n        run: pnpm test\n",
    "shared: &shared\n  run: pnpm lint\njobs:\n  safe:\n    steps:\n      - name: Safe\n        <<: *shared\n",
    "unexpected: true\njobs:\n  safe:\n    steps:\n      - name: Safe\n        run: pnpm lint\n",
    "jobs:\n  safe:\n    unexpected: true\n    steps:\n      - name: Safe\n        run: pnpm lint\n",
  ]) {
    assert.throws(() => auditWorkflowEntrypoints({ "safe.yml": source }, descriptor))
  }

  const accessorSources = {}
  Object.defineProperty(accessorSources, "safe.yml", {
    enumerable: true,
    get() {
      return "jobs: {}\n"
    },
  })
  assert.throws(() => auditWorkflowEntrypoints(accessorSources, descriptor))

  const sparse = structuredClone(descriptor)
  sparse["safe.yml"].jobs.length = 2
  assert.throws(() => auditWorkflowEntrypoints({ "safe.yml": "jobs: {}\n" }, sparse))
  assert.equal(Object.getPrototypeOf({}), Object.prototype)
})

test("workflow reads are bounded, contained, regular, and no-follow", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "dawn-workflow-read-"))
  const outside = await mkdtemp(path.join(os.tmpdir(), "dawn-workflow-outside-"))
  t.after(() =>
    Promise.all([
      rm(root, { recursive: true, force: true }),
      rm(outside, { recursive: true, force: true }),
    ]),
  )
  const workflows = path.join(root, ".github", "workflows")
  await mkdir(workflows, { recursive: true })
  await writeFile(path.join(outside, "outside.yml"), "jobs: {}\n")
  await symlink(path.join(outside, "outside.yml"), path.join(workflows, "unsafe.yml"))
  await assert.rejects(() => readWorkflowSourcesFromRoot(root), /fixture file/u)

  await rm(path.join(workflows, "unsafe.yml"))
  await mkdir(path.join(workflows, "directory.yaml"))
  await assert.rejects(() => readWorkflowSourcesFromRoot(root), /fixture file/u)

  await rm(path.join(workflows, "directory.yaml"), { recursive: true })
  await writeFile(path.join(workflows, "oversize.yml"), "x".repeat(1024 * 1024 + 1))
  await assert.rejects(() => readWorkflowSourcesFromRoot(root), /fixture file/u)
})

test("workflow directory traversal is anchored at regular repository components", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "dawn-workflow-root-"))
  const outside = await mkdtemp(path.join(os.tmpdir(), "dawn-workflow-external-"))
  t.after(() =>
    Promise.all([
      rm(root, { recursive: true, force: true }),
      rm(outside, { recursive: true, force: true }),
    ]),
  )
  await mkdir(path.join(outside, "workflows"))
  await writeFile(path.join(outside, "workflows", "safe.yml"), "jobs: {}\n")

  await symlink(outside, path.join(root, ".github"))
  await assert.rejects(() => readWorkflowSourcesFromRoot(root), /workflow directory/u)

  await rm(path.join(root, ".github"))
  await writeFile(path.join(root, ".github"), "not a directory\n")
  await assert.rejects(() => readWorkflowSourcesFromRoot(root), /workflow directory/u)

  await rm(path.join(root, ".github"))
  await mkdir(path.join(root, ".github"))
  await symlink(path.join(outside, "workflows"), path.join(root, ".github", "workflows"))
  await assert.rejects(() => readWorkflowSourcesFromRoot(root), /workflow directory/u)

  await rm(path.join(root, ".github", "workflows"))
  await mkdir(path.join(root, ".github", "workflows"))
  await writeFile(path.join(root, ".github", "workflows", "safe.yml"), "jobs: {}\n")
  assert.deepEqual(Object.keys(await readWorkflowSourcesFromRoot(root)), ["safe.yml"])
})

test("all scripts reachable from final release ownership match audited content pins", async () => {
  const pins = JSON.parse(await readBoundedFixture(SCRIPT_PIN_PATH, { root: ROOT }))
  const sources = await readFinalWorkflowSources()
  const packageJson = JSON.parse(
    await readBoundedFixture(path.join(ROOT, "package.json"), { root: ROOT }),
  )
  const coverage = releaseWorkflowScriptReferences(sources, packageJson)

  assert.deepEqual(Object.keys(pins).sort(), ["schemaVersion", "scripts"])
  assert.equal(pins.schemaVersion, 1)
  assert.deepEqual(coverage.unfollowable, [])
  assert.deepEqual(Object.keys(pins.scripts).sort(), coverage.referenced)
  await assertPinnedScriptContents(ROOT, pins, coverage.referenced)
})

test("final release reachability fails closed on hidden scripts and package indirection", async (t) => {
  const packageJson = {
    scripts: { version: "changeset version && node scripts/sync.mjs" },
  }
  const step = (body) =>
    `on:\n  workflow_dispatch: {}\njobs:\n  release:\n    steps:\n      - name: Publish\n${body}`
  const cases = [
    ["run step", step("        run: node scripts/evil.mjs\n"), /scripts\/evil\.mjs/u],
    [
      "action input literal",
      step(
        "        uses: example/action@x\n        with:\n          publish: node scripts/evil.mjs\n",
      ),
      /scripts\/evil\.mjs/u,
    ],
    [
      "action input pnpm indirection",
      step("        uses: example/action@x\n        with:\n          version: pnpm run version\n"),
      /scripts\/sync\.mjs/u,
    ],
    [
      "unaudited run indirection",
      step("        run: pnpm sneak\n"),
      /cannot follow to a repository script/u,
    ],
  ]
  for (const [name, source, pattern] of cases) {
    await t.test(name, () => {
      assert.throws(
        () => assertReleaseScriptCoverage({ "release.yml": source }, packageJson, []),
        pattern,
        name,
      )
    })
  }

  await t.test("action input naming no package.json script", () => {
    assert.throws(
      () =>
        assertReleaseScriptCoverage(
          {
            "release.yml": step(
              "        uses: example/action@x\n        with:\n          publish: pnpm ghost\n",
            ),
          },
          packageJson,
          [],
        ),
      /cannot follow to a repository script/u,
    )
  })

  await t.test("a stale pin whose step disappeared", () => {
    assert.throws(
      () =>
        assertReleaseScriptCoverage(
          { "release.yml": step("        run: node scripts/visible.mjs\n") },
          packageJson,
          ["scripts/stale.mjs", "scripts/visible.mjs"],
        ),
      /pinned but no final owner workflow reaches/u,
    )
  })
})

test("script content pins fail closed on drift and on a pinned script that went missing", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "dawn-script-pins-"))
  t.after(() => rm(root, { recursive: true, force: true }))
  await mkdir(path.join(root, "scripts", "release"), { recursive: true })
  const file = "scripts/release/example.mjs"
  const body = "export {}\n"
  const pins = {
    schemaVersion: 1,
    scripts: {
      [file]: { sha256: createHash("sha256").update(body).digest("hex") },
    },
  }
  await writeFile(path.join(root, file), body)
  await assertPinnedScriptContents(root, pins, [file])

  await writeFile(path.join(root, file), `${body}// appended\n`)
  await assert.rejects(
    () => assertPinnedScriptContents(root, pins, [file]),
    (error) =>
      error.message.includes(file) &&
      error.message.includes(pins.scripts[file].sha256) &&
      error.message.includes(SCRIPT_PIN_FIXTURE),
    "drift must report the file, both hashes, and the fixture to update",
  )

  await rm(path.join(root, file))
  await assert.rejects(
    () => assertPinnedScriptContents(root, pins, [file]),
    (error) => error.message.includes(file) && /missing|not a regular file/u.test(error.message),
    "a pinned script that disappeared must fail rather than silently pass",
  )

  await symlink(path.join(root, "scripts"), path.join(root, file))
  await assert.rejects(() => assertPinnedScriptContents(root, pins, [file]))
})

test("root scripts retain the controller surfaces without legacy publication commands", async () => {
  const packageJson = JSON.parse(await readFile(path.join(ROOT, "package.json"), "utf8"))

  assert.equal(packageJson.scripts["release:preflight"], "node scripts/release/preflight.mjs")
  assert.equal(
    packageJson.scripts["test:release-controller"],
    "node --test scripts/published-artifacts.test.mjs scripts/release/test/*.test.mjs",
  )
  for (const command of LEGACY_PACKAGE_COMMANDS)
    assert.equal(packageJson.scripts[command], undefined)
})

async function readRequiredWorkflow(file) {
  let source
  try {
    source = await readBoundedFixture(path.join(WORKFLOWS, file), {
      root: ROOT,
      maxBytes: 1024 * 1024,
    })
  } catch (error) {
    assert.fail(`${file} must exist as a bounded regular workflow file: ${error.message}`)
  }
  return { source, workflow: parseWorkflowSource(source, file) }
}

async function readFinalWorkflowSources() {
  const sources = Object.create(null)
  for (const file of FINAL_WORKFLOW_FILES) {
    const { source } = await readRequiredWorkflow(file)
    sources[file] = source
  }
  return sources
}

function parseWorkflowSource(source, file) {
  let workflow
  try {
    workflow = parse(source, { maxAliasCount: 0, uniqueKeys: true })
  } catch (error) {
    assert.fail(`${file} must be valid unique-key YAML: ${error.message}`)
  }
  assert.ok(isRecord(workflow), `${file} must parse to a workflow object`)
  assert.ok(isRecord(workflow.on), `${file} must declare parsed triggers`)
  assert.ok(isRecord(workflow.jobs), `${file} must declare parsed jobs`)
  return workflow
}

function requiredJob(workflow, id) {
  const job = workflow.jobs?.[id]
  assert.ok(isRecord(job), `workflow must define job ${id}`)
  assert.ok(Array.isArray(job.steps), `${id} must define concrete steps`)
  return job
}

function onlyStepUsing(job, uses) {
  const matches = job.steps.filter((step) => step.uses === uses)
  assert.equal(matches.length, 1, `job must use ${uses} exactly once`)
  return matches[0]
}

function onlyRunStepMatching(job, pattern) {
  const matches = job.steps.filter((step) => typeof step.run === "string" && pattern.test(step.run))
  assert.equal(matches.length, 1, `job must have exactly one run step matching ${pattern}`)
  return matches[0]
}

function runSource(job) {
  return job.steps
    .filter((step) => typeof step.run === "string")
    .map((step) => step.run)
    .join("\n")
}

function workflowArtifactBasenames(value) {
  assert.equal(typeof value, "string", "artifact upload path must be explicit")
  const entries = value
    .split(/\r?\n/u)
    .map((entry) => entry.trim())
    .filter(Boolean)
  assert.equal(entries.length, 1, "small handoff must contain exactly one release record")
  const globCharacters = ["*", "?", "!", "[", "]", "{", "}"]
  assert.ok(
    entries.every((entry) => globCharacters.every((character) => !entry.includes(character))),
    "handoff paths must not glob",
  )
  return entries.map((entry) => path.posix.basename(entry)).sort()
}

function assertPinnedToolchain(job) {
  const nodeSteps = job.steps.filter((step) => step.uses === ACTIONS.node)
  assert.equal(nodeSteps.length, 1, "Node jobs must have one pinned setup-node step")
  assert.equal(nodeSteps[0].with?.["node-version"], "24.19.0")
  for (const step of job.steps.filter((entry) => entry.uses === ACTIONS.pnpm)) {
    assert.equal(step.with?.version, "10.33.0")
  }
  const runs = runSource(job)
  if (
    /publisher\.mjs|independent-audit\.mjs|published-artifact-verify\.mjs|release\/smoke\//u.test(
      runs,
    )
  ) {
    assert.match(runs, /npm\s+--version/u)
    assert.match(runs, /11\.17\.0/u)
  }
}

function dispatchInputContract(input) {
  assert.ok(isRecord(input))
  return Object.fromEntries(
    ["default", "options", "required", "type"]
      .filter((key) => Object.hasOwn(input, key))
      .map((key) => [key, input[key]]),
  )
}

function assertDispatchIdentityInput(input) {
  assert.deepEqual(dispatchInputContract(input), {
    required: true,
    type: "string",
  })
}

function assertReadOrWritePermissions(actual, expected) {
  assert.deepEqual(actual, expected)
  for (const [permission, value] of Object.entries(actual)) {
    assert.ok(["read", "write"].includes(value), `${permission} has invalid permission ${value}`)
  }
}

function hasWritePermission(permissions) {
  return isRecord(permissions) && Object.values(permissions).some((value) => value === "write")
}

function assertNoWriteOrOidc(job) {
  assert.ok(isRecord(job.permissions), "read-only jobs must declare explicit permissions")
  assert.equal(hasWritePermission(job.permissions), false)
  assert.notEqual(job.permissions["id-token"], "write")
}

function normalizeNeeds(needs) {
  if (needs === undefined) return []
  const values = Array.isArray(needs) ? needs : [needs]
  assert.ok(values.every((value) => typeof value === "string"))
  assert.equal(new Set(values).size, values.length, "job needs must not contain duplicates")
  return [...values].sort()
}

function commandLine(run, command) {
  const lines = run.split(/\r?\n/u)
  const start = lines.findIndex((line) => line.includes(command))
  assert.notEqual(start, -1, `run step must invoke ${command}`)
  const selected = []
  for (let index = start; index < lines.length; index += 1) {
    const line = lines[index].trim()
    selected.push(line.replace(/\\$/u, "").trim())
    if (!line.endsWith("\\")) break
  }
  return selected.join(" ").replace(/\s+/gu, " ").trim()
}

function assertCommandFlags(run, command, expectedFlags) {
  const line = commandLine(run, command)
  const actualFlags = [...line.matchAll(/(?:^|\s)(--[a-z][a-z0-9-]*)\b/gu)].map(([, flag]) => flag)
  assert.deepEqual(actualFlags, expectedFlags, `${command} flags must be exact and ordered`)
}

function assertCommandHasFlag(run, flag) {
  assert.match(run, new RegExp(`(?:^|\\s)${escapeRegExp(flag)}(?:\\s|$)`, "u"))
  assert.equal(countMatches(run, new RegExp(escapeRegExp(flag), "gu")), 1)
}

function assertExactTagAndOperationGate(job, { operation }) {
  assert.equal(typeof job.if, "string", "exact-tag jobs must declare a job condition")
  assert.match(job.if, /needs\.tag\.outputs\.continue == 'true'/u)
  assert.match(
    job.if,
    /github\.ref == format\('refs\/tags\/v\{0\}', (?:inputs\.version|needs\.detect\.outputs\.candidate_version)\)/u,
  )
  assert.match(job.if, /github\.sha == needs\.detect\.outputs\.candidate_sha/u)
  assert.match(job.if, /inputs\.version == needs\.detect\.outputs\.candidate_version/u)
  assert.match(job.if, /inputs\.commitSha == needs\.detect\.outputs\.candidate_sha/u)
  assert.match(job.if, new RegExp(`inputs\\.operation == '${operation}'`, "u"))
  if (operation === "abandon") assert.match(job.if, /github\.event_name == 'workflow_dispatch'/u)
}

function assertExactIndependentTagGate(job, mode) {
  assert.equal(typeof job.if, "string")
  assert.match(job.if, /github\.event_name == 'workflow_dispatch'/u)
  assert.match(job.if, new RegExp(`needs\\.coordinate\\.outputs\\.mode == '${mode}'`, "u"))
  assert.match(job.if, /github\.ref == format\('refs\/tags\/v\{0\}', inputs\.version\)/u)
  assert.match(job.if, /github\.sha == inputs\.commitSha/u)
}

function transitiveNeeds(workflow, start) {
  const found = new Set()
  const visit = (id) => {
    for (const dependency of normalizeNeeds(requiredJob(workflow, id).needs)) {
      if (found.has(dependency)) continue
      found.add(dependency)
      visit(dependency)
    }
  }
  visit(start)
  return found
}

function countMatches(source, pattern) {
  return source.match(pattern)?.length ?? 0
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&")
}

async function readWorkflowSourcesFromRoot(root) {
  const resolvedRoot = path.resolve(root)
  const githubDirectory = path.join(resolvedRoot, ".github")
  const directory = path.join(githubDirectory, "workflows")
  try {
    const canonicalRoot = await realpath(resolvedRoot)
    for (const component of [githubDirectory, directory]) {
      const status = await lstat(component)
      if (!status.isDirectory() || status.isSymbolicLink()) throw new TypeError("unsafe")
      const canonicalComponent = await realpath(component)
      const relative = path.relative(canonicalRoot, canonicalComponent)
      if (relative.startsWith("..") || path.isAbsolute(relative)) throw new TypeError("unsafe")
    }
  } catch {
    throw new TypeError("Invalid workflow directory")
  }
  const sources = Object.create(null)
  for (const file of (await readdir(directory)).filter((name) => /\.ya?ml$/u.test(name)).sort()) {
    Object.defineProperty(sources, file, {
      configurable: false,
      enumerable: true,
      writable: false,
      value: await readBoundedFixture(path.join(directory, file), {
        root: resolvedRoot,
        maxBytes: 1024 * 1024,
      }),
    })
  }
  return sources
}

// Collects every repository script reachable from the three final owner workflows.
// Literal paths are recorded directly. A pnpm package-script indirection is followed
// exactly once and rejected when it cannot be resolved without executing code.
function releaseWorkflowScriptReferences(sources, packageJson) {
  const referenced = new Set()
  const unfollowable = []
  for (const [file, source] of Object.entries(sources)) {
    const workflow = parseWorkflowSource(source, file)
    for (const [job, descriptor] of Object.entries(workflow.jobs)) {
      for (const [stepIndex, step] of (descriptor.steps ?? []).entries()) {
        const where = `${file} ${job} step ${stepIndex}${step.name ? ` ("${step.name}")` : ""}`
        const scan = (value, key) => {
          for (const script of matchAllGroups(value, SCRIPT_REFERENCE)) referenced.add(script)
          for (const name of matchAllGroups(value, PNPM_REFERENCE)) {
            const command = packageJson.scripts?.[name]
            if (typeof command !== "string") {
              unfollowable.push(
                key === null
                  ? `${where} runs \`pnpm ${name}\``
                  : `${where} passes \`${key}: ${value}\`, and \`${name}\` is not a package.json script`,
              )
              continue
            }
            const scripts = matchAllGroups(command, SCRIPT_REFERENCE)
            for (const script of scripts) referenced.add(script)
            if (scripts.length === 0 || matchAllGroups(command, PNPM_REFERENCE).length > 0) {
              unfollowable.push(
                `${where} reaches \`pnpm ${name}\`, which resolves to \`${command}\``,
              )
            }
          }
        }
        if (typeof step.run === "string") scan(step.run, null)
        for (const [key, value] of Object.entries(step.with ?? {})) {
          if (typeof value === "string") scan(value, key)
        }
      }
    }
  }
  return { referenced: [...referenced].sort(), unfollowable }
}

function assertReleaseScriptCoverage(sources, packageJson, pinned) {
  const { referenced, unfollowable } = releaseWorkflowScriptReferences(sources, packageJson)
  if (unfollowable.length > 0) {
    throw new Error(
      [
        `Release workflow reaches a command this check cannot follow to a repository script:`,
        ...unfollowable.map((entry) => `  ${entry}`),
        "An unfollowable command could run an unpinned script; invoke the reviewed script directly.",
      ].join("\n"),
    )
  }
  for (const file of referenced) {
    if (pinned.includes(file)) continue
    throw new Error(
      [
        `Release workflow reaches a repository script with no content pin: ${file}`,
        "A final release owner runs it directly or through package.json, so its bytes must be pinned with the command line.",
        `Add its sha256 to ${SCRIPT_PIN_FIXTURE}. Compute the hash with:`,
        `  node -p "require('node:crypto').createHash('sha256').update(require('node:fs').readFileSync('${file}')).digest('hex')"`,
      ].join("\n"),
    )
  }
  for (const file of pinned) {
    if (referenced.includes(file)) continue
    throw new Error(
      [
        `Release script pin is stale: ${file} is pinned but no final owner workflow reaches it.`,
        `Either restore the reviewed entrypoint or remove its entry from ${SCRIPT_PIN_FIXTURE}.`,
      ].join("\n"),
    )
  }
}

function matchAllGroups(value, pattern) {
  return [...value.matchAll(pattern)].map(([, group]) => group)
}

async function assertPinnedScriptContents(root, pins, files) {
  for (const file of files) {
    const expected = pins.scripts?.[file]?.sha256
    if (typeof expected !== "string" || !SHA256_HEX.test(expected)) {
      throw new Error(
        `Release script pin for ${file} is missing or is not a 64-character lowercase sha256 in ${SCRIPT_PIN_FIXTURE}.`,
      )
    }
    let source
    try {
      source = await readBoundedFixture(path.join(root, file), {
        root,
        maxBytes: 1024 * 1024,
      })
    } catch {
      throw new Error(
        [
          `Release script ${file} is pinned in ${SCRIPT_PIN_FIXTURE} but is missing or not a regular file inside the repository.`,
          `A pinned script must exist. If it was intentionally removed, delete its entry from ${SCRIPT_PIN_FIXTURE} and its final workflow entrypoint together.`,
        ].join("\n"),
      )
    }
    const actual = createHash("sha256").update(Buffer.from(source, "utf8")).digest("hex")
    if (actual !== expected) {
      throw new Error(
        [
          `Release script content pin mismatch: ${file}`,
          `  expected sha256: ${expected}`,
          `  actual   sha256: ${actual}`,
          `This script runs during a release, so its bytes are pinned alongside the command line in the workflow entrypoint allowlist.`,
          `If you meant to change it, update the "sha256" for ${file} in ${SCRIPT_PIN_FIXTURE} in the same commit, and have the script diff reviewed as a release-integrity change. Recompute with:`,
          `  node -p "require('node:crypto').createHash('sha256').update(require('node:fs').readFileSync('${file}')).digest('hex')"`,
        ].join("\n"),
      )
    }
  }
}

function auditWorkflowEntrypoints(
  sources,
  allowlist,
  executableAllowlist = EXECUTABLE_ALLOWLIST.workflows,
) {
  const sourceSnapshot = snapshotDescriptor(sources)
  const allowlistSnapshot = snapshotDescriptor(allowlist)
  const executableSnapshot = snapshotDescriptor(executableAllowlist)
  if (!isRecord(sourceSnapshot) || !isRecord(allowlistSnapshot) || !isRecord(executableSnapshot))
    throw unauditedEntrypoint()
  const files = Object.keys(sourceSnapshot).sort()
  const allowedFiles = Object.keys(allowlistSnapshot).sort()
  const executableFiles = Object.keys(executableSnapshot).sort()
  if (!sameStrings(files, allowedFiles) || !sameStrings(files, executableFiles))
    throw unauditedEntrypoint()
  for (const file of files) {
    let workflow
    try {
      if (typeof sourceSnapshot[file] !== "string") throw new TypeError("invalid source")
      workflow = parse(sourceSnapshot[file], {
        maxAliasCount: 0,
        uniqueKeys: true,
      })
    } catch {
      throw unauditedEntrypoint()
    }
    const classifications = classifyExecutables(
      file,
      workflowExecutables(workflow),
      executableSnapshot[file],
    )
    const actual = workflowDescriptor(workflow, classifications)
    const expected = allowlistSnapshot[file]
    if (canonicalJson(actual) !== canonicalJson(expected)) throw unauditedEntrypoint()
  }
}

function workflowExecutables(workflow) {
  if (!isRecord(workflow?.jobs)) throw unauditedEntrypoint()
  const entries = []
  for (const [job, descriptor] of Object.entries(workflow.jobs)) {
    if (!isRecord(descriptor)) throw unauditedEntrypoint()
    if (descriptor.uses !== undefined) {
      if (typeof descriptor.uses !== "string") throw unauditedEntrypoint()
      entries.push({
        job,
        stepIndex: null,
        step: null,
        kind: "job-uses",
        value: descriptor.uses,
      })
    }
    if (descriptor.steps !== undefined && !Array.isArray(descriptor.steps))
      throw unauditedEntrypoint()
    for (const [stepIndex, step] of (descriptor.steps ?? []).entries()) {
      if (!isRecord(step)) throw unauditedEntrypoint()
      const hasRun = typeof step.run === "string"
      const hasUses = typeof step.uses === "string"
      if (hasRun === hasUses) throw unauditedEntrypoint()
      entries.push({
        job,
        stepIndex,
        step: typeof step.name === "string" ? step.name : null,
        kind: hasRun ? "run" : "step-uses",
        value: hasRun ? step.run : step.uses,
      })
    }
  }
  return entries
}

function classifyExecutables(file, actual, expected) {
  if (!Array.isArray(expected) || actual.length !== expected.length) throw unauditedEntrypoint()
  const classifications = new Map()
  for (let index = 0; index < actual.length; index += 1) {
    const allowed = expected[index]
    if (!isRecord(allowed) || !["safe", "publication"].includes(allowed.classification))
      throw unauditedEntrypoint()
    const identity = {
      job: allowed.job,
      stepIndex: allowed.stepIndex,
      step: allowed.step,
      kind: allowed.kind,
      value: allowed.value,
    }
    if (canonicalJson(actual[index]) !== canonicalJson(identity)) throw unauditedEntrypoint()
    const publication = isReleaseMutationExecutable(file, actual[index])
    if (allowed.classification === "publication") {
      if (file !== "release.yml" || !publication) throw unauditedEntrypoint()
    } else if (publication) throw unauditedEntrypoint()
    classifications.set(executableIdentity(actual[index]), allowed.classification)
  }
  return classifications
}

function isReleaseMutationExecutable(file, entry) {
  const value = entry.value
  if (entry.kind === "job-uses") {
    return /\.github\/workflows\/release\.yml(?:@|$)/u.test(value)
  }
  if (entry.kind === "step-uses") {
    if (/\/[^@]*(?:publish|release|attest)[^@]*@/iu.test(value)) {
      return file !== "version-pr.yml" || value !== ACTIONS.changesets
    }
    return file === "release.yml" && (value === ACTIONS.attest || value === ACTIONS.changesets)
  }
  if (
    /(?:\bnpm\s+publish\b|scripts\/release\/publisher\.mjs\b|scripts\/(?:release-publish|backfill-release-tags|upload-release-assets)\.mjs\b)/iu.test(
      value,
    )
  ) {
    return true
  }
  return (
    file === "release.yml" &&
    /(?:scripts\/release\/cli\.mjs\s+(?:tag|escrow|reconcile-npm|reconcile-smokes|dispatch-audit|record-audit-dispatch|correlate-audit|publish-release|abandon)\b|2026-03-10[\s\S]*workflow_dispatch)/iu.test(
      value,
    )
  )
}

function executableIdentity(entry) {
  return canonicalJson({
    job: entry.job,
    stepIndex: entry.stepIndex,
    kind: entry.kind,
    value: entry.value,
  })
}

const WORKFLOW_KEYS = new Set([
  "concurrency",
  "defaults",
  "env",
  "jobs",
  "name",
  "on",
  "permissions",
  "run-name",
])
const JOB_KEYS = new Set([
  "concurrency",
  "container",
  "continue-on-error",
  "defaults",
  "env",
  "environment",
  "if",
  "name",
  "needs",
  "outputs",
  "permissions",
  "runs-on",
  "secrets",
  "services",
  "steps",
  "strategy",
  "timeout-minutes",
  "uses",
  "with",
])
const STEP_KEYS = new Set([
  "continue-on-error",
  "env",
  "id",
  "if",
  "name",
  "run",
  "shell",
  "timeout-minutes",
  "uses",
  "with",
  "working-directory",
])

function workflowDescriptor(workflow, classifications) {
  assertAllowedRecord(workflow, WORKFLOW_KEYS)
  if (!isRecord(workflow.jobs)) throw unauditedEntrypoint()
  const descriptor = omitField(workflow, "jobs")
  const jobs = Object.entries(workflow.jobs)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([id, job]) => {
      assertAllowedRecord(job, JOB_KEYS)
      const hasSteps = Array.isArray(job.steps)
      const hasUses = typeof job.uses === "string"
      if (hasSteps === hasUses) throw unauditedEntrypoint()
      const steps = hasSteps
        ? job.steps.map((step, stepIndex) => {
            assertAllowedRecord(step, STEP_KEYS)
            const hasRun = typeof step.run === "string"
            const hasStepUses = typeof step.uses === "string"
            if (hasRun === hasStepUses) throw unauditedEntrypoint()
            const executable = {
              job: id,
              stepIndex,
              kind: hasRun ? "run" : "step-uses",
              value: hasRun ? step.run : step.uses,
            }
            const classification = classifications.get(executableIdentity(executable))
            if (!["safe", "publication"].includes(classification)) throw unauditedEntrypoint()
            return {
              classification,
              descriptor: snapshotDescriptor(step),
            }
          })
        : []
      return {
        classification: "safe",
        id,
        descriptor: omitField(job, "steps"),
        steps,
      }
    })
  return { classification: "safe", descriptor, jobs }
}

function omitField(value, omitted) {
  const result = Object.create(null)
  for (const key of Object.keys(value).sort()) {
    if (key === omitted) continue
    Object.defineProperty(result, key, {
      enumerable: true,
      value: snapshotDescriptor(value[key]),
    })
  }
  return result
}

function assertAllowedRecord(value, allowed) {
  if (!isRecord(value)) throw unauditedEntrypoint()
  for (const key of Reflect.ownKeys(value)) {
    if (typeof key !== "string" || !allowed.has(key)) throw unauditedEntrypoint()
    const descriptor = Object.getOwnPropertyDescriptor(value, key)
    if (!descriptor?.enumerable || !("value" in descriptor)) throw unauditedEntrypoint()
  }
}

function snapshotDescriptor(value, ancestors = new Set()) {
  if (value === null || typeof value === "string" || typeof value === "boolean") return value
  if (typeof value === "number" && Number.isFinite(value)) return value
  if (typeof value !== "object" || ancestors.has(value)) throw unauditedEntrypoint()
  ancestors.add(value)
  try {
    if (Array.isArray(value)) {
      if (Object.getPrototypeOf(value) !== Array.prototype) throw unauditedEntrypoint()
      if (Reflect.ownKeys(value).length !== value.length + 1) throw unauditedEntrypoint()
      return value.map((_entry, index) => {
        const descriptor = Object.getOwnPropertyDescriptor(value, String(index))
        if (!descriptor?.enumerable || !("value" in descriptor)) throw unauditedEntrypoint()
        return snapshotDescriptor(descriptor.value, ancestors)
      })
    }
    const prototype = Object.getPrototypeOf(value)
    if (prototype !== Object.prototype && prototype !== null) throw unauditedEntrypoint()
    const result = Object.create(null)
    for (const key of Reflect.ownKeys(value).sort()) {
      if (typeof key !== "string") throw unauditedEntrypoint()
      const descriptor = Object.getOwnPropertyDescriptor(value, key)
      if (!descriptor?.enumerable || !("value" in descriptor)) throw unauditedEntrypoint()
      Object.defineProperty(result, key, {
        enumerable: true,
        value: snapshotDescriptor(descriptor.value, ancestors),
      })
    }
    return result
  } finally {
    ancestors.delete(value)
  }
}

function canonicalJson(value) {
  return JSON.stringify(snapshotDescriptor(value))
}

function sameStrings(left, right) {
  return left.length === right.length && left.every((value, index) => value === right[index])
}

function unauditedEntrypoint() {
  return new Error("Workflow entrypoint is not explicitly audited")
}

function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value)
}
