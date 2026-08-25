import assert from "node:assert/strict"
import {
  link,
  lstat,
  mkdtemp,
  open,
  readdir,
  readFile,
  rm,
  symlink,
  unlink,
  writeFile,
} from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import test from "node:test"

import { CANONICAL_RELEASE_PACKAGE_ORDER } from "../manifest.mjs"
import { planRelease } from "../planner.mjs"
import {
  canonicalPreparationHandoffBytes,
  createPreparationHandoff,
  parsePreparationHandoff,
  parsePreparationHandoffCliArguments,
  runPreparationHandoffCli,
} from "../workflow-handoff.mjs"

const VERSION = "0.8.22"
const COMMIT_SHA = "0123456789abcdef0123456789abcdef01234567"
const ROOT = "/absolute/release-candidate"
const CANDIDATE = Object.freeze({
  version: VERSION,
  commitSha: COMMIT_SHA,
  ciWorkflow: "CI",
  ciCheck: "validate",
  publisherWorkflow: ".github/workflows/release.yml",
})

test("creates one frozen preparation handoff from the trusted report, immutable inventory, and tag run", async () => {
  const report = productionReport()
  const inventory = rawInventory()
  const environment = productionEnvironment()
  const reads = []
  const gate = Promise.withResolvers()
  const creation = createPreparationHandoff({
    report,
    root: ROOT,
    environment,
    async readInventory(input) {
      reads.push(input)
      await gate.promise
      return inventory
    },
  })

  report.candidate.version = "9.9.9"
  environment.GITHUB_RUN_ID = "999"
  gate.resolve()
  const handoff = await creation

  assert.deepEqual(reads, [{ root: ROOT, ref: COMMIT_SHA }])
  assert.deepEqual(handoff, {
    schemaVersion: 1,
    candidate: CANDIDATE,
    inventory: rawInventory(),
    ciReceipt: {
      status: "success",
      retryable: false,
      commitSha: COMMIT_SHA,
      workflow: "CI",
      check: "validate",
      runId: 501,
      runAttempt: 2,
    },
    prepareRun: { id: 7001, attempt: 3 },
    preparationAuthority: {
      state: "CANDIDATE_TAGGED",
      releaseRecord: "absent",
      npm: "absent",
    },
    sourceRef: `refs/tags/v${VERSION}`,
  })
  assertRecursivelyFrozen(handoff)

  inventory.workspacePackages[0].version = "0.0.0"
  assert.equal(handoff.inventory.workspacePackages[0].version, VERSION)

  const bytes = canonicalPreparationHandoffBytes(handoff)
  assert.equal(bytes.at(-1), 10)
  assert.deepEqual(parsePreparationHandoff(bytes), handoff)
  assertRecursivelyFrozen(parsePreparationHandoff(bytes))
})

test("rejects diagnostics and any stored report or plan drift before reading inventory", async () => {
  const cases = [
    ["report schema", (report) => (report.schemaVersion = 2)],
    ["stored plan", (report) => (report.before.plan.state = "ARTIFACTS_PREPARED")],
    ["stored disposition", (report) => (report.before.plan.disposition = "blocked")],
    ["stored transition", (report) => (report.before.plan.nextTransition = "attest-artifacts")],
    ["controller transition name", (report) => (report.transition.name = "attest-artifacts")],
    ["controller transition status", (report) => (report.transition.status = "completed")],
    ["controller transition result", (report) => (report.transition.result = {})],
    ["controller after snapshot", (report) => (report.after = report.before)],
    [
      "diagnostics",
      (report) =>
        report.diagnostics.push({
          source: "github",
          operation: "ci-correlation",
          status: "AMBIGUOUS",
          httpStatus: null,
          code: "CI_IDENTITY_AMBIGUOUS",
          classification: "conflict",
        }),
    ],
  ]

  for (const [name, mutate] of cases) {
    const report = productionReport()
    mutate(report)
    let inventoryReads = 0
    await assert.rejects(
      createPreparationHandoff({
        report,
        root: ROOT,
        environment: productionEnvironment(),
        async readInventory() {
          inventoryReads += 1
          return rawInventory()
        },
      }),
      undefined,
      name,
    )
    assert.equal(inventoryReads, 0, `${name} must fail before immutable inventory I/O`)
  }
})

