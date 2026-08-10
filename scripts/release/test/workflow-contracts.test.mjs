import assert from "node:assert/strict"
import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import test from "node:test"
import { fileURLToPath } from "node:url"

import { parse } from "yaml"

const ROOT = fileURLToPath(new URL("../../..", import.meta.url))
const WORKFLOWS = path.join(ROOT, ".github/workflows")
const SHADOW_PATH = path.join(WORKFLOWS, "release-shadow.yml")

test("release shadow has only manual and scheduled read-only triggers", async () => {
  const workflow = await readShadowWorkflow()

  assert.deepEqual(Object.keys(workflow.on).sort(), ["schedule", "workflow_dispatch"])
  assert.deepEqual(workflow.permissions, { actions: "read", contents: "read" })
  assert.deepEqual(Object.keys(workflow.jobs), ["shadow"])
  assert.equal(workflow.concurrency, undefined)
})

test("release shadow pins setup actions and installs only root tooling on Node 24", async () => {
  const workflow = await readShadowWorkflow()
  const steps = workflow.jobs.shadow.steps
  const actionSteps = steps.filter((step) => typeof step.uses === "string")

  assert.equal(actionSteps.length, 3)
  for (const step of actionSteps) {
    assert.match(step.uses, /^[^@\s]+@[0-9a-f]{40}$/u, step.uses)
  }
  assert.equal(actionSteps[0].uses.split("@")[0], "actions/checkout")
  assert.equal(actionSteps[0].with["fetch-depth"], 0)
  assert.equal(actionSteps[0].with.ref, "main")
  assert.equal(actionSteps[0].with["persist-credentials"], false)
  assert.doesNotMatch(JSON.stringify(actionSteps[0].with), /inputs|github\.event|github\.ref/iu)
  assert.equal(actionSteps[1].uses.split("@")[0], "pnpm/action-setup")
  assert.equal(actionSteps[2].uses.split("@")[0], "actions/setup-node")
  assert.equal(actionSteps[2].with["node-version"], "24.17.0")
  assert.ok(
    steps.some((step) => step.run === "pnpm install --filter . --frozen-lockfile --ignore-scripts"),
  )
})

test("release shadow scopes the GitHub token only to exact API reader steps", async () => {
  const workflow = await readShadowWorkflow()
  const job = workflow.jobs.shadow

  assert.equal(job.env, undefined)
  assert.equal(JSON.stringify(workflow).match(/\$\{\{ github\.token \}\}/gu)?.length, 2)
  for (const step of job.steps) {
    if (
      ["Reconcile release state in shadow mode", "Collect release preflight evidence"].includes(
        step.name,
      )
    ) {
      assert.deepEqual(step.env?.GITHUB_TOKEN, `\${{ github.token }}`)
    } else {
      assert.equal(step.env?.GITHUB_TOKEN, undefined, step.name)
    }
  }
})

test("release shadow accepts only paired optional identities and appends read-only reports", async () => {
  const source = await readShadowSource()
  const workflow = parse(source)
  const inputs = workflow.on.workflow_dispatch.inputs

  assert.deepEqual(Object.keys(inputs).sort(), ["commitSha", "version"])
  assert.equal(inputs.version.required, false)
  assert.equal(inputs.commitSha.required, false)
  assert.match(source, /version.*commitSha|commitSha.*version/su)
  assert.match(source, /pnpm check:release-inventory/u)
  assert.match(source, /pnpm release:shadow/u)
  assert.match(source, /pnpm release:preflight/u)
  assert.match(source, /GITHUB_STEP_SUMMARY/u)
  assert.doesNotMatch(source, /--strict/u)
  assert.doesNotMatch(
    source,
    /pnpm release:(?:shadow|preflight) --/u,
    "pnpm forwards this separator to the strict Node CLI",
  )
})

test("release shadow contains no publisher, OIDC, artifact upload, or external write path", async () => {
  const source = await readShadowSource()
  const workflow = parse(source)
  const runs = workflow.jobs.shadow.steps
    .filter((step) => typeof step.run === "string")
    .map((step) => step.run)
    .join("\n")

  assert.doesNotMatch(source, /id-token\s*:\s*write|contents\s*:\s*write/iu)
  assert.doesNotMatch(source, /actions\/upload-artifact|attest-build-provenance/iu)
  assert.doesNotMatch(runs, /(?:npm|pnpm)\s+(?:run\s+)?publish\b|release:publish/iu)
  assert.doesNotMatch(runs, /(?:git\s+(?:push|tag)|gh\s+release|curl\s|wget\s)/iu)
  assert.doesNotMatch(
    runs,
    /scripts\/(?:release-publish|backfill-release-tags|upload-release-assets)\.mjs/iu,
  )
})

test("legacy release remains the sole npm publisher without PR 2 topology constraints", async () => {
  assert.deepEqual(await publisherWorkflows(WORKFLOWS), ["release.yml"])
  const legacy = parse(await readFile(path.join(WORKFLOWS, "release.yml"), "utf8"))
  assert.deepEqual(Object.keys(legacy.jobs), ["release"])
  assert.equal(legacy.jobs.detect, undefined)
  assert.equal(legacy.jobs.prepare, undefined)
  assert.equal(legacy.jobs.publish, undefined)
})

