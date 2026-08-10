import {
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
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { fileURLToPath, pathToFileURL } from "node:url"

import { discoverRoutes } from "@dawn-ai/core/node"

import { afterEach, describe, expect, test, vi } from "vitest"

import { runBuildCommand } from "../src/commands/build.js"
import { validateVercelOutput } from "../src/lib/build/targets/vercel-output.js"
import { loadMiddleware } from "../src/lib/dev/middleware.js"

import {
  type AtomicJsonFileOps,
  assembleNativeFixtures,
  assertBarrierId,
  assertDeploymentId,
  assertLogMarker,
  assertNativeFixtureUploadIsolation,
  assertReconciliationMarker,
  assertThreadId,
  canonicalizeVercelOrigin,
  createNativeReleaseAuthorization,
  createSecretRedactor,
  deriveDawnPackageClosure,
  NATIVE_DIRECT_DAWN_DEPENDENCIES,
  type NativeLocalCommandRequest,
  type NativePackedArtifact,
  type NativeWorkspacePackage,
  nativeAgentRunBody,
  nativeLaneEnabled,
  parseNativeFixtureLockfile,
  parseNativeReceipt,
  readNativeLaneEnvironment,
  renderNativeFixtureManifest,
  renderNativeRouteFiles,
  renderNativeWorkspaceYaml,
  sanitizeChildEnvironment,
  validateNativeFixtureLockfile,
  writeAtomicJson,
  writeFinalReceipt,
} from "./helpers/vercel-native-fixture.js"

const tempDirs: string[] = []
const cliPackageRoot = join(dirname(fileURLToPath(import.meta.url)), "..")
const repoRoot = join(cliPackageRoot, "..", "..")

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((path) => rm(path, { force: true, recursive: true })))
})

async function makeTempDir(): Promise<string> {
  const path = await mkdtemp(join(tmpdir(), "dawn-vercel-native-"))
  tempDirs.push(path)
  return path
}

function validDeployment(kind: "source" | "prebuilt") {
  return {
    kind,
    deploymentId: kind === "source" ? "dpl_Source1" : "dpl_Prebuilt2",
    canonicalOrigin:
      kind === "source"
        ? "https://dawn-source-abc.vercel.app"
        : "https://dawn-prebuilt-def.vercel.app",
    apiBindingVerified: true,
    config: { fluid: true, sha256: "a".repeat(64) },
    readyState: "READY",
    routes: { unknownRoute404: true, state: true, stream: true, release: true },
    state: {
      visits: [1, 2],
      markersInOrder: true,
      generatedReadMatched: true,
      physicalCheckpoint: true,
    },
    middleware: {
      missingHeader401: true,
      wrongHeader401: true,
      selectiveRelease: true,
      sentinelUnreleased: true,
    },
    stream: {
      status: 200,
      contentType: "text/event-stream",
      noRedirect: true,
      beforeFrameIndex: 0,
      preReleaseQuietMs: 1000,
      authorizedReleaseAfterBeforeFrame: true,
      afterFrameIndex: 1,
      doneFrameIndex: 2,
      eofAfterDone: true,
    },
    laterRequest: { succeeded: true, logMarkerSeen: true },
    logs: {
      pollIntervalMs: 2000,
      quietIntervalMs: 30000,
      queryStartIso: "2026-08-10T00:00:00.000Z",
      queryEndIso: "2026-08-10T00:01:00.000Z",
      uniqueRowVersions: 1,
      exactDeploymentOnly: true,
      noTruncation: true,
      noErrors: true,
    },
    reconciliation: {
      markerPersistedBeforeSpawn: true,
      apiBindingVerified: true,
      expectedCardinality: true,
    },
    cleanup: { deploymentAbsent: true, databaseRowsAbsent: true },
    provenance:
      kind === "source"
        ? { cleanSource: true, prebuiltOutputAbsent: true, remoteBuildObserved: true }
        : {
            localOutputValidated: true,
            prebuiltDeployObserved: true,
            remoteSourceBuildAbsent: true,
          },
  }
}

function validReceipt(): Record<string, unknown> {
  return {
    schemaVersion: 1,
    cliVersion: "58.9.0",
    projectBindingVerified: true,
    kinds: ["source", "prebuilt"],
    deployments: [validDeployment("source"), validDeployment("prebuilt")],
  }
}

function fakeAtomicJsonFileOps(options: {
  readonly fail?: "write" | "rename"
  readonly initial: Readonly<Record<string, string>>
}): { readonly files: Map<string, string>; readonly ops: AtomicJsonFileOps } {
  const files = new Map(Object.entries(options.initial))
  return {
    files,
    ops: {
      randomSuffix: () => "fixed",
      remove: async (path) => {
        files.delete(path)
      },
      rename: async (from, to) => {
        if (options.fail === "rename") throw new Error("injected rename failure")
        const contents = files.get(from)
        if (contents === undefined) throw new Error(`missing fake source ${from}`)
        files.set(to, contents)
        files.delete(from)
      },
      writeFile: async (path, contents) => {
        if (options.fail === "write") throw new Error("injected write failure")
        files.set(path, contents)
      },
    },
  }
}

function workspacePackage(
  name: string,
  manifest: Omit<NativeWorkspacePackage["manifest"], "name" | "version"> = {},
): NativeWorkspacePackage {
  return {
    dir: `packages/${name.slice("@dawn-ai/".length)}`,
    manifest: { name, version: "0.0.0-test", ...manifest },
    name,
  }
}

function packedArtifact(packageName: string): NativePackedArtifact {
  const stem = packageName.slice("@dawn-ai/".length)
  return {
    packageJson: { name: packageName, version: "0.0.0-test" },
    packageName,
    packageVersion: "0.0.0-test",
    tarballName: `dawn-ai-${stem}-0.0.0-test.tgz`,
    tarballPath: `/packs/dawn-ai-${stem}-0.0.0-test.tgz`,
  }
}

interface NativeLockfileFixture {
  readonly importers: {
    readonly ".": {
      readonly dependencies: Record<string, { specifier: string; version: string }>
    }
  }
  readonly lockfileVersion: "9.0"
  readonly overrides: Record<string, string>
  readonly packages: Record<string, unknown>
  readonly snapshots: Record<string, unknown>
}

function validNativeLockfile(artifacts: readonly NativePackedArtifact[]): NativeLockfileFixture {
  const references = artifacts.map(
    (artifact) => [artifact, `file:vendor/${artifact.tarballName}`] as const,
  )
  return {
    lockfileVersion: "9.0",
    overrides: Object.fromEntries(
      references.map(([artifact, reference]) => [artifact.packageName, reference]),
    ),
    importers: {
      ".": {
        dependencies: Object.fromEntries(
          references
            .slice(0, 1)
            .map(([artifact, reference]) => [
              artifact.packageName,
              { specifier: reference, version: reference },
            ]),
        ),
      },
    },
    packages: Object.fromEntries(
      references.map(([artifact, reference]) => [
        `${artifact.packageName}@${reference}`,
        { resolution: { tarball: reference }, version: artifact.packageVersion },
      ]),
    ),
    snapshots: Object.fromEntries(
      references.map(([artifact, reference]) => [`${artifact.packageName}@${reference}`, {}]),
    ),
  }
}

