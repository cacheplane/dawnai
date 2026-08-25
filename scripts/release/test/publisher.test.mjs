import assert from "node:assert/strict"
import { spawnSync } from "node:child_process"
import { createHash, generateKeyPairSync, sign as signBytes } from "node:crypto"
import {
  access,
  chmod,
  copyFile,
  link,
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
import { pathToFileURL } from "node:url"

import { ARTIFACT_STORE_SPARSE_FILES } from "../artifact-store.mjs"
import { CANONICAL_RELEASE_PACKAGE_ORDER, canonicalManifestBytes } from "../manifest.mjs"
import { canonicalNpmEvidenceBytes, parseNpmEvidence } from "../npm-evidence.mjs"
import {
  PUBLISHER_OVERALL_TIMEOUT_MS,
  PUBLISHER_SPARSE_FILES,
  parsePublisherArguments,
  publishManifestSerially,
  runPublisherCli,
} from "../publisher.mjs"
import { canonicalReleaseRecordBytes } from "../release-record.mjs"

const VERSION = "0.8.21"
const COMMIT_SHA = "0123456789abcdef0123456789abcdef01234567"
const CANDIDATE = Object.freeze({
  version: VERSION,
  commitSha: COMMIT_SHA,
  ciWorkflow: "CI",
  ciCheck: "validate",
  publisherWorkflow: ".github/workflows/release.yml",
})

test("publishes missing manifest tarballs serially in dependency order with create-dawn-ai-app final", async () => {
  const fixture = publisherFixture()

  const result = await publishManifestSerially(fixture.inputs)

  assert.equal(result.status, "NPM_COMPLETE")
  assert.equal(result.complete, true)
  assert.deepEqual(fixture.publishCalls, CANONICAL_RELEASE_PACKAGE_ORDER)
  assert.equal(fixture.concurrentPublishes.maximum, 1)
  assert.equal(fixture.publishCalls.at(-1), "create-dawn-ai-app")
  let previousPublish = -1
  for (const name of CANONICAL_RELEASE_PACKAGE_ORDER) {
    const publishIndex = fixture.events.findIndex(
      (event, index) => index > previousPublish && event[0] === "publish" && event[1] === name,
    )
    const latestNames = new Set(
      fixture.events
        .slice(previousPublish + 1, publishIndex)
        .filter(([operation]) => operation === "metadata")
        .map(([, packageName]) => packageName),
    )
    assert.deepEqual([...latestNames].sort(), [...CANONICAL_RELEASE_PACKAGE_ORDER].sort())
    previousPublish = publishIndex
  }
})

test("matching existing packages are a no-op and mismatched registry bytes stop before mutation", async () => {
  const existing = publisherFixture({ initiallyPresent: "all" })
  const repeated = await publishManifestSerially(existing.inputs)
  assert.equal(repeated.status, "NPM_COMPLETE")
  assert.deepEqual(existing.publishCalls, [])

  const mismatch = publisherFixture({ initiallyPresent: [0], corruptRegistryIndex: 0 })
  await assert.rejects(
    publishManifestSerially(mismatch.inputs),
    /registry tarball|digest|bytes.*match/iu,
  )
  assert.deepEqual(mismatch.publishCalls, [])
})

test("runner loss after first, middle, or last acceptance resumes without republishing", async () => {
  for (const failureIndex of [0, 10, 20]) {
    const fixture = publisherFixture({ failAfterAcceptIndex: failureIndex })

    await assert.rejects(publishManifestSerially(fixture.inputs), /simulated runner loss/u)
    assert.deepEqual(
      fixture.publishCalls,
      CANONICAL_RELEASE_PACKAGE_ORDER.slice(0, failureIndex + 1),
    )

    fixture.disableFailure()
    const resumed = await publishManifestSerially(fixture.inputs)
    assert.equal(resumed.status, "NPM_COMPLETE")
    assert.deepEqual(fixture.publishCalls, CANONICAL_RELEASE_PACKAGE_ORDER)

    await publishManifestSerially(fixture.inputs)
    assert.deepEqual(fixture.publishCalls, CANONICAL_RELEASE_PACKAGE_ORDER)
  }
})

test("polls delayed exact metadata, signature, provenance, and latest before advancing", async () => {
  const fixture = publisherFixture({ delayedIndex: 0, initiallyPresent: "except-delayed" })

  await publishManifestSerially(fixture.inputs)

  assert.deepEqual(fixture.publishCalls, [CANONICAL_RELEASE_PACKAGE_ORDER[0]])
  assert.ok(fixture.pollCalls.length >= 4)
  assert.ok(fixture.pollCalls.every(({ name }) => name === CANONICAL_RELEASE_PACKAGE_ORDER[0]))
})

test("raw npm signature records never satisfy publication verification", async () => {
  const fixture = publisherFixture({ initiallyPresent: "all", rawSignatureIndex: 0 })

  await assert.rejects(
    publishManifestSerially(fixture.inputs),
    /registry did not converge|signature/iu,
  )

  assert.deepEqual(fixture.publishCalls, [])
})

test("a newer latest is a pre-mutation superseded no-op but conflicts with partial state", async () => {
  const superseded = publisherFixture({ newerLatestIndex: 0 })
  const result = await publishManifestSerially(superseded.inputs)
  assert.equal(result.status, "SUPERSEDED_NOOP")
  assert.equal(result.complete, false)
  assert.deepEqual(superseded.publishCalls, [])

  const partial = publisherFixture({ initiallyPresent: [0], newerLatestIndex: 1 })
  await assert.rejects(publishManifestSerially(partial.inputs), /newer latest|partial.*conflict/iu)
  assert.deepEqual(partial.publishCalls, [])
})

test("rechecks latest immediately before every mutation and stops on ambiguous observations", async () => {
  const raced = publisherFixture({ newerLatestOnSecondMetadataRead: 0 })
  const result = await publishManifestSerially(raced.inputs)
  assert.equal(result.status, "SUPERSEDED_NOOP")
  assert.deepEqual(raced.publishCalls, [])

  const exactVersionWindow = publisherFixture({ newerLatestAfterVersionRecheckIndex: 0 })
  const exactVersionWindowResult = await publishManifestSerially(exactVersionWindow.inputs)
  assert.equal(exactVersionWindowResult.status, "SUPERSEDED_NOOP")
  assert.deepEqual(exactVersionWindow.publishCalls, [])
  assert.equal(exactVersionWindow.events.at(-1)?.[0], "metadata")

  const ambiguous = publisherFixture({ ambiguousVersionIndex: 0 })
  await assert.rejects(publishManifestSerially(ambiguous.inputs), /ambiguous|registry.*verified/iu)
  assert.deepEqual(ambiguous.publishCalls, [])
})

test("complete npm evidence is exact, canonical, ordered, and bound to every manifest entry", async () => {
  const manifest = releaseManifest()
  const result = await publishManifestSerially(publisherFixture({ initiallyPresent: "all" }).inputs)
  const context = {
    candidate: CANDIDATE,
    manifestSha256: releaseRecord(manifest).manifestSha256,
    manifest,
  }

  const parsed = parseNpmEvidence(result, context)
  assert.deepEqual(parsed, result)
  assert.deepEqual(
    parsed.packages.map(({ name }) => name),
    CANONICAL_RELEASE_PACKAGE_ORDER,
  )
  assert.ok(Object.isFrozen(parsed))
  assert.deepEqual(JSON.parse(canonicalNpmEvidenceBytes(result, context)), parsed)

  for (const mutate of [
    (value) => value.packages.reverse(),
    (value) => value.packages.pop(),
    (value) => value.packages.push({ ...value.packages[0] }),
    (value) => {
      value.packages[0].name = "unknown-package"
    },
    (value) => {
      value.packages[0].status = "absent"
    },
    (value) => {
      value.packages[0].signature.keyid = "noncanonical"
    },
    (value) => {
      value.packages[0].provenance.ref = "refs/heads/main"
    },
    (value) => {
      value.packages[0].tarballSha256 = "f".repeat(64)
    },
    (value) => {
      value.packages[0].unexpected = true
    },
  ]) {
    const malformed = structuredClone(result)
    mutate(malformed)
    assert.throws(() => parseNpmEvidence(malformed, context), /npm evidence|package|manifest/iu)
  }

  const accessor = structuredClone(result)
  let getterReads = 0
  Object.defineProperty(accessor.packages[0], "name", {
    enumerable: true,
    get() {
      getterReads += 1
      return CANONICAL_RELEASE_PACKAGE_ORDER[0]
    },
  })
  assert.throws(() => parseNpmEvidence(accessor, context), /JSON|field|evidence/iu)
  assert.equal(getterReads, 0)

  const unsafe = structuredClone(result)
  Object.defineProperty(unsafe.packages[0], "__proto__", {
    enumerable: true,
    value: { polluted: true },
  })
  assert.throws(() => parseNpmEvidence(unsafe, context), /unknown|field|evidence/iu)
  assert.equal(Object.prototype.polluted, undefined)

  const oversized = structuredClone(result)
  oversized.padding = "x".repeat(1024 * 1024)
  assert.throws(() => parseNpmEvidence(oversized, context), /byte|large|evidence/iu)
})

test("rejects a reordered or incomplete sealed manifest before registry reads", async () => {
  for (const mutate of [
    (manifest) => manifest.packageOrder.reverse(),
    (manifest) => manifest.packages.pop(),
  ]) {
    const fixture = publisherFixture()
    mutate(fixture.inputs.manifest)
    await assert.rejects(
      publishManifestSerially(fixture.inputs),
      /packageOrder|package set|packages/iu,
    )
    assert.equal(fixture.observeCalls.length, 0)
  }
})

test("the production CLI accepts only its narrow arguments and publishes exact recorded tgzs", async (t) => {
  const temporary = await realpath(await mkdtemp(path.join(os.tmpdir(), "dawn-publisher-cli-")))
  t.after(() => rm(temporary, { recursive: true, force: true }))
  const artifactDir = path.join(temporary, "artifact")
  const inputDir = path.join(temporary, "input")
  const outputDir = path.join(temporary, "output")
  await Promise.all([mkdir(artifactDir), mkdir(inputDir), mkdir(outputDir)])
  const manifest = releaseManifest()
  const record = releaseRecord(manifest)
  const candidatePath = path.join(inputDir, "candidate.json")
  const recordPath = path.join(inputDir, "release-record.json")
  const reportPath = path.join(outputDir, "publish.json")
  const githubOutputPath = path.join(outputDir, "github-output")
  await writeFile(candidatePath, `${JSON.stringify(CANDIDATE)}\n`)
  await writeFile(recordPath, canonicalReleaseRecordBytes(record))
  await writeFile(path.join(artifactDir, "manifest.json"), canonicalManifestBytes(manifest))
  for (const entry of manifest.packages) {
    await writeFile(path.join(artifactDir, entry.filename), tarballBytes(entry.name))
  }

  assert.deepEqual(
    parsePublisherArguments([
      "--candidate",
      candidatePath,
      "--record",
      recordPath,
      "--artifact-dir",
      artifactDir,
      "--report",
      reportPath,
      "--github-output",
      githubOutputPath,
    ]),
    { candidatePath, recordPath, artifactDir, reportPath, githubOutputPath },
  )
  for (const args of [
    [],
    ["--candidate", candidatePath],
    [
      "--candidate",
      candidatePath,
      "--record",
      recordPath,
      "--artifact-dir",
      artifactDir,
      "--report",
      reportPath,
      "--github-output",
      githubOutputPath,
      "--repack",
      "true",
    ],
  ]) {
    assert.throws(() => parsePublisherArguments(args), /Usage|argument/iu)
  }

  const fixture = publisherFixture({ initiallyPresent: "all-except-last" })
  const npmCalls = []
  const result = await runPublisherCli(
    [
      "--candidate",
      candidatePath,
      "--record",
      recordPath,
      "--artifact-dir",
      artifactDir,
      "--report",
      reportPath,
      "--github-output",
      githubOutputPath,
    ],
    {
      npmReader: fixture.npmReader,
      async runNpm(command, args) {
        npmCalls.push([command, ...args])
        fixture.acceptPublish(args[1])
        return { stdout: "", stderr: "" }
      },
      poll: fixture.inputs.poll,
      log() {},
    },
  )

  const last = manifest.packages.at(-1)
  assert.equal(result.status, "NPM_COMPLETE")
  assert.deepEqual(npmCalls, [
    [
      "npm",
      "publish",
      path.join(artifactDir, last.filename),
      "--tag",
      "latest",
      "--access",
      "public",
      "--provenance",
      "--ignore-scripts",
    ],
  ])
  const report = JSON.parse(await readFile(reportPath, "utf8"))
  assert.deepEqual(Object.keys(report).sort(), [
    "commitSha",
    "complete",
    "manifestSha256",
    "packages",
    "schemaVersion",
    "status",
    "version",
  ])
  assert.equal(report.complete, true)
  assert.equal(report.status, "NPM_COMPLETE")
  assert.equal(report.manifestSha256, record.manifestSha256)
  assert.deepEqual(
    report.packages.map(({ name }) => name),
    CANONICAL_RELEASE_PACKAGE_ORDER,
  )
  assert.ok(report.packages.every((entry) => entry.signature.status === "valid"))
  assert.equal(await readFile(githubOutputPath, "utf8"), "complete=true\nstate=NPM_COMPLETE\n")
})

test("the publisher rejects missing, extra, symlinked, and hardlinked artifact payloads", async (t) => {
  for (const kind of ["missing", "extra", "symlink", "hardlink"]) {
    await t.test(kind, async (t) => {
      const fixture = await publisherCliFilesystem(t, `dawn-publisher-${kind}-`)
      const first = fixture.manifest.packages[0]
      const firstPath = path.join(fixture.artifactDir, first.filename)
      if (kind === "missing") {
        await rm(firstPath)
      } else if (kind === "extra") {
        await writeFile(path.join(fixture.artifactDir, "unexpected.tgz"), Buffer.from("extra"))
      } else if (kind === "symlink") {
        const external = path.join(fixture.temporary, "external.tgz")
        await writeFile(external, tarballBytes(first.name))
        await rm(firstPath)
        await symlink(external, firstPath)
      } else {
        await link(firstPath, path.join(fixture.temporary, "outside-hardlink.tgz"))
      }
      const registry = publisherFixture({ initiallyPresent: "all" })
      await assert.rejects(
        runPublisherCli(fixture.argv, {
          npmReader: registry.npmReader,
          async runNpm() {
            throw new Error("npm must not run")
          },
          poll: registry.inputs.poll,
          log() {},
        }),
        /artifact|file set|regular file|ENOENT/iu,
      )
      assert.equal(registry.observeCalls.length, 0)
    })
  }
})

test("the publisher detects artifact mutation after initial verification and during npm publish", async (t) => {
  const beforePublish = await publisherCliFilesystem(t, "dawn-publisher-mutated-before-")
  const beforeRegistry = publisherFixture({ initiallyPresent: "all-except-last" })
  const beforeTarget = path.join(
    beforePublish.artifactDir,
    beforePublish.manifest.packages.at(-1).filename,
  )
  const observeMetadata = beforeRegistry.npmReader.observePackageMetadata.bind(
    beforeRegistry.npmReader,
  )
  let mutated = false
  beforeRegistry.npmReader.observePackageMetadata = async (request) => {
    if (!mutated) {
      mutated = true
      await writeFile(beforeTarget, Buffer.from("mutated after artifact verification"))
    }
    return observeMetadata(request)
  }
  let npmCalls = 0
  await assert.rejects(
    runPublisherCli(beforePublish.argv, {
      npmReader: beforeRegistry.npmReader,
      async runNpm() {
        npmCalls += 1
      },
      poll: beforeRegistry.inputs.poll,
      log() {},
    }),
    /local tarball|release manifest|match/iu,
  )
  assert.equal(npmCalls, 0)

  const duringPublish = await publisherCliFilesystem(t, "dawn-publisher-mutated-during-")
  const duringRegistry = publisherFixture({ initiallyPresent: "all-except-last" })
  const duringTarget = path.join(
    duringPublish.artifactDir,
    duringPublish.manifest.packages.at(-1).filename,
  )
  await assert.rejects(
    runPublisherCli(duringPublish.argv, {
      npmReader: duringRegistry.npmReader,
      async runNpm(_command, args) {
        await writeFile(duringTarget, Buffer.from("mutated while npm accepted publication"))
        duringRegistry.acceptPublish(args[1])
      },
      poll: duringRegistry.inputs.poll,
      log() {},
    }),
    /local tarball|release manifest|match/iu,
  )
  await assert.rejects(access(duringPublish.reportPath))
})

test("the production publisher deadline cancels registry reads and poll delays", async (t) => {
  assert.equal(PUBLISHER_OVERALL_TIMEOUT_MS, 25 * 60_000)
  const metadataFixture = await publisherCliFilesystem(t, "dawn-publisher-deadline-metadata-")
  let metadataSignal
  const metadataReader = {
    async observePackageMetadata({ signal }) {
      metadataSignal = signal
      await new Promise((resolve) => setTimeout(resolve, 100))
      return {
        status: "AMBIGUOUS",
        operation: "package-metadata",
        httpStatus: null,
        code: "TIMEOUT",
      }
    },
    async observePackageVersion() {
      throw new Error("version must not be observed")
    },
    async downloadRegistryTarball() {
      throw new Error("tarball must not be downloaded")
    },
    async verifyRegistrySignatures() {
      throw new Error("signature must not be verified")
    },
  }
  const metadataStarted = Date.now()
  await assert.rejects(
    runPublisherCli(metadataFixture.argv, {
      npmReader: metadataReader,
      async runNpm() {
        throw new Error("npm must not run")
      },
      async poll() {},
      log() {},
      overallTimeoutMs: 20,
    }),
    /publisher overall deadline/iu,
  )
  assert.ok(Date.now() - metadataStarted < 90)
  assert.ok(metadataSignal instanceof AbortSignal)
  assert.equal(metadataSignal.aborted, true)

  const pollFixture = await publisherCliFilesystem(t, "dawn-publisher-deadline-poll-")
  const delayed = publisherFixture({ initiallyPresent: "all" })
  delayed.npmReader.verifyRegistrySignatures = async () => ({
    status: "PRESENT",
    operation: "registry-signature",
    httpStatus: null,
    code: null,
    signature: { status: "missing", keyid: null },
  })
  let pollSignal
  await assert.rejects(
    runPublisherCli(pollFixture.argv, {
      npmReader: delayed.npmReader,
      async runNpm() {
        throw new Error("npm must not run")
      },
      async poll({ signal }) {
        pollSignal = signal
        await new Promise((resolve) => setTimeout(resolve, 100))
      },
      log() {},
      overallTimeoutMs: 20,
    }),
    /publisher overall deadline/iu,
  )
  assert.ok(pollSignal instanceof AbortSignal)
  assert.equal(pollSignal.aborted, true)
})

test("the production publisher deadline preserves OIDC and terminates the npm subprocess tree", {
  skip: process.platform === "win32",
  timeout: 10_000,
}, async (t) => {
  const cli = await publisherCliFilesystem(t, "dawn-publisher-deadline-process-")
  const registry = publisherFixture({ initiallyPresent: "all-except-last" })
  const binDir = path.join(cli.temporary, "bin")
  const descendantPath = path.join(cli.temporary, "descendant.pid")
  const oidcPath = path.join(cli.temporary, "oidc.json")
  await mkdir(binDir)
  const npmPath = path.join(binDir, "npm")
  await writeFile(
    npmPath,
    `#!/usr/bin/env node
const { spawn } = require("node:child_process")
const { writeFileSync } = require("node:fs")
writeFileSync(${JSON.stringify(oidcPath)}, JSON.stringify({
  token: process.env.ACTIONS_ID_TOKEN_REQUEST_TOKEN,
  url: process.env.ACTIONS_ID_TOKEN_REQUEST_URL,
}))
const descendant = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" })
writeFileSync(${JSON.stringify(descendantPath)}, String(descendant.pid))
setInterval(() => {}, 1000)
`,
  )
  await chmod(npmPath, 0o755)
  const environment = {
    PATH: `${binDir}:${path.dirname(process.execPath)}`,
    ACTIONS_ID_TOKEN_REQUEST_TOKEN: "exact-oidc-token",
    ACTIONS_ID_TOKEN_REQUEST_URL: "https://token.actions.githubusercontent.com/exact",
  }

  await assert.rejects(
    runPublisherCli(cli.argv, {
      npmReader: registry.npmReader,
      poll: registry.inputs.poll,
      log() {},
      environment,
      overallTimeoutMs: 500,
    }),
    /publisher overall deadline/iu,
  )
  assert.deepEqual(JSON.parse(await readFile(oidcPath, "utf8")), {
    token: environment.ACTIONS_ID_TOKEN_REQUEST_TOKEN,
    url: environment.ACTIONS_ID_TOKEN_REQUEST_URL,
  })
  const descendantPid = Number(await readFile(descendantPath, "utf8"))
  await waitForProcessExit(descendantPid)
})

test("the exact sparse production sequence resolves Actions and expired escrow into identical publish evidence", {
  timeout: 60_000,
}, async (t) => {
  const fixture = await sparseProductionFixture(t)
  assert.deepEqual(
    await listFilesRecursively(fixture.sparseRoot),
    [
      "release-input/candidate.json",
      "release-input/release-record.json",
      ...fixture.sparseScripts,
    ].sort(),
  )
  for (const forbidden of [
    "package.json",
    "pnpm-lock.yaml",
    "scripts/release/candidate.mjs",
    "scripts/release/cli.mjs",
    "scripts/release/controller.mjs",
    "scripts/release/inventory.mjs",
    "scripts/release/preflight.mjs",
  ]) {
    await assert.rejects(access(path.join(fixture.sparseRoot, forbidden)))
  }

  const successful = []
  for (const scenario of ["actions", "escrow"]) {
    const outcome = await runSparseProductionSequence(fixture, scenario)
    assert.equal(outcome.resolve.status, 0, outcome.resolve.stderr)
    assert.equal(outcome.publish.status, 0, outcome.publish.stderr)
    assert.deepEqual(
      await readdir(outcome.materializedDir),
      ["manifest.json", ...fixture.manifest.packages.map(({ filename }) => filename)].sort(),
    )
    const payload = []
    for (const name of await readdir(outcome.materializedDir)) {
      const target = path.join(outcome.materializedDir, name)
      const metadata = await lstat(target)
      assert.equal(metadata.isFile(), true)
      assert.equal(metadata.isSymbolicLink(), false)
      assert.equal(metadata.nlink, 1)
      payload.push([name, (await readFile(target)).toString("base64")])
    }
    const commands = await readJsonLines(outcome.commandLog)
    assert.equal(commands.filter(({ command }) => command === "npm").length, 0)
    const ghCalls = commands.filter(({ command }) => command === "gh")
    assert.equal(ghCalls.length, 22)
    assert.ok(
      ghCalls.every(
        ({ args }) =>
          args[0] === "attestation" &&
          args[1] === "verify" &&
          args.includes("--repo") &&
          args.includes("--source-digest") &&
          args.includes("--source-ref") &&
          args.includes("--predicate-type") &&
          (scenario === "escrow" ? args.includes("--bundle") : !args.includes("--bundle")),
      ),
    )
    const reportBytes = await readFile(outcome.reportPath)
    const report = parseNpmEvidence(reportBytes, {
      candidate: CANDIDATE,
      manifestSha256: fixture.record.manifestSha256,
      manifest: fixture.manifest,
    })
    assert.equal(report.complete, true)
    assert.deepEqual(
      report.packages.map(({ name }) => name),
      CANONICAL_RELEASE_PACKAGE_ORDER,
    )
    successful.push({ payload, reportBytes })
  }
  assert.deepEqual(successful[0].payload, successful[1].payload)
  assert.deepEqual(successful[0].reportBytes, successful[1].reportBytes)

  for (const scenario of ["auth", "timeout", "malformed", "nonretention"]) {
    const outcome = await runSparseProductionSequence(fixture, scenario)
    assert.notEqual(outcome.resolve.status, 0, scenario)
    assert.equal(outcome.publish, null)
    await assert.rejects(access(outcome.materializedDir))
    const commands = await readJsonLines(outcome.commandLog)
    assert.equal(
      commands.some(({ command }) => command === "npm"),
      false,
    )
    const fetches = await readJsonLines(outcome.fetchLog)
    assert.equal(
      fetches.some(({ url }) => url.includes("/releases")),
      false,
    )
  }
})

test("the publisher sparse allowlist equals its local import closure and excludes workspace inputs", async () => {
  const releaseRoot = path.resolve(import.meta.dirname, "..")
  const repositoryRoot = path.resolve(releaseRoot, "../..")
  const discovered = new Set()
  const visit = async (absolutePath) => {
    const repositoryPath = path.relative(repositoryRoot, absolutePath)
    if (discovered.has(repositoryPath)) return
    discovered.add(repositoryPath)
    const source = await readFile(absolutePath, "utf8")
    for (const match of source.matchAll(/from\s+["'](\.{1,2}\/[^"']+)["']/gu)) {
      await visit(path.resolve(path.dirname(absolutePath), match[1]))
    }
  }
  await visit(path.join(releaseRoot, "publisher.mjs"))

  assert.deepEqual([...discovered].sort(), PUBLISHER_SPARSE_FILES)
  for (const forbidden of [
    "inventory.mjs",
    "candidate.mjs",
    "controller.mjs",
    "cli.mjs",
    "preflight.mjs",
  ]) {
    assert.ok(!PUBLISHER_SPARSE_FILES.includes(`scripts/release/${forbidden}`))
  }
  assert.ok(!PUBLISHER_SPARSE_FILES.some((entry) => entry === "package.json"))
  await assert.rejects(access(path.join(releaseRoot, "publisher.mjs.not-present")))
})

async function sparseProductionFixture(t) {
  const repositoryRoot = path.resolve(import.meta.dirname, "../../..")
  const temporary = await realpath(
    await mkdtemp(path.join(os.tmpdir(), "dawn-publisher-sparse-production-")),
  )
  t.after(() => rm(temporary, { recursive: true, force: true }))
  const sparseRoot = path.join(temporary, "sparse")
  const harnessRoot = path.join(temporary, "harness")
  const binDir = path.join(harnessRoot, "bin")
  await Promise.all([
    mkdir(path.join(sparseRoot, "release-input"), { recursive: true }),
    mkdir(binDir, { recursive: true }),
  ])

  const sparseScripts = [
    ...new Set([...ARTIFACT_STORE_SPARSE_FILES, ...PUBLISHER_SPARSE_FILES]),
  ].sort()
  for (const repositoryPath of sparseScripts) {
    const target = path.join(sparseRoot, repositoryPath)
    await mkdir(path.dirname(target), { recursive: true })
    await copyFile(path.join(repositoryRoot, repositoryPath), target)
  }

  const manifest = releaseManifest()
  const artifactFiles = [
    { name: "manifest.json", bytes: canonicalManifestBytes(manifest) },
    ...manifest.packages.map((entry) => ({
      name: entry.filename,
      bytes: tarballBytes(entry.name),
    })),
  ]
  const archive = storedZip(artifactFiles)
  const serviceDigest = `sha256:${createHash("sha256").update(archive).digest("hex")}`
  const record = releaseRecord(manifest, serviceDigest)
  await writeFile(
    path.join(sparseRoot, "release-input/candidate.json"),
    `${JSON.stringify(CANDIDATE)}\n`,
  )
  await writeFile(
    path.join(sparseRoot, "release-input/release-record.json"),
    canonicalReleaseRecordBytes(record),
  )

  const { publicKey, privateKey } = generateKeyPairSync("ec", { namedCurve: "P-256" })
  const keyid = "SHA256:sparse-production-key"
  const npmPackages = manifest.packages.map((entry) => {
    const tarballUrl = new URL(`${entry.name}/-/${entry.filename}`, "https://registry.npmjs.org/")
      .href
    const metadataUrl = new URL(encodeURIComponent(entry.name), "https://registry.npmjs.org/").href
    const versionUrl = new URL(
      `${encodeURIComponent(entry.name)}/${encodeURIComponent(entry.version)}`,
      "https://registry.npmjs.org/",
    ).href
    const provenanceUrl = new URL(
      `/-/npm/v1/attestations/${npmAttestationName(entry.name)}@${entry.version}`,
      "https://registry.npmjs.org/",
    ).href
    const integrity = entry.npmIntegrity
    const signature = signBytes(
      "sha256",
      Buffer.from(`${entry.name}@${entry.version}:${integrity}`),
      privateKey,
    ).toString("base64")
    const statement = {
      predicateType: "https://slsa.dev/provenance/v1",
      subject: [
        {
          name: npmSubjectName(entry.name, entry.version),
          digest: { sha512: entry.sha512 },
        },
      ],
      predicate: {
        buildDefinition: {
          externalParameters: {
            workflow: {
              path: CANDIDATE.publisherWorkflow,
              repository: "https://github.com/cacheplane/dawnai",
              ref: `refs/tags/v${VERSION}`,
            },
          },
          resolvedDependencies: [
            {
              uri: `git+https://github.com/cacheplane/dawnai@refs/tags/v${VERSION}`,
              digest: { gitCommit: COMMIT_SHA },
            },
          ],
        },
      },
    }
    return {
      name: entry.name,
      version: entry.version,
      metadataUrl,
      versionUrl,
      tarballUrl,
      provenanceUrl,
      tarballBase64: tarballBytes(entry.name).toString("base64"),
      versionDocument: {
        name: entry.name,
        version: entry.version,
        dist: {
          tarball: tarballUrl,
          shasum: createHash("sha1").update(tarballBytes(entry.name)).digest("hex"),
          integrity,
          signatures: [{ keyid, sig: signature }],
          attestations: { url: provenanceUrl },
        },
      },
      metadataDocument: { name: entry.name, "dist-tags": { latest: VERSION } },
      provenanceDocument: {
        attestations: [
          {
            predicateType: "https://slsa.dev/provenance/v1",
            bundle: {
              dsseEnvelope: {
                payload: Buffer.from(JSON.stringify(statement)).toString("base64"),
              },
            },
          },
        ],
      },
    }
  })
  const escrowAssets = []
  let assetId = 1_000
  for (const file of [
    { name: "release-record.json", bytes: canonicalReleaseRecordBytes(record) },
    ...artifactFiles,
    ...artifactFiles.map((file) => ({
      name: `${file.name}.intoto.jsonl`,
      bytes: Buffer.from(`bundle:${file.name}`),
    })),
  ]) {
    escrowAssets.push({
      id: assetId,
      name: file.name,
      size: file.bytes.length,
      contentBase64: Buffer.from(file.bytes).toString("base64"),
    })
    assetId += 1
  }
  assert.equal(escrowAssets.length, 45)

  const fixturePath = path.join(harnessRoot, "fixture.json")
  await writeFile(
    fixturePath,
    `${JSON.stringify({
      record,
      archiveBase64: archive.toString("base64"),
      release: { id: 77, assets: escrowAssets },
      npm: {
        key: {
          expires: null,
          key: publicKey.export({ format: "der", type: "spki" }).toString("base64"),
          keyid,
          keytype: "ecdsa-sha2-nistp256",
          scheme: "ecdsa-sha2-nistp256",
        },
        packages: npmPackages,
      },
    })}\n`,
  )
  const fetchShimPath = path.join(harnessRoot, "fetch-shim.mjs")
  await writeFile(fetchShimPath, sparseFetchShimSource())
  for (const command of ["gh", "npm"]) {
    const target = path.join(binDir, command)
    await writeFile(target, fakeSparseCommandSource(command))
    await chmod(target, 0o755)
  }
  return {
    sparseRoot,
    sparseScripts,
    harnessRoot,
    binDir,
    fixturePath,
    fetchShimPath,
    manifest,
    record,
  }
}

async function runSparseProductionSequence(fixture, scenario) {
  const runRoot = path.join(fixture.sparseRoot, "runs", scenario)
  const outputRoot = path.join(runRoot, "release-output")
  await mkdir(outputRoot, { recursive: true })
  const materializedDir = path.join(runRoot, "release-materialized")
  const reportPath = path.join(outputRoot, "publish.json")
  const githubOutputPath = path.join(outputRoot, "github-output")
  const commandLog = path.join(fixture.harnessRoot, `${scenario}-commands.jsonl`)
  const fetchLog = path.join(fixture.harnessRoot, `${scenario}-fetches.jsonl`)
  await Promise.all([writeFile(commandLog, ""), writeFile(fetchLog, "")])
  const environment = {
    ...process.env,
    PATH: `${fixture.binDir}:${path.dirname(process.execPath)}:${process.env.PATH ?? ""}`,
    NODE_OPTIONS: `--import=${pathToFileURL(fixture.fetchShimPath).href}`,
    DAWN_SPARSE_FIXTURE: fixture.fixturePath,
    DAWN_SPARSE_SCENARIO: scenario,
    DAWN_COMMAND_LOG: commandLog,
    DAWN_FETCH_LOG: fetchLog,
    GITHUB_API_URL: "https://api.github.com",
    GITHUB_REPOSITORY: "cacheplane/dawnai",
    GITHUB_TOKEN: "fixture-token",
  }
  const resolve = spawnSync(
    process.execPath,
    [
      "scripts/release/artifact-store.mjs",
      "resolve",
      "--record",
      "release-input/release-record.json",
      "--output-dir",
      path.relative(fixture.sparseRoot, materializedDir),
    ],
    {
      cwd: fixture.sparseRoot,
      env: environment,
      encoding: "utf8",
      timeout: 20_000,
    },
  )
  let publish = null
  if (resolve.status === 0) {
    publish = spawnSync(
      process.execPath,
      [
        "scripts/release/publisher.mjs",
        "--candidate",
        "release-input/candidate.json",
        "--record",
        "release-input/release-record.json",
        "--artifact-dir",
        path.relative(fixture.sparseRoot, materializedDir),
        "--report",
        path.relative(fixture.sparseRoot, reportPath),
        "--github-output",
        path.relative(fixture.sparseRoot, githubOutputPath),
      ],
      {
        cwd: fixture.sparseRoot,
        env: environment,
        encoding: "utf8",
        timeout: 20_000,
      },
    )
  }
  return {
    resolve,
    publish,
    materializedDir,
    reportPath,
    githubOutputPath,
    commandLog,
    fetchLog,
  }
}

function sparseFetchShimSource() {
  return `import { appendFileSync, readFileSync } from "node:fs"

const fixture = JSON.parse(readFileSync(process.env.DAWN_SPARSE_FIXTURE, "utf8"))
const scenario = process.env.DAWN_SPARSE_SCENARIO
const fetchLog = process.env.DAWN_FETCH_LOG
if (scenario === "timeout") {
  const nativeSetTimeout = globalThis.setTimeout
  globalThis.setTimeout = (callback, delay, ...args) =>
    nativeSetTimeout(callback, delay === 15_000 ? 10 : delay, ...args)
}

const json = (value, status = 200) =>
  new Response(JSON.stringify(value), {
    status,
    headers: { "content-type": "application/json" },
  })
const binary = (value, status = 200) =>
  new Response(value, {
    status,
    headers: { "content-type": "application/octet-stream" },
  })
const api = "https://api.github.com/repos/cacheplane/dawnai"
const artifactUrl = \`\${api}/actions/artifacts/\${fixture.record.actionsArtifact.id}\`
const attemptUrl = \`\${api}/actions/runs/\${fixture.record.actionsArtifact.prepareRunId}/attempts/\${fixture.record.actionsArtifact.prepareRunAttempt}\`
const downloadUrl = \`\${artifactUrl}/zip\`

globalThis.fetch = async (input, init = {}) => {
  const url = String(input)
  appendFileSync(fetchLog, JSON.stringify({ url }) + "\\n")
  if (url === artifactUrl) {
    if (scenario === "auth") return json({ code: "EAUTH" }, 401)
    if (scenario === "malformed") {
      return new Response("{", { headers: { "content-type": "application/json" } })
    }
    if (scenario === "timeout") {
      return new Promise((_resolve, reject) => {
        const fail = () => reject(new DOMException("fixture timeout", "AbortError"))
        if (init.signal?.aborted === true) fail()
        else init.signal?.addEventListener("abort", fail, { once: true })
      })
    }
    return json({
      id: Number(fixture.record.actionsArtifact.id),
      name: fixture.record.actionsArtifact.name,
      digest: fixture.record.actionsArtifact.serviceDigest,
      expired: scenario !== "actions",
      workflow_run: {
        id: Number(fixture.record.actionsArtifact.prepareRunId),
        head_sha: fixture.record.commitSha,
      },
    })
  }
  if (url === attemptUrl) {
    return json({
      id: Number(fixture.record.actionsArtifact.prepareRunId),
      run_attempt: fixture.record.actionsArtifact.prepareRunAttempt,
      head_sha: fixture.record.commitSha,
    })
  }
  if (url === downloadUrl) {
    if (scenario === "actions") return binary(Buffer.from(fixture.archiveBase64, "base64"))
    if (scenario === "escrow") return binary(Buffer.alloc(0), 410)
    return binary(Buffer.from("non-retention failure"), 500)
  }
  if (url === \`\${api}/releases?per_page=100\`) {
    return json([
      {
        id: fixture.release.id,
        name: \`Dawn \${fixture.record.tag}\`,
        tag_name: fixture.record.tag,
        target_commitish: fixture.record.commitSha,
        draft: true,
        prerelease: false,
      },
    ])
  }
  if (url === \`\${api}/releases/\${fixture.release.id}/assets?per_page=100\`) {
    return json(fixture.release.assets.map(({ id, name, size }) => ({ id, name, size })))
  }
  const asset = fixture.release.assets.find(
    ({ id }) => url === \`\${api}/releases/assets/\${id}\`,
  )
  if (asset !== undefined) return binary(Buffer.from(asset.contentBase64, "base64"))

  if (url === "https://registry.npmjs.org/-/npm/v1/keys") {
    return json({ keys: [fixture.npm.key] })
  }
  for (const pkg of fixture.npm.packages) {
    if (url === pkg.metadataUrl) return json(pkg.metadataDocument)
    if (url === pkg.versionUrl) return json(pkg.versionDocument)
    if (url === pkg.provenanceUrl) return json(pkg.provenanceDocument)
    if (url === pkg.tarballUrl) return binary(Buffer.from(pkg.tarballBase64, "base64"))
  }
  throw new Error(\`Unexpected sparse fixture URL: \${url}\`)
}
`
}

function fakeSparseCommandSource(command) {
  return `#!/usr/bin/env node
const { appendFileSync } = require("node:fs")
appendFileSync(process.env.DAWN_COMMAND_LOG, JSON.stringify({
  command: ${JSON.stringify(command)},
  args: process.argv.slice(2),
}) + "\\n")
process.exit(${command === "gh" ? 0 : 97})
`
}

async function listFilesRecursively(root) {
  const files = []
  const visit = async (directory) => {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const absolute = path.join(directory, entry.name)
      if (entry.isDirectory()) await visit(absolute)
      else files.push(path.relative(root, absolute))
    }
  }
  await visit(root)
  return files.sort()
}