test("recomputes the production plan and rejects candidate or CI authority tampering", async () => {
  const cases = [
    ["candidate SHA", (report) => (report.candidate.commitSha = "f".repeat(40))],
    ["CI status", (report) => (report.before.observation.ci.status = "failed")],
    ["CI workflow", (report) => (report.before.observation.ci.workflow = "Other")],
    ["CI check", (report) => (report.before.observation.ci.check = "other")],
    ["CI SHA", (report) => (report.before.observation.ci.commitSha = "f".repeat(40))],
  ]

  for (const [name, mutate] of cases) {
    const report = productionReport()
    mutate(report)
    await assert.rejects(createWith({ report }), undefined, name)
  }
})

test("accepts preparation identity only from the exact tag-bound release workflow environment", async () => {
  const cases = [
    ["repository", { GITHUB_REPOSITORY: "fork/dawnai" }],
    ["ref", { GITHUB_REF: "refs/heads/main" }],
    ["SHA", { GITHUB_SHA: "f".repeat(40) }],
    ["run", { GITHUB_RUN_ID: "0" }],
    ["run leading zero", { GITHUB_RUN_ID: "07001" }],
    ["attempt", { GITHUB_RUN_ATTEMPT: "0" }],
    [
      "workflow ref",
      {
        GITHUB_WORKFLOW_REF: `cacheplane/dawnai/.github/workflows/other.yml@refs/tags/v${VERSION}`,
      },
    ],
  ]

  for (const [name, override] of cases) {
    await assert.rejects(
      createWith({ environment: { ...productionEnvironment(), ...override } }),
      undefined,
      name,
    )
  }
})

test("prevents CI and preparation identities from being mixed into one workflow run", async () => {
  await assert.rejects(
    createWith({
      environment: {
        ...productionEnvironment(),
        GITHUB_RUN_ID: "501",
        GITHUB_RUN_ATTEMPT: "2",
      },
    }),
    /distinct/iu,
  )

  const handoff = structuredClone(await createWith())
  handoff.prepareRun.id = handoff.ciReceipt.runId
  assert.throws(() => parsePreparationHandoff(handoff), /distinct/iu)
})

test("correlates the full immutable inventory to the observed candidate package set", async () => {
  const inventory = rawInventory()
  const removed = inventory.workspacePackages.findIndex(
    (pkg) => pkg.name === CANONICAL_RELEASE_PACKAGE_ORDER[0],
  )
  inventory.workspacePackages.splice(removed, 1)
  inventory.fixedGroups[0] = inventory.fixedGroups[0].slice(1)
  inventory.workspacePackages.push({
    name: "@dawn-ai/unobserved",
    version: VERSION,
    path: "packages/unobserved/package.json",
  })
  inventory.fixedGroups[0].push("@dawn-ai/unobserved")

  await assert.rejects(createWith({ inventory }), /package set/iu)
})

test("handoff parsing rejects extra and prototype-pollution fields at every exact boundary", async () => {
  const cases = [
    ["root", (value) => (value.extra = true)],
    ["candidate", (value) => (value.candidate.extra = true)],
    ["CI receipt", (value) => (value.ciReceipt.extra = true)],
    ["prepare run", (value) => (value.prepareRun.extra = true)],
    ["authority", (value) => (value.preparationAuthority.extra = true)],
    ["inventory", (value) => (value.inventory.extra = true)],
    [
      "__proto__",
      (value) =>
        Object.defineProperty(value.candidate, "__proto__", {
          value: { polluted: true },
          enumerable: true,
        }),
    ],
    ["constructor", (value) => (value.ciReceipt.constructor = "unsafe")],
    ["prototype", (value) => (value.prepareRun.prototype = "unsafe")],
    [
      "nested raw inventory prototype field",
      (value) =>
        Object.defineProperty(value.inventory.workspacePackages[0], "prototype", {
          value: { polluted: true },
          enumerable: true,
        }),
    ],
  ]
  const valid = await createWith()

  for (const [name, mutate] of cases) {
    const input = structuredClone(valid)
    mutate(input)
    assert.throws(() => parsePreparationHandoff(input), undefined, name)
  }
})