function renderTestNativeLockfile(artifacts: readonly NativePackedArtifact[]): string {
  const entries = artifacts.map((artifact) => ({
    artifact,
    identity: `${artifact.packageName}@file:vendor/${artifact.tarballName}`,
    reference: `file:vendor/${artifact.tarballName}`,
  }))
  const direct = NATIVE_DIRECT_DAWN_DEPENDENCIES.map((name) => {
    const entry = entries.find(({ artifact }) => artifact.packageName === name)
    if (!entry) throw new Error(`missing test artifact ${name}`)
    return entry
  })
  return [
    'lockfileVersion: "9.0"',
    "",
    "overrides:",
    ...entries.map(
      ({ artifact, reference }) =>
        `  ${JSON.stringify(artifact.packageName)}: ${JSON.stringify(reference)}`,
    ),
    "",
    "importers:",
    "  .:",
    "    dependencies:",
    ...direct.flatMap(({ artifact, reference }) => [
      `      ${JSON.stringify(artifact.packageName)}:`,
      `        specifier: ${JSON.stringify(reference)}`,
      `        version: ${JSON.stringify(reference)}`,
    ]),
    "",
    "packages:",
    ...entries.flatMap(({ artifact, identity, reference }) => [
      `  ${JSON.stringify(identity)}:`,
      `    resolution: {tarball: ${JSON.stringify(reference)}}`,
      `    version: ${JSON.stringify(artifact.packageVersion)}`,
    ]),
    "",
    "snapshots:",
    ...entries.map(({ identity }) => `  ${JSON.stringify(identity)}: {}`),
    "",
  ].join("\n")
}

async function makeAssemblyWorkspace() {
  const ownerRoot = await realpath(await makeTempDir())
  const repoRoot = join(ownerRoot, "repo")
  const runRoot = join(ownerRoot, "run")
  await mkdir(join(repoRoot, "packages"), { recursive: true })
  const entries = [
    workspacePackage("@dawn-ai/cli", {
      dependencies: { "@dawn-ai/core": "workspace:*" },
      optionalDependencies: { "@dawn-ai/langchain": "workspace:*" },
      peerDependencies: { "@dawn-ai/sdk": "workspace:*" },
    }),
    workspacePackage("@dawn-ai/core", {
      dependencies: { "@dawn-ai/sdk": "workspace:*" },
    }),
    workspacePackage("@dawn-ai/langchain", {
      dependencies: { "@dawn-ai/memory": "workspace:*" },
    }),
    workspacePackage("@dawn-ai/memory"),
    workspacePackage("@dawn-ai/postgres-storage", {
      dependencies: { "@dawn-ai/core": "workspace:*" },
    }),
    workspacePackage("@dawn-ai/sdk"),
    workspacePackage("@dawn-ai/unrelated"),
  ]
  for (const entry of entries) {
    const packageRoot = join(repoRoot, entry.dir)
    await mkdir(packageRoot, { recursive: true })
    await writeFile(
      join(packageRoot, "package.json"),
      `${JSON.stringify(entry.manifest, null, 2)}\n`,
      "utf8",
    )
  }
  return { entries, ownerRoot, repoRoot, runRoot }
}

async function makeUploadFixture(kind: "source" | "prebuilt") {
  const root = await realpath(await makeTempDir())
  const expectedTarballs = ["dawn-ai-cli-0.0.0-test.tgz", "dawn-ai-sdk-0.0.0-test.tgz"]
  await mkdir(join(root, "vendor"), { recursive: true })
  await mkdir(join(root, ".vercel"), { recursive: true })
  for (const name of expectedTarballs) await writeFile(join(root, "vendor", name), name, "utf8")
  await writeFile(
    join(root, ".vercel", "project.json"),
    `${JSON.stringify({ orgId: "team_Test123", projectId: "prj_Test456" })}\n`,
    "utf8",
  )
  await writeFile(join(root, "package.json"), '{"private":true}\n', "utf8")
  if (kind === "prebuilt") {
    await mkdir(join(root, ".vercel", "output", "functions"), { recursive: true })
    await writeFile(join(root, ".vercel", "output", "config.json"), "{}\n", "utf8")
    await mkdir(join(root, "node_modules", ".store", "fixture"), { recursive: true })
    await symlink(".store/fixture", join(root, "node_modules", "fixture"), "dir")
  }
  return { expectedTarballs, root }
}

async function expectUploadAccepted(kind: "source" | "prebuilt") {
  const fixture = await makeUploadFixture(kind)
  await expect(
    assertNativeFixtureUploadIsolation({
      ...fixture,
      kind,
      orgId: "team_Test123",
      projectId: "prj_Test456",
    }),
  ).resolves.toBeUndefined()
  return fixture
}

async function makeModelFreeNativeFixture(
  files: Readonly<Record<string, string>>,
): Promise<string> {
  const root = await realpath(await makeTempDir())
  const manifest = {
    ...renderNativeFixtureManifest("prebuilt", [
      packedArtifact("@dawn-ai/cli"),
      packedArtifact("@dawn-ai/postgres-storage"),
      packedArtifact("@dawn-ai/sdk"),
    ]),
    dependencies: {
      "@dawn-ai/cli": "0.0.0-test",
      "@dawn-ai/postgres-storage": "0.0.0-test",
      "@dawn-ai/sdk": "0.0.0-test",
      "@langchain/core": "1.2.5",
      "@langchain/langgraph": "1.4.9",
      "@langchain/langgraph-checkpoint": "1.1.3",
      "@neondatabase/serverless": "1.1.0",
      hono: "4.12.28",
      pg: "8.22.0",
      zod: "4.4.3",
    },
  }
  const fixtureFiles = {
    "package.json": `${JSON.stringify(manifest, null, 2)}\n`,
    "dawn.config.ts": 'export default { build: { targets: ["vercel"] } }\n',
    "vercel.json": `${JSON.stringify(
      {
        $schema: "https://openapi.vercel.sh/vercel.json",
        buildCommand: "node node_modules/@dawn-ai/cli/dist/index.js build",
        fluid: true,
      },
      null,
      2,
    )}\n`,
    ...files,
  }
  for (const [path, contents] of Object.entries(fixtureFiles)) {
    const destination = join(root, path)
    await mkdir(dirname(destination), { recursive: true })
    await writeFile(destination, contents, "utf8")
  }

  const dependencies = {
    "@dawn-ai/cli": cliPackageRoot,
    "@dawn-ai/core": join(repoRoot, "packages", "core"),
    "@dawn-ai/langchain": join(repoRoot, "packages", "langchain"),
    "@dawn-ai/langgraph": join(repoRoot, "packages", "langgraph"),
    "@dawn-ai/postgres-storage": join(repoRoot, "packages", "postgres-storage"),
    "@dawn-ai/sdk": join(repoRoot, "packages", "sdk"),
    "@langchain/core": join(cliPackageRoot, "node_modules", "@langchain", "core"),
    "@langchain/langgraph": join(cliPackageRoot, "node_modules", "@langchain", "langgraph"),
    "@langchain/langgraph-checkpoint": join(
      cliPackageRoot,
      "node_modules",
      "@langchain",
      "langgraph-checkpoint",
    ),
    "@neondatabase/serverless": join(cliPackageRoot, "node_modules", "@neondatabase", "serverless"),
    hono: join(cliPackageRoot, "node_modules", "hono"),
    pg: join(cliPackageRoot, "node_modules", "pg"),
    zod: join(cliPackageRoot, "node_modules", "zod"),
  }
  for (const [specifier, target] of Object.entries(dependencies)) {
    const destination = join(root, "node_modules", specifier)
    await mkdir(dirname(destination), { recursive: true })
    await symlink(target, destination, "junction")
  }
  return root
}

async function readRegularTree(root: string): Promise<Readonly<Record<string, string>>> {
  const files: Record<string, string> = {}
  async function visit(directory: string, prefix = ""): Promise<void> {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const relativePath = prefix ? join(prefix, entry.name) : entry.name
      const path = join(directory, entry.name)
      if (entry.isDirectory()) await visit(path, relativePath)
      else if (entry.isFile()) files[relativePath] = await readFile(path, "utf8")
    }
  }
  await visit(root)
  return files
}

