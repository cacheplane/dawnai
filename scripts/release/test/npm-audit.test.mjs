import assert from "node:assert/strict"
import { execFileSync, spawn } from "node:child_process"
import { createHash } from "node:crypto"
import * as fs from "node:fs/promises"
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
    filename: `${name.replace(/^@/u, "").replaceAll("/", "-")}-${VERSION}.tgz`,
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

const BATCH_CANDIDATE = Object.freeze({ ...CANDIDATE, ciWorkflow: "CI", ciCheck: "validate" })
const BATCH_ENTRIES = [ENTRY, packageEntry("@dawn-ai/core"), packageEntry("create-dawn-ai-app")]
function batchOutput(entries = BATCH_ENTRIES) {
  const verified = entries.map((entry) => {
    const row = JSON.parse(auditOutput()).verified[0]
    row.name = entry.name
    row.version = entry.version
    row.location = `node_modules/${entry.name}`
    row.attestations.url = `https://registry.npmjs.org/-/npm/v1/attestations/${encodeURIComponent(entry.name)}@${entry.version}`
    const bundle = row.attestationBundles[1].bundle
    const statement = JSON.parse(Buffer.from(bundle.dsseEnvelope.payload, "base64"))
    statement.subject = [
      {
        name: entry.name.startsWith("@")
          ? npmSubjectName(entry.name, entry.version)
          : `pkg:npm/${entry.name}@${entry.version}`,
        digest: { sha512: entry.sha512 },
      },
    ]
    bundle.dsseEnvelope.payload = Buffer.from(JSON.stringify(statement)).toString("base64")
    return row
  })
  return JSON.stringify({ invalid: [], missing: [], verified })
}
async function batchVerifier(run, fileSystem = fs, signal = new AbortController().signal) {
  return createNpmAuditVerifier({
    fileSystem,
    signal,
    environment: {
      PATH: process.env.PATH ?? "",
      GITHUB_TOKEN: "secret",
      NPM_TOKEN: "secret",
      ACTIONS_ID_TOKEN_REQUEST_TOKEN: "secret",
      DAWN_RECOVERY_POLICY_TOKEN: "secret",
      NODE_OPTIONS: "secret",
    },
    async runNpm(command, args, options) {
      if (args[0] === "--version") return { stdout: "11.17.0\n" }
      assert.equal(command, "npm")
      assert.deepEqual(args, [
        "audit",
        "signatures",
        "--no-package-lock",
        "--json",
        "--include-attestations",
      ])
      assert.deepEqual(options.acceptedExitCodes, [0, 1])
      assert.equal(options.signal, signal)
      for (const key of [
        "GITHUB_TOKEN",
        "NPM_TOKEN",
        "ACTIONS_ID_TOKEN_REQUEST_TOKEN",
        "DAWN_RECOVERY_POLICY_TOKEN",
        "NODE_OPTIONS",
      ])
        assert.equal(options.env[key], undefined)
      assert.equal(options.env.npm_config_ignore_scripts, "true")
      return run(options)
    },
  })
}
test("batch audits the whole inventory once in a fresh exact tree on every call", async () => {
  const roots = []
  const verifier = await batchVerifier(async ({ cwd }) => {
    roots.push(cwd)
    const root = JSON.parse(await readFile(path.join(cwd, "package.json")))
    assert.deepEqual(
      root.dependencies,
      Object.fromEntries(BATCH_ENTRIES.map((e) => [e.name, e.version])),
    )
    assert.deepEqual((await readdir(cwd)).sort(), ["node_modules", "package.json"])
    assert.deepEqual((await readdir(path.join(cwd, "node_modules"))).sort(), [
      "@dawn-ai",
      "create-dawn-ai-app",
    ])
    assert.deepEqual((await readdir(path.join(cwd, "node_modules/@dawn-ai"))).sort(), [
      "core",
      "sdk",
    ])
    for (const entry of BATCH_ENTRIES) {
      const leaf = path.join(cwd, "node_modules", entry.name)
      assert.deepEqual(await readdir(leaf), ["package.json"])
      assert.deepEqual(JSON.parse(await readFile(path.join(leaf, "package.json"))), {
        name: entry.name,
        version: entry.version,
      })
    }
    return { stdout: batchOutput(), exitCode: 1 }
  })
  try {
    for (let i = 0; i < 2; i++) {
      const results = await verifier.verifyPackages({
        entries: BATCH_ENTRIES,
        candidate: BATCH_CANDIDATE,
      })
      assert.deepEqual(
        results,
        BATCH_ENTRIES.map((entry) => ({
          name: entry.name,
          version: entry.version,
          ...parseNpmAuditSignatures(batchOutput(), { entry, candidate: BATCH_CANDIDATE }),
        })),
      )
      assert.ok(Object.isFrozen(results) && results.every(Object.isFrozen))
    }
    assert.equal(roots.length, 2)
    assert.notEqual(roots[0], roots[1])
  } finally {
    await verifier.dispose()
  }
  await assert.rejects(access(verifier.root))
  await assert.rejects(
    verifier.verifyPackages({ entries: BATCH_ENTRIES, candidate: BATCH_CANDIDATE }),
    /disposed/,
  )
})
for (const [label, mutate] of [
  ["missing", (a) => a.verified.pop()],
  ["extra", (a) => a.verified.push(a.verified[0])],
  [
    "duplicate",
    (a) => {
      a.verified[1] = a.verified[0]
    },
  ],
  [
    "foreign",
    (a) => {
      a.verified[1].name = "foreign"
    },
  ],
  [
    "null",
    (a) => {
      a.verified[1] = null
    },
  ],
  [
    "version",
    (a) => {
      a.verified[1].version = "0.8.21"
    },
  ],
  [
    "location",
    (a) => {
      a.verified[1].location = "node_modules/other"
    },
  ],
  [
    "invalid",
    (a) => {
      a.invalid = [null]
    },
  ],
  [
    "missing signatures",
    (a) => {
      a.missing = [null]
    },
  ],
  [
    "unknown root",
    (a) => {
      a.extra = []
    },
  ],
  [
    "unknown row",
    (a) => {
      a.verified[1].extra = []
    },
  ],
  [
    "untrusted provenance",
    (a) => {
      a.verified[1].attestationBundles[1].bundle.verificationMaterial.certificate.rawBytes =
        WRONG_NPM_PROVENANCE_CERTIFICATE
    },
  ],
])
  test(`batch rejects ${label} anywhere in whole audit stdout`, async () => {
    const audit = JSON.parse(batchOutput())
    mutate(audit)
    const verifier = await batchVerifier(async () => ({ stdout: JSON.stringify(audit) }))
    try {
      await assert.rejects(
        verifier.verifyPackages({ entries: BATCH_ENTRIES, candidate: BATCH_CANDIDATE }),
        /audit|certificate|identity/,
      )
    } finally {
      await verifier.dispose()
    }
  })
