import assert from "node:assert/strict"
import { createHash } from "node:crypto"
import test from "node:test"

import { CANONICAL_RELEASE_PACKAGE_ORDER, canonicalManifestBytes } from "../manifest.mjs"
import {
  runPublishedHarnessSmoke,
  validateNpmAuditSignatures,
} from "../smoke/published-harness.mjs"
import { parseSmokeResult } from "../smoke-result.mjs"
import { EXACT_NPM_PROVENANCE_CERTIFICATE } from "./fixtures/npm-audit-certificates.mjs"

const VERSION = "0.8.22"
const COMMIT_SHA = "a".repeat(40)
const manifest = releaseManifest(VERSION, COMMIT_SHA)
const options = Object.freeze({
  version: VERSION,
  commitSha: COMMIT_SHA,
  manifestSha256: createHash("sha256").update(canonicalManifestBytes(manifest)).digest("hex"),
  manifest: "/inputs/manifest.json",
  result: "/results/published-harness.json",
})

test("installs the exact public fixed group, verifies npm signatures, and runs clean harness lanes", async () => {
  const commands = []
  const lanes = []
  let cleaned = false
  let receipt
  await runPublishedHarnessSmoke(options, {
    env: { GITHUB_RUN_ID: "801", GITHUB_RUN_ATTEMPT: "1" },
    now: clock(),
    async makeTempDir() {
      return "/tmp/published-harness"
    },
    async readManifest() {
      return manifest
    },
    async removeDir() {
      cleaned = true
    },
    async runCommand(command, args, runOptions) {
      commands.push({
        command,
        args,
        cwd: runOptions.cwd,
        acceptedExitCodes: runOptions.acceptedExitCodes,
      })
      if (args[0] === "audit") return { stdout: auditOutput(manifest), stderr: "" }
      return { stdout: "", stderr: "" }
    },
    async runHarnessAssertion(_root, lane, version) {
      lanes.push({ lane, version })
    },
    async runAgUiProbe() {
      lanes.push({ lane: "ag-ui", version: options.version })
    },
    async runTypeScriptProbe() {
      lanes.push({ lane: "typescript-tooling", version: options.version })
    },
    async runDockerProbe() {
      lanes.push({ lane: "docker-pid-recovery", version: options.version })
    },
    async writeFile(_path, bytes) {
      receipt = parseSmokeResult(bytes)
    },
    async mkdir() {},
  })

  const install = commands.find(({ command, args }) => command === "npm" && args[0] === "install")
  assert.deepEqual(
    install.args.filter((argument) => argument.includes("@0.8.22")).sort(),
    CANONICAL_RELEASE_PACKAGE_ORDER.map((name) => `${name}@0.8.22`).sort(),
  )
  assert.equal(
    commands.some(
      ({ command, args }) =>
        command === "npm" && args.join(" ") === "audit signatures --json --include-attestations",
    ),
    true,
  )
  const audit = commands.find(({ command, args }) => command === "npm" && args[0] === "audit")
  assert.deepEqual(audit.acceptedExitCodes, [0, 1])
  assert.equal(
    commands.some(({ args }) => /verdaccio|workspace:|file:|publish/u.test(args.join(" "))),
    false,
  )
  assert.deepEqual(lanes, [
    { lane: "ag-ui", version: "0.8.22" },
    { lane: "typescript-tooling", version: "0.8.22" },
    { lane: "docker-pid-recovery", version: "0.8.22" },
    { lane: "framework", version: "0.8.22" },
    { lane: "runtime", version: "0.8.22" },
    { lane: "smoke", version: "0.8.22" },
  ])
  assert.equal(cleaned, true)
  assert.equal(receipt.conclusion, "success")
  assert.equal(receipt.lane, "published-harness")
})

test("fails closed on malformed, missing, duplicate, or wrong-version npm audit evidence", () => {
  assert.throws(
    () =>
      validateNpmAuditSignatures("{}", {
        version: options.version,
        requiredPackages: ["@dawn-ai/sdk"],
        candidate: candidate(),
        manifest,
      }),
    /malformed|missing|unknown/i,
  )
  assert.throws(
    () =>
      validateNpmAuditSignatures(
        JSON.stringify({
          invalid: [],
          missing: [{ name: "@dawn-ai/sdk", version: options.version }],
          verified: [],
        }),
        {
          version: options.version,
          requiredPackages: ["@dawn-ai/sdk"],
          candidate: candidate(),
          manifest,
        },
      ),
    /missing.*signature/i,
  )
  const duplicate = JSON.parse(auditOutput(manifest, ["@dawn-ai/sdk"]))
  duplicate.verified.push(duplicate.verified[0])
  assert.throws(
    () =>
      validateNpmAuditSignatures(JSON.stringify(duplicate), {
        version: options.version,
        requiredPackages: ["@dawn-ai/sdk"],
        candidate: candidate(),
        manifest,
      }),
    /duplicate/i,
  )
  assert.throws(
    () =>
      validateNpmAuditSignatures(auditOutput(manifest, ["@dawn-ai/sdk"], { version: "0.8.21" }), {
        version: options.version,
        requiredPackages: ["@dawn-ai/sdk"],
        candidate: candidate(),
        manifest,
      }),
    /exact.*0\.8\.22/i,
  )
})

