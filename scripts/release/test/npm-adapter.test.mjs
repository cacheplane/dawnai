import assert from "node:assert/strict"
import test from "node:test"

import { classifyRegistryResponse, createNpmReader } from "../adapters/npm.mjs"

const NAME = "@dawn-ai/sdk"
const VERSION = "0.8.21"
const COMMIT_SHA = "0123456789abcdef0123456789abcdef01234567"
const REGISTRY = "https://registry.npmjs.org"

test("createNpmReader exposes only the named read operation and uses encoded GET requests", async () => {
  const { fetchImpl, calls } = recordingFetch([
    jsonResponse(versionDocument()),
    jsonResponse({ "dist-tags": { next: "0.9.0-beta.1", latest: VERSION } }),
    jsonResponse(attestationDocument()),
  ])
  const npm = createNpmReader({ fetchImpl })

  assert.deepEqual(Object.keys(npm), ["observePackageVersion"])
  const result = await npm.observePackageVersion({ name: NAME, version: VERSION })

  assert.deepEqual(
    calls.map(({ url, init }) => ({ url, method: init.method, accept: init.headers.Accept })),
    [
      {
        url: `${REGISTRY}/%40dawn-ai%2Fsdk/0.8.21`,
        method: "GET",
        accept: "application/json",
      },
      {
        url: `${REGISTRY}/%40dawn-ai%2Fsdk`,
        method: "GET",
        accept: "application/vnd.npm.install-v1+json",
      },
      {
        url: `${REGISTRY}/-/npm/v1/attestations/%40dawn-ai%2Fsdk@0.8.21`,
        method: "GET",
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
      integrity: `sha512-${"A".repeat(86)}==`,
      signatures: [
        { keyid: "SHA256:key-a", sig: "signature-a" },
        { keyid: "SHA256:key-b", sig: "signature-b" },
      ],
      distTags: { latest: VERSION, next: "0.9.0-beta.1" },
      latest: VERSION,
      provenance: {
        status: "PRESENT",
        url: `${REGISTRY}/-/npm/v1/attestations/%40dawn-ai%2Fsdk@0.8.21`,
        predicateTypes: ["https://slsa.dev/provenance/v1"],
        workflow: ".github/workflows/release.yml",
        commitSha: COMMIT_SHA,
      },
    },
  })
  assert.deepEqual(JSON.parse(JSON.stringify(result)), result)
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

test("npm reports absent provenance explicitly without inventing workflow identity", async () => {
  const document = versionDocument()
  delete document.dist.attestations
  const { fetchImpl } = recordingFetch([
    jsonResponse(document),
    jsonResponse({ "dist-tags": { latest: VERSION } }),
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
  })
})

function versionDocument() {
  return {
    name: NAME,
    version: VERSION,
    dist: {
      tarball: `${REGISTRY}/@dawn-ai/sdk/-/sdk-${VERSION}.tgz`,
      shasum: "a".repeat(40),
      integrity: `sha512-${"A".repeat(86)}==`,
      signatures: [
        { keyid: "SHA256:key-b", sig: "signature-b" },
        { keyid: "SHA256:key-a", sig: "signature-a" },
      ],
      attestations: {
        url: `${REGISTRY}/-/npm/v1/attestations/%40dawn-ai%2Fsdk@0.8.21`,
      },
    },
  }
}

function attestationDocument() {
  const statement = {
    predicateType: "https://slsa.dev/provenance/v1",
    predicate: {
      buildDefinition: {
        externalParameters: {
          workflow: { path: ".github/workflows/release.yml" },
        },
        resolvedDependencies: [{ digest: { gitCommit: COMMIT_SHA } }],
      },
    },
  }
  return {
    attestations: [
      {
        predicateType: statement.predicateType,
        bundle: {
          dsseEnvelope: {
            payload: Buffer.from(JSON.stringify(statement)).toString("base64"),
          },
        },
      },
    ],
  }
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

function responseMeta(status) {
  return { status, ok: status >= 200 && status < 300 }
}