for (const output of ["bad json", " ".repeat(2 * 1024 * 1024) + batchOutput()])
  test("batch bounds original stdout before parsing", async () => {
    const verifier = await batchVerifier(async () => ({ stdout: output }))
    try {
      await assert.rejects(
        verifier.verifyPackages({ entries: BATCH_ENTRIES, candidate: BATCH_CANDIDATE }),
        /audit|output/,
      )
    } finally {
      await verifier.dispose()
    }
  })
test("batch rejects malformed complete inputs without invoking getters or filesystem work", async () => {
  let fsCalls = 0,
    getters = 0
  const fileSystem = Object.fromEntries(
    Object.entries(fs).map(([key, value]) => [
      key,
      typeof value === "function"
        ? (...args) => {
            fsCalls++
            return value(...args)
          }
        : value,
    ]),
  )
  const verifier = await batchVerifier(async () => {
    throw new Error("must not run")
  }, fileSystem)
  const getter = Object.defineProperty({}, "entries", {
    enumerable: true,
    get() {
      getters++
      return BATCH_ENTRIES
    },
  })
  try {
    for (const input of [
      getter,
      { entries: [], candidate: BATCH_CANDIDATE },
      { entries: Array(65).fill(ENTRY), candidate: BATCH_CANDIDATE },
      { entries: [ENTRY, ENTRY], candidate: BATCH_CANDIDATE },
      ...["../escape", "@scope/..", "node_modules", "favicon.ico", "a".repeat(215)].map((name) => ({
        entries: [packageEntry(name)],
        candidate: BATCH_CANDIDATE,
      })),
      { entries: [ENTRY, { ...ENTRY, version: "0.8.21" }], candidate: BATCH_CANDIDATE },
    ]) {
      const before = fsCalls
      await assert.rejects(verifier.verifyPackages(input))
      assert.equal(fsCalls, before)
    }
    assert.equal(getters, 0)
  } finally {
    await verifier.dispose()
  }
})
for (const stage of ["before", "after"])
  for (const drift of [
    "root bytes",
    "leaf bytes",
    "scope member",
    "nested dependency",
    "lockfile",
    "symlink",
  ])
    test(`batch detects ${stage} command tree drift: ${drift}`, async () => {
      let cwd,
        tampered = false,
        commands = 0
      async function tamper(directory) {
        if (tampered) return
        tampered = true
        if (drift === "root bytes") await writeFile(path.join(directory, "package.json"), "{}")
        if (drift === "leaf bytes")
          await writeFile(path.join(directory, "node_modules/@dawn-ai/core/package.json"), "{}")
        if (drift === "scope member")
          await fs.mkdir(path.join(directory, "node_modules/@dawn-ai/extra"))
        if (drift === "nested dependency")
          await fs.mkdir(path.join(directory, "node_modules/@dawn-ai/core/node_modules"))
        if (drift === "lockfile") await writeFile(path.join(directory, "package-lock.json"), "{}")
        if (drift === "symlink") {
          const file = path.join(directory, "node_modules/@dawn-ai/core/package.json")
          await fs.rename(file, path.join(directory, "outside.json"))
          await fs.symlink(path.join(directory, "outside.json"), file)
        }
      }
      const verifier = await batchVerifier(
        async ({ cwd: directory }) => {
          commands++
          cwd = directory
          if (stage === "after") await tamper(cwd)
          return { stdout: batchOutput() }
        },
        {
          ...fs,
          async readFile(file, ...args) {
            if (stage === "before" && file.endsWith("package.json") && !tampered) {
              const directory = file.slice(0, file.indexOf("/package.json"))
              if (!directory.includes("node_modules")) await tamper(directory)
            }
            return fs.readFile(file, ...args)
          },
        },
      )
      try {
        await assert.rejects(
          verifier.verifyPackages({ entries: BATCH_ENTRIES, candidate: BATCH_CANDIDATE }),
        )
        assert.equal(commands, stage === "before" ? 0 : 1)
      } finally {
        await verifier.dispose()
      }
    })