async function readJsonLines(target) {
  const source = await readFile(target, "utf8")
  return source.length === 0
    ? []
    : source
        .trimEnd()
        .split("\n")
        .map((line) => JSON.parse(line))
}

async function waitForProcessExit(pid) {
  const deadline = Date.now() + 3_000
  while (Date.now() < deadline) {
    try {
      process.kill(pid, 0)
    } catch (error) {
      if (error?.code === "ESRCH") return
      throw error
    }
    await new Promise((resolve) => setTimeout(resolve, 20))
  }
  assert.fail(`publisher descendant process ${pid} survived deadline termination`)
}

function npmAttestationName(name) {
  const slash = name.indexOf("/")
  return slash === -1
    ? encodeURIComponent(name)
    : `${name.slice(0, slash)}%2f${name.slice(slash + 1)}`
}

function npmSubjectName(name, version) {
  if (!name.startsWith("@")) return `pkg:npm/${name}@${version}`
  const [scope, packageName] = name.split("/")
  return `pkg:npm/${encodeURIComponent(scope)}/${packageName}@${version}`
}

function storedZip(files) {
  const locals = []
  const centrals = []
  let offset = 0
  for (const file of files) {
    const name = Buffer.from(file.name)
    const bytes = Buffer.from(file.bytes)
    const local = Buffer.alloc(30 + name.length + bytes.length)
    local.writeUInt32LE(0x04034b50, 0)
    local.writeUInt16LE(20, 4)
    local.writeUInt16LE(0, 6)
    local.writeUInt16LE(0, 8)
    local.writeUInt32LE(bytes.length, 18)
    local.writeUInt32LE(bytes.length, 22)
    local.writeUInt16LE(name.length, 26)
    name.copy(local, 30)
    bytes.copy(local, 30 + name.length)
    locals.push(local)

    const central = Buffer.alloc(46 + name.length)
    central.writeUInt32LE(0x02014b50, 0)
    central.writeUInt16LE(20, 4)
    central.writeUInt16LE(20, 6)
    central.writeUInt16LE(0, 8)
    central.writeUInt16LE(0, 10)
    central.writeUInt32LE(bytes.length, 20)
    central.writeUInt32LE(bytes.length, 24)
    central.writeUInt16LE(name.length, 28)
    central.writeUInt32LE(offset, 42)
    name.copy(central, 46)
    centrals.push(central)
    offset += local.length
  }
  const centralOffset = offset
  const centralSize = centrals.reduce((total, entry) => total + entry.length, 0)
  const end = Buffer.alloc(22)
  end.writeUInt32LE(0x06054b50, 0)
  end.writeUInt16LE(files.length, 8)
  end.writeUInt16LE(files.length, 10)
  end.writeUInt32LE(centralSize, 12)
  end.writeUInt32LE(centralOffset, 16)
  return Buffer.concat([...locals, ...centrals, end])
}

