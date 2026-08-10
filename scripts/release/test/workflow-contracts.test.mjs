import assert from "node:assert/strict"
import { mkdir, mkdtemp, readdir, readFile, rm, symlink, writeFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import test from "node:test"
import { fileURLToPath } from "node:url"

import { parse } from "yaml"

import { readBoundedFixture } from "../fixture-io.mjs"

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
printf 'DAWN_PUBLISHED_VERSION=%s\\n' "$DAWN_PUBLISHED_VERSION" >> "$GITHUB_ENV"
`,
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
  const allowlist = JSON.parse(await readBoundedFixture(ENTRYPOINT_ALLOWLIST_PATH, { root: ROOT }))
  const publicationFiles = Object.entries(allowlist.workflows)
    .filter(([, workflow]) =>
      workflow.jobs.some((job) =>
        job.steps.some(({ classification }) => classification === "publication"),
      ),
    )
    .map(([file]) => file)
    .sort()

  assert.deepEqual(publicationFiles, ["release.yml"])
  assert.deepEqual(
    allowlist.workflows["release.yml"].jobs
      .flatMap((job) => job.steps)
      .filter(({ classification }) => classification === "publication")
      .map(({ descriptor }) =>
        descriptor.uses === undefined ? `run:${descriptor.run}` : `step-uses:${descriptor.uses}`,
      ),
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
  const allowlist = JSON.parse(await readBoundedFixture(ENTRYPOINT_ALLOWLIST_PATH, { root: ROOT }))
  const sources = await readWorkflowSources(WORKFLOWS)

  assert.deepEqual(Object.keys(allowlist).sort(), ["schemaVersion", "workflows"])
  assert.equal(allowlist.schemaVersion, 2)
  assert.doesNotThrow(() => auditWorkflowEntrypoints(sources, allowlist.workflows))
})

test("workflow audit binds complete execution descriptors and byte-exact run strings", async (t) => {
  const allowlist = JSON.parse(await readBoundedFixture(ENTRYPOINT_ALLOWLIST_PATH, { root: ROOT }))
  const sources = await readWorkflowSources(WORKFLOWS)
  const cases = [
    [
      "workflow permissions",
      "release-shadow.yml",
      (source) => source.replace("actions: read", "actions: write"),
    ],
    [
      "job runner",
      "release-shadow.yml",
      (source) => source.replace("ubuntu-latest", "self-hosted"),
    ],
    [
      "checkout inputs",
      "release-shadow.yml",
      (source) => source.replace("fetch-depth: 0", "fetch-depth: 1"),
    ],
    [
      "action inputs",
      "release-shadow.yml",
      (source) => source.replace("version: 10.33.0", "version: 10.32.0"),
    ],
    [
      "action environment",
      "release-shadow.yml",
      (source) =>
        source.replace(
          "      - name: Setup pnpm\n",
          "      - name: Setup pnpm\n        env:\n          BASH_ENV: scripts/bypass.sh\n",
        ),
    ],
    [
      "action condition",
      "release-shadow.yml",
      (source) =>
        source.replace(
          "      - name: Setup pnpm\n",
          "      - name: Setup pnpm\n        if: always()\n",
        ),
    ],
    [
      "unknown step key",
      "release-shadow.yml",
      (source) =>
        source.replace(
          "      - name: Setup pnpm\n",
          "      - name: Setup pnpm\n        unexpected: true\n",
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
          steps: [{ classification: "safe", descriptor: { name: "Safe", run: "pnpm lint" } }],
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
  await writeFile(path.join(outside, "outside.yml"), "jobs: {}\n")
  await symlink(path.join(outside, "outside.yml"), path.join(root, "unsafe.yml"))
  await assert.rejects(() => readWorkflowSources(root), /fixture file/u)

  await rm(path.join(root, "unsafe.yml"))
  await mkdir(path.join(root, "directory.yaml"))
  await assert.rejects(() => readWorkflowSources(root), /fixture file/u)

  await rm(path.join(root, "directory.yaml"), { recursive: true })
  await writeFile(path.join(root, "oversize.yml"), "x".repeat(1024 * 1024 + 1))
  await assert.rejects(() => readWorkflowSources(root), /fixture file/u)
})

test("legacy publication indirection is bound to exact root scripts and regular files", async (t) => {
  await assertReleaseIndirection(ROOT)

  const root = await mkdtemp(path.join(os.tmpdir(), "dawn-release-indirection-"))
  t.after(() => rm(root, { recursive: true, force: true }))
  await mkdir(path.join(root, "scripts"))
  await writeFile(
    path.join(root, "package.json"),
    JSON.stringify({ scripts: { "release:publish": "node scripts/other.mjs" } }),
  )
  for (const file of [
    "release-publish.mjs",
    "upload-release-assets.mjs",
    "backfill-release-tags.mjs",
  ])
    await writeFile(path.join(root, "scripts", file), "export {}\n")
  await assert.rejects(() => assertReleaseIndirection(root), /not explicitly audited/u)

  await writeFile(
    path.join(root, "package.json"),
    JSON.stringify({ scripts: { "release:publish": "node scripts/release-publish.mjs" } }),
  )
  await rm(path.join(root, "scripts", "upload-release-assets.mjs"))
  await symlink(
    path.join(root, "scripts", "release-publish.mjs"),
    path.join(root, "scripts", "upload-release-assets.mjs"),
  )
  await assert.rejects(() => assertReleaseIndirection(root), /not explicitly audited/u)
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
  const sources = Object.create(null)
  for (const file of (await readdir(directory)).filter((name) => /\.ya?ml$/u.test(name)).sort()) {
    Object.defineProperty(sources, file, {
      configurable: false,
      enumerable: true,
      writable: false,
      value: await readBoundedFixture(path.join(directory, file), {
        root: directory,
        maxBytes: 1024 * 1024,
      }),
    })
  }
  return sources
}

async function assertReleaseIndirection(root) {
  try {
    const packageJson = JSON.parse(
      await readBoundedFixture(path.join(root, "package.json"), {
        root,
        maxBytes: 1024 * 1024,
      }),
    )
    if (
      !isRecord(packageJson) ||
      !isRecord(packageJson.scripts) ||
      packageJson.scripts["release:publish"] !== "node scripts/release-publish.mjs"
    ) {
      throw unauditedEntrypoint()
    }
    for (const file of [
      "scripts/release-publish.mjs",
      "scripts/upload-release-assets.mjs",
      "scripts/backfill-release-tags.mjs",
    ]) {
      await readBoundedFixture(path.join(root, file), { root, maxBytes: 1024 * 1024 })
    }
  } catch {
    throw unauditedEntrypoint()
  }
}

function auditWorkflowEntrypoints(sources, allowlist) {
  const sourceSnapshot = snapshotDescriptor(sources)
  const allowlistSnapshot = snapshotDescriptor(allowlist)
  if (!isRecord(sourceSnapshot) || !isRecord(allowlistSnapshot)) throw unauditedEntrypoint()
  const files = Object.keys(sourceSnapshot).sort()
  const allowedFiles = Object.keys(allowlistSnapshot).sort()
  if (!sameStrings(files, allowedFiles)) throw unauditedEntrypoint()
  for (const file of files) {
    let workflow
    try {
      if (typeof sourceSnapshot[file] !== "string") throw new TypeError("invalid source")
      workflow = parse(sourceSnapshot[file], { maxAliasCount: 0, uniqueKeys: true })
    } catch {
      throw unauditedEntrypoint()
    }
    const actual = workflowDescriptor(workflow, file)
    const expected = allowlistSnapshot[file]
    if (canonicalJson(actual) !== canonicalJson(expected)) throw unauditedEntrypoint()
  }
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

function workflowDescriptor(workflow, file) {
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
        ? job.steps.map((step) => {
            assertAllowedRecord(step, STEP_KEYS)
            const hasRun = typeof step.run === "string"
            const hasStepUses = typeof step.uses === "string"
            if (hasRun === hasStepUses) throw unauditedEntrypoint()
            return {
              classification: classifyStep(file, step),
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

function classifyStep(file, step) {
  const kind = typeof step.run === "string" ? "run" : "step-uses"
  const value = step.run ?? step.uses
  const key = `${kind}:${value}`
  if (LEGACY_PUBLICATION_ENTRYPOINTS.has(key)) {
    if (file !== "release.yml") throw unauditedEntrypoint()
    return "publication"
  }
  if (file === "release.yml" && !LEGACY_SAFE_ENTRYPOINTS.has(key)) throw unauditedEntrypoint()
  return "safe"
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