test("batch snapshots every caller identity before asynchronous filesystem work", async () => {
  const entries = structuredClone(BATCH_ENTRIES),
    candidate = structuredClone(BATCH_CANDIDATE)
  const verifier = await batchVerifier(async () => ({ stdout: batchOutput() }), {
    ...fs,
    async mkdtemp(prefix) {
      if (prefix.includes("/consumers/")) {
        entries[0].name = "foreign"
        candidate.commitSha = "f".repeat(40)
        entries.pop()
      }
      return fs.mkdtemp(prefix)
    },
  })
  try {
    const result = await verifier.verifyPackages({ entries, candidate })
    assert.equal(result.length, BATCH_ENTRIES.length)
    assert.equal(result[0].name, ENTRY.name)
    assert.equal(result[0].provenance.commitSha, COMMIT_SHA)
  } finally {
    await verifier.dispose()
  }
})
test("batch rejects nested accessors before filesystem use", async () => {
  let called = false
  const entry = { ...ENTRY }
  Object.defineProperty(entry, "sha512", {
    enumerable: true,
    get() {
      called = true
      return ENTRY.sha512
    },
  })
  const verifier = await batchVerifier(async () => {
    throw new Error("must not run")
  })
  try {
    await assert.rejects(verifier.verifyPackages({ entries: [entry], candidate: BATCH_CANDIDATE }))
    assert.equal(called, false)
  } finally {
    await verifier.dispose()
  }
})
test("fresh batch cannot reuse successful stdout after a later audit fails", async () => {
  let count = 0
  const verifier = await batchVerifier(async () => ({
    stdout: ++count === 1 ? batchOutput() : "{}",
  }))
  try {
    await verifier.verifyPackages({ entries: BATCH_ENTRIES, candidate: BATCH_CANDIDATE })
    await assert.rejects(
      verifier.verifyPackages({ entries: BATCH_ENTRIES, candidate: BATCH_CANDIDATE }),
      /audit/,
    )
    assert.equal(count, 2)
  } finally {
    await verifier.dispose()
  }
})
for (const stop of ["abort", "dispose"])
  test(`batch ${stop} denies late proof and cleanup waits for raw command settlement`, async () => {
    let start,
      finish,
      removed = 0
    const started = new Promise((r) => {
      start = r
    })
    const pending = new Promise((r) => {
      finish = r
    })
    const controller = new AbortController()
    const verifier = await batchVerifier(
      async () => {
        start()
        await pending
        return { stdout: batchOutput() }
      },
      {
        ...fs,
        async rm(...args) {
          removed++
          return fs.rm(...args)
        },
      },
      controller.signal,
    )
    const work = verifier.verifyPackages({ entries: BATCH_ENTRIES, candidate: BATCH_CANDIDATE })
    await started
    if (stop === "abort") controller.abort()
    const disposal = verifier.dispose()
    assert.equal(verifier.dispose(), disposal)
    assert.equal(removed, 0)
    finish()
    await assert.rejects(work, /disposed|abort/)
    await disposal
    assert.equal(removed, 1)
    await assert.rejects(access(verifier.root))
  })
