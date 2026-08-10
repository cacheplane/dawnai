import assert from "node:assert/strict"
import { readdir, readFile } from "node:fs/promises"
import path from "node:path"
import test from "node:test"
import { fileURLToPath } from "node:url"

import { parse } from "yaml"

const ROOT = fileURLToPath(new URL("../../..", import.meta.url))
const WORKFLOWS = path.join(ROOT, ".github/workflows")
const SHADOW_PATH = path.join(WORKFLOWS, "release-shadow.yml")
const ENTRYPOINT_ALLOWLIST_PATH = path.join(
  ROOT,
  "scripts/release/test/fixtures/workflow-entrypoints.json",
)
const LEGACY_SAFE_ENTRYPOINTS = new Set([
  "step-uses:actions/checkout@9c091bb21b7c1c1d1991bb908d89e4e9dddfe3e0",
  "step-uses:actions/setup-node@48b55a011bda9f5d6aeb4c2d9c7362e8dae4041e",
  "step-uses:pnpm/action-setup@0ebf47130e4866e96fce0953f49152a61190b271",
  "run:pnpm install --frozen-lockfile",
  "run:pnpm ci:validate",
  `run:DAWN_PUBLISHED_VERSION="$(node -p "require('./packages/core/package.json').version")"
printf 'DAWN_PUBLISHED_VERSION=%s\\n' "$DAWN_PUBLISHED_VERSION" >> "$GITHUB_ENV"`,
  'run:pnpm published:verify -- --version "$DAWN_PUBLISHED_VERSION" --package-set typescript-tooling --wait-attempts 18 --wait-delay-ms 10000',
  'run:pnpm published:smoke -- --version "$DAWN_PUBLISHED_VERSION" --package-set typescript-tooling',
  'run:pnpm published:verify -- --version "$DAWN_PUBLISHED_VERSION" --package-set docker-sandbox --wait-attempts 18 --wait-delay-ms 10000',
  'run:pnpm published:smoke -- --version "$DAWN_PUBLISHED_VERSION" --package-set docker-sandbox',
])
const LEGACY_PUBLICATION_ENTRYPOINTS = new Set([
  "step-uses:changesets/action@a45c4d594aa4e2c509dc14a9f2b3b67ba3780d0d",
  "step-uses:actions/attest-build-provenance@0f67c3f4856b2e3261c31976d6725780e5e4c373",
  "run:node scripts/upload-release-assets.mjs",
  "run:node scripts/backfill-release-tags.mjs",
])

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
  const allowlist = JSON.parse(await readFile(ENTRYPOINT_ALLOWLIST_PATH, "utf8"))
  const publicationFiles = Object.entries(allowlist.workflows)
    .filter(([, entries]) => entries.some(({ classification }) => classification === "publication"))
    .map(([file]) => file)
    .sort()

  assert.deepEqual(publicationFiles, ["release.yml"])
  assert.deepEqual(
    allowlist.workflows["release.yml"]
      .filter(({ classification }) => classification === "publication")
      .map(({ kind, value }) => `${kind}:${value}`),
    [
      "step-uses:changesets/action@a45c4d594aa4e2c509dc14a9f2b3b67ba3780d0d",
      "step-uses:actions/attest-build-provenance@0f67c3f4856b2e3261c31976d6725780e5e4c373",
      "run:node scripts/upload-release-assets.mjs",
      "run:node scripts/backfill-release-tags.mjs",
    ],
  )
  const legacy = parse(await readFile(path.join(WORKFLOWS, "release.yml"), "utf8"))
  assert.deepEqual(Object.keys(legacy.jobs), ["release"])
  assert.equal(legacy.jobs.detect, undefined)
  assert.equal(legacy.jobs.prepare, undefined)
  assert.equal(legacy.jobs.publish, undefined)
})

