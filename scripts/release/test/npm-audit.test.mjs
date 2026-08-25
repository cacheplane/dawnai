import assert from "node:assert/strict"
import { execFileSync } from "node:child_process"
import { createHash, generateKeyPairSync, sign } from "node:crypto"
import { access, mkdtemp, rm } from "node:fs/promises"
import { createServer } from "node:http"
import { createRequire } from "node:module"
import os from "node:os"
import path from "node:path"
import test from "node:test"

import {
  createNpmAuditVerifier,
  NPM_AUDIT_VERIFIER,
  parseNpmAuditSignatures,
} from "../npm-audit.mjs"

const VERSION = "0.8.22"
const COMMIT_SHA = "0123456789abcdef0123456789abcdef01234567"
const ENTRY = Object.freeze(packageEntry("@dawn-ai/sdk"))
const CANDIDATE = Object.freeze({
  version: VERSION,
  commitSha: COMMIT_SHA,
  publisherWorkflow: ".github/workflows/release.yml",
})

test("parses the exact npm 11 audit shape and binds its verified SLSA statement", () => {
  assert.equal(NPM_AUDIT_VERIFIER, "npm-audit-signatures@11")
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
  ]

  for (const [drift, expected] of rows) {
    const result = () =>
      parseNpmAuditSignatures(auditOutput(drift), { entry: ENTRY, candidate: CANDIDATE })
    if (expected === null) assert.deepEqual(result(), { status: "pending" })
    else assert.throws(result, expected)
  }
})