test("aborted batch does no filesystem work or command", async () => {
  const controller = new AbortController()
  const verifier = await batchVerifier(
    async () => {
      throw new Error("must not run")
    },
    fs,
    controller.signal,
  )
  controller.abort()
  try {
    await assert.rejects(
      verifier.verifyPackages({ entries: BATCH_ENTRIES, candidate: BATCH_CANDIDATE }),
      /abort/,
    )
  } finally {
    await verifier.dispose()
  }
})
test("factory removes its created root even when canonicalization fails", async () => {
  let created, removed
  await assert.rejects(
    batchVerifier(async () => {}, {
      ...fs,
      async mkdtemp(prefix) {
        created = await fs.mkdtemp(prefix)
        return created
      },
      async realpath() {
        throw new Error("canonicalization failed")
      },
      async rm(directory, options) {
        removed = directory
        return fs.rm(directory, options)
      },
    }),
    /canonicalization failed/,
  )
  try {
    assert.equal(removed, created)
    await assert.rejects(access(created))
  } finally {
    await fs.rm(created, { recursive: true, force: true })
  }
})

test("controlled 21-package captures reduce actual audit runner invocations from 42 to 2", async (t) => {
  const entries = [
    ...BATCH_ENTRIES,
    ...Array.from({ length: 18 }, (_, i) => packageEntry(`package-${i}`)),
  ]
  const counts = {}
  for (const mode of ["verifyPackage", "verifyPackages"]) {
    counts[mode] = { factories: 0, auditCommands: 0 }
    for (let capture = 0; capture < 2; capture++) {
      counts[mode].factories++
      const verifier = await batchVerifier(async () => {
        counts[mode].auditCommands++
        return { stdout: batchOutput(entries) }
      })
      try {
        if (mode === "verifyPackages")
          await verifier.verifyPackages({ entries, candidate: BATCH_CANDIDATE })
        else
          for (const entry of entries)
            await verifier.verifyPackage({ entry, candidate: BATCH_CANDIDATE })
      } finally {
        await verifier.dispose()
      }
    }
  }
  assert.deepEqual(counts, {
    verifyPackage: { factories: 2, auditCommands: 42 },
    verifyPackages: { factories: 2, auditCommands: 2 },
  })
  t.diagnostic(
    `Deterministic runner counts; not network or production latency: ${JSON.stringify(counts)}`,
  )
})

test("batch verifies the complete tree even when the audit command rejects", async () => {
  let readsAfterFailure = 0,
    failed = false
  const verifier = await batchVerifier(
    async () => {
      failed = true
      throw new Error("audit process failed")
    },
    {
      ...fs,
      async readFile(...args) {
        if (failed) readsAfterFailure++
        return fs.readFile(...args)
      },
    },
  )
  try {
    await assert.rejects(
      verifier.verifyPackages({ entries: BATCH_ENTRIES, candidate: BATCH_CANDIDATE }),
      /audit process failed/,
    )
    assert.equal(readsAfterFailure, BATCH_ENTRIES.length + 1)
  } finally {
    await verifier.dispose()
  }
})

