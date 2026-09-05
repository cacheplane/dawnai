import assert from "node:assert/strict"
import test from "node:test"

const engine = await import("../smoke-result.mjs")

for (const [file, name] of [
  ["runtime-targets", "executeRuntimeTargetsSmoke"],
  ["scaffold", "executeScaffoldSmoke"],
  ["storage", "executeStorageSmoke"],
  ["published-harness", "executePublishedHarnessSmoke"],
]) {
  test(`${file} exposes the actual operation independently of v1 receipts`, async () => {
    const module = await import(`../smoke/${file}.mjs`)
    assert.equal(typeof module[name], "function")
    const checks = []
    const stop = new Error("stop after containment")
    await assert.rejects(
      module[name](
        { version: "0.8.24" },
        {
          async check(name, _detail, operation) {
            checks.push(name)
            return operation()
          },
          deferCleanup() {
            assert.fail("must stop before cleanup registration")
          },
        },
        {
          strictRunner: {
            async probe() {
              throw stop
            },
            async runCommand() {
              assert.fail()
            },
          },
        },
      ),
      (error) => error === stop,
    )
    assert.deepEqual(checks, ["containment"])
  })
}

test("shared check engine records failed cleanup without any receipt or GitHub identity", async () => {
  assert.equal(typeof engine.executeSmokeOperation, "function")
  const error = new Error("cleanup failed")
  const result = await engine.executeSmokeOperation(async ({ check, deferCleanup }) => {
    deferCleanup("cleanup", "removed", async () => {
      throw error
    })
    await check("probe", "passed", async () => 42)
  })
  assert.equal(result.conclusion, "failure")
  assert.deepEqual(result.errors, [error])
  assert.deepEqual(
    result.checks.map(({ name, conclusion }) => ({ name, conclusion })),
    [
      { name: "probe", conclusion: "success" },
      { name: "cleanup", conclusion: "failure" },
    ],
  )
  assert.equal(Object.hasOwn(result, "schemaVersion"), false)
})

test("metadata exposes exact verification independently of the receipt protocol", async () => {
  const module = await import("../../published-artifact-verify.mjs")
  assert.equal(typeof module.executeReleaseMetadataVerify, "function")
  const failure = new Error("containment failed")
  const result = await module.executeReleaseMetadataVerify(
    {},
    {
      strictRunner: {
        async probe() {
          throw failure
        },
        async runCommand() {
          assert.fail()
        },
      },
      env: {},
    },
  )
  assert.deepEqual(result.failures, [failure])
  assert.deepEqual(result.fatalErrors, [failure])
  assert.deepEqual(
    result.checks.map(({ name, conclusion }) => ({ name, conclusion })),
    [{ name: "containment", conclusion: "failure" }],
  )
  assert.equal(Object.hasOwn(result, "schemaVersion"), false)
})

const recovery = await import("../recovery/smoke.mjs").catch(() => ({}))
const { candidate, executor, wireFixtures } = await import("./support/recovery-fixture.mjs")
const { mkdtemp, mkdir, writeFile, rm } = await import("node:fs/promises")
const { tmpdir } = await import("node:os")
const { join } = await import("node:path")
const integrity = `sha512-${Buffer.alloc(64, 1).toString("base64")}`

async function installedFixture() {
  const root = await mkdtemp(join(tmpdir(), "dawn-recovery-tree-"))
  await mkdir(join(root, "node_modules/@dawn-ai/sdk/node_modules/transitive"), {
    recursive: true,
  })
  await writeFile(
    join(root, "package.json"),
    JSON.stringify({ dependencies: { "@dawn-ai/sdk": "0.8.24" } }),
  )
  await writeFile(
    join(root, "node_modules/@dawn-ai/sdk/package.json"),
    JSON.stringify({
      name: "@dawn-ai/sdk",
      version: "0.8.24",
      dependencies: { transitive: "^1.0.0" },
    }),
  )
  await writeFile(
    join(root, "node_modules/@dawn-ai/sdk/node_modules/transitive/package.json"),
    JSON.stringify({ name: "transitive", version: "1.0.1" }),
  )
  const packages = {
    "node_modules/@dawn-ai/sdk": {
      version: "0.8.24",
      resolved: "https://registry.npmjs.org/@dawn-ai/sdk/-/sdk-0.8.24.tgz",
      integrity,
    },
    "node_modules/@dawn-ai/sdk/node_modules/transitive": {
      version: "1.0.1",
      resolved: "https://registry.npmjs.org/transitive/-/transitive-1.0.1.tgz",
      integrity,
    },
  }
  await writeFile(
    join(root, "node_modules/.package-lock.json"),
    JSON.stringify({ lockfileVersion: 3, packages }),
  )
  return { root, packages }
}

