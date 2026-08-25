import assert from "node:assert/strict"
import { createHash, generateKeyPairSync, sign as signBytes } from "node:crypto"
import test from "node:test"

import { classifyRegistryResponse, createNpmReader } from "../adapters/npm.mjs"

const NAME = "@dawn-ai/sdk"
const VERSION = "0.8.21"
const COMMIT_SHA = "0123456789abcdef0123456789abcdef01234567"
const OTHER_COMMIT_SHA = "abcdef0123456789abcdef0123456789abcdef01"
const REGISTRY = "https://registry.npmjs.org"
const INTEGRITY = `sha512-${"A".repeat(86)}==`

test("createNpmReader exposes only the named read operation and uses encoded GET requests", async () => {
  const { fetchImpl, calls } = recordingFetch([
    jsonResponse(versionDocument()),
    jsonResponse({ name: NAME, "dist-tags": { next: "0.9.0-beta.1", latest: VERSION } }),
    jsonResponse(attestationDocument()),
  ])
  const npm = createNpmReader({ fetchImpl })

  assert.deepEqual(Object.keys(npm), [
    "observePackageMetadata",
    "observePackageVersion",
    "downloadRegistryTarball",
    "verifyRegistrySignatures",
  ])
  const result = await npm.observePackageVersion({ name: NAME, version: VERSION })

  assert.deepEqual(
    calls.map(({ url, init }) => ({
      url,
      method: init.method,
      redirect: init.redirect,
      accept: init.headers.Accept,
    })),
    [
      {
        url: `${REGISTRY}/%40dawn-ai%2Fsdk/0.8.21`,
        method: "GET",
        redirect: "manual",
        accept: "application/json",
      },
      {
        url: `${REGISTRY}/%40dawn-ai%2Fsdk`,
        method: "GET",
        redirect: "manual",
        accept: "application/vnd.npm.install-v1+json",
      },
      {
        url: `${REGISTRY}/-/npm/v1/attestations/@dawn-ai%2fsdk@0.8.21`,
        method: "GET",
        redirect: "manual",
        accept: "application/json",
      },
    ],
  )
  assert.deepEqual(result, {
    status: "PRESENT",
    operation: "package-version",
    httpStatus: 200,
    code: null,
    package: {
      name: NAME,
      version: VERSION,
      tarballUrl: `${REGISTRY}/@dawn-ai/sdk/-/sdk-${VERSION}.tgz`,
      shasum: "a".repeat(40),
      integrity: INTEGRITY,
      signatures: [
        { keyid: "SHA256:key-a", sig: "signature-a" },
        { keyid: "SHA256:key-b", sig: "signature-b" },
      ],
      distTags: { latest: VERSION, next: "0.9.0-beta.1" },
      latest: VERSION,
      provenance: {
        status: "PRESENT",
        url: `${REGISTRY}/-/npm/v1/attestations/@dawn-ai%2fsdk@0.8.21`,
        predicateTypes: ["https://slsa.dev/provenance/v1"],
        workflow: ".github/workflows/release.yml",
        commitSha: COMMIT_SHA,
        repository: "https://github.com/cacheplane/dawnai",
        ref: "refs/heads/main",
      },
    },
  })
  assert.deepEqual(JSON.parse(JSON.stringify(result)), result)
})

test("downloads an exact same-origin registry tarball with bounded canonical bytes and digests", async () => {
  const bytes = Buffer.from("exact registry tarball bytes")
  const tarballUrl = `${REGISTRY}/@dawn-ai/sdk/-/sdk-${VERSION}.tgz`
  const { fetchImpl, calls } = recordingFetch([
    new Response(bytes, { headers: { "content-type": "application/octet-stream" } }),
  ])

  const result = await createNpmReader({ fetchImpl }).downloadRegistryTarball({ tarballUrl })

  assert.deepEqual(
    calls.map(({ url, init }) => ({
      url,
      method: init.method,
      redirect: init.redirect,
      accept: init.headers.Accept,
    })),
    [
      {
        url: tarballUrl,
        method: "GET",
        redirect: "manual",
        accept: "application/octet-stream",
      },
    ],
  )
  assert.deepEqual(result, {
    status: "PRESENT",
    operation: "package-tarball",
    httpStatus: 200,
    code: null,
    tarball: {
      url: tarballUrl,
      size: bytes.length,
      sha1: createHash("sha1").update(bytes).digest("hex"),
      sha256: createHash("sha256").update(bytes).digest("hex"),
      sha512: createHash("sha512").update(bytes).digest("hex"),
      contentBase64: bytes.toString("base64"),
    },
  })
  assert.deepEqual(JSON.parse(JSON.stringify(result)), result)
})