test("sole-publisher detection covers parsed .yaml workflows and indirect publication paths", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "dawn-workflow-contract-"))
  t.after(() => rm(root, { recursive: true, force: true }))
  await Promise.all([
    writeFile(
      path.join(root, "release.yml"),
      `jobs:\n  release:\n    steps:\n      - uses: changesets/action@${"a".repeat(40)}\n`,
    ),
    writeFile(
      path.join(root, "hidden.yaml"),
      "jobs:\n  hidden:\n    steps:\n      - run: node scripts/release-publish.mjs\n",
    ),
    writeFile(
      path.join(root, "assets.yml"),
      "jobs:\n  assets:\n    steps:\n      - run: node scripts/upload-release-assets.mjs\n",
    ),
    writeFile(
      path.join(root, "backfill.yml"),
      "jobs:\n  tags:\n    steps:\n      - run: node scripts/backfill-release-tags.mjs\n",
    ),
    writeFile(
      path.join(root, "delegated.yaml"),
      "jobs:\n  publish:\n    uses: ./.github/workflows/release.yml\n",
    ),
    writeFile(
      path.join(root, "npm.yaml"),
      "jobs:\n  publish:\n    steps:\n      - run: npm publish --provenance\n",
    ),
    writeFile(
      path.join(root, "release-action.yml"),
      `jobs:\n  publish:\n    steps:\n      - uses: softprops/action-gh-release@${"b".repeat(40)}\n`,
    ),
    writeFile(
      path.join(root, "safe.yaml"),
      '# npm publish in a comment is inert\njobs:\n  safe:\n    steps:\n      - run: echo \\"npm publish is disabled\\"\n      - run: node scripts/check-docs.mjs\n',
    ),
  ])

  assert.deepEqual(await publisherWorkflows(root), [
    "assets.yml",
    "backfill.yml",
    "delegated.yaml",
    "hidden.yaml",
    "npm.yaml",
    "release-action.yml",
    "release.yml",
  ])
  assert.deepEqual(await unexpectedPublisherWorkflows(root), [
    "assets.yml",
    "backfill.yml",
    "delegated.yaml",
    "hidden.yaml",
    "npm.yaml",
    "release-action.yml",
  ])
})

test("root scripts expose shadow and preflight without adding the slow workflow test to fast scripts", async () => {
  const packageJson = JSON.parse(await readFile(path.join(ROOT, "package.json"), "utf8"))

  assert.equal(packageJson.scripts["release:shadow"], "node scripts/release/shadow-reconcile.mjs")
  assert.equal(packageJson.scripts["release:preflight"], "node scripts/release/preflight.mjs")
  assert.equal(
    packageJson.scripts["test:release-controller"],
    "node --test scripts/release/test/*.test.mjs",
  )
})

async function readShadowWorkflow() {
  return parse(await readShadowSource())
}

async function readShadowSource() {
  let source = null
  try {
    source = await readFile(SHADOW_PATH, "utf8")
  } catch {}
  assert.notEqual(source, null, "release-shadow.yml must exist")
  return source
}

async function publisherWorkflows(directory) {
  const files = (await readdir(directory)).filter((name) => /\.ya?ml$/u.test(name)).sort()
  const publishers = []
  for (const file of files) {
    const workflow = parse(await readFile(path.join(directory, file), "utf8"), {
      maxAliasCount: 0,
      uniqueKeys: true,
    })
    if (hasPublicationEntrypoint(workflow)) publishers.push(file)
  }
  return publishers
}

async function unexpectedPublisherWorkflows(directory) {
  return (await publisherWorkflows(directory)).filter((name) => name !== "release.yml")
}

function hasPublicationEntrypoint(workflow) {
  const jobs = isRecord(workflow?.jobs) ? Object.values(workflow.jobs) : []
  return jobs.some((job) => {
    if (typeof job?.uses === "string" && isPublishingAction(job.uses)) return true
    return (Array.isArray(job?.steps) ? job.steps : []).some((step) => {
      if (!isRecord(step)) return false
      if (typeof step.uses === "string" && isPublishingAction(step.uses)) return true
      return typeof step.run === "string" && isPublishingCommand(step.run)
    })
  })
}

function isPublishingAction(value) {
  const action = value.split("@", 1)[0].toLowerCase()
  return new Set([
    "actions/attest-build-provenance",
    "actions/upload-release-asset",
    "changesets/action",
    "./.github/workflows/release.yml",
    "ncipollo/release-action",
    "softprops/action-gh-release",
  ]).has(action)
}

function isPublishingCommand(value) {
  return value.split("\n").some((line) => {
    const command = line.trim()
    return (
      /^(?:npm|pnpm)(?:\s+run)?\s+publish(?:\s|$)/u.test(command) ||
      /^pnpm(?:\s+run)?\s+release:publish(?:\s|$)/u.test(command) ||
      /^node\s+(?:\.\/)?scripts\/(?:release-publish|upload-release-assets|backfill-release-tags)\.mjs(?:\s|$)/u.test(
        command,
      )
    )
  })
}

function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value)
}