function errorTreeText(value: unknown, active = new WeakSet<object>()): string {
  if (typeof value === "string") return value
  if (!value || typeof value !== "object" || active.has(value)) return String(value)
  active.add(value)
  try {
    const pieces: string[] = []
    if (value instanceof Error) {
      pieces.push(value.name, value.message, value.stack ?? "")
      if (value.cause !== undefined) pieces.push(errorTreeText(value.cause, active))
      if (value instanceof AggregateError) pieces.push(errorTreeText(value.errors, active))
    }
    for (const key of Object.keys(value)) {
      pieces.push(key, errorTreeText((value as Record<string, unknown>)[key], active))
    }
    return pieces.join("\n")
  } finally {
    active.delete(value)
  }
}

describe("native harness trust boundary", () => {
  test("skips only an absent native-lane flag and rejects every present invalid value", () => {
    expect(nativeLaneEnabled(undefined)).toBe(false)
    expect(nativeLaneEnabled("1")).toBe(true)
    for (const value of ["", "0", "true", "01", " 1 "]) {
      expect(() => nativeLaneEnabled(value)).toThrow(/DAWN_TEST_VERCEL/)
    }
  })

  test("fails closed on every enabled-lane input in one diagnostic", () => {
    expect(() =>
      readNativeLaneEnvironment(
        {
          DAWN_VERCEL_ARTIFACT_DIR: "relative-artifacts",
          DAWN_VERCEL_ORG_ID: "user_personal",
          DAWN_VERCEL_PROJECT_ID: "project-no-prefix",
        },
        "23.9.0",
      ),
    ).toThrow(
      /Node 24.*DAWN_VERCEL_ARTIFACT_DIR.*DAWN_VERCEL_TOKEN.*DAWN_VERCEL_DATABASE_URL.*DAWN_VERCEL_ORG_ID.*DAWN_VERCEL_PROJECT_ID/,
    )
  })

  test("accepts one complete team-owned Node 24 lane environment", () => {
    expect(
      readNativeLaneEnvironment(
        {
          DAWN_VERCEL_ARTIFACT_DIR: "/tmp/dawn-vercel-artifacts",
          DAWN_VERCEL_TOKEN: "test-token",
          DAWN_VERCEL_ORG_ID: "team_AbC123",
          DAWN_VERCEL_PROJECT_ID: "prj_DeF456",
          DAWN_VERCEL_DATABASE_URL: "postgres://test.invalid/db",
        },
        "24.14.0",
      ),
    ).toEqual({
      artifactDir: "/tmp/dawn-vercel-artifacts",
      token: "test-token",
      orgId: "team_AbC123",
      projectId: "prj_DeF456",
      databaseUrl: "postgres://test.invalid/db",
    })
  })

  test("accepts only exact resource identifier grammars", () => {
    expect(assertDeploymentId("dpl_AbC012")).toBe("dpl_AbC012")
    expect(assertReconciliationMarker(`vclrun_${"a".repeat(32)}`)).toBe(`vclrun_${"a".repeat(32)}`)
    expect(assertThreadId(`t-vcl-${"b".repeat(32)}`)).toBe(`t-vcl-${"b".repeat(32)}`)
    expect(assertBarrierId(`b-vcl-${"c".repeat(32)}`)).toBe(`b-vcl-${"c".repeat(32)}`)
    expect(assertLogMarker(`log-vcl-${"d".repeat(32)}`)).toBe(`log-vcl-${"d".repeat(32)}`)

    for (const value of ["dpl_", "dpl_bad-dash", "x_dpl_AbC", "dpl_AbC/path"]) {
      expect(() => assertDeploymentId(value)).toThrow()
    }
    for (const value of [
      `vclrun_${"A".repeat(32)}`,
      `vclrun_${"a".repeat(31)}`,
      `vclrun_${"a".repeat(33)}`,
      `vclrun_${"g".repeat(32)}`,
    ]) {
      expect(() => assertReconciliationMarker(value)).toThrow()
    }
    expect(() => assertThreadId(`t-vcl-${"A".repeat(32)}`)).toThrow()
    expect(() => assertBarrierId(`b-vcl-${"c".repeat(31)}`)).toThrow()
    expect(() => assertLogMarker(`log-vcl-${"d".repeat(32)}-tail`)).toThrow()
  })

  test("canonicalizes only root HTTPS Vercel deployment origins", () => {
    expect(canonicalizeVercelOrigin("dawn-native-abc.vercel.app")).toBe(
      "https://dawn-native-abc.vercel.app",
    )
    expect(canonicalizeVercelOrigin("https://dawn-native-abc.vercel.app/")).toBe(
      "https://dawn-native-abc.vercel.app",
    )
    for (const value of [
      "http://dawn-native-abc.vercel.app",
      "https://user:pass@dawn-native-abc.vercel.app",
      "https://dawn-native-abc.vercel.app:443",
      "https://dawn-native-abc.vercel.app/path",
      "https://dawn-native-abc.vercel.app?query=1",
      "https://dawn-native-abc.vercel.app/#fragment",
      "https://not-vercel.example",
      "bad host.vercel.app",
      "https://-bad.vercel.app",
      "//dawn-native-abc.vercel.app",
      "\\\\dawn-native-abc.vercel.app",
      "https://dawn-native-abc.vercel.app/%2e",
      "https://dawn-native-abc.vercel.app/%2e%2e",
      "https://dawn-native-abc.vercel.app\\",
      "https://dawn-native-abc%2evercel.app",
      `${"a".repeat(63)}.${"b".repeat(63)}.${"c".repeat(63)}.${"d".repeat(63)}.vercel.app`,
    ]) {
      expect(() => canonicalizeVercelOrigin(value)).toThrow()
    }
  })

  test("redacts and scans every captured or persisted evidence surface", () => {
    const protectedValues = [
      "token secret+/=",
      "team_SecretScope",
      "prj_SecretProject",
      "postgres://user:pass@db.invalid/name?sslmode=require",
      "release-value_secret",
    ]
    const redactor = createSecretRedactor(protectedValues)
    const joined = protectedValues.flatMap((value) => [value, encodeURIComponent(value)]).join(" ")
    const evidence = {
      message: joined,
      stack: `Error: ${joined}`,
      command: { args: [joined] },
      child: { stdout: joined, stderr: joined },
      api: { request: joined, errorBody: joined },
      bundle: `export const leaked = ${JSON.stringify(joined)}`,
      diagnosticFile: joined,
    }
    const redacted = redactor.redactValue(evidence)
    expect(JSON.stringify(redacted)).not.toContain("Secret")
    for (const value of protectedValues) {
      expect(JSON.stringify(redacted)).not.toContain(value)
      expect(JSON.stringify(redacted)).not.toContain(encodeURIComponent(value))
    }
    expect(() => redactor.assertSafe("raw evidence", evidence)).toThrow(/raw evidence/)
    expect(() =>
      redactor.assertSafe("nested error", { error: new Error(protectedValues[0]) }),
    ).toThrow(/nested error/)
    const childError = Object.assign(new Error("safe child failure"), {
      stdout: protectedValues[0],
      stderr: encodeURIComponent(protectedValues[1] ?? ""),
      command: { args: [protectedValues[2]] },
    })
    expect(() => redactor.assertSafe("child error metadata", childError)).toThrow(
      /child error metadata/,
    )
    expect(() => redactor.assertSafe("redacted evidence", redacted)).not.toThrow()
  })

  test("scans non-enumerable AggregateError child errors", () => {
    const secret = "postgres://aggregate:secret@db.invalid/native"
    const redactor = createSecretRedactor([secret])
    expect(() =>
      redactor.assertSafe(
        "aggregate child errors",
        new AggregateError([new Error(secret)], "safe aggregate"),
      ),
    ).toThrow(/aggregate child errors/)
  })

  test("scans URL JSON semantics instead of treating URL objects as empty records", () => {
    const secret = "release-url-secret-value"
    const redactor = createSecretRedactor([secret])
    expect(() =>
      redactor.assertSafe(
        "URL metadata",
        new URL(`https://example.invalid/${encodeURIComponent(secret)}`),
      ),
    ).toThrow(/URL metadata/)
  })

  test("scans inherited toJSON output before evidence persistence", () => {
    const secret = "prj_InheritedSecret"
    const redactor = createSecretRedactor([secret])
    const inheritedToJson = Object.assign(
      Object.create({ toJSON: () => ({ leaked: secret }) }) as Record<string, unknown>,
      { safe: true },
    )
    expect(() => redactor.assertSafe("inherited toJSON", inheritedToJson)).toThrow(
      /inherited toJSON/,
    )
  })

  test("projects callable JSON serialization into inert redacted data", () => {
    const secret = "release-own-to-json-secret"
    const redactor = createSecretRedactor([secret])
    const redacted = redactor.redactValue({
      safe: true,
      toJSON: () => ({ leaked: secret }),
    })
    expect(JSON.stringify(redacted)).toBe('{"leaked":"[REDACTED]"}')
    expect(JSON.stringify(redacted)).not.toContain(secret)

    const callable = Object.assign(() => undefined, {
      toJSON: () => ({ leaked: secret }),
    })
    const redactedCallable = redactor.redactValue({ callable })
    expect(JSON.stringify(redactedCallable)).toBe('{"callable":{"leaked":"[REDACTED]"}}')
    expect(JSON.stringify(redactedCallable)).not.toContain(secret)

    const keySensitive = {
      special: {
        toJSON: (key: string) => (key === "special" ? { leaked: secret } : { safe: true }),
      },
    }
    expect(() => redactor.assertSafe("key-sensitive JSON serializer", keySensitive)).toThrow(
      /key-sensitive/,
    )
    expect(JSON.stringify(redactor.redactValue(keySensitive))).toBe(
      '{"special":{"leaked":"[REDACTED]"}}',
    )
  })

  test("does not retain a protected throwing toJSON error in redaction failures", () => {
    const secret = "postgres://throwing-to-json-secret@db.invalid/native"
    const redactor = createSecretRedactor([secret])
    const value = {
      toJSON: () => {
        throw new Error(secret)
      },
    }
    for (const operation of [
      () => redactor.assertSafe("throwing JSON serializer", value),
      () => redactor.redactValue(value),
    ]) {
      let thrown: unknown
      try {
        operation()
      } catch (error) {
        thrown = error
      }
      expect(thrown).toBeInstanceOf(Error)
      expect(errorTreeText(thrown)).not.toContain(secret)
    }
  })

  test("scans protected strings before JSON escaping changes their bytes", () => {
    const secret = 'quote"slash\\line\nsecret'
    const redactor = createSecretRedactor([secret])
    expect(() => redactor.assertSafe("JSON-escaped value", { message: secret })).toThrow(
      /JSON-escaped value/,
    )
  })

  test("sanitizes inherited child environments before applying an operation allowlist", () => {
    const sanitized = sanitizeChildEnvironment(
      {
        PATH: "/safe/bin",
        CI: "1",
        DAWN_VERCEL_TOKEN: "ambient-dawn",
        VERCEL_TOKEN: "ambient-vercel",
        VERCEL_ORG_ID: "ambient-org",
        NOW_TOKEN: "ambient-now",
        DATABASE_URL: "ambient-db",
        RELEASE_TOKEN: "ambient-release",
        DAWN_RELEASE_HEADER: "ambient-header",
      },
      {
        VERCEL_TELEMETRY_DISABLED: "1",
        NO_UPDATE_NOTIFIER: "1",
      },
    )
    expect(sanitized).toEqual({
      PATH: "/safe/bin",
      CI: "1",
      VERCEL_TELEMETRY_DISABLED: "1",
      NO_UPDATE_NOTIFIER: "1",
    })
  })

  test("atomically replaces JSON and never accepts partial evidence as a final receipt", async () => {
    const root = await makeTempDir()
    const path = join(root, "receipt.partial.json")
    await writeFile(path, '{"old":true}\n', "utf8")
    await writeAtomicJson(path, { schemaVersion: 1, attempts: [] })
    expect(JSON.parse(await readFile(path, "utf8"))).toEqual({ schemaVersion: 1, attempts: [] })
    const partialReceipt = JSON.parse(await readFile(path, "utf8"))
    expect(() => parseNativeReceipt(partialReceipt)).toThrow()

    await expect(writeAtomicJson(path, undefined)).rejects.toThrow(/JSON/)
    expect(await readFile(path, "utf8")).toBe(
      `${JSON.stringify({ schemaVersion: 1, attempts: [] }, null, 2)}\n`,
    )

    const inheritedJson = Object.assign(
      Object.create({ toJSON: () => ({ leaked: "unsafe inherited serialization" }) }) as Record<
        string,
        unknown
      >,
      { safe: true },
    )
    await expect(writeAtomicJson(path, inheritedJson)).rejects.toThrow(/plain JSON/)
    expect(await readFile(path, "utf8")).toBe(
      `${JSON.stringify({ schemaVersion: 1, attempts: [] }, null, 2)}\n`,
    )
  })

  test("preserves old JSON and removes its temp file after injected write or rename failures", async () => {
    const target = "/job/receipt.partial.json"
    const oldContents = '{"old":true}\n'
    for (const fail of ["write", "rename"] as const) {
      const fake = fakeAtomicJsonFileOps({ fail, initial: { [target]: oldContents } })
      await expect(writeAtomicJson(target, { next: true }, fake.ops)).rejects.toThrow(
        new RegExp(`injected ${fail} failure`),
      )
      expect(fake.files).toEqual(new Map([[target, oldContents]]))
    }
  })

  test("rejects accessor-backed arrays without evaluating their getters", async () => {
    let getterCalls = 0
    const accessorBacked: unknown[] = []
    Object.defineProperty(accessorBacked, "0", {
      configurable: true,
      enumerable: true,
      get: () => {
        getterCalls += 1
        return "unsafe accessor value"
      },
    })
    const fake = fakeAtomicJsonFileOps({ initial: {} })
    await expect(writeAtomicJson("/job/evidence.json", accessorBacked, fake.ops)).rejects.toThrow(
      /data property/,
    )
    expect(getterCalls).toBe(0)
    expect(fake.files).toEqual(new Map())
  })

  test("reconstructs a fresh receipt instead of retaining inherited JSON serialization", async () => {
    const protectedValue = "release-private-inherited-value"
    const original = Object.assign(
      Object.create({ toJSON: () => ({ leaked: protectedValue }) }) as Record<string, unknown>,
      validReceipt(),
    )
    const parsed = parseNativeReceipt(original)
    expect(parsed).not.toBe(original)
    expect(Object.getPrototypeOf(parsed)).toBe(Object.prototype)
    expect(JSON.stringify(parsed)).not.toContain(protectedValue)

    const root = await makeTempDir()
    const path = join(root, "receipt.json")
    await writeFinalReceipt(path, original, [protectedValue])
    expect(JSON.parse(await readFile(path, "utf8"))).toEqual(validReceipt())
  })

  test("requires source and prebuilt receipts to bind different deployments and origins", () => {
    const duplicateId = validReceipt()
    duplicateId.deployments = [
      validDeployment("source"),
      { ...validDeployment("prebuilt"), deploymentId: "dpl_Source1" },
    ]
    expect(() => parseNativeReceipt(duplicateId)).toThrow(/deploymentId/)

    const duplicateOrigin = validReceipt()
    duplicateOrigin.deployments = [
      validDeployment("source"),
      {
        ...validDeployment("prebuilt"),
        canonicalOrigin: "https://dawn-source-abc.vercel.app",
      },
    ]
    expect(() => parseNativeReceipt(duplicateOrigin)).toThrow(/canonicalOrigin/)
  })

  test("rejects own __proto__ additional keys at top-level and nested receipt paths", () => {
    const topLevel = validReceipt()
    Object.defineProperty(topLevel, "__proto__", {
      enumerable: true,
      value: "unexpected",
    })
    expect(() => parseNativeReceipt(topLevel)).toThrow(/additional 1/)

    const nested = validReceipt()
    const [source, prebuilt] = nested.deployments as [ReturnType<typeof validDeployment>, unknown]
    Object.defineProperty(source.config, "__proto__", {
      enumerable: true,
      value: "unexpected",
    })
    nested.deployments = [source, prebuilt]
    expect(() => parseNativeReceipt(nested)).toThrow(/additional 1/)
  })

  test("never echoes protected additional receipt keys and leaves no final evidence", async () => {
    const secret = "team_PrivateReceiptKey"
    const receipt = validReceipt()
    Object.defineProperty(receipt, secret, {
      enumerable: true,
      value: "unexpected",
    })
    const root = await makeTempDir()
    const path = join(root, "receipt.json")
    let thrown: unknown
    try {
      await writeFinalReceipt(path, receipt, [secret])
    } catch (error) {
      thrown = error
    }
    expect(thrown).toBeInstanceOf(Error)
    expect(errorTreeText(thrown)).not.toContain(secret)
    await expect(readFile(path, "utf8")).rejects.toMatchObject({ code: "ENOENT" })
  })

  test("validates the exact closed final evidence schema", async () => {
    const receipt = validReceipt()
    expect(parseNativeReceipt(receipt)).toEqual(receipt)

    const invalidReceipts: unknown[] = [
      { ...receipt, extra: true },
      { ...receipt, schemaVersion: 2 },
      { ...receipt, cliVersion: "latest" },
      { ...receipt, projectBindingVerified: false },
      { ...receipt, kinds: ["prebuilt", "source"] },
      { ...receipt, deployments: {} },
      { ...receipt, deployments: [validDeployment("prebuilt"), validDeployment("source")] },
      {
        ...receipt,
        deployments: [
          { ...validDeployment("source"), deploymentId: "project-name" },
          validDeployment("prebuilt"),
        ],
      },
      {
        ...receipt,
        deployments: [
          {
            ...validDeployment("source"),
            stream: { ...validDeployment("source").stream, beforeFrameIndex: Number.NaN },
          },
          validDeployment("prebuilt"),
        ],
      },
      {
        ...receipt,
        deployments: [
          {
            ...validDeployment("source"),
            stream: { ...validDeployment("source").stream, afterFrameIndex: 0 },
          },
          validDeployment("prebuilt"),
        ],
      },
      {
        ...receipt,
        deployments: [
          {
            ...validDeployment("source"),
            logs: { ...validDeployment("source").logs, queryStartIso: "not-an-ISO-bound" },
          },
          validDeployment("prebuilt"),
        ],
      },
      {
        ...receipt,
        deployments: [
          {
            ...validDeployment("source"),
            logs: { ...validDeployment("source").logs, uniqueRowVersions: 0 },
          },
          validDeployment("prebuilt"),
        ],
      },
      {
        ...receipt,
        deployments: [
          {
            ...validDeployment("source"),
            config: { fluid: true, sha256: "not-a-hash" },
          },
          validDeployment("prebuilt"),
        ],
      },
      {
        ...receipt,
        deployments: [
          {
            ...validDeployment("source"),
            cleanup: { deploymentAbsent: false, databaseRowsAbsent: true },
          },
          validDeployment("prebuilt"),
        ],
      },
      {
        ...receipt,
        deployments: [
          {
            ...validDeployment("source"),
            provenance: { ...validDeployment("source").provenance, extra: true },
          },
          validDeployment("prebuilt"),
        ],
      },
    ]
    for (const invalid of invalidReceipts) expect(() => parseNativeReceipt(invalid)).toThrow()

    const root = await makeTempDir()
    const finalPath = join(root, "receipt.json")
    await writeFinalReceipt(finalPath, receipt, ["team_SecretScope", "prj_SecretProject"])
    expect(JSON.parse(await readFile(finalPath, "utf8"))).toEqual(receipt)
    const rejectedPath = join(root, "leaky-receipt.json")
    await expect(writeFinalReceipt(rejectedPath, receipt, ["dpl_Source1"])).rejects.toThrow(
      /protected value/,
    )
    await expect(readFile(rejectedPath, "utf8")).rejects.toMatchObject({ code: "ENOENT" })
  })
})

