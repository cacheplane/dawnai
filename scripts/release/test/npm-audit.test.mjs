import assert from "node:assert/strict"
import { createHash } from "node:crypto"
import { access, readdir, readFile, writeFile } from "node:fs/promises"
import path from "node:path"
import test from "node:test"

import {
  createNpmAuditVerifier,
  NPM_AUDIT_VERIFIER,
  parseNpmAuditSignatures,
} from "../npm-audit.mjs"
import {
  EXACT_NPM_PROVENANCE_CERTIFICATE,
  MULTIPLE_NPM_PROVENANCE_CERTIFICATE,
  WRONG_NPM_PROVENANCE_CERTIFICATE,
} from "./fixtures/npm-audit-certificates.mjs"

const VERSION = "0.8.22"
const COMMIT_SHA = "0123456789abcdef0123456789abcdef01234567"
const ENTRY = Object.freeze(packageEntry("@dawn-ai/sdk"))
const CANDIDATE = Object.freeze({
  version: VERSION,
  commitSha: COMMIT_SHA,
  publisherWorkflow: ".github/workflows/release.yml",
})

test("parses the exact npm 11 audit shape and binds its verified SLSA statement", () => {
  assert.equal(NPM_AUDIT_VERIFIER, "npm-audit-signatures@11.17.0")
  const expected = {
    status: "verified",
    signature: { status: "valid", verifier: NPM_AUDIT_VERIFIER },
    provenance: {
      predicateType: "https://slsa.dev/provenance/v1",
      workflow: CANDIDATE.publisherWorkflow,
      commitSha: COMMIT_SHA,
      repository: "https://github.com/cacheplane/dawnai",
      ref: `refs/tags/v${VERSION}`,
    },
  }

  assert.deepEqual(
    parseNpmAuditSignatures(auditOutput(), { entry: ENTRY, candidate: CANDIDATE }),
    expected,
  )
  assert.deepEqual(
    parseNpmAuditSignatures(auditOutput({ registry: "https://registry.npmjs.org" }), {
      entry: ENTRY,
      candidate: CANDIDATE,
    }),
    expected,
  )
})

test("rejects unsigned, forged, or ambiguous provenance even when registry JSON claims it", () => {
  const rows = [
    [{ verified: [] }, null],
    [
      { attestations: { url: attestationUrl(), publish: { predicateType: "publish" } } },
      /attestation|provenance/iu,
    ],
    [{ repository: "https://github.com/fork/dawnai" }, /repository/iu],
    [{ workflow: ".github/workflows/other.yml" }, /workflow/iu],
    [{ ref: "refs/heads/main" }, /ref/iu],
    [{ commitSha: "f".repeat(40) }, /commit/iu],
    [{ subjectName: "pkg:npm/%40dawn-ai/sdk@0.8.21" }, /subject/iu],
    [{ subjectSha512: "f".repeat(128) }, /subject|integrity/iu],
    [{ predicateType: "https://example.test/unsigned" }, /provenance|predicate/iu],
    [{ duplicateProvenance: true }, /duplicate|ambiguous|provenance/iu],
    [{ provenanceOnly: true }, /publish|signature|attestation/iu],
    [{ publishKeyid: "" }, /publish|key|signature/iu],
    [{ publishHint: "" }, /publish|key|signature/iu],
    [{ duplicatePublish: true }, /duplicate|ambiguous|publish/iu],
    [{ certificateRawBytes: WRONG_NPM_PROVENANCE_CERTIFICATE }, /certificate|identity|workflow/iu],
    [
      { certificateRawBytes: MULTIPLE_NPM_PROVENANCE_CERTIFICATE },
      /certificate|identity|multiple/iu,
    ],
  ]

  for (const [drift, expected] of rows) {
    const result = () =>
      parseNpmAuditSignatures(auditOutput(drift), { entry: ENTRY, candidate: CANDIDATE })
    if (expected === null) assert.deepEqual(result(), { status: "pending" })
    else assert.throws(result, expected)
  }
})