test("handoff inputs reject accessors, symbols, sparse arrays, and non-plain prototypes without invocation", async () => {
  const valid = await createWith()
  let reads = 0
  const accessor = structuredClone(valid)
  Object.defineProperty(accessor.candidate, "version", {
    enumerable: true,
    get() {
      reads += 1
      return VERSION
    },
  })
  assert.throws(() => parsePreparationHandoff(accessor), /JSON|field|accessor/iu)
  assert.equal(reads, 0)

  const symbol = structuredClone(valid)
  symbol[Symbol("hidden")] = true
  assert.throws(() => parsePreparationHandoff(symbol), /JSON|key|symbol/iu)

  const sparse = structuredClone(valid)
  delete sparse.inventory.fixedGroups[0][0]
  assert.throws(() => parsePreparationHandoff(sparse), /JSON|array|sparse/iu)

  const prototype = structuredClone(valid)
  Object.setPrototypeOf(prototype.candidate, { inherited: true })
  assert.throws(() => parsePreparationHandoff(prototype), /JSON|object|prototype/iu)
})

test("create rejects accessor-based authority and unknown option fields without invoking them", async () => {
  let reads = 0
  const environment = productionEnvironment()
  Object.defineProperty(environment, "GITHUB_SHA", {
    enumerable: true,
    get() {
      reads += 1
      return COMMIT_SHA
    },
  })
  await assert.rejects(createWith({ environment }), /GITHUB_SHA/iu)
  assert.equal(reads, 0)

  const hiddenEnvironment = productionEnvironment()
  Object.defineProperty(hiddenEnvironment, "GITHUB_RUN_ID", {
    value: "7001",
    enumerable: false,
  })
  await assert.rejects(createWith({ environment: hiddenEnvironment }), /GITHUB_RUN_ID/iu)

  await assert.rejects(
    createPreparationHandoff({
      report: productionReport(),
      root: ROOT,
      environment: productionEnvironment(),
      readInventory: async () => rawInventory(),
      ciReceipt: { forged: true },
    }),
    /option|field/iu,
  )
})

test("immutable inventory roots must be absolute, bounded, and free of control characters", async () => {
  for (const root of [
    "relative/repository",
    "/repository\0other",
    "/repository\nother",
    `/${"x".repeat(4097)}`,
  ]) {
    let reads = 0
    await assert.rejects(
      createPreparationHandoff({
        report: productionReport(),
        root,
        environment: productionEnvironment(),
        async readInventory() {
          reads += 1
          return rawInventory()
        },
      }),
      /root/iu,
    )
    assert.equal(reads, 0)
  }
})

test("parses only bounded canonical UTF-8 bytes", async () => {
  const valid = await createWith()
  const canonical = canonicalPreparationHandoffBytes(valid)
  const compact = Buffer.from(JSON.stringify(valid), "utf8")
  assert.ok(!compact.equals(canonical))
  assert.throws(() => parsePreparationHandoff(compact), /canonical/iu)

  const oversized = Buffer.concat([canonical, Buffer.alloc(256 * 1024, 0x20)])
  assert.throws(() => parsePreparationHandoff(oversized), /byte limit/iu)

  const large = structuredClone(valid)
  large.inventory.workspacePackages.at(-1).description = "x".repeat(300 * 1024)
  assert.throws(() => canonicalPreparationHandoffBytes(large), /byte limit/iu)
})

test("canonical encoding is stable across object key order and parser snapshots caller data", async () => {
  const valid = await createWith()
  const reordered = reverseObjectKeys(valid)
  const parsed = parsePreparationHandoff(reordered)
  reordered.candidate.version = "9.9.9"
  reordered.inventory.fixedGroups[0][0] = "@attacker/package"

  assert.equal(parsed.candidate.version, VERSION)
  assert.equal(parsed.inventory.fixedGroups[0][0], CANONICAL_RELEASE_PACKAGE_ORDER[0])
  assert.deepEqual(
    canonicalPreparationHandoffBytes(parsed),
    canonicalPreparationHandoffBytes(valid),
  )
  assertRecursivelyFrozen(parsed)
})