describe("fixture package closure", () => {
  test("derives only the recursive Dawn runtime closure across required dependency kinds", () => {
    const root = workspacePackage("@dawn-ai/root", {
      dependencies: {
        "@dawn-ai/dependency": "workspace:*",
        external: "1.0.0",
      },
      optionalDependencies: { "@dawn-ai/optional": "workspace:*" },
      peerDependencies: {
        "@dawn-ai/optional-peer": "workspace:*",
        "@dawn-ai/required-peer": "workspace:*",
      },
      peerDependenciesMeta: { "@dawn-ai/optional-peer": { optional: true } },
    })
    const dependency = workspacePackage("@dawn-ai/dependency", {
      dependencies: { "@dawn-ai/root": "workspace:*" },
    })
    const packages = new Map(
      [
        root,
        dependency,
        workspacePackage("@dawn-ai/optional"),
        workspacePackage("@dawn-ai/required-peer"),
        workspacePackage("@dawn-ai/optional-peer"),
        workspacePackage("@dawn-ai/unrelated"),
      ].map((entry) => [entry.name, entry]),
    )

    expect(deriveDawnPackageClosure([root.name], packages).map(({ name }) => name)).toEqual([
      "@dawn-ai/dependency",
      "@dawn-ai/optional",
      "@dawn-ai/required-peer",
      "@dawn-ai/root",
    ])
  })

  test("fails closed when a root or reachable Dawn package is absent", () => {
    const root = workspacePackage("@dawn-ai/root", {
      dependencies: { "@dawn-ai/missing": "workspace:*" },
    })
    const packages = new Map([[root.name, root]])
    expect(() => deriveDawnPackageClosure(["@dawn-ai/absent"], packages)).toThrow(/absent/)
    expect(() => deriveDawnPackageClosure([root.name], packages)).toThrow(/missing/)
  })

  test("accepts only one matching vendored resolution for every expected Dawn package", () => {
    const artifacts = [packedArtifact("@dawn-ai/root"), packedArtifact("@dawn-ai/dependency")]
    expect(() =>
      validateNativeFixtureLockfile(validNativeLockfile(artifacts), artifacts),
    ).not.toThrow()

    const missing = structuredClone(validNativeLockfile(artifacts))
    delete missing.packages[
      `@dawn-ai/dependency@file:vendor/${artifacts[1]?.tarballName as string}`
    ]
    expect(() => validateNativeFixtureLockfile(missing, artifacts)).toThrow(/dependency/)

    const duplicate = structuredClone(validNativeLockfile(artifacts))
    duplicate.packages[
      `@dawn-ai/root@file:vendor/${artifacts[0]?.tarballName as string}(duplicate)`
    ] = {}
    expect(() => validateNativeFixtureLockfile(duplicate, artifacts)).toThrow(/root/)

    const peerContext = structuredClone(validNativeLockfile(artifacts))
    const rootIdentity = `@dawn-ai/root@file:vendor/${artifacts[0]?.tarballName as string}`
    const rootPackage = peerContext.packages[rootIdentity]
    const rootSnapshot = peerContext.snapshots[rootIdentity]
    delete peerContext.packages[rootIdentity]
    delete peerContext.snapshots[rootIdentity]
    peerContext.packages[`${rootIdentity}(peer@1.0.0)`] = rootPackage
    peerContext.snapshots[`${rootIdentity}(peer@1.0.0)`] = rootSnapshot
    expect(() => validateNativeFixtureLockfile(peerContext, artifacts)).not.toThrow()

    const truncatedPeerContext = structuredClone(validNativeLockfile(artifacts))
    const truncatedPackage = truncatedPeerContext.packages[rootIdentity]
    const truncatedSnapshot = truncatedPeerContext.snapshots[rootIdentity]
    delete truncatedPeerContext.packages[rootIdentity]
    delete truncatedPeerContext.snapshots[rootIdentity]
    truncatedPeerContext.packages[`${rootIdentity}(foreign`] = truncatedPackage
    truncatedPeerContext.snapshots[`${rootIdentity}(foreign`] = truncatedSnapshot
    expect(() => validateNativeFixtureLockfile(truncatedPeerContext, artifacts)).toThrow(/root/)

    const registryCopy = structuredClone(validNativeLockfile(artifacts))
    registryCopy.packages["@dawn-ai/root@0.0.0-test"] = {
      resolution: { integrity: "sha512-not-the-vendored-tarball" },
      version: "0.0.0-test",
    }
    registryCopy.snapshots["@dawn-ai/root@0.0.0-test"] = {}
    expect(() => validateNativeFixtureLockfile(registryCopy, artifacts)).toThrow(/root/)

    const unexpected = structuredClone(validNativeLockfile(artifacts))
    unexpected.packages["@dawn-ai/unexpected@file:vendor/unexpected.tgz"] = {}
    unexpected.snapshots["@dawn-ai/unexpected@file:vendor/unexpected.tgz"] = {}
    expect(() => validateNativeFixtureLockfile(unexpected, artifacts)).toThrow(/unexpected/)
  })

  test("rejects every nonlocal, ambiguous, or mismatched Dawn lockfile reference", () => {
    const artifacts = [packedArtifact("@dawn-ai/root"), packedArtifact("@dawn-ai/dependency")]
    expect(() =>
      validateNativeFixtureLockfile(validNativeLockfile(artifacts), artifacts),
    ).not.toThrow()
    const badReferences = [
      "0.8.21",
      "workspace:*",
      "link:../root",
      "file:/absolute/root.tgz",
      "file:../../packages/root",
      "file:../assets/root.tgz",
      `file:vendor/${artifacts[1]?.tarballName as string}`,
    ]
    for (const reference of badReferences) {
      const lockfile = structuredClone(validNativeLockfile(artifacts))
      lockfile.overrides["@dawn-ai/root"] = reference
      expect(() => validateNativeFixtureLockfile(lockfile, artifacts), reference).toThrow()
    }

    const foreignSuffix = structuredClone(validNativeLockfile(artifacts))
    foreignSuffix.packages["foreign@1.0.0"] = {
      resolution: {
        tarball: `file:vendor/${artifacts[0]?.tarballName as string}#foreign`,
      },
      version: "1.0.0",
    }
    foreignSuffix.snapshots["foreign@1.0.0"] = {}
    expect(() => validateNativeFixtureLockfile(foreignSuffix, artifacts)).toThrow(/file reference/)
  })

  test("renders an exact isolated fixture manifest, workspace, and parsed lockfile", () => {
    const artifacts = [
      packedArtifact("@dawn-ai/cli"),
      packedArtifact("@dawn-ai/postgres-storage"),
      packedArtifact("@dawn-ai/sdk"),
      packedArtifact("@dawn-ai/transitive"),
    ]
    const manifest = renderNativeFixtureManifest("source", artifacts)
    expect(manifest).toMatchObject({
      name: "dawn-vercel-native-source",
      private: true,
      packageManager: "pnpm@10.33.0",
      scripts: { build: "dawn build" },
      dependencies: {
        "@dawn-ai/cli": `file:vendor/${artifacts[0]?.tarballName as string}`,
        "@dawn-ai/postgres-storage": `file:vendor/${artifacts[1]?.tarballName as string}`,
        "@dawn-ai/sdk": `file:vendor/${artifacts[2]?.tarballName as string}`,
        "@langchain/core": "1.2.5",
        "@langchain/langgraph": "1.4.9",
        "@langchain/langgraph-checkpoint": "1.1.3",
        "@neondatabase/serverless": "1.1.0",
        hono: "4.12.28",
        pg: "8.22.0",
        zod: "4.4.3",
      },
    })
    expect((manifest.dependencies as Record<string, string>)["@dawn-ai/transitive"]).toBeUndefined()

    const workspace = renderNativeWorkspaceYaml(artifacts)
    expect(workspace).toContain("onlyBuiltDependencies:\n  - esbuild")
    expect(workspace).toContain("allowBuilds:\n  esbuild: true")
    for (const artifact of artifacts) {
      expect(workspace).toContain(
        `${JSON.stringify(artifact.packageName)}: ${JSON.stringify(`file:vendor/${artifact.tarballName}`)}`,
      )
    }
    expect(workspace).not.toContain("workspace:")
    expect(workspace).not.toContain("link:")
    expect(workspace).not.toContain("/packs/")

    const parsed = parseNativeFixtureLockfile(renderTestNativeLockfile(artifacts))
    expect(() => validateNativeFixtureLockfile(parsed, artifacts)).not.toThrow()
  })

  test("builds once, packs only the derived closure, and assembles two independent fixtures", async () => {
    const workspace = await makeAssemblyWorkspace()
    const commands: NativeLocalCommandRequest[] = []
    const packed: NativePackedArtifact[] = []
    const packCalls: string[] = []
    const packPackage = async (entry: NativeWorkspacePackage, packDir: string) => {
      packCalls.push(entry.name)
      const artifact = packedArtifact(entry.name)
      const localArtifact = { ...artifact, tarballPath: join(packDir, artifact.tarballName) }
      await mkdir(packDir, { recursive: true })
      await writeFile(localArtifact.tarballPath, `packed:${entry.name}\n`, "utf8")
      packed.push(localArtifact)
      return localArtifact
    }
    const runCommand = async (request: NativeLocalCommandRequest) => {
      commands.push(request)
      if (request.args.includes("--lockfile-only")) {
        await writeFile(
          join(request.cwd, "pnpm-lock.yaml"),
          renderTestNativeLockfile(packed),
          "utf8",
        )
      } else if (request.args.includes("--frozen-lockfile")) {
        await mkdir(join(request.cwd, "node_modules"), { recursive: true })
      } else if (request.executable.endsWith(join("node_modules", ".bin", "dawn"))) {
        await mkdir(join(request.cwd, ".vercel", "output", "functions"), { recursive: true })
        await writeFile(join(request.cwd, ".vercel", "output", "config.json"), "{}\n", "utf8")
      }
      return { exitCode: 0, stderr: "", stdout: "" }
    }

    const assembly = await assembleNativeFixtures({
      generatedFiles: { "src/fixture.ts": 'export const fixture = "model-free"\n' },
      orgId: "team_Test123",
      packPackage,
      projectId: "prj_Test456",
      repoRoot: workspace.repoRoot,
      runCommand,
      runRoot: workspace.runRoot,
    })

    const expectedClosure = [
      "@dawn-ai/cli",
      "@dawn-ai/core",
      "@dawn-ai/langchain",
      "@dawn-ai/memory",
      "@dawn-ai/postgres-storage",
      "@dawn-ai/sdk",
    ]
    expect(assembly.closure.map(({ name }) => name)).toEqual(expectedClosure)
    expect(packCalls).toEqual(expectedClosure)
    expect(packCalls).not.toContain("@dawn-ai/unrelated")
    expect(commands[0]).toEqual({
      executable: "corepack",
      args: ["pnpm", "build"],
      cwd: workspace.repoRoot,
    })
    expect(commands.filter(({ args }) => args.includes("--lockfile-only"))).toHaveLength(2)
    expect(commands.filter(({ args }) => args.includes("--frozen-lockfile"))).toEqual([
      expect.objectContaining({ cwd: assembly.prebuilt.root }),
    ])
    expect(commands.at(-1)).toEqual({
      executable: join(assembly.prebuilt.root, "node_modules", ".bin", "dawn"),
      args: ["build"],
      cwd: assembly.prebuilt.root,
    })

    for (const fixture of [assembly.source, assembly.prebuilt]) {
      expect(
        JSON.parse(await readFile(join(fixture.root, ".vercel", "project.json"), "utf8")),
      ).toEqual({ orgId: "team_Test123", projectId: "prj_Test456" })
      expect(JSON.parse(await readFile(join(fixture.root, "vercel.json"), "utf8"))).toEqual({
        $schema: "https://openapi.vercel.sh/vercel.json",
        buildCommand: "node node_modules/@dawn-ai/cli/dist/index.js build",
        fluid: true,
      })
      expect(await readFile(join(fixture.root, "dawn.config.ts"), "utf8")).toBe(
        'export default { build: { targets: ["vercel"] } }\n',
      )
      expect(await readFile(join(fixture.root, "src", "fixture.ts"), "utf8")).toContain(
        "model-free",
      )
      const parsedLockfile = parseNativeFixtureLockfile(
        await readFile(fixture.lockfilePath, "utf8"),
      )
      expect(() => validateNativeFixtureLockfile(parsedLockfile, assembly.artifacts)).not.toThrow()
    }

    for (const artifact of assembly.artifacts) {
      const sourceCopy = join(assembly.source.root, "vendor", artifact.tarballName)
      const prebuiltCopy = join(assembly.prebuilt.root, "vendor", artifact.tarballName)
      expect((await lstat(sourceCopy)).ino).not.toBe((await lstat(prebuiltCopy)).ino)
      expect(await readFile(sourceCopy, "utf8")).toBe(await readFile(prebuiltCopy, "utf8"))
    }
    await expect(lstat(join(assembly.source.root, "node_modules"))).rejects.toMatchObject({
      code: "ENOENT",
    })
    await expect(lstat(join(assembly.source.root, ".dawn"))).rejects.toMatchObject({
      code: "ENOENT",
    })
    expect((await lstat(join(assembly.prebuilt.root, ".vercel", "output"))).isDirectory()).toBe(
      true,
    )
  })

  test("rejects a run root whose relative name merely starts with two dots", async () => {
    const workspace = await makeAssemblyWorkspace()
    await expect(
      assembleNativeFixtures({
        generatedFiles: {},
        orgId: "team_Test123",
        projectId: "prj_Test456",
        repoRoot: workspace.repoRoot,
        runCommand: async () => {
          throw new Error("run command must not execute for an in-repository root")
        },
        runRoot: join(workspace.repoRoot, "..evil"),
      }),
    ).rejects.toThrow(/outside the repository/)
  })

  test("rejects an outside-looking run root whose symlinked parent resolves into the repo", async () => {
    const workspace = await makeAssemblyWorkspace()
    const alias = join(workspace.ownerRoot, "repo-alias")
    const escapedRunRoot = join(alias, "escaped-run")
    await symlink(workspace.repoRoot, alias, "dir")

    await expect(
      assembleNativeFixtures({
        generatedFiles: {},
        orgId: "team_Test123",
        projectId: "prj_Test456",
        repoRoot: workspace.repoRoot,
        runCommand: async () => {
          throw new Error("run command must not execute for a symlink escape")
        },
        runRoot: escapedRunRoot,
      }),
    ).rejects.toThrow(/outside the repository/)
    await expect(lstat(join(workspace.repoRoot, "escaped-run"))).rejects.toMatchObject({
      code: "ENOENT",
    })
  })
})