test("fails closed on strict audit-output drift, conflicting versions, and output limits", () => {
  for (const raw of [
    "{}",
    JSON.stringify({ invalid: [], missing: [], verified: [], summary: {} }),
    JSON.stringify({ invalid: "none", missing: [], verified: [] }),
    `${" ".repeat(2 * 1024 * 1024)}{}`,
  ]) {
    assert.throws(
      () => parseNpmAuditSignatures(raw, { entry: ENTRY, candidate: CANDIDATE }),
      /audit|output|malformed|limit/iu,
    )
  }

  assert.throws(
    () =>
      parseNpmAuditSignatures(auditOutput({ version: "0.8.21" }), {
        entry: ENTRY,
        candidate: CANDIDATE,
      }),
    /version|exact/iu,
  )
  assert.throws(
    () =>
      parseNpmAuditSignatures(auditOutput({ registry: "https://registry.example.test/" }), {
        entry: ENTRY,
        candidate: CANDIDATE,
      }),
    /registry/iu,
  )
})

test("uses one synthetic exact-package tree with no install, unpack, or lockfile", async () => {
  const calls = []
  const sourceEnvironment = {
    PATH: process.env.PATH ?? "",
    LANG: "en_US.UTF-8",
    GITHUB_ACTIONS: "true",
    GITHUB_EVENT_NAME: "workflow_dispatch",
    GITHUB_REF: `refs/tags/v${VERSION}`,
    GITHUB_REPOSITORY: "cacheplane/dawnai",
    GITHUB_REPOSITORY_ID: "123456789",
    GITHUB_REPOSITORY_OWNER_ID: "987654321",
    GITHUB_RUN_ATTEMPT: "1",
    GITHUB_RUN_ID: "100",
    GITHUB_SERVER_URL: "https://github.com",
    GITHUB_SHA: COMMIT_SHA,
    GITHUB_WORKFLOW_REF: `cacheplane/dawnai/.github/workflows/release.yml@refs/tags/v${VERSION}`,
    RUNNER_ENVIRONMENT: "github-hosted",
    NODE_OPTIONS: "--require=/credential/stealer.cjs",
    NPM_TOKEN: "must-not-leak",
    NODE_AUTH_TOKEN: "must-not-leak",
    GITHUB_TOKEN: "must-not-leak",
    ACTIONS_ID_TOKEN_REQUEST_TOKEN: "exact-oidc-token",
    ACTIONS_ID_TOKEN_REQUEST_URL: "https://token.actions.githubusercontent.com/exact",
  }
  const verifier = await createNpmAuditVerifier({
    environment: sourceEnvironment,
    signal: new AbortController().signal,
    async runNpm(command, args, options) {
      calls.push({ command, args, options })
      if (args[0] === "--version") return { stdout: "11.17.0\n", stderr: "", exitCode: 0 }
      if (args[0] === "audit") {
        assert.deepEqual((await readdir(options.cwd)).sort(), ["node_modules", "package.json"])
        assert.deepEqual(await readdir(path.join(options.cwd, "node_modules")), ["@dawn-ai"])
        assert.deepEqual(await readdir(path.join(options.cwd, "node_modules", "@dawn-ai")), ["sdk"])
        assert.deepEqual(
          JSON.parse(await readFile(path.join(options.cwd, "package.json"), "utf8")),
          {
            name: "dawn-release-audit-consumer",
            version: "0.0.0",
            private: true,
            dependencies: { [ENTRY.name]: ENTRY.version },
          },
        )
        assert.deepEqual(
          JSON.parse(
            await readFile(
              path.join(options.cwd, "node_modules", ...ENTRY.name.split("/"), "package.json"),
              "utf8",
            ),
          ),
          { name: ENTRY.name, version: ENTRY.version },
        )
        assert.deepEqual(
          await readdir(path.join(options.cwd, "node_modules", ...ENTRY.name.split("/"))),
          ["package.json"],
        )
        await assert.rejects(access(path.join(options.cwd, "package-lock.json")))
        return { stdout: auditOutput(), stderr: "", exitCode: 0 }
      }
      throw new Error(`unexpected npm operation ${args[0]}`)
    },
  })
  const root = verifier.root
  try {
    assert.equal(
      (await verifier.verifyPackage({ entry: ENTRY, candidate: CANDIDATE })).status,
      "verified",
    )
    assert.equal(
      (await verifier.verifyPackage({ entry: ENTRY, candidate: CANDIDATE })).status,
      "verified",
    )

    assert.deepEqual(
      calls.map(({ command, args }) => [command, ...args]),
      [
        ["npm", "--version"],
        ["npm", "audit", "signatures", "--no-package-lock", "--json", "--include-attestations"],
        ["npm", "audit", "signatures", "--no-package-lock", "--json", "--include-attestations"],
      ],
    )
    const audits = calls.slice(1)
    assert.ok(audits[0].options.cwd.startsWith(root))
    assert.ok(audits.every(({ options }) => options.cwd === audits[0].options.cwd))
    assert.ok(audits.every(({ options }) => options.acceptedExitCodes.join(",") === "0,1"))
    for (const { options } of audits) {
      assert.ok(options.signal instanceof AbortSignal)
      assert.ok(options.env.HOME.startsWith(root))
      assert.equal(options.env.npm_config_registry, "https://registry.npmjs.org/")
      assert.equal(options.env.npm_config_ignore_scripts, "true")
      for (const secret of [
        "NODE_OPTIONS",
        "NPM_TOKEN",
        "NODE_AUTH_TOKEN",
        "GITHUB_TOKEN",
        "ACTIONS_ID_TOKEN_REQUEST_TOKEN",
        "ACTIONS_ID_TOKEN_REQUEST_URL",
      ]) {
        assert.equal(options.env[secret], undefined, secret)
      }
    }

    const publishEnvironment = verifier.publisherEnvironment({ candidate: CANDIDATE })
    assert.equal(publishEnvironment.ACTIONS_ID_TOKEN_REQUEST_TOKEN, "exact-oidc-token")
    assert.equal(
      publishEnvironment.ACTIONS_ID_TOKEN_REQUEST_URL,
      "https://token.actions.githubusercontent.com/exact",
    )
    assert.equal(publishEnvironment.GITHUB_TOKEN, undefined)
    assert.equal(publishEnvironment.NPM_TOKEN, undefined)
    assert.equal(publishEnvironment.NODE_OPTIONS, undefined)
    assert.ok(publishEnvironment.HOME.startsWith(root))
    for (const name of [
      "GITHUB_ACTIONS",
      "GITHUB_EVENT_NAME",
      "GITHUB_REF",
      "GITHUB_REPOSITORY",
      "GITHUB_REPOSITORY_ID",
      "GITHUB_REPOSITORY_OWNER_ID",
      "GITHUB_RUN_ATTEMPT",
      "GITHUB_RUN_ID",
      "GITHUB_SERVER_URL",
      "GITHUB_SHA",
      "GITHUB_WORKFLOW_REF",
      "RUNNER_ENVIRONMENT",
    ]) {
      assert.equal(publishEnvironment[name], sourceEnvironment[name], name)
    }

    for (const [name, invalid] of [
      ["GITHUB_REF", "refs/heads/main"],
      ["GITHUB_REPOSITORY", "fork/dawnai"],
      ["GITHUB_SHA", "f".repeat(40)],
      ["GITHUB_WORKFLOW_REF", "cacheplane/dawnai/.github/workflows/other.yml@refs/tags/v0.8.22"],
      ["RUNNER_ENVIRONMENT", "self-hosted"],
    ]) {
      const valid = sourceEnvironment[name]
      sourceEnvironment[name] = invalid
      assert.throws(
        () => verifier.publisherEnvironment({ candidate: CANDIDATE }),
        /provenance environment/iu,
      )
      sourceEnvironment[name] = valid
    }
  } finally {
    await verifier.dispose()
  }
  await assert.rejects(access(root))
})