test("the executable creates one canonical write-once handoff from exactly three path flags", async (t) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "dawn-preparation-handoff-"))
  t.after(() => rm(directory, { recursive: true, force: true }))
  const reportPath = path.join(directory, "production-report.json")
  const outputPath = path.join(directory, "preparation-handoff.json")
  await writeFile(reportPath, `${JSON.stringify(productionReport())}\n`, "utf8")
  const argv = ["--report", reportPath, "--root", ROOT, "--output", outputPath]

  const result = await runPreparationHandoffCli(argv, {
    environment: productionEnvironment(),
    async readInventory() {
      return rawInventory()
    },
  })

  assert.deepEqual(parsePreparationHandoff(await readFile(outputPath)), result)
  assert.deepEqual(await readFile(outputPath), canonicalPreparationHandoffBytes(result))
  await runPreparationHandoffCli(argv, {
    environment: productionEnvironment(),
    async readInventory() {
      return rawInventory()
    },
  })
})

test("the executable rejects unknown, duplicate, missing, unsafe, and aliased paths", async () => {
  const valid = ["--report", "/tmp/report.json", "--root", ROOT, "--output", "/tmp/output.json"]
  for (const argv of [
    [],
    valid.slice(0, -2),
    [...valid, "--extra", "value"],
    ["--report", "/tmp/report.json", "--report", "/tmp/other.json", "--root", ROOT],
    ["--report", "/tmp/report.json\n", "--root", ROOT, "--output", "/tmp/output.json"],
    ["--report", "/tmp/same.json", "--root", ROOT, "--output", "/tmp/same.json"],
    ["--report", "/tmp/report.json", "--root", "relative", "--output", "/tmp/output.json"],
  ]) {
    assert.throws(() => parsePreparationHandoffCliArguments(argv), /argument|flag|path|root/iu)
  }
})

test("the executable never clobbers conflicting files or follows output symlinks", async (t) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "dawn-preparation-handoff-output-"))
  t.after(() => rm(directory, { recursive: true, force: true }))
  const reportPath = path.join(directory, "production-report.json")
  const outputPath = path.join(directory, "preparation-handoff.json")
  const targetPath = path.join(directory, "target.json")
  await writeFile(reportPath, `${JSON.stringify(productionReport())}\n`, "utf8")
  await writeFile(outputPath, "conflicting bytes\n", "utf8")
  const runtime = {
    environment: productionEnvironment(),
    async readInventory() {
      return rawInventory()
    },
  }
  await assert.rejects(
    runPreparationHandoffCli(
      ["--report", reportPath, "--root", ROOT, "--output", outputPath],
      runtime,
    ),
    /conflict|different|existing/iu,
  )
  assert.equal(await readFile(outputPath, "utf8"), "conflicting bytes\n")

  await rm(outputPath)
  await writeFile(targetPath, "unchanged\n", "utf8")
  await symlink(targetPath, outputPath)
  await assert.rejects(
    runPreparationHandoffCli(
      ["--report", reportPath, "--root", ROOT, "--output", outputPath],
      runtime,
    ),
    /regular|symbolic|output|existing/iu,
  )
  assert.equal(await readFile(targetPath, "utf8"), "unchanged\n")
})