test("physical installed inventory includes nested transitive resolution and rejects missing lock paths", async () => {
  assert.equal(typeof recovery.readInstalledResolutions, "function")
  const { root, packages } = await installedFixture()
  try {
    const tree = await recovery.readInstalledResolutions(root, candidate())
    assert.equal(tree.length, 2)
    assert.equal(tree[0].subject, true)
    assert.equal(tree[1].requested, "^1.0.0")
    assert.equal(tree[1].installPath, "node_modules/@dawn-ai/sdk/node_modules/transitive")
    delete packages[tree[1].installPath]
    await writeFile(
      join(root, "node_modules/.package-lock.json"),
      JSON.stringify({ lockfileVersion: 3, packages }),
    )
    await assert.rejects(recovery.readInstalledResolutions(root, candidate()), /lock|inventory/u)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test("candidate A is probed by executor B with real operations and complete install sidecar before cleanup", async () => {
  assert.equal(typeof recovery.runRecoverySmoke, "function")
  const { root } = await installedFixture()
  let receipt
  const writes = []
  const commands = []
  let removed = false
  try {
    const result = await recovery.runRecoverySmoke(
      {
        lane: "runtime-targets",
        candidate: candidate(),
        executor: executor(),
        policySha256: wireFixtures().intent.policySha256,
        result: join(root, "receipt.json"),
      },
      {
        strictRunner: {
          async probe() {},
          async runCommand(command, args, options) {
            const { assertStrictSmokeCommandOptions } = await import("../smoke-process-runner.mjs")
            assertStrictSmokeCommandOptions(options)
            commands.push([command, args])
            return {
              stdout: args[0] === "--version" ? "11.19.0\n" : "",
              stderr: "",
            }
          },
        },
        async makeTempDir() {
          return root
        },
        async removeDir() {
          removed = true
        },
        async writeProbeFiles() {},
        async writeEvidence(path, bytes) {
          assert.equal(removed, false)
          writes.push({ path, bytes })
        },
        async writeResult(_path, value) {
          receipt = value
        },
      },
    )
    assert.equal(result.conclusion, "success")
    assert.equal(receipt.candidate.candidateSha, "a".repeat(40))
    assert.equal(receipt.executor.controllerSha, "c".repeat(40))
    assert.equal(receipt.environment.node, process.versions.node)
    assert.equal(receipt.environment.packageManager, "npm@11.19.0")
    assert.equal(receipt.installations[0].count, 2)
    assert.equal(writes.length, 1)
    assert.ok(commands.some(([cmd, args]) => cmd === "npm" && args.includes("@dawn-ai/sdk@0.8.24")))
    assert.ok(
      receipt.checks.some(
        (check) => check.name === "edge-import" && check.conclusion === "success",
      ),
    )
    assert.equal(removed, true)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test("recovery records cleanup failure and containment failure without inventing package evidence", async () => {
  assert.equal(typeof recovery.runRecoverySmoke, "function")
  let receipt
  const failure = new Error("containment unavailable")
  await assert.rejects(
    recovery.runRecoverySmoke(
      {
        lane: "runtime-targets",
        candidate: candidate(),
        executor: executor(),
        policySha256: wireFixtures().intent.policySha256,
        result: "/tmp/recovery-test-result.json",
      },
      {
        strictRunner: {
          async probe() {
            throw failure
          },
          async runCommand() {
            assert.fail()
          },
        },
        async writeResult(_path, value) {
          receipt = value
        },
      },
    ),
    (error) => error === failure,
  )
  assert.equal(receipt.conclusion, "failure")
  assert.deepEqual(receipt.resolutions, [])
  assert.deepEqual(receipt.installations, [])
  assert.equal(receipt.environment.packageManager, null)
})

test("recovery cleanup error remains a failure after successful mandatory probes", async () => {
  const { root } = await installedFixture()
  let receipt
  try {
    await assert.rejects(
      recovery.runRecoverySmoke(
        {
          lane: "runtime-targets",
          candidate: candidate(),
          executor: executor(),
          policySha256: wireFixtures().intent.policySha256,
          result: join(root, "receipt.json"),
        },
        {
          strictRunner: {
            async probe() {},
            async runCommand(_cmd, args) {
              return {
                stdout: args[0] === "--version" ? "11.19.0" : "",
                stderr: "",
              }
            },
          },
          async makeTempDir() {
            return root
          },
          async removeDir() {
            throw new Error("bad cleanup")
          },
          async writeProbeFiles() {},
          async writeEvidence() {},
          async writeResult(_path, value) {
            receipt = value
          },
        },
      ),
      /bad cleanup/u,
    )
    assert.equal(receipt.conclusion, "failure")
    assert.equal(receipt.checks.find((item) => item.name === "cleanup").conclusion, "failure")
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

for (const [alias, name] of [
  ["aliased", "actual"],
  ["@scope/alias", "@real/package"],
]) {
  test(`physical npm alias ${alias} preserves actual package identity and selector`, async () => {
    const { root, packages } = await installedFixture()
    try {
      const installPath = `node_modules/${alias}`
      await mkdir(join(root, installPath), { recursive: true })
      await writeFile(
        join(root, installPath, "package.json"),
        JSON.stringify({ name, version: "1.2.3" }),
      )
      packages[installPath] = {
        name,
        version: "1.2.3",
        resolved: `https://registry.npmjs.org/${name}/-/package-1.2.3.tgz`,
        integrity,
      }
      await writeFile(
        join(root, "node_modules/.package-lock.json"),
        JSON.stringify({ lockfileVersion: 3, packages }),
      )
      await writeFile(
        join(root, "package.json"),
        JSON.stringify({
          dependencies: {
            "@dawn-ai/sdk": "0.8.24",
            [alias]: `npm:${name}@^1.2.0`,
          },
        }),
      )
      const resolutions = await recovery.readInstalledResolutions(root, candidate())
      const { parseRecovery } = await import("../recovery/schema.mjs")
      const sidecar = {
        schemaVersion: 2,
        kind: "recovery-installation",
        candidate: candidate(),
        executor: executor(),
        policySha256: wireFixtures().intent.policySha256,
        lane: "runtime-targets",
        check: "exact-install",
        resolutions,
      }
      assert.equal(
        parseRecovery(sidecar).resolutions.find((item) => item.installPath === installPath).name,
        name,
      )
      resolutions.find((item) => item.installPath === installPath).requested = "^1.2.0"
      assert.throws(() => parseRecovery(sidecar), /identity/u)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })
}

test("sandbox source captures original and replacement executed image identities without losing PID assertions", async () => {
  const { dockerSandboxInstalledProbeSource } = await import("../../published-artifact-smoke.mjs")
  const source = dockerSandboxInstalledProbeSource(`published-uuid-${"a".repeat(32)}`, {
    imageEvidencePath: "docker-image.json",
  })
  assert.match(source, /\.Config\.Image/u)
  assert.match(source, /originalImage/u)
  assert.match(source, /replacementImage/u)
  assert.match(source, /assert\.notEqual\(replacementKeeperId, originalKeeperId/u)
  assert.match(source, /await provider\.destroy\(threadId\)/u)
})

test("complete tree rejects a mandatory dependency absent from both disk and lock", async () => {
  const { root } = await installedFixture()
  try {
    await writeFile(
      join(root, "node_modules/@dawn-ai/sdk/package.json"),
      JSON.stringify({
        name: "@dawn-ai/sdk",
        version: "0.8.24",
        dependencies: { transitive: "^1.0.0", missing: "^1.0.0" },
      }),
    )
    await assert.rejects(recovery.readInstalledResolutions(root, candidate()), /required.*missing/u)
    await writeFile(
      join(root, "node_modules/@dawn-ai/sdk/package.json"),
      JSON.stringify({
        name: "@dawn-ai/sdk",
        version: "0.8.24",
        dependencies: { transitive: "^1.0.0" },
        optionalDependencies: { missing: "^1.0.0" },
        peerDependencies: { optionalPeer: "^1.0.0" },
        peerDependenciesMeta: { optionalPeer: { optional: true } },
      }),
    )
    assert.equal((await recovery.readInstalledResolutions(root, candidate())).length, 2)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test("installation evidence writer supports the separately bounded sidecar size", async () => {
  const { writeCanonicalFileNoClobber } = await import("../smoke-result.mjs")
  const root = await mkdtemp(join(tmpdir(), "dawn-recovery-sidecar-"))
  try {
    const bytes = Buffer.alloc(300 * 1024, 32)
    await writeCanonicalFileNoClobber(join(root, "sidecar.json"), bytes, {}, 1024 * 1024)
    await assert.rejects(
      writeCanonicalFileNoClobber(join(root, "legacy.json"), bytes),
      /byte limit/u,
    )
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test("multiple physical incoming selectors are retained as sorted unique values", async () => {
  const { root } = await installedFixture()
  try {
    await writeFile(
      join(root, "node_modules/@dawn-ai/sdk/package.json"),
      JSON.stringify({
        name: "@dawn-ai/sdk",
        version: "0.8.24",
        dependencies: { transitive: "^1.0.0" },
        peerDependencies: { transitive: "~1.0.1" },
      }),
    )
    const tree = await recovery.readInstalledResolutions(root, candidate())
    assert.deepEqual(tree[1].requested, ["^1.0.0", "~1.0.1"])
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test("installed manifest input is bounded before retaining package metadata", async () => {
  const { root } = await installedFixture()
  try {
    await writeFile(
      join(root, "node_modules/@dawn-ai/sdk/package.json"),
      JSON.stringify({
        name: "@dawn-ai/sdk",
        version: "0.8.24",
        dependencies: { transitive: "^1.0.0" },
        padding: "x".repeat(256 * 1024),
      }),
    )
    await assert.rejects(
      recovery.readInstalledResolutions(root, candidate()),
      /bound|limit|262144/u,
    )
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test("AG-UI captures its actual install before a subsequent tsc failure", async () => {
  const { runAgUiInstalledProbe } = await import("../../published-artifact-smoke.mjs")
  const root = await mkdtemp(join(tmpdir(), "dawn-recovery-agui-"))
  const seen = []
  try {
    await assert.rejects(
      runAgUiInstalledProbe(root, {
        async runCommand(_command, args) {
          seen.push(args[0])
          if (args[0] === "exec") throw new Error("tsc failed")
          return { stdout: "", stderr: "" }
        },
        async captureInstallation() {
          seen.push("captured")
        },
      }),
      /tsc failed/u,
    )
    assert.deepEqual(seen, ["smoke-ag-ui.mjs", "install", "captured", "exec"])
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

const { createHash } = await import("node:crypto")
const { CANONICAL_RELEASE_PACKAGE_ORDER, canonicalManifestBytes } = await import("../manifest.mjs")
const { EXACT_NPM_PROVENANCE_CERTIFICATE } = await import("./fixtures/npm-audit-certificates.mjs")

for (const lane of ["metadata", "published-harness", "scaffold", "storage"]) {
  test(`${lane} recovery executes mandatory candidate-A checks with executor-B identity`, async () => {
    const { root, packages } = await installedFixture()
    const version = lane === "published-harness" ? "0.8.22" : "0.8.24"
    if (lane === "published-harness") {
      packages["node_modules/@dawn-ai/sdk"].version = version
      packages["node_modules/@dawn-ai/sdk"].resolved =
        `https://registry.npmjs.org/@dawn-ai/sdk/-/sdk-${version}.tgz`
      await writeFile(
        join(root, "package.json"),
        JSON.stringify({ dependencies: { "@dawn-ai/sdk": version } }),
      )
      await writeFile(
        join(root, "node_modules/@dawn-ai/sdk/package.json"),
        JSON.stringify({
          name: "@dawn-ai/sdk",
          version,
          dependencies: { transitive: "^1.0.0" },
        }),
      )
      await writeFile(
        join(root, "node_modules/.package-lock.json"),
        JSON.stringify({ lockfileVersion: 3, packages }),
      )
    }
    const manifest = releaseManifest(version, candidate().candidateSha)
    const bytes = canonicalManifestBytes(manifest)
    const c = {
      ...candidate(),
      version,
      tag: `v${version}`,
      manifestSha256: createHash("sha256").update(bytes).digest("hex"),
    }
    const seen = []
    const sidecars = []
    let receipt
    const { cp } = await import("node:fs/promises")
    try {
      if (lane === "scaffold") {
        for (const directory of ["installer", "app"]) {
          const fixture = await installedFixture()
          await cp(fixture.root, join(root, directory), { recursive: true })
          await rm(fixture.root, { recursive: true, force: true })
        }
      }
      await recovery.runRecoverySmoke(
        {
          lane,
          candidate: c,
          executor: executor(),
          policySha256: wireFixtures().intent.policySha256,
          result: join(root, "result.json"),
          manifest: join(root, "manifest.json"),
        },
        {
          strictRunner: {
            async probe() {},
            async runCommand(command, args, options) {
              const { assertStrictSmokeCommandOptions } = await import(
                "../smoke-process-runner.mjs"
              )
              assertStrictSmokeCommandOptions(options)
              seen.push([command, args])
              if (args[0] === "--version") return { stdout: "11.19.0", stderr: "" }
              if (args[0] === "audit") return { stdout: auditOutput(manifest), stderr: "" }
              if (command === "docker" && args.includes("--format"))
                return {
                  stdout: JSON.stringify({
                    Config: {
                      Image: args.at(-1).includes("pgvector")
                        ? "pgvector/pgvector:pg16"
                        : "postgres:16",
                    },
                    Image: `sha256:${"d".repeat(64)}`,
                  }),
                  stderr: "",
                }
              if (command === "docker" && args.includes("inspect"))
                throw Object.assign(new Error("missing"), {
                  exitCode: 1,
                  stderr: `Error: No such ${args[0] === "volume" ? "volume" : "object"}: ${args.at(-1)}`,
                })
              return { stdout: "", stderr: "" }
            },
          },
          async makeTempDir() {
            return root
          },
          async removeDir() {
            seen.push(["cleanup", []])
          },
          async readManifest() {
            return lane === "metadata" ? bytes : manifest
          },
          async createNpmReader() {
            return {}
          },
          async createNpmAuditVerifier() {
            return {
              async verifyPackage() {},
              async dispose() {
                seen.push(["audit-dispose", []])
              },
            }
          },
          async verifyReleasePackage(entry, context) {
            assert.equal(entry.version, c.version)
            assert.equal(context.candidate.commitSha, c.candidateSha)
            seen.push(["verify", [entry.name]])
          },
          async verifyExactScaffold(_root, version) {
            assert.equal(version, c.version)
          },
          async runAgUiProbe(_root, capture) {
            await capture()
          },
          async runTypeScriptProbe(_root, capture) {
            await capture()
          },
          async runDockerProbe() {
            await writeFile(
              join(root, "docker-image.json"),
              `${JSON.stringify({ digest: `sha256:${"d".repeat(64)}`, reference: "node:22-slim" })}\n`,
            )
          },
          async runHarnessAssertion(_root, _lane, version) {
            assert.equal(version, c.version)
          },
          async startDatabase() {
            return "postgres://test"
          },
          async stopContainer() {},
          async runPgvectorProbe() {},
          async runPostgresProbe() {},
          async writeEvidence(file, bytes) {
            sidecars.push({ file, bytes })
          },
          async writeResult(_file, value) {
            receipt = value
          },
        },
      )
      assert.equal(receipt.conclusion, "success")
      assert.equal(receipt.executor.controllerSha, "c".repeat(40))
      assert.equal(receipt.candidate.candidateSha, "a".repeat(40))
      assert.ok(receipt.checks.every((item) => item.conclusion === "success"))
      const { RECOVERY_INSTALL_CHECKS } = await import("../recovery/schema.mjs")
      assert.deepEqual(
        receipt.installations.map((item) => item.check),
        RECOVERY_INSTALL_CHECKS[lane],
      )
      assert.equal(sidecars.length, RECOVERY_INSTALL_CHECKS[lane].length)
      if (lane === "metadata")
        assert.equal(
          seen.filter(([command]) => command === "verify").length,
          CANONICAL_RELEASE_PACKAGE_ORDER.length,
        )
      if (lane === "storage")
        assert.deepEqual(
          receipt.environment.dockerImages.map((item) => item.reference),
          ["pgvector/pgvector:pg16", "postgres:16"],
        )
      if (lane === "published-harness")
        assert.deepEqual(receipt.environment.dockerImages, [
          { reference: "node:22-slim", digest: `sha256:${"d".repeat(64)}` },
        ])
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })
}

function auditOutput(release, packages = CANONICAL_RELEASE_PACKAGE_ORDER, drift = {}) {
  const version = drift.version ?? release.version
  return JSON.stringify({
    invalid: [],
    missing: [],
    verified: packages.map((name) => {
      const entry = release.packages.find((item) => item.name === name)
      const repository = drift.repository ?? "https://github.com/cacheplane/dawnai"
      const workflow = drift.workflow ?? ".github/workflows/release.yml"
      const ref = drift.ref ?? `refs/tags/v${release.version}`
      const commitSha = drift.commitSha ?? release.commitSha
      const subjectName = drift.subjectName ?? npmSubjectName(name, version)
      const subjectSha512 = drift.subjectSha512 ?? entry.sha512
      const statement = {
        _type: "https://in-toto.io/Statement/v1",
        subject: [{ name: subjectName, digest: { sha512: subjectSha512 } }],
        predicateType: "https://slsa.dev/provenance/v1",
        predicate: {
          buildDefinition: {
            buildType: "https://slsa-framework.github.io/github-actions-buildtypes/workflow/v1",
            externalParameters: {
              workflow: { ref, repository, path: workflow },
            },
            internalParameters: { github: { event_name: "push" } },
            resolvedDependencies: [
              {
                uri: `git+${repository}@${ref}`,
                digest: { gitCommit: commitSha },
              },
            ],
          },
          runDetails: {
            builder: { id: "https://github.com/actions/runner/github-hosted" },
            metadata: {
              invocationId: "https://github.com/cacheplane/dawnai/actions/runs/801/attempts/1",
            },
          },
        },
      }
      return {
        name,
        version,
        location: `node_modules/${name}`,
        // npm 11.17.0 serializes the exact public registry without a trailing slash.
        registry: "https://registry.npmjs.org",
        attestations: drift.attestations ?? {
          url: `https://registry.npmjs.org/-/npm/v1/attestations/${encodeURIComponent(name)}@${version}`,
          provenance: { predicateType: "https://slsa.dev/provenance/v1" },
        },
        attestationBundles: [
          {
            predicateType: "https://github.com/npm/attestation/tree/main/specs/publish/v0.1",
            bundle: {
              mediaType: "application/vnd.dev.sigstore.bundle+json;version=0.2",
              verificationMaterial: {
                publicKey: { hint: "SHA256:test" },
                tlogEntries: [{}],
                timestampVerificationData: { rfc3161Timestamps: [] },
              },
              dsseEnvelope: {
                payload: Buffer.from("{}", "utf8").toString("base64"),
                payloadType: "application/vnd.in-toto+json",
                signatures: [{ sig: "verified-by-npm", keyid: "SHA256:test" }],
              },
            },
            signedAccessSignatureUrl: "",
          },
          {
            predicateType: "https://slsa.dev/provenance/v1",
            bundle: {
              mediaType: "application/vnd.dev.sigstore.bundle.v0.3+json",
              verificationMaterial: {
                certificate: { rawBytes: EXACT_NPM_PROVENANCE_CERTIFICATE },
                tlogEntries: [{}],
                timestampVerificationData: { rfc3161Timestamps: [] },
              },
              dsseEnvelope: {
                payload: Buffer.from(JSON.stringify(statement), "utf8").toString("base64"),
                payloadType: "application/vnd.in-toto+json",
                signatures: [{ sig: "verified-by-npm", keyid: "" }],
              },
            },
            signedAccessSignatureUrl: "",
          },
        ],
      }
    }),
  })
}

function releaseManifest(version, commitSha) {
  return {
    schemaVersion: 1,
    version,
    commitSha,
    ci: { workflow: "CI", runId: 100, runAttempt: 1 },
    artifact: {
      name: `release-v${version}-${commitSha.slice(0, 12)}`,
      prepareRunId: 200,
      prepareRunAttempt: 1,
    },
    packageOrder: [...CANONICAL_RELEASE_PACKAGE_ORDER],
    packages: CANONICAL_RELEASE_PACKAGE_ORDER.map((name) => {
      const bytes = Buffer.from(`published-${name}`)
      const sha512 = createHash("sha512").update(bytes).digest("hex")
      return {
        name,
        version,
        filename: `${name.startsWith("@") ? name.slice(1).replace("/", "-") : name}-${version}.tgz`,
        size: bytes.length,
        sha256: createHash("sha256").update(bytes).digest("hex"),
        sha512,
        npmIntegrity: `sha512-${Buffer.from(sha512, "hex").toString("base64")}`,
        access: "public",
      }
    }),
  }
}

function npmSubjectName(name, version) {
  if (!name.startsWith("@")) return `pkg:npm/${name}@${version}`
  const [scope, packageName] = name.split("/")
  return `pkg:npm/${encodeURIComponent(scope)}/${packageName}@${version}`
}