test("rejects an audit command that creates a lockfile in the synthetic tree", async () => {
  const verifier = await createNpmAuditVerifier({
    environment: { PATH: process.env.PATH ?? "" },
    signal: new AbortController().signal,
    async runNpm(_command, args, options) {
      if (args[0] === "--version") return { stdout: "11.17.0\n", stderr: "", exitCode: 0 }
      if (args[0] === "audit") {
        await writeFile(path.join(options.cwd, "package-lock.json"), "{}\n")
        return { stdout: auditOutput(), stderr: "", exitCode: 0 }
      }
      throw new Error(`unexpected npm operation ${args[0]}`)
    },
  })
  try {
    await assert.rejects(
      verifier.verifyPackage({ entry: ENTRY, candidate: CANDIDATE }),
      /consumer identity/iu,
    )
  } finally {
    await verifier.dispose()
  }
})

test("pins the exact npm CLI contract consumed by the strict audit parser", async () => {
  for (const version of ["11.16.0", "11.17.1", "12.0.0"]) {
    await assert.rejects(async () => {
      const verifier = await createNpmAuditVerifier({
        environment: { PATH: process.env.PATH ?? "" },
        signal: new AbortController().signal,
        async runNpm(_command, args) {
          if (args[0] === "--version") {
            return { stdout: `${version}\n`, stderr: "", exitCode: 0 }
          }
          throw new Error("audit must not run")
        },
      })
      await verifier.dispose()
    }, /exact stable npm 11/iu)
  }
})