test("the executable rejects unsafe runtime accessors and report or parent symlinks", async (t) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "dawn-preparation-handoff-input-"))
  t.after(() => rm(directory, { recursive: true, force: true }))
  const reportPath = path.join(directory, "production-report.json")
  const reportLink = path.join(directory, "report-link.json")
  const outputDirectory = path.join(directory, "output")
  const outputLink = path.join(directory, "output-link")
  const outputPath = path.join(outputDirectory, "preparation-handoff.json")
  await writeFile(reportPath, `${JSON.stringify(productionReport())}\n`, "utf8")
  await symlink(reportPath, reportLink)
  await symlink(directory, outputLink)

  let accessorReads = 0
  const unsafeRuntime = {
    environment: productionEnvironment(),
    async readInventory() {
      return rawInventory()
    },
  }
  Object.defineProperty(unsafeRuntime, "fileSystem", {
    enumerable: true,
    get() {
      accessorReads += 1
      return null
    },
  })
  await assert.rejects(
    runPreparationHandoffCli(
      ["--report", reportPath, "--root", ROOT, "--output", outputPath],
      unsafeRuntime,
    ),
    /runtime|unsafe/iu,
  )
  assert.equal(accessorReads, 0)

  const runtime = {
    environment: productionEnvironment(),
    async readInventory() {
      return rawInventory()
    },
  }
  await assert.rejects(
    runPreparationHandoffCli(
      ["--report", reportLink, "--root", ROOT, "--output", outputPath],
      runtime,
    ),
    /regular|report/iu,
  )
  await assert.rejects(
    runPreparationHandoffCli(
      [
        "--report",
        reportPath,
        "--root",
        ROOT,
        "--output",
        path.join(outputLink, "preparation-handoff.json"),
      ],
      runtime,
    ),
    /directory|parent/iu,
  )
  await assert.rejects(readFile(outputPath), { code: "ENOENT" })
})

test("the write-once executable cleans temporary files after write or link failure", async (t) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "dawn-preparation-handoff-failure-"))
  t.after(() => rm(directory, { recursive: true, force: true }))
  const reportPath = path.join(directory, "production-report.json")
  const outputPath = path.join(directory, "preparation-handoff.json")
  await writeFile(reportPath, `${JSON.stringify(productionReport())}\n`, "utf8")
  const argv = ["--report", reportPath, "--root", ROOT, "--output", outputPath]
  const baseRuntime = {
    environment: productionEnvironment(),
    async readInventory() {
      return rawInventory()
    },
    randomUUID() {
      return "01234567-89ab-cdef-0123-456789abcdef"
    },
  }

  const writeFailure = Object.assign(new Error("injected write failure"), { code: "EIO" })
  await assert.rejects(
    runPreparationHandoffCli(argv, {
      ...baseRuntime,
      fileSystem: {
        link,
        lstat,
        async open(filePath, ...arguments_) {
          const handle = await open(filePath, ...arguments_)
          if (!filePath.endsWith(".tmp")) return handle
          return {
            close: handle.close.bind(handle),
            stat: handle.stat.bind(handle),
            sync: handle.sync.bind(handle),
            async writeFile() {
              throw writeFailure
            },
          }
        },
        unlink,
      },
    }),
    /write failure/iu,
  )
  assert.deepEqual(await readdir(directory), ["production-report.json"])

  const linkFailure = Object.assign(new Error("injected link failure"), { code: "EIO" })
  await assert.rejects(
    runPreparationHandoffCli(argv, {
      ...baseRuntime,
      fileSystem: {
        async link() {
          throw linkFailure
        },
        lstat,
        open,
        unlink,
      },
    }),
    /link failure/iu,
  )
  assert.deepEqual(await readdir(directory), ["production-report.json"])
})

async function createWith({
  report = productionReport(),
  inventory = rawInventory(),
  environment = productionEnvironment(),
} = {}) {
  return createPreparationHandoff({
    report,
    root: ROOT,
    environment,
    async readInventory() {
      return inventory
    },
  })
}

function productionReport() {
  const candidate = structuredClone(CANDIDATE)
  const observation = taggedObservation()
  const plan = planRelease({ candidate, observation, mode: "controller" })
  assert.equal(plan.state, "CANDIDATE_TAGGED")
  return {
    schemaVersion: 1,
    candidate,
    before: { observation, plan: structuredClone(plan) },
    transition: {
      name: "prepare-artifacts",
      status: "dry-run",
      result: null,
      error: null,
    },
    after: null,
    diagnostics: [],
  }
}