async function publisherCliFilesystem(t, prefix) {
  const temporary = await realpath(await mkdtemp(path.join(os.tmpdir(), prefix)))
  t.after(() => rm(temporary, { recursive: true, force: true }))
  const artifactDir = path.join(temporary, "artifact")
  const inputDir = path.join(temporary, "input")
  const outputDir = path.join(temporary, "output")
  await Promise.all([mkdir(artifactDir), mkdir(inputDir), mkdir(outputDir)])
  const manifest = releaseManifest()
  const record = releaseRecord(manifest)
  const candidatePath = path.join(inputDir, "candidate.json")
  const recordPath = path.join(inputDir, "release-record.json")
  const reportPath = path.join(outputDir, "publish.json")
  const githubOutputPath = path.join(outputDir, "github-output")
  await writeFile(candidatePath, `${JSON.stringify(CANDIDATE)}\n`)
  await writeFile(recordPath, canonicalReleaseRecordBytes(record))
  await writeFile(path.join(artifactDir, "manifest.json"), canonicalManifestBytes(manifest))
  for (const entry of manifest.packages) {
    await writeFile(path.join(artifactDir, entry.filename), tarballBytes(entry.name))
  }
  return {
    temporary,
    artifactDir,
    manifest,
    record,
    reportPath,
    githubOutputPath,
    argv: [
      "--candidate",
      candidatePath,
      "--record",
      recordPath,
      "--artifact-dir",
      artifactDir,
      "--report",
      reportPath,
      "--github-output",
      githubOutputPath,
    ],
  }
}