test("registry tarball auth, redirect, oversized, malformed, and cross-origin results are never absence", async () => {
  const tarballUrl = `${REGISTRY}/@dawn-ai/sdk/-/sdk-${VERSION}.tgz`
  const responses = [
    new Response("denied", {
      status: 401,
      headers: { "content-type": "application/octet-stream" },
    }),
    new Response(null, {
      status: 302,
      headers: {
        "content-type": "application/octet-stream",
        location: "https://cdn.example.test/package.tgz",
      },
    }),
    new Response(Buffer.alloc(6), {
      headers: { "content-length": "6", "content-type": "application/octet-stream" },
    }),
    responseLike({
      status: 200,
      ok: true,
      body: "bytes",
      headers: { "content-type": "text/plain" },
    }),
  ]
  for (let index = 0; index < responses.length; index += 1) {
    const npm = createNpmReader({
      fetchImpl: async () => responses[index],
      ...(index === 2 ? { maxResponseBytes: 5 } : {}),
    })
    const result = await npm.downloadRegistryTarball({ tarballUrl })
    assert.notEqual(result.status, "ABSENT")
    assert.equal(result.operation, "package-tarball")
  }

  let fetches = 0
  const npm = createNpmReader({
    fetchImpl: async () => {
      fetches += 1
      throw new Error("must not fetch")
    },
  })
  await assert.rejects(
    npm.downloadRegistryTarball({
      tarballUrl: `https://registry.example.test/sdk-${VERSION}.tgz`,
    }),
    /registry tarball URL|same-origin|unsafe/iu,
  )
  assert.equal(fetches, 0)
})

test("cryptographically verifies npm registry signatures against the exact registry key", async () => {
  const { publicKey, privateKey } = generateKeyPairSync("ec", { namedCurve: "P-256" })
  const keyid = "SHA256:test-key"
  const signature = signBytes(
    "sha256",
    Buffer.from(`${NAME}@${VERSION}:${INTEGRITY}`),
    privateKey,
  ).toString("base64")
  const { fetchImpl, calls } = recordingFetch([
    jsonResponse({
      keys: [
        {
          expires: null,
          keyid,
          keytype: "ecdsa-sha2-nistp256",
          scheme: "ecdsa-sha2-nistp256",
          key: publicKey.export({ format: "der", type: "spki" }).toString("base64"),
        },
      ],
    }),
  ])
  const npm = createNpmReader({ fetchImpl })

  const result = await npm.verifyRegistrySignatures({
    name: NAME,
    version: VERSION,
    integrity: INTEGRITY,
    signatures: [{ keyid, sig: signature }],
  })

  assert.equal(calls[0].url, `${REGISTRY}/-/npm/v1/keys`)
  assert.deepEqual(result, {
    status: "PRESENT",
    operation: "registry-signature",
    httpStatus: 200,
    code: null,
    signature: { status: "valid", keyid },
  })
  assert.deepEqual(
    await npm.verifyRegistrySignatures({
      name: NAME,
      version: VERSION,
      integrity: INTEGRITY,
      signatures: [],
    }),
    {
      status: "PRESENT",
      operation: "registry-signature",
      httpStatus: null,
      code: null,
      signature: { status: "missing", keyid: null },
    },
  )
})

test("invalid, unknown-key, and ambiguous registry signatures never become valid evidence", async () => {
  const { publicKey } = generateKeyPairSync("ec", { namedCurve: "P-256" })
  const key = publicKey.export({ format: "der", type: "spki" }).toString("base64")
  const signatures = [{ keyid: "SHA256:unknown", sig: Buffer.from("invalid").toString("base64") }]
  for (const response of [
    jsonResponse({
      keys: [
        {
          expires: null,
          keyid: "SHA256:other",
          keytype: "ecdsa-sha2-nistp256",
          scheme: "ecdsa-sha2-nistp256",
          key,
        },
      ],
    }),
    jsonResponse({ code: "EAUTH" }, 401),
    jsonResponse({ keys: "malformed" }),
  ]) {
    const result = await createNpmReader({
      fetchImpl: async () => response,
    }).verifyRegistrySignatures({
      name: NAME,
      version: VERSION,
      integrity: INTEGRITY,
      signatures,
    })
    assert.notDeepEqual(result.signature, { status: "valid", keyid: "SHA256:unknown" })
    assert.notEqual(result.status, "ABSENT")
  }
})