function taggedObservation() {
  const packages = observationPackages()
  return {
    inventory: { status: "valid", packages },
    ci: {
      status: "success",
      workflow: "CI",
      check: "validate",
      commitSha: COMMIT_SHA,
      workflowRunId: 501,
      runAttempt: 2,
    },
    otherCandidates: [],
    tag: { status: "present", commitSha: COMMIT_SHA },
    artifacts: {
      status: "absent",
      manifestVersion: null,
      manifestCommitSha: null,
      manifestSha256: null,
      files: packages.map((pkg) => ({
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
        ...packages.map((pkg) => ({
          name: pkg.attestationFilename,
          status: "pending",
          sha256: null,
          subjectName: pkg.filename,
          subjectSha256: null,
        })),
        {
          name: "manifest.json.intoto.jsonl",
          status: "pending",
          sha256: null,
          subjectName: "manifest.json",
          subjectSha256: null,
        },
      ],
    },
    escrow: { status: "absent", manifestSha256: null, assets: [] },
    registry: {
      publishJobStarted: false,
      mutationStarted: false,
      packages: packages.map((pkg) => ({
        name: pkg.name,
        status: "e404",
        version: null,
        tarballSha256: null,
        integrity: null,
        latest: { status: "e404", version: null },
        signature: { status: "missing" },
        provenance: null,
      })),
    },
    release: {
      status: "absent",
      tag: null,
      commitSha: null,
      immutable: null,
      bodySha256: null,
      marker: null,
      assets: [],
    },
    requiredSmokeLanes: ["published-install"],
    smokes: [
      {
        name: "published-install",
        status: "pending",
        version: VERSION,
        commitSha: COMMIT_SHA,
        manifestSha256: null,
        workflowRunId: null,
        runAttempt: null,
      },
    ],
    audit: {
      status: "none",
      version: null,
      commitSha: null,
      manifestSha256: null,
      workflowRunId: null,
      runAttempt: null,
      conclusion: null,
    },
    abandonment: { requested: false, recorded: false, predecessor: null },
  }
}

function observationPackages() {
  return [...CANONICAL_RELEASE_PACKAGE_ORDER].sort(compareText).map((name) => {
    const filename = `${name.replace(/^@/u, "").replaceAll("/", "-")}-${VERSION}.tgz`
    return {
      name,
      version: VERSION,
      filename,
      tarballSha256: null,
      attestationFilename: `${filename}.intoto.jsonl`,
      attestationSha256: null,
      integrity: null,
    }
  })
}

function rawInventory() {
  return {
    fixedGroups: [[...CANONICAL_RELEASE_PACKAGE_ORDER]],
    workspacePackages: [
      ...CANONICAL_RELEASE_PACKAGE_ORDER.map((name, index) => ({
        name,
        version: VERSION,
        path: `packages/package-${index}/package.json`,
        description: `retained raw manifest ${index}`,
        ...(index === 1
          ? { dependencies: { [CANONICAL_RELEASE_PACKAGE_ORDER[0]]: "workspace:*" } }
          : {}),
      })),
      {
        name: "@dawn-example/private",
        private: true,
        path: "examples/private/package.json",
        scripts: { test: "node --test" },
      },
    ],
  }
}

function productionEnvironment() {
  return {
    GITHUB_REPOSITORY: "cacheplane/dawnai",
    GITHUB_REF: `refs/tags/v${VERSION}`,
    GITHUB_SHA: COMMIT_SHA,
    GITHUB_RUN_ID: "7001",
    GITHUB_RUN_ATTEMPT: "3",
    GITHUB_WORKFLOW_REF: `cacheplane/dawnai/.github/workflows/release.yml@refs/tags/v${VERSION}`,
    PATH: "/not-authority",
  }
}

function assertRecursivelyFrozen(value) {
  if (value === null || typeof value !== "object") return
  assert.equal(Object.isFrozen(value), true)
  for (const child of Object.values(value)) assertRecursivelyFrozen(child)
}

function reverseObjectKeys(value) {
  if (Array.isArray(value)) return value.map(reverseObjectKeys)
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.keys(value)
        .reverse()
        .map((key) => [key, reverseObjectKeys(value[key])]),
    )
  }
  return value
}

function compareText(left, right) {
  return left < right ? -1 : left > right ? 1 : 0
}