function publisherFixture(overrides = {}) {
  const manifest = releaseManifest()
  const present = new Map()
  const publishCalls = []
  const observeCalls = []
  const pollCalls = []
  const events = []
  const metadataReads = new Map()
  const versionReads = new Map()
  const newerAfterVersionRecheck = new Set()
  let failureEnabled = true
  let activePublishes = 0
  const concurrentPublishes = { maximum: 0 }

  if (overrides.initiallyPresent === "all") {
    for (const entry of manifest.packages) present.set(entry.name, { ready: 4 })
  } else if (overrides.initiallyPresent === "all-except-last") {
    for (const entry of manifest.packages.slice(0, -1)) present.set(entry.name, { ready: 4 })
  } else if (overrides.initiallyPresent === "except-delayed") {
    for (const entry of manifest.packages) {
      if (entry.name !== manifest.packages[overrides.delayedIndex].name) {
        present.set(entry.name, { ready: 4 })
      }
    }
  } else if (Array.isArray(overrides.initiallyPresent)) {
    for (const index of overrides.initiallyPresent) {
      present.set(manifest.packages[index].name, { ready: 4 })
    }
  }

  const observeRegistry = async ({ name, version }) => {
    observeCalls.push({ name, ...(version === undefined ? {} : { version }) })
    events.push([version === undefined ? "metadata" : "version", name])
    const index = CANONICAL_RELEASE_PACKAGE_ORDER.indexOf(name)
    if (version === undefined) {
      const reads = (metadataReads.get(name) ?? 0) + 1
      metadataReads.set(name, reads)
      const newer =
        overrides.newerLatestIndex === index ||
        (overrides.newerLatestOnSecondMetadataRead === index && reads >= 2) ||
        newerAfterVersionRecheck.has(index)
      const state = present.get(name)
      return {
        status: "PRESENT",
        operation: "package-metadata",
        httpStatus: 200,
        code: null,
        metadata: {
          name,
          latest: newer ? "0.9.0" : state?.ready >= 4 ? VERSION : "0.8.20",
        },
      }
    }
    if (overrides.ambiguousVersionIndex === index) {
      return {
        status: "AMBIGUOUS",
        operation: "package-version",
        httpStatus: 401,
        code: "EAUTH",
      }
    }
    const reads = (versionReads.get(name) ?? 0) + 1
    versionReads.set(name, reads)
    if (overrides.newerLatestAfterVersionRecheckIndex === index && reads >= 2) {
      newerAfterVersionRecheck.add(index)
    }
    const state = present.get(name)
    if (state === undefined || state.ready === 0) {
      return {
        status: "ABSENT",
        operation: "package-version",
        httpStatus: 404,
        code: "E404",
      }
    }
    return registryObservation(
      manifest.packages[index],
      state.ready,
      overrides.corruptRegistryIndex === index,
      overrides.rawSignatureIndex === index,
    )
  }
  const downloadRegistryTarball = async ({ tarballUrl }) => {
    const entry = manifest.packages.find((candidate) => registryUrl(candidate) === tarballUrl)
    if (entry === undefined) throw new Error("unknown fixture tarball URL")
    const index = manifest.packages.indexOf(entry)
    const bytes =
      overrides.corruptRegistryIndex === index ? Buffer.from("corrupt") : tarballBytes(entry.name)
    return tarballDownload(entry, bytes)
  }
  const publishTarball = async ({ entry }) => {
    activePublishes += 1
    concurrentPublishes.maximum = Math.max(concurrentPublishes.maximum, activePublishes)
    try {
      publishCalls.push(entry.name)
      events.push(["publish", entry.name])
      const index = manifest.packages.findIndex(({ name }) => name === entry.name)
      present.set(entry.name, { ready: overrides.delayedIndex === index ? 0 : 4 })
      if (failureEnabled && overrides.failAfterAcceptIndex === index) {
        throw new Error("simulated runner loss")
      }
    } finally {
      activePublishes -= 1
    }
  }
  const poll = async ({ name, attempt }) => {
    pollCalls.push({ name, attempt })
    const state = present.get(name)
    if (state !== undefined && state.ready < 4) state.ready += 1
  }
  const npmReader = {
    observePackageMetadata({ name }) {
      return observeRegistry({ name })
    },
    observePackageVersion({ name, version }) {
      return observeRegistry({ name, version })
    },
    downloadRegistryTarball,
    async verifyRegistrySignatures({ signatures }) {
      return {
        status: "PRESENT",
        operation: "registry-signature",
        httpStatus: signatures.length === 0 ? null : 200,
        code: null,
        signature:
          signatures.length === 0
            ? { status: "missing", keyid: null }
            : { status: "valid", keyid: "SHA256:key" },
      }
    },
  }
  return {
    inputs: {
      candidate: { ...CANDIDATE },
      manifest,
      observeRegistry,
      downloadRegistryTarball,
      publishTarball,
      poll,
      log() {},
    },
    npmReader,
    publishCalls,
    observeCalls,
    pollCalls,
    events,
    concurrentPublishes,
    disableFailure() {
      failureEnabled = false
    },
    acceptPublish(tarballPath) {
      const entry = manifest.packages.find(({ filename }) => tarballPath.endsWith(filename))
      if (entry === undefined) throw new Error("unknown fixture publish tarball")
      publishCalls.push(entry.name)
      present.set(entry.name, { ready: 4 })
    },
  }
}