test("batch rejects unknown, missing, or malformed canonical entry and candidate fields before filesystem work", async () => {
  let fsCalls = 0
  const fileSystem = Object.fromEntries(
    Object.entries(fs).map(([key, value]) => [
      key,
      typeof value === "function"
        ? (...args) => {
            fsCalls++
            return value(...args)
          }
        : value,
    ]),
  )
  const verifier = await batchVerifier(async () => ({ stdout: batchOutput() }), fileSystem)
  const valid = {
    entries: structuredClone(BATCH_ENTRIES),
    candidate: structuredClone(BATCH_CANDIDATE),
  }
  const inputs = []
  for (const target of ["entry", "candidate"]) {
    const extra = structuredClone(valid)
    ;(target === "entry" ? extra.entries[0] : extra.candidate).unexpected = true
    inputs.push(extra)
    for (const field of Object.keys(target === "entry" ? ENTRY : BATCH_CANDIDATE)) {
      const missing = structuredClone(valid)
      delete (target === "entry" ? missing.entries[0] : missing.candidate)[field]
      inputs.push(missing)
    }
  }
  for (const drift of [
    { filename: "other.tgz" },
    { filename: "../escape.tgz" },
    { size: 0 },
    { size: 1.5 },
    { size: 33 * 1024 * 1024 },
    { sha256: "F".repeat(64) },
    { access: "restricted" },
  ]) {
    const input = structuredClone(valid)
    Object.assign(input.entries[0], drift)
    inputs.push(input)
  }
  for (const drift of [{ ciWorkflow: "Other" }, { ciCheck: "other" }]) {
    const input = structuredClone(valid)
    Object.assign(input.candidate, drift)
    inputs.push(input)
  }
  try {
    for (const input of inputs) {
      const before = fsCalls
      await assert.rejects(verifier.verifyPackages(input))
      assert.equal(fsCalls, before)
    }
  } finally {
    await verifier.dispose()
  }
})
for (const stage of ["before", "after"])
  test(`batch rejects actual FIFO package metadata ${stage} the command before reading it`, {
    skip: process.platform === "win32",
    timeout: 5000,
  }, async () => {
    let writer,
      closed,
      fifo,
      expectedBytes,
      replaced = false,
      fifoReads = 0,
      commands = 0
    async function replace(file) {
      if (replaced) return
      replaced = true
      expectedBytes = await fs.readFile(file)
      await fs.unlink(file)
      execFileSync("mkfifo", [file])
      fifo = file
    }
    const verifier = await batchVerifier(
      async ({ cwd }) => {
        commands++
        if (stage === "after")
          await replace(path.join(cwd, "node_modules/@dawn-ai/core/package.json"))
        return { stdout: batchOutput() }
      },
      {
        ...fs,
        async writeFile(file, ...args) {
          await fs.writeFile(file, ...args)
          if (stage === "before" && file.endsWith("node_modules/@dawn-ai/core/package.json"))
            await replace(file)
        },
        async readFile(file, ...args) {
          if (file !== fifo) return fs.readFile(file, ...args)
          fifoReads++
          writer = spawn(
            process.execPath,
            [
              "-e",
              "require('node:fs').writeFileSync(process.argv[1], Buffer.from(process.argv[2], 'base64'))",
              file,
              expectedBytes.toString("base64"),
            ],
            { stdio: "ignore" },
          )
          closed = new Promise((resolve) => writer.once("close", resolve))
          const bytes = await fs.readFile(file, ...args)
          await closed
          return bytes
        },
      },
    )
    try {
      await assert.rejects(
        verifier.verifyPackages({ entries: BATCH_ENTRIES, candidate: BATCH_CANDIDATE }),
        /regular file/,
      )
      assert.equal(fifoReads, 0)
      assert.equal(commands, stage === "before" ? 0 : 1)
    } finally {
      if (writer?.exitCode === null) writer.kill("SIGKILL")
      if (closed) await closed
      await verifier.dispose()
    }
  })

test("legacy verifier dependencies need no lstat until a batch is requested", async () => {
  const fileSystem = { ...fs }
  delete fileSystem.lstat
  const verifier = await batchVerifier(async () => ({ stdout: auditOutput() }), fileSystem)
  try {
    assert.equal(
      (await verifier.verifyPackage({ entry: ENTRY, candidate: CANDIDATE })).status,
      "verified",
    )
    await assert.rejects(
      verifier.verifyPackages({ entries: BATCH_ENTRIES, candidate: BATCH_CANDIDATE }),
      /lstat/,
    )
  } finally {
    await verifier.dispose()
  }
})