describe("upload isolation", () => {
  test("accepts the asymmetric source and prebuilt upload surfaces", async () => {
    await expectUploadAccepted("source")
    await expectUploadAccepted("prebuilt")
  })

  test("rejects source node_modules and every source-tree symlink", async () => {
    const withNodeModules = await makeUploadFixture("source")
    await mkdir(join(withNodeModules.root, "node_modules"))
    await expect(
      assertNativeFixtureUploadIsolation({
        ...withNodeModules,
        kind: "source",
        orgId: "team_Test123",
        projectId: "prj_Test456",
      }),
    ).rejects.toThrow(/node_modules/)

    const withSymlink = await makeUploadFixture("source")
    await symlink("package.json", join(withSymlink.root, "source-link"))
    await expect(
      assertNativeFixtureUploadIsolation({
        ...withSymlink,
        kind: "source",
        orgId: "team_Test123",
        projectId: "prj_Test456",
      }),
    ).rejects.toThrow(/symlink/)
  })

  test("allows prebuilt node_modules links but rejects vendor and output symlinks", async () => {
    const vendorLink = await makeUploadFixture("prebuilt")
    const vendorTarget = join(vendorLink.root, "vendor-target.tgz")
    await writeFile(vendorTarget, "target", "utf8")
    const expectedName = vendorLink.expectedTarballs[0] as string
    await rm(join(vendorLink.root, "vendor", expectedName))
    await symlink(vendorTarget, join(vendorLink.root, "vendor", expectedName))
    await expect(
      assertNativeFixtureUploadIsolation({
        ...vendorLink,
        kind: "prebuilt",
        orgId: "team_Test123",
        projectId: "prj_Test456",
      }),
    ).rejects.toThrow(/symlink/)

    const outputLink = await makeUploadFixture("prebuilt")
    await symlink(
      "../../package.json",
      join(outputLink.root, ".vercel", "output", "linked-package.json"),
    )
    await expect(
      assertNativeFixtureUploadIsolation({
        ...outputLink,
        kind: "prebuilt",
        orgId: "team_Test123",
        projectId: "prj_Test456",
      }),
    ).rejects.toThrow(/symlink/)
  })

  test("requires the exact regular vendored tarballs and project binding", async () => {
    const missingTarball = await makeUploadFixture("source")
    await rm(join(missingTarball.root, "vendor", missingTarball.expectedTarballs[0] as string))
    await expect(
      assertNativeFixtureUploadIsolation({
        ...missingTarball,
        kind: "source",
        orgId: "team_Test123",
        projectId: "prj_Test456",
      }),
    ).rejects.toThrow(/tarball/)

    const unexpectedTarball = await makeUploadFixture("source")
    await writeFile(join(unexpectedTarball.root, "vendor", "unexpected.tgz"), "unexpected", "utf8")
    await expect(
      assertNativeFixtureUploadIsolation({
        ...unexpectedTarball,
        kind: "source",
        orgId: "team_Test123",
        projectId: "prj_Test456",
      }),
    ).rejects.toThrow(/tarball/)

    const mismatchedLink = await makeUploadFixture("source")
    await writeFile(
      join(mismatchedLink.root, ".vercel", "project.json"),
      `${JSON.stringify({ orgId: "team_Wrong", projectId: "prj_Test456", extra: true })}\n`,
      "utf8",
    )
    await expect(
      assertNativeFixtureUploadIsolation({
        ...mismatchedLink,
        kind: "source",
        orgId: "team_Test123",
        projectId: "prj_Test456",
      }),
    ).rejects.toThrow(/project/)

    const symlinkedLink = await makeUploadFixture("prebuilt")
    const alternate = join(symlinkedLink.root, ".vercel", "alternate-project.json")
    await writeFile(
      alternate,
      `${JSON.stringify({ orgId: "team_Test123", projectId: "prj_Test456" })}\n`,
      "utf8",
    )
    await rm(join(symlinkedLink.root, ".vercel", "project.json"))
    await symlink("alternate-project.json", join(symlinkedLink.root, ".vercel", "project.json"))
    await expect(
      assertNativeFixtureUploadIsolation({
        ...symlinkedLink,
        kind: "prebuilt",
        orgId: "team_Test123",
        projectId: "prj_Test456",
      }),
    ).rejects.toThrow(/project.*symlink|symlink.*project/)
  })
})