function releaseManifest() {
  return {
    schemaVersion: 1,
    version: VERSION,
    commitSha: COMMIT_SHA,
    ci: { workflow: "CI", runId: 100, runAttempt: 1 },
    artifact: {
      name: `release-v${VERSION}-${COMMIT_SHA.slice(0, 12)}`,
      prepareRunId: 200,
      prepareRunAttempt: 1,
    },
    packageOrder: [...CANONICAL_RELEASE_PACKAGE_ORDER],
    packages: CANONICAL_RELEASE_PACKAGE_ORDER.map((name) => packageEntry(name)),
  }
}

function packageEntry(name) {
  const bytes = tarballBytes(name)
  const sha512 = createHash("sha512").update(bytes).digest("hex")
  return {
    name,
    version: VERSION,
    filename: `${tarballStem(name)}-${VERSION}.tgz`,
    size: bytes.length,
    sha256: createHash("sha256").update(bytes).digest("hex"),
    sha512,
    npmIntegrity: `sha512-${Buffer.from(sha512, "hex").toString("base64")}`,
    access: "public",
  }
}

function releaseRecord(manifest, serviceDigest = `sha256:${"a".repeat(64)}`) {
  return {
    schemaVersion: 1,
    version: VERSION,
    commitSha: COMMIT_SHA,
    tag: `v${VERSION}`,
    manifestSha256: createHash("sha256").update(canonicalManifestBytes(manifest)).digest("hex"),
    actionsArtifact: {
      id: "123456789",
      name: manifest.artifact.name,
      serviceDigest,
      prepareRunId: "200",
      prepareRunAttempt: 1,
    },
  }
}