test("official npm 11 uses publication time and validates every registry signature", async (t) => {
  const fixture = await officialNpmSignatureFixture(t)
  const historical = await fixture.verify("dawn-audit-historical")
  assert.equal(historical._signatures.length, 1)
  assert.ok(Date.parse(fixture.expiredAt) < Date.now())

  const dual = await fixture.verify("dawn-audit-dual")
  assert.equal(dual._signatures.length, 2)

  await assert.rejects(
    fixture.verify("dawn-audit-valid-plus-unknown"),
    (error) => error?.code === "EMISSINGSIGNATUREKEY",
  )
  await assert.rejects(
    fixture.verify("dawn-audit-forged"),
    (error) => error?.code === "EINTEGRITYSIGNATURE",
  )
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

test("uses one isolated exact-package consumer with credential-free npm 11 audit calls", async () => {
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
      if (args[0] === "install") return { stdout: "", stderr: "", exitCode: 0 }
      if (args[0] === "audit") {
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
        [
          "npm",
          "install",
          "--ignore-scripts",
          "--package-lock=true",
          "--omit=dev",
          "--no-audit",
          "--no-fund",
          "--registry",
          "https://registry.npmjs.org/",
        ],
        ["npm", "audit", "signatures", "--json", "--include-attestations"],
        ["npm", "audit", "signatures", "--json", "--include-attestations"],
      ],
    )
    const install = calls[1]
    const audits = calls.slice(2)
    assert.ok(install.options.cwd.startsWith(root))
    assert.ok(audits.every(({ options }) => options.cwd === install.options.cwd))
    assert.ok(audits.every(({ options }) => options.acceptedExitCodes.join(",") === "0,1"))
    for (const { options } of [install, ...audits]) {
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

async function officialNpmSignatureFixture(t) {
  const globalRoot = execFileSync("npm", ["root", "--global"], {
    encoding: "utf8",
  }).trim()
  const require = createRequire(import.meta.url)
  const npmPackage = require(path.join(globalRoot, "npm", "package.json"))
  assert.match(npmPackage.version, /^11\.[0-9]+\.[0-9]+$/u)
  const pacote = require(path.join(globalRoot, "npm", "node_modules", "pacote"))
  const cache = await mkdtemp(path.join(os.tmpdir(), "dawn-official-npm-signature-test-"))
  const version = "1.0.0"
  const expiredAt = "2020-01-01T00:00:00.000Z"
  const publishedAt = "2019-01-01T00:00:00.000Z"
  const integrity = `sha512-${createHash("sha512").update("official npm fixture").digest("base64")}`
  const historicalKey = signingKey("historical", expiredAt)
  const firstKey = signingKey("first", null)
  const secondKey = signingKey("second", null)
  const unknownKey = signingKey("unknown", null)
  const forgeryKey = signingKey("forgery", null)
  const packages = new Map([
    [
      "dawn-audit-historical",
      {
        publishedAt,
        signatures: [registrySignature("dawn-audit-historical", historicalKey)],
      },
    ],
    [
      "dawn-audit-dual",
      {
        publishedAt: "2026-01-01T00:00:00.000Z",
        signatures: [
          registrySignature("dawn-audit-dual", firstKey),
          registrySignature("dawn-audit-dual", secondKey),
        ],
      },
    ],
    [
      "dawn-audit-valid-plus-unknown",
      {
        publishedAt: "2026-01-01T00:00:00.000Z",
        signatures: [
          registrySignature("dawn-audit-valid-plus-unknown", firstKey),
          registrySignature("dawn-audit-valid-plus-unknown", unknownKey),
        ],
      },
    ],
    [
      "dawn-audit-forged",
      {
        publishedAt: "2026-01-01T00:00:00.000Z",
        signatures: [registrySignature("dawn-audit-forged", forgeryKey, firstKey.keyid)],
      },
    ],
  ])
  let origin
  const server = createServer((request, response) => {
    const name = decodeURIComponent(new URL(request.url, origin).pathname.slice(1))
    const entry = packages.get(name)
    if (entry === undefined) {
      response.writeHead(404, { "content-type": "application/json" })
      response.end(JSON.stringify({ error: "not found" }))
      return
    }
    const body = JSON.stringify({
      name,
      versions: {
        [version]: {
          name,
          version,
          dist: {
            tarball: `${origin}/${name}-${version}.tgz`,
            integrity,
            signatures: entry.signatures,
          },
        },
      },
      "dist-tags": { latest: version },
      time: { [version]: entry.publishedAt },
    })
    response.writeHead(200, {
      "content-length": Buffer.byteLength(body),
      "content-type": "application/json",
    })
    response.end(body)
  })
  await new Promise((resolve, reject) => {
    server.once("error", reject)
    server.listen(0, "127.0.0.1", resolve)
  })
  origin = `http://127.0.0.1:${server.address().port}`
  const registry = `${origin}/`
  const registryKey = `//127.0.0.1:${server.address().port}/:_keys`
  t.after(async () => {
    await new Promise((resolve) => server.close(resolve))
    await rm(cache, { recursive: true, force: true })
  })
  return {
    expiredAt,
    verify(name) {
      return pacote.manifest(`${name}@${version}`, {
        cache,
        registry,
        verifySignatures: true,
        [registryKey]: [historicalKey, firstKey, secondKey].map(({ keyid, pemkey, expires }) => ({
          keyid,
          pemkey,
          expires,
        })),
      })
    },
  }

  function registrySignature(name, key, keyid = key.keyid) {
    return {
      keyid,
      sig: sign("sha256", Buffer.from(`${name}@${version}:${integrity}`), key.privateKey).toString(
        "base64",
      ),
    }
  }
}

function signingKey(name, expires) {
  const { privateKey, publicKey } = generateKeyPairSync("ec", { namedCurve: "P-256" })
  return {
    expires,
    keyid: `SHA256:${name}`,
    pemkey: publicKey.export({ type: "spki", format: "pem" }),
    privateKey,
  }
}

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
      verificationMaterial: { certificate: { rawBytes: "npm-verified" } },
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
      attestationBundles: drift.duplicateProvenance
        ? [provenance, structuredClone(provenance)]
        : [
            {
              predicateType: "https://github.com/npm/attestation/tree/main/specs/publish/v0.1",
              bundle: {
                mediaType: "application/vnd.dev.sigstore.bundle+json;version=0.2",
                verificationMaterial: { publicKey: { hint: "SHA256:test" } },
                dsseEnvelope: {
                  payload: Buffer.from("{}", "utf8").toString("base64"),
                  payloadType: "application/vnd.in-toto+json",
                  signatures: [{ sig: "npm-verified", keyid: "SHA256:test" }],
                },
              },
              signedAccessSignatureUrl: "",
            },
            provenance,
          ],
    },
  ]
  return JSON.stringify({ invalid: drift.invalid ?? [], missing: drift.missing ?? [], verified })
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