test("registry signature evidence rejects duplicate, expired, unsupported, and malformed keys and signatures", async () => {
  const { publicKey, privateKey } = generateKeyPairSync("ec", { namedCurve: "P-256" })
  const keyid = "SHA256:strict-key"
  const key = publicKey.export({ format: "der", type: "spki" }).toString("base64")
  const signature = signBytes(
    "sha256",
    Buffer.from(`${NAME}@${VERSION}:${INTEGRITY}`),
    privateKey,
  ).toString("base64")
  const validKey = {
    expires: null,
    key,
    keyid,
    keytype: "ecdsa-sha2-nistp256",
    scheme: "ecdsa-sha2-nistp256",
  }
  const rows = [
    {
      name: "duplicate key IDs",
      body: { keys: [validKey, { ...validKey }] },
      signatures: [{ keyid, sig: signature }],
      code: "MALFORMED_SCHEMA",
    },
    {
      name: "expired matching key",
      body: { keys: [{ ...validKey, expires: "2026-01-01T00:00:00.000Z" }] },
      signatures: [{ keyid, sig: signature }],
      now: () => Date.parse("2026-01-02T00:00:00.000Z"),
      code: "REGISTRY_KEY_EXPIRED",
    },
    {
      name: "unsupported key type",
      body: { keys: [{ ...validKey, keytype: "rsa-sha2-512" }] },
      signatures: [{ keyid, sig: signature }],
      code: "MALFORMED_SCHEMA",
    },
    {
      name: "unsupported signature scheme",
      body: { keys: [{ ...validKey, scheme: "ecdsa-sha2-nistp384" }] },
      signatures: [{ keyid, sig: signature }],
      code: "MALFORMED_SCHEMA",
    },
    {
      name: "noncanonical key base64",
      body: { keys: [{ ...validKey, key: "AA" }] },
      signatures: [{ keyid, sig: signature }],
      code: "MALFORMED_SCHEMA",
    },
    {
      name: "invalid public key DER",
      body: { keys: [{ ...validKey, key: Buffer.from("not-spki").toString("base64") }] },
      signatures: [{ keyid, sig: signature }],
      code: "MALFORMED_SCHEMA",
    },
    {
      name: "key ID mismatch",
      body: { keys: [validKey] },
      signatures: [{ keyid: "SHA256:another-key", sig: signature }],
      code: "REGISTRY_KEY_NOT_FOUND",
    },
    {
      name: "noncanonical signature base64",
      body: { keys: [validKey] },
      signatures: [{ keyid, sig: `${signature}=` }],
      code: "MALFORMED_SIGNATURE",
    },
    {
      name: "invalid signature DER",
      body: { keys: [validKey] },
      signatures: [{ keyid, sig: Buffer.from("not-der").toString("base64") }],
      code: "MALFORMED_SIGNATURE",
    },
    {
      name: "unexpected key response field",
      body: { keys: [validKey], fetchedAt: "2026-01-01T00:00:00.000Z" },
      signatures: [{ keyid, sig: signature }],
      code: "MALFORMED_SCHEMA",
    },
  ]

  for (const row of rows) {
    const result = await createNpmReader({
      fetchImpl: async () => jsonResponse(row.body),
      ...(row.now === undefined ? {} : { now: row.now }),
    }).verifyRegistrySignatures({
      name: NAME,
      version: VERSION,
      integrity: INTEGRITY,
      signatures: row.signatures,
    })
    assert.equal(result.status, "ERROR", row.name)
    assert.equal(result.code, row.code, row.name)
    assert.notDeepEqual(result.signature, { status: "valid", keyid }, row.name)
  }

  for (const signatures of [
    [
      { keyid, sig: signature },
      { keyid, sig: signature },
    ],
    [{ keyid, sig: signature, unexpected: true }],
    Array.from({ length: 257 }, (_, index) => ({
      keyid: `SHA256:key-${index}`,
      sig: signature,
    })),
  ]) {
    await assert.rejects(
      createNpmReader({
        fetchImpl: async () => jsonResponse({ keys: [validKey] }),
      }).verifyRegistrySignatures({
        name: NAME,
        version: VERSION,
        integrity: INTEGRITY,
        signatures,
      }),
      /signature inputs/iu,
    )
  }
})