function registryObservation(entry, ready, corrupt, rawSignature) {
  const bytes = corrupt ? Buffer.from("corrupt") : tarballBytes(entry.name)
  return {
    status: "PRESENT",
    operation: "package-version",
    httpStatus: 200,
    code: null,
    package: {
      name: entry.name,
      version: entry.version,
      tarballUrl: registryUrl(entry),
      shasum: createHash("sha1").update(bytes).digest("hex"),
      integrity: entry.npmIntegrity,
      signatures: ready >= 2 ? [{ keyid: "SHA256:key", sig: "signature" }] : [],
      ...(rawSignature
        ? {}
        : {
            signature:
              ready >= 2
                ? { status: "valid", keyid: "SHA256:key" }
                : { status: "missing", keyid: null },
          }),
      distTags: { latest: ready >= 4 ? VERSION : "0.8.20" },
      latest: ready >= 4 ? VERSION : "0.8.20",
      provenance:
        ready >= 3
          ? {
              status: "PRESENT",
              url: `https://registry.npmjs.org/-/npm/v1/attestations/${encodeURIComponent(entry.name)}@${VERSION}`,
              predicateTypes: ["https://slsa.dev/provenance/v1"],
              workflow: CANDIDATE.publisherWorkflow,
              commitSha: COMMIT_SHA,
              repository: "https://github.com/cacheplane/dawnai",
              ref: `refs/tags/v${VERSION}`,
            }
          : {
              status: "ABSENT",
              url: null,
              predicateTypes: [],
              workflow: null,
              commitSha: null,
              repository: null,
              ref: null,
            },
    },
  }
}

function tarballDownload(entry, bytes) {
  return {
    status: "PRESENT",
    operation: "package-tarball",
    httpStatus: 200,
    code: null,
    tarball: {
      url: registryUrl(entry),
      size: bytes.length,
      sha1: createHash("sha1").update(bytes).digest("hex"),
      sha256: createHash("sha256").update(bytes).digest("hex"),
      sha512: createHash("sha512").update(bytes).digest("hex"),
      contentBase64: bytes.toString("base64"),
    },
  }
}

function registryUrl(entry) {
  return `https://registry.npmjs.org/${entry.name}/-/${entry.filename}`
}

function tarballBytes(name) {
  return Buffer.from(`packed:${name}`)
}

function tarballStem(name) {
  return name.startsWith("@") ? name.slice(1).replaceAll("/", "-") : name
}