test("workflow entrypoints fail closed unless their exact normalized form is explicitly audited", () => {
  const allowlist = {
    "safe.yml": [
      {
        classification: "audited",
        job: "safe",
        kind: "run",
        step: "Audited command",
        stepIndex: 0,
        value: "pnpm lint",
      },
    ],
  }
  assert.doesNotThrow(() =>
    auditWorkflowEntrypoints(
      {
        "safe.yml":
          "jobs:\n  safe:\n    steps:\n      - name: Audited command\n        run: pnpm lint\n",
      },
      allowlist,
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

test("every workflow executable entrypoint matches the readable audited allowlist", async () => {
  const allowlist = JSON.parse(await readFile(ENTRYPOINT_ALLOWLIST_PATH, "utf8"))
  const sources = await readWorkflowSources(WORKFLOWS)

  assert.deepEqual(Object.keys(allowlist).sort(), ["schemaVersion", "workflows"])
  assert.equal(allowlist.schemaVersion, 1)
  assert.doesNotThrow(() => auditWorkflowEntrypoints(sources, allowlist.workflows))
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

async function readWorkflowSources(directory) {
  const sources = {}
  for (const file of (await readdir(directory)).filter((name) => /\.ya?ml$/u.test(name)).sort()) {
    sources[file] = await readFile(path.join(directory, file), "utf8")
  }
  return sources
}

function auditWorkflowEntrypoints(sources, allowlist) {
  if (!isRecord(sources) || !isRecord(allowlist)) throw unauditedEntrypoint()
  const files = Object.keys(sources).sort()
  const allowedFiles = Object.keys(allowlist).sort()
  if (!sameStrings(files, allowedFiles)) throw unauditedEntrypoint()
  for (const file of files) {
    let workflow
    try {
      workflow = parse(sources[file], { maxAliasCount: 0, uniqueKeys: true })
    } catch {
      throw unauditedEntrypoint()
    }
    const actual = workflowEntrypoints(workflow)
    const expected = allowlist[file]
    if (!Array.isArray(expected) || actual.length !== expected.length) throw unauditedEntrypoint()
    for (let index = 0; index < actual.length; index += 1) {
      const allowed = expected[index]
      if (
        !isRecord(allowed) ||
        !["audited", "publication", "safe"].includes(allowed.classification) ||
        JSON.stringify(actual[index]) !==
          JSON.stringify({
            job: allowed.job,
            stepIndex: allowed.stepIndex,
            step: allowed.step,
            kind: allowed.kind,
            value: allowed.value,
          })
      ) {
        throw unauditedEntrypoint()
      }
      const classification =
        file === "release.yml" ? classifyLegacyEntrypoint(actual[index]) : "audited"
      if (allowed.classification !== classification) throw unauditedEntrypoint()
    }
  }
}

function workflowEntrypoints(workflow) {
  if (!isRecord(workflow?.jobs)) throw unauditedEntrypoint()
  const entries = []
  for (const [jobName, job] of Object.entries(workflow.jobs)) {
    if (!isRecord(job)) throw unauditedEntrypoint()
    if (typeof job.uses === "string") {
      entries.push({ job: jobName, stepIndex: null, step: null, kind: "job-uses", value: job.uses })
    } else if (job.uses !== undefined) {
      throw unauditedEntrypoint()
    }
    if (job.steps !== undefined && !Array.isArray(job.steps)) throw unauditedEntrypoint()
    for (const [stepIndex, step] of (job.steps ?? []).entries()) {
      if (!isRecord(step)) throw unauditedEntrypoint()
      const hasRun = typeof step.run === "string"
      const hasUses = typeof step.uses === "string"
      if (hasRun === hasUses) throw unauditedEntrypoint()
      entries.push({
        job: jobName,
        stepIndex,
        step: typeof step.name === "string" ? step.name : null,
        kind: hasRun ? "run" : "step-uses",
        value: hasRun ? normalizeRunCommand(step.run) : step.uses,
      })
    }
  }
  return entries
}

function normalizeRunCommand(value) {
  return value
    .replace(/\r\n?/gu, "\n")
    .split("\n")
    .map((line) => line.replace(/[\t ]+$/gu, ""))
    .join("\n")
    .trim()
}

function classifyLegacyEntrypoint(entry) {
  const key = `${entry.kind}:${entry.value}`
  if (LEGACY_PUBLICATION_ENTRYPOINTS.has(key)) return "publication"
  if (LEGACY_SAFE_ENTRYPOINTS.has(key)) return "safe"
  throw unauditedEntrypoint()
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