test("cached registry keys are rechecked against their exact expiry", async () => {
  const { publicKey, privateKey } = generateKeyPairSync("ec", { namedCurve: "P-256" })
  const keyid = "SHA256:expiring-key"
  const expires = "2026-08-25T12:01:00.000Z"
  let observedNow = Date.parse("2026-08-25T12:00:00.000Z")
  let fetches = 0
  const signature = signBytes(
    "sha256",
    Buffer.from(`${NAME}@${VERSION}:${INTEGRITY}`),
    privateKey,
  ).toString("base64")
  const npm = createNpmReader({
    now: () => observedNow,
    fetchImpl: async () => {
      fetches += 1
      return jsonResponse({
        keys: [
          {
            expires,
            keyid,
            keytype: "ecdsa-sha2-nistp256",
            scheme: "ecdsa-sha2-nistp256",
            key: publicKey.export({ format: "der", type: "spki" }).toString("base64"),
          },
        ],
      })
    },
  })
  const request = {
    name: NAME,
    version: VERSION,
    integrity: INTEGRITY,
    signatures: [{ keyid, sig: signature }],
  }

  assert.equal((await npm.verifyRegistrySignatures(request)).signature.status, "valid")
  observedNow = Date.parse(expires)
  const expired = await npm.verifyRegistrySignatures(request)

  assert.equal(fetches, 1)
  assert.equal(expired.status, "ERROR")
  assert.equal(expired.code, "REGISTRY_KEY_EXPIRED")
})

test("observePackageMetadata reads only bounded public dist-tags independently", async () => {
  const { fetchImpl, calls } = recordingFetch([
    jsonResponse({ name: NAME, "dist-tags": { next: "0.9.0-beta.1", latest: "0.8.22" } }),
  ])
  const result = await createNpmReader({ fetchImpl }).observePackageMetadata({ name: NAME })
  assert.deepEqual(
    calls.map(({ url, init }) => ({ url, method: init.method, accept: init.headers.Accept })),
    [
      {
        url: `${REGISTRY}/%40dawn-ai%2Fsdk`,
        method: "GET",
        accept: "application/vnd.npm.install-v1+json",
      },
    ],
  )
  assert.deepEqual(result, {
    status: "PRESENT",
    operation: "package-metadata",
    httpStatus: 200,
    code: null,
    metadata: { name: NAME, latest: "0.8.22" },
  })
})

test("npm packuments require an exact own package name before retaining dist-tags", async (t) => {
  const cases = [
    ["missing", { "dist-tags": { latest: VERSION } }],
    ["wrong", { name: "npm_secret-package-name", "dist-tags": { latest: VERSION } }],
    ["number", { name: 7, "dist-tags": { latest: VERSION } }],
    ["object", { name: { value: NAME }, "dist-tags": { latest: VERSION } }],
    ["array", { name: [NAME], "dist-tags": { latest: VERSION } }],
    ["null", { name: null, "dist-tags": { latest: VERSION } }],
  ]
  for (const [label, packument] of cases) {
    await t.test(label, async () => {
      const metadata = await createNpmReader({
        fetchImpl: async () => jsonResponse(packument),
      }).observePackageMetadata({ name: NAME })
      assert.deepEqual(metadata, {
        status: "ERROR",
        operation: "package-metadata",
        httpStatus: 200,
        code: "MALFORMED_SCHEMA",
      })
      assert.doesNotMatch(JSON.stringify(metadata), /latest|distTags|npm_secret/u)

      const recording = recordingFetch([jsonResponse(versionDocument()), jsonResponse(packument)])
      const version = await createNpmReader({
        fetchImpl: recording.fetchImpl,
      }).observePackageVersion({ name: NAME, version: VERSION })
      assert.deepEqual(version, {
        status: "ERROR",
        operation: "package-metadata",
        httpStatus: 200,
        code: "MALFORMED_SCHEMA",
      })
      assert.equal(recording.calls.length, 2)
      assert.doesNotMatch(JSON.stringify(version), /latest|distTags|npm_secret/u)
    })
  }

  const inheritedName = await createNpmReader({
    fetchImpl: async () =>
      rawJsonResponse(`{"__proto__":{"name":"${NAME}"},"dist-tags":{"latest":"${VERSION}"}}`),
  }).observePackageMetadata({ name: NAME })
  assert.deepEqual(inheritedName, {
    status: "ERROR",
    operation: "package-metadata",
    httpStatus: 200,
    code: "MALFORMED_SCHEMA",
  })
})

test("observePackageMetadata never classifies package-level 404 as exact-version absence", async () => {
  const result = await createNpmReader({
    fetchImpl: async () => jsonResponse({ code: "E404" }, 404),
  }).observePackageMetadata({ name: NAME })
  assert.deepEqual(result, {
    status: "AMBIGUOUS",
    operation: "package-metadata",
    httpStatus: 404,
    code: "E404",
  })
})