describe("model-free native fixture", () => {
  test("keeps the random release credential private and emits exact agent run bodies", () => {
    const authorization = createNativeReleaseAuthorization()
    expect(authorization.digestSha256).toMatch(/^[a-f0-9]{64}$/)
    expect(nativeAgentRunBody("/state#agent", `log-vcl-${"a".repeat(32)}`)).toEqual({
      input: {
        messages: [{ content: `log-vcl-${"a".repeat(32)}`, role: "user" }],
      },
      route: "/state#agent",
    })
    expect(nativeAgentRunBody("/stream#agent", `b-vcl-${"b".repeat(32)}`)).toEqual({
      input: {
        messages: [{ content: `b-vcl-${"b".repeat(32)}`, role: "user" }],
      },
      route: "/stream#agent",
    })
    expect(() => nativeAgentRunBody("/state#agent", "unsafe marker")).toThrow(/log marker/)
    expect(() => nativeAgentRunBody("/stream#agent", "unsafe barrier")).toThrow(/barrier/)

    const privateHeaders = new Headers()
    authorization.apply(privateHeaders)
    expect(privateHeaders.get("x-dawn-vercel-release")).toMatch(/^[A-Za-z0-9_-]{43}$/)
    expect(() =>
      authorization.assertSafe("private release header", Object.fromEntries(privateHeaders)),
    ).toThrow(/private release header/)
    expect(() =>
      authorization.assertSafe("public release digest", {
        digest: authorization.digestSha256,
      }),
    ).not.toThrow()
  })

  test("discovers and builds exactly three deterministic routes with selective release middleware", async () => {
    const authorization = createNativeReleaseAuthorization()
    const files = renderNativeRouteFiles(authorization.digestSha256)
    expect(Object.keys(files).sort()).toEqual([
      "src/app/release/index.ts",
      "src/app/state/index.ts",
      "src/app/stream/index.ts",
      "src/lib/database.ts",
      "src/lib/stream-deadline.mjs",
      "src/middleware.ts",
    ])
    const generatedSource = Object.values(files).join("\n")
    expect(generatedSource).not.toMatch(/gpt-|openai|model\s*:/i)
    expect(generatedSource).toContain(authorization.digestSha256)
    expect(() => authorization.assertSafe("generated route source", files)).not.toThrow()

    const deadlineModulePath = join(await makeTempDir(), "stream-deadline.mjs")
    await writeFile(deadlineModulePath, files["src/lib/stream-deadline.mjs"] as string, "utf8")
    const deadlineModule = (await import(pathToFileURL(deadlineModulePath).href)) as {
      readonly raceStreamDeadline: <T>(
        operation: Promise<T>,
        timeoutMs: number,
        signal?: AbortSignal,
      ) => Promise<T>
    }
    vi.useFakeTimers()
    try {
      const stalled = deadlineModule.raceStreamDeadline(new Promise<never>(() => {}), 5_000)
      const rejection = expect(stalled).rejects.toThrow(/deadline exceeded/)
      await vi.advanceTimersByTimeAsync(5_000)
      await rejection
    } finally {
      vi.useRealTimers()
    }

    const appRoot = await makeModelFreeNativeFixture(files)
    const manifest = await discoverRoutes({ appRoot })
    const routeKeys = manifest.routes.map(({ id, kind }) => `${id}#${kind}`).sort()
    expect(routeKeys).toEqual(["/release#graph", "/state#agent", "/stream#agent"])
    expect(routeKeys).not.toContain("/state#graph")

    const stdout: string[] = []
    const stderr: string[] = []
    await runBuildCommand(
      { clean: true, cwd: appRoot },
      {
        stderr: (message) => stderr.push(message),
        stdout: (message) => stdout.push(message),
      },
    )
    expect(stderr.join("")).toBe("")
    expect(stdout.join("\n")).toContain("vercel")
    const outputRoot = join(appRoot, ".vercel", "output")
    await validateVercelOutput(outputRoot)

    const middleware = await loadMiddleware(appRoot)
    expect(middleware).toBeTypeOf("function")
    const runMiddleware = async (headers: Headers, routeId = "/release") =>
      await middleware?.({
        assistantId: `${routeId}#graph`,
        headers: Object.fromEntries(headers),
        method: "POST",
        params: {},
        routeId,
        url: `https://fixture.invalid${routeId}`,
      })
    await expect(runMiddleware(new Headers())).resolves.toMatchObject({
      action: "reject",
      status: 401,
    })
    await expect(
      runMiddleware(new Headers({ "x-dawn-vercel-release": "malformed value" })),
    ).resolves.toMatchObject({ action: "reject", status: 401 })
    await expect(
      runMiddleware(new Headers({ "x-dawn-vercel-release": "A".repeat(43) })),
    ).resolves.toMatchObject({ action: "reject", status: 401 })
    await expect(
      runMiddleware(new Headers({ "x-dawn-vercel-release": authorization.digestSha256 })),
    ).resolves.toMatchObject({ action: "reject", status: 401 })
    const authorizedHeaders = new Headers()
    authorization.apply(authorizedHeaders)
    await expect(runMiddleware(authorizedHeaders)).resolves.toEqual({ action: "continue" })
    await expect(runMiddleware(new Headers(), "/state")).resolves.toEqual({ action: "continue" })

    const outputFiles = await readRegularTree(outputRoot)
    const packageManifest = JSON.parse(await readFile(join(appRoot, "package.json"), "utf8"))
    expect(Object.keys(packageManifest.dependencies)).not.toContain("@langchain/openai")
    expect(() =>
      authorization.assertSafe("model-free fixture artifacts", {
        diagnostics: { message: "safe", stderr, stdout },
        environment: sanitizeChildEnvironment(process.env, {}),
        files,
        logs: ["dawn-vercel-fixture-log safe"],
        outputFiles,
        packageManifest,
        receipt: validReceipt(),
      }),
    ).not.toThrow()
  }, 60_000)
})

const nativeEnabled = nativeLaneEnabled(process.env.DAWN_TEST_VERCEL)
const nativeTest = nativeEnabled ? test : test.skip

nativeTest("runs two native Vercel previews", async () => {
  readNativeLaneEnvironment(process.env)
  throw new Error("native Vercel orchestration is not implemented")
})