test("accepts the exact npm 11 production shape and rejects verified-entry shape drift", () => {
  const production = auditOutput(manifest, ["@dawn-ai/sdk"])
  assert.deepEqual(
    validateNpmAuditSignatures(production, {
      version: options.version,
      requiredPackages: ["@dawn-ai/sdk"],
      candidate: candidate(),
      manifest,
    }),
    ["@dawn-ai/sdk"],
  )
  assert.throws(
    () =>
      validateNpmAuditSignatures(production, {
        version: options.version,
        requiredPackages: ["@dawn-ai/sdk"],
      }),
    /candidate|manifest/i,
  )
  const trailingSlash = JSON.parse(production)
  trailingSlash.verified[0].registry = "https://registry.npmjs.org/"
  assert.deepEqual(
    validateNpmAuditSignatures(JSON.stringify(trailingSlash), {
      version: options.version,
      requiredPackages: ["@dawn-ai/sdk"],
      candidate: candidate(),
      manifest,
    }),
    ["@dawn-ai/sdk"],
  )
  const registryPath = structuredClone(trailingSlash)
  registryPath.verified[0].registry = "https://registry.npmjs.org/private"
  assert.throws(
    () =>
      validateNpmAuditSignatures(JSON.stringify(registryPath), {
        version: options.version,
        requiredPackages: ["@dawn-ai/sdk"],
        candidate: candidate(),
        manifest,
      }),
    /registry|provenance/i,
  )

  const unexpected = JSON.parse(production)
  unexpected.verified[0].summary = "caller-provided verification summary"
  assert.throws(
    () =>
      validateNpmAuditSignatures(JSON.stringify(unexpected), {
        version: options.version,
        requiredPackages: ["@dawn-ai/sdk"],
        candidate: candidate(),
        manifest,
      }),
    /verified entry.*(?:malformed|missing|unknown)/i,
  )

  const missingLocation = JSON.parse(production)
  delete missingLocation.verified[0].location
  assert.throws(
    () =>
      validateNpmAuditSignatures(JSON.stringify(missingLocation), {
        version: options.version,
        requiredPackages: ["@dawn-ai/sdk"],
        candidate: candidate(),
        manifest,
      }),
    /verified entry.*(?:malformed|missing|unknown)/i,
  )
})

test("binds npm-verified provenance to the exact repository, workflow, ref, commit, and subject", () => {
  const cases = [
    [
      {
        attestations: {
          publish: {
            predicateType: "https://github.com/npm/attestation/tree/main/specs/publish/v0.1",
          },
        },
      },
      /attestation|provenance/i,
    ],
    [{ repository: "https://github.com/fork/dawnai" }, /repository/i],
    [{ workflow: ".github/workflows/other.yml" }, /workflow/i],
    [{ ref: "refs/heads/main" }, /ref/i],
    [{ commitSha: "c".repeat(40) }, /commit/i],
    [{ subjectName: "pkg:npm/%40dawn-ai/sdk@0.8.21" }, /subject/i],
    [{ subjectSha512: "d".repeat(128) }, /subject|integrity/i],
  ]
  for (const [drift, expected] of cases) {
    assert.throws(
      () =>
        validateNpmAuditSignatures(auditOutput(manifest, ["@dawn-ai/sdk"], drift), {
          version: options.version,
          requiredPackages: ["@dawn-ai/sdk"],
          candidate: candidate(),
          manifest,
        }),
      expected,
    )
  }
})

test("writes a receipt and cleans when an installed-package harness assertion fails", async () => {
  const events = []
  let receipt
  await assert.rejects(
    runPublishedHarnessSmoke(options, {
      env: { GITHUB_RUN_ID: "802", GITHUB_RUN_ATTEMPT: "2" },
      now: clock(),
      async makeTempDir() {
        return "/tmp/published-harness-failure"
      },
      async readManifest() {
        return manifest
      },
      async removeDir() {
        events.push("cleanup")
      },
      async runCommand(_command, args) {
        return {
          stdout: args[0] === "audit" ? auditOutput(manifest) : "",
          stderr: "",
        }
      },
      async runHarnessAssertion(_root, lane) {
        if (lane === "runtime") throw new Error("runtime assertion failed")
      },
      async runAgUiProbe() {},
      async runTypeScriptProbe() {},
      async runDockerProbe() {},
      async writeFile(_path, bytes) {
        events.push("receipt")
        receipt = parseSmokeResult(bytes)
      },
      async mkdir() {},
    }),
    /runtime assertion failed/,
  )

  assert.deepEqual(events, ["cleanup", "receipt"])
  assert.equal(receipt.conclusion, "failure")
})

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
            externalParameters: { workflow: { ref, repository, path: workflow } },
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

function candidate() {
  return {
    version: options.version,
    commitSha: options.commitSha,
    publisherWorkflow: ".github/workflows/release.yml",
  }
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

function clock() {
  const values = [new Date("2026-08-25T12:00:00.000Z"), new Date("2026-08-25T12:00:01.000Z")]
  return () => values.shift() ?? new Date("2026-08-25T12:00:01.000Z")
}