test("classifyRegistryResponse treats only exact-version E404 as absence", () => {
  const rows = [
    {
      name: "exact version E404",
      operation: "package-version",
      response: responseMeta(404),
      body: { code: "E404" },
      status: "ABSENT",
      code: "E404",
    },
    {
      name: "package metadata E404",
      operation: "package-metadata",
      response: responseMeta(404),
      body: { code: "E404" },
      status: "AMBIGUOUS",
      code: "E404",
    },
    ...[401, 403, 408, 429, 500, 503].map((httpStatus) => ({
      name: `HTTP ${httpStatus}`,
      operation: "package-version",
      response: responseMeta(httpStatus),
      body: { code: `E${httpStatus}`, error: "secret-bearing registry detail" },
      status: "AMBIGUOUS",
      code: `E${httpStatus}`,
    })),
  ]

  for (const row of rows) {
    assert.deepEqual(
      classifyRegistryResponse(row),
      {
        status: row.status,
        operation: row.operation,
        httpStatus: row.response.status,
        code: row.code,
      },
      row.name,
    )
  }

  assert.deepEqual(
    classifyRegistryResponse({
      operation: "package-version",
      response: { status: 404, ok: true },
      body: { code: "E404" },
    }),
    {
      status: "ABSENT",
      operation: "package-version",
      httpStatus: 404,
      code: "E404",
    },
  )
  assert.equal(
    classifyRegistryResponse({
      operation: "package-version",
      response: { status: 200, ok: false },
      body: {},
    }).status,
    "PRESENT",
  )
})

test("npm network, timeout, parse, content-type, and schema failures never become absence", async () => {
  const cases = [
    {
      name: "abort",
      fetchImpl: async () => {
        throw new DOMException("token=npm_secret", "AbortError")
      },
      code: "ABORTED",
      status: "AMBIGUOUS",
    },
    {
      name: "network",
      fetchImpl: async () => {
        throw new Error("https://user:npm_secret@example.invalid")
      },
      code: "NETWORK_ERROR",
      status: "AMBIGUOUS",
    },
    {
      name: "malformed JSON",
      fetchImpl: async () => new Response("{", { headers: { "content-type": "application/json" } }),
      code: "MALFORMED_JSON",
      status: "ERROR",
      httpStatus: 200,
    },
    {
      name: "wrong content type",
      fetchImpl: async () => new Response("{}", { headers: { "content-type": "text/html" } }),
      code: "UNEXPECTED_CONTENT_TYPE",
      status: "ERROR",
      httpStatus: 200,
    },
    {
      name: "malformed schema",
      fetchImpl: async () => jsonResponse({ name: NAME, version: VERSION, dist: null }),
      code: "MALFORMED_SCHEMA",
      status: "ERROR",
      httpStatus: 200,
    },
  ]

  for (const row of cases) {
    const npm = createNpmReader({ fetchImpl: row.fetchImpl })
    const result = await npm.observePackageVersion({ name: NAME, version: VERSION })
    assert.deepEqual(result, {
      status: row.status,
      operation: "package-version",
      httpStatus: row.httpStatus ?? null,
      code: row.code,
    })
    assert.doesNotMatch(JSON.stringify(result), /npm_secret|authorization/iu)
  }
})

test("npm HTTP failures retain safe operation/status/code without registry error text", async () => {
  const npm = createNpmReader({
    fetchImpl: async () =>
      jsonResponse({ code: "E403", error: "token=npm_secret Authorization: bearer hidden" }, 403),
  })

  const result = await npm.observePackageVersion({ name: NAME, version: VERSION })

  assert.deepEqual(result, {
    status: "AMBIGUOUS",
    operation: "package-version",
    httpStatus: 403,
    code: "E403",
  })
  assert.doesNotMatch(JSON.stringify(result), /npm_secret|authorization|bearer/iu)
})

test("npm refuses unsafe identities and registry URLs before fetching", () => {
  const npm = createNpmReader({ registryUrl: `${REGISTRY}/`, fetchImpl: assert.fail })
  for (const name of ["", "../sdk", "@dawn-ai", "@dawn-ai/sdk/extra", "dawn sdk", "--help"]) {
    assert.throws(() => npm.observePackageVersion({ name, version: VERSION }), /package name/u)
  }
  for (const version of ["", "v0.8.21", "latest", "0.8", "0.8.21 || 1.0.0"]) {
    assert.throws(() => npm.observePackageVersion({ name: NAME, version }), /exact SemVer/u)
  }
  for (const registryUrl of [
    "http://registry.npmjs.org",
    "https://user:secret@example.com",
    "not a url",
  ]) {
    assert.throws(() => createNpmReader({ registryUrl, fetchImpl: assert.fail }), /registry URL/u)
  }
})