function auditOutput(drift = {}) {
  const version = drift.version ?? VERSION
  const repository = drift.repository ?? "https://github.com/cacheplane/dawnai"
  const workflow = drift.workflow ?? CANDIDATE.publisherWorkflow
  const ref = drift.ref ?? `refs/tags/v${VERSION}`
  const commitSha = drift.commitSha ?? COMMIT_SHA
  const predicateType = drift.predicateType ?? "https://slsa.dev/provenance/v1"
  const statement = {
    _type: "https://in-toto.io/Statement/v1",
    subject: [
      {
        name: drift.subjectName ?? npmSubjectName(ENTRY.name, version),
        digest: { sha512: drift.subjectSha512 ?? ENTRY.sha512 },
      },
    ],
    predicateType,
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
          invocationId: "https://github.com/cacheplane/dawnai/actions/runs/100/attempts/1",
        },
      },
    },
  }
  const provenance = {
    predicateType,
    bundle: {
      mediaType: "application/vnd.dev.sigstore.bundle.v0.3+json",
      verificationMaterial: {
        certificate: {
          rawBytes: drift.certificateRawBytes ?? EXACT_NPM_PROVENANCE_CERTIFICATE,
        },
        tlogEntries: [{}],
        timestampVerificationData: { rfc3161Timestamps: [] },
      },
      dsseEnvelope: {
        payload: Buffer.from(JSON.stringify(statement), "utf8").toString("base64"),
        payloadType: "application/vnd.in-toto+json",
        signatures: [{ sig: "npm-verified", keyid: "" }],
      },
    },
    signedAccessSignatureUrl: "",
  }
  const verified = drift.verified ?? [
    {
      name: ENTRY.name,
      version,
      location: `node_modules/${ENTRY.name}`,
      registry: drift.registry ?? "https://registry.npmjs.org/",
      attestations: drift.attestations ?? {
        url: attestationUrl(version),
        provenance: { predicateType: "https://slsa.dev/provenance/v1" },
      },
      attestationBundles: auditBundles(provenance, drift),
    },
  ]
  return JSON.stringify({ invalid: drift.invalid ?? [], missing: drift.missing ?? [], verified })
}

function auditBundles(provenance, drift) {
  const publish = {
    predicateType: "https://github.com/npm/attestation/tree/main/specs/publish/v0.1",
    bundle: {
      mediaType: "application/vnd.dev.sigstore.bundle+json;version=0.2",
      verificationMaterial: {
        publicKey: { hint: drift.publishHint ?? "SHA256:test" },
        tlogEntries: [{}],
        timestampVerificationData: { rfc3161Timestamps: [] },
      },
      dsseEnvelope: {
        payload: Buffer.from("{}", "utf8").toString("base64"),
        payloadType: "application/vnd.in-toto+json",
        signatures: [{ sig: "npm-verified", keyid: drift.publishKeyid ?? "SHA256:test" }],
      },
    },
    signedAccessSignatureUrl: "",
  }
  if (drift.duplicateProvenance) return [publish, provenance, structuredClone(provenance)]
  if (drift.provenanceOnly) return [provenance]
  if (drift.duplicatePublish) return [publish, structuredClone(publish), provenance]
  return [publish, provenance]
}

function packageEntry(name) {
  const bytes = Buffer.from(`packed:${name}`)
  const sha512 = createHash("sha512").update(bytes).digest("hex")
  return {
    name,
    version: VERSION,
    filename: "dawn-ai-sdk-0.8.22.tgz",
    size: bytes.length,
    sha256: createHash("sha256").update(bytes).digest("hex"),
    sha512,
    npmIntegrity: `sha512-${Buffer.from(sha512, "hex").toString("base64")}`,
    access: "public",
  }
}

function npmSubjectName(name, version) {
  const [scope, packageName] = name.split("/")
  return `pkg:npm/${encodeURIComponent(scope)}/${packageName}@${version}`
}

function attestationUrl(version = VERSION) {
  return `https://registry.npmjs.org/-/npm/v1/attestations/@dawn-ai%2fsdk@${version}`
}