test("npm rejects oversized inputs with a stable non-echoing code before parsing", () => {
  const npm = createNpmReader({ fetchImpl: assert.fail })
  for (const [name, version] of [
    [`@scope/${"a".repeat(300)}`, VERSION],
    [NAME, `1.0.0-${"a".repeat(300)}`],
  ]) {
    assert.throws(
      () => npm.observePackageVersion({ name, version }),
      (error) => error?.code === "INPUT_TOO_LONG" && !error.message.includes("a".repeat(100)),
    )
  }
  assert.throws(
    () => createNpmReader({ registryUrl: `https://${"a".repeat(2_100)}.test` }),
    (error) => error?.code === "INPUT_TOO_LONG" && !error.message.includes("a".repeat(100)),
  )
})

test("npm validation errors never echo control characters", () => {
  const npm = createNpmReader({ fetchImpl: assert.fail })
  for (const invoke of [
    () => npm.observePackageVersion({ name: "sdk\nforged", version: VERSION }),
    () => npm.observePackageVersion({ name: NAME, version: "1.0.0\rforged" }),
  ]) {
    assert.throws(invoke, errorWithoutControls)
  }
})

test("npm requires an explicit exact trust grant for non-default registry origins", () => {
  assert.throws(
    () => createNpmReader({ registryUrl: "https://registry.example.test/npm/" }),
    (error) => error?.code === "UNTRUSTED_REGISTRY_ORIGIN",
  )
  assert.doesNotThrow(() =>
    createNpmReader({
      registryUrl: "https://registry.example.test/npm/",
      trustedRegistryOrigins: ["https://registry.example.test"],
      fetchImpl: assert.fail,
    }),
  )
  assert.doesNotThrow(() =>
    createNpmReader({
      registryUrl: "http://[::1]:4873/",
      trustedRegistryOrigins: ["http://[::1]:4873"],
      fetchImpl: assert.fail,
    }),
  )
  assert.throws(
    () =>
      createNpmReader({
        registryUrl: "https://registry.example.test/npm/",
        trustedRegistryOrigins: ["https://registry.example.test.evil.test"],
      }),
    (error) => error?.code === "UNTRUSTED_REGISTRY_ORIGIN",
  )
})

test("npm refuses malformed or cross-origin tarball and provenance URLs", async () => {
  for (const mutate of [
    (document) => {
      document.dist.tarball = "https://evil.example/sdk.tgz"
    },
    (document) => {
      document.dist.tarball = "not a URL"
    },
    (document) => {
      document.dist.tarball = "https://user:secret@registry.npmjs.org/sdk.tgz"
    },
    (document) => {
      document.dist.attestations.url = "https://evil.example/provenance"
    },
    (document) => {
      document.dist.attestations.url = `${REGISTRY}/-/npm/v1/admin/users`
    },
    (document) => {
      document.dist.attestations.url = `${REGISTRY}/-/npm/v1/attestations/@dawn-ai%2fsdk@0.8.21?admin=true`
    },
    (document) => {
      document.dist.attestations.url = `https://user:secret@registry.npmjs.org/-/npm/v1/attestations/@dawn-ai%2fsdk@0.8.21`
    },
  ]) {
    const document = versionDocument()
    mutate(document)
    const { fetchImpl, calls } = recordingFetch([jsonResponse(document)])
    const result = await createNpmReader({ fetchImpl }).observePackageVersion({
      name: NAME,
      version: VERSION,
    })

    assert.equal(result.status, "ERROR")
    assert.equal(result.code, "UNSAFE_REGISTRY_URL")
    assert.equal(calls.length, 1)
  }
})

test("npm binds custom-registry provenance to the exact origin endpoint", async () => {
  const customRegistry = "https://registry.example.test/npm/"
  const document = versionDocument()
  document.dist.tarball = `https://registry.example.test/@dawn-ai/sdk/-/sdk-${VERSION}.tgz`
  document.dist.attestations.url =
    "https://registry.example.test/-/npm/v1/attestations/@dawn-ai%2fsdk@0.8.21"
  const recording = recordingFetch([
    jsonResponse(document),
    jsonResponse({ name: NAME, "dist-tags": { latest: VERSION } }),
    jsonResponse(attestationDocument()),
  ])

  const result = await createNpmReader({
    registryUrl: customRegistry,
    trustedRegistryOrigins: ["https://registry.example.test"],
    fetchImpl: recording.fetchImpl,
  }).observePackageVersion({ name: NAME, version: VERSION })

  assert.equal(result.status, "PRESENT")
  assert.equal(
    recording.calls[2].url,
    "https://registry.example.test/-/npm/v1/attestations/@dawn-ai%2fsdk@0.8.21",
  )
})

test("npm rejects provenance redirects without following them", async () => {
  const recording = recordingFetch([
    jsonResponse(versionDocument()),
    jsonResponse({ name: NAME, "dist-tags": { latest: VERSION } }),
    new Response(null, {
      status: 302,
      headers: { location: `${REGISTRY}/-/npm/v1/admin/users` },
    }),
  ])

  const result = await createNpmReader({ fetchImpl: recording.fetchImpl }).observePackageVersion({
    name: NAME,
    version: VERSION,
  })

  assert.deepEqual(result, {
    status: "ERROR",
    operation: "provenance",
    httpStatus: 302,
    code: "REDIRECT",
  })
  assert.equal(recording.calls.length, 3)
})

test("npm requires a canonical padded base64 encoding of exactly 64 integrity bytes", async () => {
  for (const integrity of [
    "sha512-A",
    "sha512-AA==",
    `sha512-${"A".repeat(86)}`,
    `sha512-${"A".repeat(85)}B==`,
  ]) {
    const document = versionDocument()
    document.dist.integrity = integrity
    const recording = recordingFetch([jsonResponse(document)])

    assert.deepEqual(
      await createNpmReader({ fetchImpl: recording.fetchImpl }).observePackageVersion({
        name: NAME,
        version: VERSION,
      }),
      {
        status: "ERROR",
        operation: "package-version",
        httpStatus: 200,
        code: "MALFORMED_SCHEMA",
      },
    )
    assert.equal(recording.calls.length, 1)
  }
})

test("npm applies bounded deadlines and response limits through the named observer", async () => {
  const timeout = createNpmReader({
    timeoutMs: 5,
    fetchImpl: async (_url, init) => {
      if (!(init.signal instanceof AbortSignal)) {
        throw new Error("missing bounded signal")
      }
      return new Promise((_resolve, reject) => {
        init.signal.addEventListener(
          "abort",
          () => reject(new DOMException("deadline", "AbortError")),
          { once: true },
        )
      })
    },
  })
  assert.deepEqual(await timeout.observePackageVersion({ name: NAME, version: VERSION }), {
    status: "AMBIGUOUS",
    operation: "package-version",
    httpStatus: null,
    code: "TIMEOUT",
  })

  const oversized = createNpmReader({
    maxResponseBytes: 4,
    fetchImpl: async () => jsonResponse(versionDocument()),
  })
  assert.deepEqual(await oversized.observePackageVersion({ name: NAME, version: VERSION }), {
    status: "ERROR",
    operation: "package-version",
    httpStatus: 200,
    code: "RESPONSE_TOO_LARGE",
  })
})

test("npm rejects malformed injected status and does not trust response ok", async () => {
  for (const response of [
    responseLike({ status: 99, ok: true, body: "{}" }),
    responseLike({ status: 600, ok: true, body: "{}" }),
  ]) {
    const result = await createNpmReader({ fetchImpl: async () => response }).observePackageVersion(
      {
        name: NAME,
        version: VERSION,
      },
    )
    assert.equal(result.status, "ERROR")
    assert.equal(result.code, "MALFORMED_RESPONSE")
  }

  const concealed = createNpmReader({
    fetchImpl: async () =>
      responseLike({
        status: 404,
        ok: true,
        body: JSON.stringify({ code: "E404" }),
        headers: { "content-type": "application/json" },
      }),
  })
  assert.equal(
    (await concealed.observePackageVersion({ name: NAME, version: VERSION })).status,
    "ABSENT",
  )
})

test("npm reports absent provenance explicitly without inventing workflow identity", async () => {
  const document = versionDocument()
  delete document.dist.attestations
  const { fetchImpl } = recordingFetch([
    jsonResponse(document),
    jsonResponse({ name: NAME, "dist-tags": { latest: VERSION } }),
  ])

  const result = await createNpmReader({ fetchImpl }).observePackageVersion({
    name: NAME,
    version: VERSION,
  })

  assert.deepEqual(result.package.provenance, {
    status: "ABSENT",
    url: null,
    predicateTypes: [],
    workflow: null,
    commitSha: null,
    repository: null,
    ref: null,
  })
})

test("npm never synthesizes provenance identity across separate SLSA statements", async () => {
  const evidence = attestationDocument([
    provenanceStatement({ commitSha: null }),
    provenanceStatement({ workflow: null }),
  ])

  const result = await observeWithEvidence(evidence)

  assert.deepEqual(result, {
    status: "ERROR",
    operation: "provenance",
    httpStatus: 200,
    code: "MALFORMED_PROVENANCE_IDENTITY",
  })
})

test("npm rejects conflicting complete provenance statements independent of input order", async () => {
  const statements = [provenanceStatement(), provenanceStatement({ commitSha: OTHER_COMMIT_SHA })]

  const forward = await observeWithEvidence(attestationDocument(statements))
  const reversed = await observeWithEvidence(attestationDocument([...statements].reverse()))

  assert.deepEqual(forward, {
    status: "AMBIGUOUS",
    operation: "provenance",
    httpStatus: 200,
    code: "PROVENANCE_IDENTITY_CONFLICT",
  })
  assert.deepEqual(reversed, forward)
})

test("npm agreeing provenance statements normalize independently of evidence order", async () => {
  const statements = [provenanceStatement(), structuredClone(provenanceStatement())]

  const forward = await observeWithEvidence(attestationDocument(statements))
  const reversed = await observeWithEvidence(attestationDocument([...statements].reverse()))

  assert.equal(forward.status, "PRESENT")
  assert.deepEqual(reversed, forward)
  assert.equal(forward.package.provenance.workflow, ".github/workflows/release.yml")
  assert.equal(forward.package.provenance.commitSha, COMMIT_SHA)
  assert.equal(forward.package.provenance.repository, "https://github.com/cacheplane/dawnai")
  assert.equal(forward.package.provenance.ref, "refs/heads/main")
})

function versionDocument() {
  return {
    name: NAME,
    version: VERSION,
    dist: {
      tarball: `${REGISTRY}/@dawn-ai/sdk/-/sdk-${VERSION}.tgz`,
      shasum: "a".repeat(40),
      integrity: INTEGRITY,
      signatures: [
        { keyid: "SHA256:key-b", sig: "signature-b" },
        { keyid: "SHA256:key-a", sig: "signature-a" },
      ],
      attestations: {
        url: `${REGISTRY}/-/npm/v1/attestations/@dawn-ai%2fsdk@0.8.21`,
      },
    },
  }
}

function provenanceStatement({
  workflow = ".github/workflows/release.yml",
  commitSha = COMMIT_SHA,
  repository = "https://github.com/cacheplane/dawnai",
  ref = "refs/heads/main",
} = {}) {
  return {
    predicateType: "https://slsa.dev/provenance/v1",
    subject: [
      {
        name: `pkg:npm/%40dawn-ai/sdk@${VERSION}`,
        digest: { sha512: "0".repeat(128) },
      },
    ],
    predicate: {
      buildDefinition: {
        externalParameters: {
          workflow:
            workflow === null
              ? undefined
              : {
                  path: workflow,
                  repository,
                  ref,
                },
        },
        resolvedDependencies:
          commitSha === null
            ? []
            : [
                {
                  uri: `git+${repository}@${ref}`,
                  digest: { gitCommit: commitSha },
                },
              ],
      },
    },
  }
}

function attestationDocument(statements = [provenanceStatement()]) {
  return {
    attestations: statements.map((statement) => ({
      predicateType: statement.predicateType,
      bundle: {
        dsseEnvelope: {
          payload: Buffer.from(JSON.stringify(statement)).toString("base64"),
        },
      },
    })),
  }
}

async function observeWithEvidence(evidence) {
  const { fetchImpl } = recordingFetch([
    jsonResponse(versionDocument()),
    jsonResponse({ name: NAME, "dist-tags": { latest: VERSION } }),
    jsonResponse(evidence),
  ])
  return createNpmReader({ fetchImpl }).observePackageVersion({
    name: NAME,
    version: VERSION,
  })
}

function recordingFetch(responses) {
  const calls = []
  return {
    calls,
    async fetchImpl(url, init) {
      calls.push({ url: String(url), init })
      return responses.shift()
    },
  }
}

function jsonResponse(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  })
}

function rawJsonResponse(body, status = 200) {
  return new Response(body, {
    status,
    headers: { "content-type": "application/json" },
  })
}

function responseMeta(status) {
  return { status, ok: status >= 200 && status < 300 }
}

function responseLike({ status, ok, body, headers = { "content-type": "application/json" } }) {
  const bytes = new TextEncoder().encode(body)
  return {
    status,
    ok,
    headers: new Headers(headers),
    body: new ReadableStream({
      start(controller) {
        controller.enqueue(bytes)
        controller.close()
      },
    }),
  }
}

function errorWithoutControls(error) {
  return ![...(error?.message ?? "")].some((character) => {
    const codePoint = character.codePointAt(0)
    return codePoint <= 31 || codePoint === 127
  })
}
