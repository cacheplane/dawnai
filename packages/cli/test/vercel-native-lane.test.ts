import { createHash } from "node:crypto"
import { EventEmitter } from "node:events"
import {
  lstat,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  realpath,
  rename,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises"
import { tmpdir } from "node:os"
import { delimiter, dirname, join } from "node:path"
import { PassThrough } from "node:stream"
import { fileURLToPath, pathToFileURL } from "node:url"

import { discoverRoutes } from "@dawn-ai/core/node"
import { transform } from "esbuild"

import { afterEach, describe, expect, test, vi } from "vitest"

import { runBuildCommand } from "../src/commands/build.js"
import { validateVercelOutput } from "../src/lib/build/targets/vercel-output.js"
import { loadMiddleware } from "../src/lib/dev/middleware-node.js"

import {
  type AtomicJsonFileOps,
  assembleNativeFixtures,
  assertBarrierId,
  assertDeploymentId,
  assertLogMarker,
  assertNativeFixtureUploadIsolation,
  assertNativePostReleaseSseFrames,
  assertNativePreReleaseSseFrame,
  assertReconciliationMarker,
  assertThreadId,
  canonicalizeVercelOrigin,
  cleanupNativeDatabase,
  cleanupNativeDeployments,
  cleanupNativeEvidenceStore,
  createNativeBlackBoxEvidencePersistence,
  createNativeBoundedDatabase,
  createNativeChildRunner,
  createNativeDeadlineOwner,
  createNativeEvidenceStore,
  createNativeFetchAdapters,
  createNativePinnedVercelBoundary,
  createNativePostgresDatabase,
  createNativeReleaseAuthorization,
  createNativeSseFrameReader,
  createNativeVercelApiClient,
  createNativeVercelLaneDependencies,
  createSecretRedactor,
  deriveDawnPackageClosure,
  deriveNativeAttemptEvidence,
  NATIVE_DIRECT_DAWN_DEPENDENCIES,
  type NativeAttemptEvidence,
  type NativeLocalCommandRequest,
  type NativePackedArtifact,
  type NativeVercelApiRequest,
  type NativeVercelChildRequest,
  type NativeWorkspacePackage,
  nativeAgentRunBody,
  nativeLaneEnabled,
  parseNativeBuildProvenance,
  parseNativeCleanupManifest,
  parseNativeFixtureLockfile,
  parseNativeReceipt,
  parseNativeVercelBuildLogTranscript,
  parseNativeVercelDeploymentBinding,
  parseNativeVercelDeploymentReceipt,
  parseNativeVercelInspectReceipt,
  parseNativeVercelProjectBinding,
  pollNativeVercelRuntimeLogs,
  prepareNativeArtifactUpload,
  prepareNativeFixtureDeployment,
  readNativeLaneEnvironment,
  readNativeVercelConfigEvidence,
  reconcileNativeMarker,
  renderNativeFixtureManifest,
  renderNativeRouteFiles,
  renderNativeWorkspaceYaml,
  runNativeCleanupWithPrimaryFailure,
  runNativeDeployAttempt,
  runNativeDeploymentKind,
  runNativeLocalChild,
  runNativeOwnedOperation,
  runNativeVercelBlackBox,
  runNativeVercelLane,
  runNativeVercelOrchestration,
  runNativeWindowsTaskkill,
  sanitizeChildEnvironment,
  scanNativeVercelLogJsonl,
  validateNativeFixtureLockfile,
  writeAtomicJson,
  writeFinalReceipt,
} from "./helpers/vercel-native-fixture.js"

const tempDirs: string[] = []
const cliPackageRoot = join(dirname(fileURLToPath(import.meta.url)), "..")
const repoRoot = join(cliPackageRoot, "..", "..")
const pinnedVercelVersionStderr = `Vercel CLI 58.9.0 (Node.js ${process.versions.node})\n`

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
  } as const
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
      `@dawn-ai/root@file:vendor/${artifacts[0]?.tarballName as string}(peer@1.0.0)`
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
    registryCopy.packages["@dawn-ai/root@0.0.0-test(peer@1.0.0)"] = {
      resolution: { integrity: "sha512-not-the-vendored-tarball" },
      version: "0.0.0-test",
    }
    registryCopy.snapshots["@dawn-ai/root@0.0.0-test(peer@1.0.0)"] = {}
    expect(() => validateNativeFixtureLockfile(registryCopy, artifacts)).toThrow(/root/)

    const unexpected = structuredClone(validNativeLockfile(artifacts))
    unexpected.packages["@dawn-ai/unexpected@file:vendor/unexpected.tgz"] = {}
    unexpected.snapshots["@dawn-ai/unexpected@file:vendor/unexpected.tgz"] = {}
    expect(() => validateNativeFixtureLockfile(unexpected, artifacts)).toThrow(/unexpected/)
  })

  test("accepts only complete nested pnpm peer contexts on vendored importer versions", () => {
    const artifacts = [packedArtifact("@dawn-ai/root")]
    const lockfile = structuredClone(validNativeLockfile(artifacts))
    const artifact = artifacts[0] as NativePackedArtifact
    const reference = `file:vendor/${artifact.tarballName}`
    const identity = `${artifact.packageName}@${reference}`
    const peerContext =
      "(@langchain/core@1.2.5(openai@6.49.0(zod@4.4.3)))" +
      "(@langchain/langgraph-checkpoint@1.1.3(@langchain/core@1.2.5(openai@6.49.0(zod@4.4.3))))" +
      "(zod@4.4.3)"
    const snapshotEntry = lockfile.snapshots[identity]
    const importerDependency = lockfile.importers["."].dependencies[artifact.packageName] as {
      version: string
    }
    delete lockfile.snapshots[identity]
    lockfile.snapshots[`${identity}${peerContext}`] = snapshotEntry
    importerDependency.version = `${reference}${peerContext}`

    expect(() => validateNativeFixtureLockfile(lockfile, artifacts)).not.toThrow()

    importerDependency.version = `${reference}${peerContext.slice(0, -1)}`
    expect(() => validateNativeFixtureLockfile(lockfile, artifacts)).toThrow(/file reference/)

    importerDependency.version = `${reference}${peerContext}#foreign`
    expect(() => validateNativeFixtureLockfile(lockfile, artifacts)).toThrow(/file reference/)

    for (const hiddenReference of ["file:vendor/foreign.tgz", "workspace:*", "link:foreign"]) {
      importerDependency.version = `${reference}(peer@${hiddenReference})`
      expect(() => validateNativeFixtureLockfile(lockfile, artifacts), hiddenReference).toThrow(
        /file reference/,
      )
    }
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

    const mismatchedPeerVersion = structuredClone(validNativeLockfile(artifacts))
    const dependencyReference = `file:vendor/${artifacts[1]?.tarballName as string}`
    const rootImporter = mismatchedPeerVersion.importers["."].dependencies["@dawn-ai/root"] as {
      version: string
    }
    rootImporter.version = `${dependencyReference}(peer@1.0.0)`
    expect(() => validateNativeFixtureLockfile(mismatchedPeerVersion, artifacts)).toThrow(
      /matching tarball/,
    )

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

  test("builds the workspace once, packs only the closure, and leaves prebuilt compilation to orchestration", async () => {
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
    expect(commands[0]).toMatchObject({
      executable: "corepack",
      args: ["pnpm", "build"],
      cwd: workspace.repoRoot,
      timeoutMs: 120_000,
    })
    expect(commands[0]?.env).not.toHaveProperty("DAWN_VERCEL_TOKEN")
    expect(commands[0]?.env).not.toHaveProperty("VERCEL_TOKEN")
    expect(commands.filter(({ args }) => args.includes("--lockfile-only"))).toHaveLength(2)
    expect(commands.filter(({ args }) => args.includes("--frozen-lockfile"))).toEqual([
      expect.objectContaining({ cwd: assembly.prebuilt.root }),
    ])
    expect(commands.some(({ executable }) => executable.endsWith(join(".bin", "dawn")))).toBe(false)

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
    await expect(lstat(join(assembly.prebuilt.root, ".vercel", "output"))).rejects.toMatchObject({
      code: "ENOENT",
    })
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

describe("pinned vercel boundary", () => {
  test("uses only the absolute pinned binary with operation-local credentials", async () => {
    const jobRoot = await realpath(await makeTempDir())
    const sourceRoot = join(jobRoot, "source")
    const prebuiltRoot = join(jobRoot, "prebuilt")
    const globalConfigDir = join(jobRoot, "global-config")
    await mkdir(sourceRoot)
    await mkdir(prebuiltRoot)
    await mkdir(globalConfigDir, { mode: 0o700 })
    const localConfigPath = join(sourceRoot, "vercel.json")
    const prebuiltConfigPath = join(prebuiltRoot, "vercel.json")
    await writeFile(localConfigPath, '{"fluid":true}\n', "utf8")
    await writeFile(prebuiltConfigPath, '{"fluid":true}\n', "utf8")

    const requests: NativeVercelChildRequest[] = []
    let logStderr = [
      '\u001b[36mResolving deployment "dpl_Source123"\u001b[39m\r\n',
      '\u001b[36mFetching project "prj_Test456"\u001b[39m\r\n',
      '\u001b[36mFetching project "prj_Test456"\u001b[39m\r\n',
      "\u001b[36mFetching logs...\u001b[39m\r\n",
    ].join("")
    const boundary = await createNativePinnedVercelBoundary({
      cliPackageRoot,
      databaseUrl: "postgres://native-secret",
      fixtureRoots: [sourceRoot, prebuiltRoot],
      globalConfigDir,
      jobRoot,
      orgId: "team_Test123",
      parentEnv: {
        PATH: process.env.PATH,
        DATABASE_URL: "ambient-database",
        DAWN_VERCEL_TOKEN: "ambient-dawn-token",
        NOW_TOKEN: "ambient-now-token",
        RELEASE_TOKEN: "ambient-release-token",
        VERCEL_TOKEN: "ambient-vercel-token",
      },
      projectId: "prj_Test456",
      releaseCredential: "private-release-value",
      runChild: async (request) => {
        requests.push(request)
        if (request.args[0] === "--version") {
          return {
            exitCode: 0,
            stderr: pinnedVercelVersionStderr,
            stdout: "58.9.0\n",
          }
        }
        if (request.args[0] === "inspect") {
          return {
            exitCode: 0,
            stderr: "",
            stdout:
              '{"id":"dpl_Source123","url":"dawn-source-abc.vercel.app","readyState":"READY"}\n',
          }
        }
        if (request.args[0] === "logs") {
          return { exitCode: 0, stderr: logStderr, stdout: '{"id":"request-1"}\n' }
        }
        if (request.args.includes("--prebuilt")) {
          return {
            exitCode: 0,
            stderr: "",
            stdout:
              '{"status":"ok","message":"deployed","next":"inspect","deployment":{"id":"dpl_Prebuilt456","url":"dawn-prebuilt-def.vercel.app","readyState":"BUILDING"}}\n',
          }
        }
        return {
          exitCode: 0,
          stderr: "",
          stdout: '{"id":"dpl_Source123","url":"dawn-source-abc.vercel.app"}\n',
        }
      },
      token: "vercel-token-secret",
    })

    await boundary.assertVersion()
    await expect(
      boundary.deploy({
        fixtureRoot: sourceRoot,
        kind: "source",
        localConfigPath,
        marker: `vclrun_${"a".repeat(32)}`,
      }),
    ).resolves.toEqual({
      canonicalOrigin: "https://dawn-source-abc.vercel.app",
      commandEvidence: {
        command: "deploy",
        positionalPathAbsent: true,
        prebuiltFlagCount: 0,
      },
      deploymentId: "dpl_Source123",
    })
    await expect(
      boundary.deploy({
        fixtureRoot: prebuiltRoot,
        kind: "prebuilt",
        localConfigPath: prebuiltConfigPath,
        marker: `vclrun_${"b".repeat(32)}`,
      }),
    ).resolves.toEqual({
      canonicalOrigin: "https://dawn-prebuilt-def.vercel.app",
      commandEvidence: {
        command: "deploy",
        positionalPathAbsent: true,
        prebuiltFlagCount: 1,
      },
      deploymentId: "dpl_Prebuilt456",
    })
    await expect(
      boundary.inspect({
        canonicalOrigin: "https://dawn-source-abc.vercel.app",
        deploymentId: "dpl_Source123",
      }),
    ).resolves.toEqual({ readyState: "READY" })
    const queryStartIso = "2027-01-15T08:00:00.000Z"
    const queryEndIso = "2027-01-15T08:01:00.000Z"
    await expect(
      boundary.logs({ deploymentId: "dpl_Source123", queryEndIso, queryStartIso }),
    ).resolves.toBe('{"id":"request-1"}\n')
    logStderr = `Fetching logs...\nwarning: vercel-token-secret\n`
    const unexpectedLogStderr = await boundary
      .logs({ deploymentId: "dpl_Source123", queryEndIso, queryStartIso })
      .then(
        () => undefined,
        (error: unknown) => error,
      )
    expect(unexpectedLogStderr).toBeInstanceOf(Error)
    expect((unexpectedLogStderr as Error).message).toMatch(/stderr|progress|logs/)
    expect((unexpectedLogStderr as Error).message).not.toContain("vercel-token-secret")

    expect(requests).toHaveLength(6)
    const expectedExecutable = join(cliPackageRoot, "node_modules", ".bin", "vercel")
    expect(requests.every(({ executable }) => executable === expectedExecutable)).toBe(true)
    expect(requests[0]).toMatchObject({
      args: ["--version", "--global-config", globalConfigDir],
      cwd: jobRoot,
      timeoutMs: expect.any(Number),
    })
    expect(Number.isFinite(requests[0]?.timeoutMs)).toBe(true)
    expect((requests[0]?.timeoutMs as number) > 0).toBe(true)
    expect(requests[0]?.env.PATH?.split(delimiter)[0]).toBe(dirname(process.execPath))
    expect(requests[0]?.env).not.toHaveProperty("VERCEL_TOKEN")
    expect(requests[0]?.env).not.toHaveProperty("DATABASE_URL")
    expect(requests[0]?.env).not.toHaveProperty("RELEASE_TOKEN")

    const deploy = requests[1] as NativeVercelChildRequest
    expect(deploy.cwd).toBe(sourceRoot)
    expect(deploy.args).toEqual([
      "deploy",
      "--target",
      "preview",
      "--meta",
      `dawnVercelRun=vclrun_${"a".repeat(32)}`,
      "--scope",
      "team_Test123",
      "--non-interactive",
      "--yes",
      "--no-wait",
      "--json",
      "--global-config",
      globalConfigDir,
      "--local-config",
      localConfigPath,
      "--env",
      "DATABASE_URL",
    ])
    expect(deploy.args).not.toContain("--debug")
    expect(deploy.args.join("\0")).not.toContain("vercel-token-secret")
    expect(deploy.args.join("\0")).not.toContain("postgres://native-secret")
    expect(deploy.args.join("\0")).not.toContain("private-release-value")
    expect(deploy.env).toMatchObject({
      DATABASE_URL: "postgres://native-secret",
      NO_UPDATE_NOTIFIER: "1",
      VERCEL_ORG_ID: "team_Test123",
      VERCEL_PROJECT_ID: "prj_Test456",
      VERCEL_TELEMETRY_DISABLED: "1",
      VERCEL_TOKEN: "vercel-token-secret",
    })
    expect(deploy.env).not.toHaveProperty("DAWN_VERCEL_TOKEN")
    expect(deploy.env).not.toHaveProperty("RELEASE_TOKEN")

    const prebuilt = requests[2] as NativeVercelChildRequest
    expect(prebuilt.cwd).toBe(prebuiltRoot)
    expect(prebuilt.args).toEqual([
      "deploy",
      "--prebuilt",
      "--target",
      "preview",
      "--meta",
      `dawnVercelRun=vclrun_${"b".repeat(32)}`,
      "--scope",
      "team_Test123",
      "--non-interactive",
      "--yes",
      "--no-wait",
      "--json",
      "--global-config",
      globalConfigDir,
      "--local-config",
      prebuiltConfigPath,
      "--env",
      "DATABASE_URL",
    ])

    const inspect = requests[3] as NativeVercelChildRequest
    expect(inspect.args).toEqual([
      "inspect",
      "dpl_Source123",
      "--scope",
      "team_Test123",
      "--wait",
      "--json",
      "--non-interactive",
      "--global-config",
      globalConfigDir,
    ])
    expect(inspect.cwd).toBe(jobRoot)
    expect(inspect.env).toMatchObject({
      NO_UPDATE_NOTIFIER: "1",
      VERCEL_ORG_ID: "team_Test123",
      VERCEL_PROJECT_ID: "prj_Test456",
      VERCEL_TELEMETRY_DISABLED: "1",
      VERCEL_TOKEN: "vercel-token-secret",
    })
    expect(inspect.env).not.toHaveProperty("DATABASE_URL")
    expect(inspect.args).not.toContain("--debug")

    const logs = requests[4] as NativeVercelChildRequest
    expect(logs).toMatchObject({
      args: [
        "logs",
        "--project",
        "prj_Test456",
        "--deployment",
        "dpl_Source123",
        "--json",
        "--since",
        queryStartIso,
        "--until",
        queryEndIso,
        "--limit",
        "1000",
        "--scope",
        "team_Test123",
        "--non-interactive",
        "--global-config",
        globalConfigDir,
      ],
      cwd: jobRoot,
      executable: expectedExecutable,
      timeoutMs: expect.any(Number),
    })
    expect(logs.env).toMatchObject({
      NO_UPDATE_NOTIFIER: "1",
      VERCEL_ORG_ID: "team_Test123",
      VERCEL_PROJECT_ID: "prj_Test456",
      VERCEL_TELEMETRY_DISABLED: "1",
      VERCEL_TOKEN: "vercel-token-secret",
    })
    expect(logs.env).not.toHaveProperty("DATABASE_URL")
    expect(logs.env).not.toHaveProperty("RELEASE_TOKEN")
    expect(logs.args).not.toContain("--debug")
    expect(requests[5]).toEqual(logs)
  })

  test("fails closed on ambient binary paths, fixture-local auth, and a non-pinned version", async () => {
    const jobRoot = await realpath(await makeTempDir())
    const sourceRoot = join(jobRoot, "source")
    const prebuiltRoot = join(jobRoot, "prebuilt")
    await mkdir(sourceRoot)
    await mkdir(prebuiltRoot)
    const makeBoundary = (
      globalConfigDir: string,
      stdout = "58.9.1\n",
      stderr = pinnedVercelVersionStderr,
    ) =>
      createNativePinnedVercelBoundary({
        cliPackageRoot,
        databaseUrl: "postgres://native-secret",
        fixtureRoots: [sourceRoot, prebuiltRoot],
        globalConfigDir,
        jobRoot,
        orgId: "team_Test123",
        parentEnv: process.env,
        projectId: "prj_Test456",
        releaseCredential: "private-release-value",
        runChild: async () => ({ exitCode: 0, stderr, stdout }),
        token: "vercel-token-secret",
      })

    const insideFixture = join(sourceRoot, "global-config")
    await mkdir(insideFixture, { mode: 0o700 })
    await expect(makeBoundary(insideFixture)).rejects.toThrow(/global config/i)
    await expect(makeBoundary("relative-global-config")).rejects.toThrow(/absolute/i)

    const outsideRoot = await realpath(await makeTempDir())
    const outsideConfig = join(outsideRoot, "global-config")
    await mkdir(outsideConfig, { mode: 0o700 })
    await expect(makeBoundary(outsideConfig)).rejects.toThrow(/job root/i)

    const permissiveConfig = join(jobRoot, "permissive-config")
    await mkdir(permissiveConfig, { mode: 0o755 })
    await expect(makeBoundary(permissiveConfig)).rejects.toThrow(/owner-only/i)

    const realConfig = join(jobRoot, "real-config")
    const linkedConfig = join(jobRoot, "linked-config")
    await mkdir(realConfig, { mode: 0o700 })
    await symlink(realConfig, linkedConfig, "dir")
    await expect(makeBoundary(linkedConfig)).rejects.toThrow(/owner-only|symlink/i)

    const realParent = join(jobRoot, "real-parent")
    const linkedParent = join(jobRoot, "linked-parent")
    await mkdir(realParent, { mode: 0o700 })
    await mkdir(join(realParent, "config"), { mode: 0o700 })
    await symlink(realParent, linkedParent, "dir")
    await expect(makeBoundary(join(linkedParent, "config"))).rejects.toThrow(/owner-only|symlink/i)

    const globalConfigDir = join(jobRoot, "global-config")
    await mkdir(globalConfigDir, { mode: 0o700 })
    const boundary = await makeBoundary(globalConfigDir)
    await expect(boundary.assertVersion()).rejects.toThrow(/58\.9\.0/)

    const unexpectedBanner = await makeBoundary(
      globalConfigDir,
      "58.9.0\n",
      `${pinnedVercelVersionStderr}unexpected warning\n`,
    )
    await expect(unexpectedBanner.assertVersion()).rejects.toThrow(/58\.9\.0/)

    const linkedJobRoot = join(await realpath(await makeTempDir()), "linked-job")
    await symlink(jobRoot, linkedJobRoot, "dir")
    await expect(
      createNativePinnedVercelBoundary({
        cliPackageRoot,
        databaseUrl: "postgres://native-secret",
        fixtureRoots: [sourceRoot, prebuiltRoot],
        globalConfigDir: join(linkedJobRoot, "global-config"),
        jobRoot: linkedJobRoot,
        orgId: "team_Test123",
        parentEnv: process.env,
        projectId: "prj_Test456",
        releaseCredential: "private-release-value",
        runChild: async () => ({
          exitCode: 0,
          stderr: pinnedVercelVersionStderr,
          stdout: "58.9.0\n",
        }),
        token: "vercel-token-secret",
      }),
    ).rejects.toThrow(/job root|symlink/i)
  })

  test("persists the exact deterministic marker evidence before spawning each logical attempt", async () => {
    const coordinates = {
      githubJob: "vercel-native",
      githubRepositoryId: "123456",
      githubRunAttempt: "2",
      githubRunId: "987654",
      kind: "source" as const,
      logicalAttemptIndex: "0",
    }
    const attemptStartMs = 1_800_000_000_000
    const expectedPreimage = [
      "dawn-vercel-marker-v1",
      "123456",
      "987654",
      "2",
      "vercel-native",
      "source",
      "0",
    ] as const
    const expectedMarker = `vclrun_${createHash("sha256")
      .update(JSON.stringify(expectedPreimage), "utf8")
      .digest("hex")
      .slice(0, 32)}`
    expect(deriveNativeAttemptEvidence(coordinates, attemptStartMs)).toEqual({
      attemptLowerBoundMs: attemptStartMs - 300_000,
      attemptStartMs,
      kind: "source",
      marker: expectedMarker,
      preimage: expectedPreimage,
      spawnStarted: true,
    })

    const order: string[] = []
    let persisted: NativeAttemptEvidence | undefined
    const fixtureRoot = await makeTempDir()
    const localConfigPath = join(fixtureRoot, "vercel.json")
    await writeFile(
      localConfigPath,
      `${JSON.stringify({
        $schema: "https://openapi.vercel.sh/vercel.json",
        buildCommand: "node node_modules/@dawn-ai/cli/dist/index.js build",
        fluid: true,
      })}\n`,
      "utf8",
    )
    const result = await runNativeDeployAttempt({
      apiClient: {
        request: async (_method, path) => {
          if (path.startsWith("/v9/projects/")) {
            order.push("project-preflight")
            return {
              body: { id: "prj_Test456", accountId: "team_Test123", rootDirectory: null },
              status: 200,
            }
          }
          order.push("deployment-binding")
          return {
            body: {
              id: "dpl_Source123",
              url: "dawn-source-abc.vercel.app",
              projectId: "prj_Test456",
              ownerId: "team_Test123",
              createdAt: attemptStartMs,
              target: null,
              meta: { dawnVercelRun: expectedMarker },
            },
            status: 200,
          }
        },
      },
      attemptStartMs,
      boundary: {
        assertVersion: async () => {
          order.push("version-check")
        },
        deploy: async ({ marker }) => {
          order.push(`spawn:${marker}`)
          return {
            canonicalOrigin: "https://dawn-source-abc.vercel.app",
            commandEvidence: {
              command: "deploy",
              positionalPathAbsent: true,
              prebuiltFlagCount: 0,
            },
            deploymentId: "dpl_Source123",
          }
        },
        inspect: async () => {
          order.push("inspect-ready")
          return { readyState: "READY" }
        },
      },
      coordinates,
      fixtureRoot,
      localConfigPath,
      orgId: "team_Test123",
      persistAttempt: async (evidence) => {
        persisted = evidence
        order.push(`persist:${evidence.marker}`)
      },
      persistDeploymentBinding: async () => {
        order.push("persist-binding")
      },
      persistDeploymentReceipt: async () => {
        order.push("persist-receipt")
      },
      projectId: "prj_Test456",
      readConfigEvidence: async (path) => {
        order.push("config-evidence")
        return await readNativeVercelConfigEvidence(path)
      },
    })
    expect(order).toEqual([
      "version-check",
      "project-preflight",
      "config-evidence",
      `persist:${expectedMarker}`,
      `spawn:${expectedMarker}`,
      "persist-receipt",
      "deployment-binding",
      "persist-binding",
      "inspect-ready",
    ])
    expect(persisted).toEqual(result.attempt)
    expect(result).toMatchObject({
      binding: {
        deploymentId: "dpl_Source123",
        ownerIdMatched: true,
        projectIdMatched: true,
      },
      canonicalOrigin: "https://dawn-source-abc.vercel.app",
      deploymentId: "dpl_Source123",
      config: { fluid: true, sha256: expect.stringMatching(/^[a-f0-9]{64}$/) },
      readyState: "READY",
    })

    for (const badCoordinates of [
      { ...coordinates, githubJob: "" },
      { ...coordinates, githubRepositoryId: "" },
      { ...coordinates, kind: "other" },
      { ...coordinates, logicalAttemptIndex: "00" },
      { ...coordinates, logicalAttemptIndex: "-1" },
      { ...coordinates, logicalAttemptIndex: "1.0" },
    ]) {
      expect(() =>
        deriveNativeAttemptEvidence(badCoordinates as typeof coordinates, attemptStartMs),
      ).toThrow()
    }
  })

  test("stops immediately when any attempt or deployment evidence persist fails", async () => {
    const fixtureRoot = await makeTempDir()
    const localConfigPath = join(fixtureRoot, "vercel.json")
    await writeFile(
      localConfigPath,
      `${JSON.stringify({
        $schema: "https://openapi.vercel.sh/vercel.json",
        buildCommand: "node node_modules/@dawn-ai/cli/dist/index.js build",
        fluid: true,
      })}\n`,
      "utf8",
    )
    const marker = `vclrun_${"a".repeat(32)}`
    for (const phase of ["attempt", "receipt", "binding"] as const) {
      let apiCalls = 0
      let attemptMarker = marker
      let deployCalls = 0
      let inspectCalls = 0
      await expect(
        runNativeDeployAttempt({
          apiClient: {
            request: async () => {
              apiCalls += 1
              return apiCalls === 1
                ? {
                    body: {
                      id: "prj_Test456",
                      accountId: "team_Test123",
                      rootDirectory: null,
                    },
                    status: 200,
                  }
                : {
                    body: {
                      id: "dpl_Source123",
                      url: "dawn-source-abc.vercel.app",
                      projectId: "prj_Test456",
                      ownerId: "team_Test123",
                      createdAt: 1_800_000_000_000,
                      target: null,
                      meta: { dawnVercelRun: attemptMarker },
                    },
                    status: 200,
                  }
            },
          },
          attemptStartMs: 1_800_000_000_000,
          boundary: {
            assertVersion: async () => {},
            deploy: async () => {
              deployCalls += 1
              return {
                canonicalOrigin: "https://dawn-source-abc.vercel.app",
                commandEvidence: {
                  command: "deploy",
                  positionalPathAbsent: true,
                  prebuiltFlagCount: 0,
                },
                deploymentId: "dpl_Source123",
              }
            },
            inspect: async () => {
              inspectCalls += 1
              return { readyState: "READY" }
            },
          },
          coordinates: {
            githubJob: "vercel-native",
            githubRepositoryId: "123456",
            githubRunAttempt: "2",
            githubRunId: "987654",
            kind: "source",
            logicalAttemptIndex: "0",
          },
          fixtureRoot,
          localConfigPath,
          orgId: "team_Test123",
          persistAttempt: async (evidence) => {
            attemptMarker = evidence.marker
            if (phase === "attempt") throw new Error("injected persist failure")
          },
          persistDeploymentBinding: async () => {
            if (phase === "binding") throw new Error("injected persist failure")
          },
          persistDeploymentReceipt: async () => {
            if (phase === "receipt") throw new Error("injected persist failure")
          },
          projectId: "prj_Test456",
        }),
      ).rejects.toThrow(/injected persist failure/)
      expect({ phase, apiCalls, deployCalls, inspectCalls }).toEqual(
        phase === "attempt"
          ? { phase, apiCalls: 1, deployCalls: 0, inspectCalls: 0 }
          : phase === "receipt"
            ? { phase, apiCalls: 1, deployCalls: 1, inspectCalls: 0 }
            : { phase, apiCalls: 2, deployCalls: 1, inspectCalls: 0 },
      )
    }
  })

  test("rejects malformed project scope before any child or API operation", async () => {
    let externalCalls = 0
    await expect(
      runNativeDeployAttempt({
        apiClient: {
          request: async () => {
            externalCalls += 1
            throw new Error("API must not run")
          },
        },
        attemptStartMs: 1_800_000_000_000,
        boundary: {
          assertVersion: async () => {
            externalCalls += 1
          },
          deploy: async () => {
            externalCalls += 1
            throw new Error("deploy must not run")
          },
          inspect: async () => {
            externalCalls += 1
            throw new Error("inspect must not run")
          },
        },
        coordinates: {
          githubJob: "vercel-native",
          githubRepositoryId: "123456",
          githubRunAttempt: "2",
          githubRunId: "987654",
          kind: "source",
          logicalAttemptIndex: "0",
        },
        fixtureRoot: "/unused/source",
        localConfigPath: "/unused/source/vercel.json",
        orgId: "not-a-team",
        persistAttempt: async () => {},
        persistDeploymentBinding: async () => {},
        persistDeploymentReceipt: async () => {},
        projectId: "prj_Test456",
      }),
    ).rejects.toThrow(/organization|project|scope/i)
    expect(externalCalls).toBe(0)
  })

  test("short-circuits safely on non-200 project and deployment API reads", async () => {
    const baseCoordinates = {
      githubJob: "vercel-native",
      githubRepositoryId: "123456",
      githubRunAttempt: "2",
      githubRunId: "987654",
      kind: "source" as const,
      logicalAttemptIndex: "0",
    }
    const baseBoundary = (order: string[]) => ({
      assertVersion: async () => {
        order.push("version")
      },
      deploy: async () => {
        order.push("deploy")
        return {
          canonicalOrigin: "https://dawn-source-abc.vercel.app",
          commandEvidence: {
            command: "deploy" as const,
            positionalPathAbsent: true as const,
            prebuiltFlagCount: 0 as const,
          },
          deploymentId: "dpl_Source123",
        }
      },
      inspect: async () => {
        order.push("inspect")
        return { readyState: "READY" as const }
      },
    })

    const projectOrder: string[] = []
    await expect(
      runNativeDeployAttempt({
        apiClient: {
          request: async () => {
            projectOrder.push("project-api")
            return { body: { error: "forbidden" }, status: 403 }
          },
        },
        attemptStartMs: 1_800_000_000_000,
        boundary: baseBoundary(projectOrder),
        coordinates: baseCoordinates,
        fixtureRoot: "/unused/source",
        localConfigPath: "/unused/source/vercel.json",
        orgId: "team_Test123",
        persistAttempt: async () => {
          projectOrder.push("persist-attempt")
        },
        persistDeploymentBinding: async () => {
          projectOrder.push("persist-binding")
        },
        persistDeploymentReceipt: async () => {
          projectOrder.push("persist-receipt")
        },
        projectId: "prj_Test456",
        readConfigEvidence: async () => {
          projectOrder.push("config")
          return { fluid: true, sha256: "a".repeat(64) }
        },
      }),
    ).rejects.toThrow(/status 403/)
    expect(projectOrder).toEqual(["version", "project-api"])

    const deploymentOrder: string[] = []
    let apiCall = 0
    await expect(
      runNativeDeployAttempt({
        apiClient: {
          request: async () => {
            apiCall += 1
            deploymentOrder.push(apiCall === 1 ? "project-api" : "deployment-api")
            return apiCall === 1
              ? {
                  body: {
                    id: "prj_Test456",
                    accountId: "team_Test123",
                    rootDirectory: null,
                  },
                  status: 200,
                }
              : { body: { error: "unavailable" }, status: 503 }
          },
        },
        attemptStartMs: 1_800_000_000_000,
        boundary: baseBoundary(deploymentOrder),
        coordinates: baseCoordinates,
        fixtureRoot: "/unused/source",
        localConfigPath: "/unused/source/vercel.json",
        orgId: "team_Test123",
        persistAttempt: async () => {
          deploymentOrder.push("persist-attempt")
        },
        persistDeploymentBinding: async () => {
          deploymentOrder.push("persist-binding")
        },
        persistDeploymentReceipt: async () => {
          deploymentOrder.push("persist-receipt")
        },
        projectId: "prj_Test456",
        readConfigEvidence: async () => {
          deploymentOrder.push("config")
          return { fluid: true, sha256: "a".repeat(64) }
        },
      }),
    ).rejects.toThrow(/status 503/)
    expect(deploymentOrder).toEqual([
      "version",
      "project-api",
      "config",
      "persist-attempt",
      "deploy",
      "persist-receipt",
      "deployment-api",
    ])
  })

  test("uses only the fixed Vercel API origin and authorization header", async () => {
    const requests: NativeVercelApiRequest[] = []
    const client = createNativeVercelApiClient({
      token: "vercel-token-secret",
      transport: async (request) => {
        requests.push(request)
        return { body: { id: "prj_Test456" }, status: 200 }
      },
    })
    await expect(
      client.request("GET", "/v9/projects/prj_Test456?teamId=team_Test123"),
    ).resolves.toEqual({ body: { id: "prj_Test456" }, status: 200 })
    expect(requests).toEqual([
      {
        headers: { authorization: "Bearer vercel-token-secret" },
        method: "GET",
        redirect: "manual",
        timeoutMs: expect.any(Number),
        url: "https://api.vercel.com/v9/projects/prj_Test456?teamId=team_Test123",
      },
    ])
    for (const path of [
      "https://attacker.invalid/v9/projects/x",
      "//attacker.invalid/v9/projects/x",
      "\\\\attacker.invalid\\v9\\projects\\x",
      "v9/projects/x",
      "/v9/projects/x#fragment",
      "/v9/projects/../attacker",
      "/v9/projects/%2e%2e/attacker",
    ]) {
      await expect(client.request("GET", path), path).rejects.toThrow(/path/)
    }
    await expect(client.request("POST" as "GET", "/v9/projects/prj_Test456")).rejects.toThrow(
      /method/,
    )
    expect(JSON.stringify(requests)).not.toContain("postgres://")
  })
})

describe("deployment receipt", () => {
  test("accepts only the two pinned 58.9.0 JSON shapes", () => {
    expect(
      parseNativeVercelDeploymentReceipt(
        '{"id":"dpl_Source123","url":"dawn-source-abc.vercel.app"}\n',
      ),
    ).toEqual({
      canonicalOrigin: "https://dawn-source-abc.vercel.app",
      deploymentId: "dpl_Source123",
    })
    expect(
      parseNativeVercelDeploymentReceipt(
        '{"status":"ok","message":"deployed","next":"inspect","deployment":{"id":"dpl_Prebuilt456","url":"https://dawn-prebuilt-def.vercel.app/","readyState":"BUILDING"}}',
      ),
    ).toEqual({
      canonicalOrigin: "https://dawn-prebuilt-def.vercel.app",
      deploymentId: "dpl_Prebuilt456",
    })
  })

  test.each([
    "https://dawn-source-abc.vercel.app",
    'prefix {"id":"dpl_Source123","url":"dawn-source-abc.vercel.app"}',
    '{"id":"dpl_Source123","url":"dawn-source-abc.vercel.app"} suffix',
    '{"id":"dpl_Source123","url":"dawn-source-abc.vercel.app","deployment":{"id":"dpl_Other1","url":"other.vercel.app"}}',
    '{"status":"ok","id":"dpl_Source123","deployment":{"id":"dpl_Other1","url":"other.vercel.app"}}',
    '{"status":"failed","deployment":{"id":"dpl_Source123","url":"dawn-source-abc.vercel.app"}}',
    '{"result":{"id":"dpl_Source123","url":"dawn-source-abc.vercel.app"}}',
    '{"id":"project-name","url":"dawn-source-abc.vercel.app"}',
    '{"id":"dpl_Source123","url":"http://dawn-source-abc.vercel.app"}',
    '{"id":"dpl_Source123","url":"dawn-source-abc.vercel.app/path"}',
  ])("rejects noncanonical or ambiguous stdout: %s", (stdout) => {
    expect(() => parseNativeVercelDeploymentReceipt(stdout)).toThrow()
  })

  test("requires exact project, config, authoritative deployment, and inspect binding", async () => {
    expect(
      parseNativeVercelProjectBinding(
        { id: "prj_Test456", accountId: "team_Test123", rootDirectory: null, name: "safe" },
        { orgId: "team_Test123", projectId: "prj_Test456" },
      ),
    ).toEqual({ projectBindingVerified: true, rootDirectory: null })
    expect(
      parseNativeVercelProjectBinding(
        { id: "prj_Test456", accountId: "team_Test123" },
        { orgId: "team_Test123", projectId: "prj_Test456" },
      ),
    ).toEqual({ projectBindingVerified: true, rootDirectory: null })

    const root = await makeTempDir()
    const configPath = join(root, "vercel.json")
    const configSource = `${JSON.stringify(
      {
        $schema: "https://openapi.vercel.sh/vercel.json",
        buildCommand: "node node_modules/@dawn-ai/cli/dist/index.js build",
        fluid: true,
      },
      null,
      2,
    )}\n`
    await writeFile(configPath, configSource, "utf8")
    await expect(readNativeVercelConfigEvidence(configPath)).resolves.toEqual({
      fluid: true,
      sha256: createHash("sha256").update(configSource, "utf8").digest("hex"),
    })

    const expected = {
      attemptLowerBoundMs: 1_799_999_700_000,
      attemptUpperBoundMs: 1_800_000_300_000,
      canonicalOrigin: "https://dawn-source-abc.vercel.app",
      deploymentId: "dpl_Source123",
      marker: `vclrun_${"a".repeat(32)}`,
      orgId: "team_Test123",
      projectId: "prj_Test456",
    }
    const binding = parseNativeVercelDeploymentBinding(
      {
        id: "dpl_Source123",
        url: "dawn-source-abc.vercel.app",
        projectId: "prj_Test456",
        ownerId: "team_Test123",
        createdAt: 1_800_000_000_000,
        target: null,
        meta: { dawnVercelRun: `vclrun_${"a".repeat(32)}` },
        env: { SECRET: "must-not-be-projected" },
      },
      expected,
    )
    expect(binding).toEqual({
      canonicalOrigin: "https://dawn-source-abc.vercel.app",
      createdAt: 1_800_000_000_000,
      deploymentId: "dpl_Source123",
      marker: `vclrun_${"a".repeat(32)}`,
      ownerIdMatched: true,
      projectIdMatched: true,
      target: "preview",
    })
    expect(JSON.stringify(binding)).not.toContain("team_Test123")
    expect(JSON.stringify(binding)).not.toContain("prj_Test456")

    expect(
      parseNativeVercelInspectReceipt(
        '{"id":"dpl_Source123","url":"dawn-source-abc.vercel.app","readyState":"READY"}',
        expected,
      ),
    ).toEqual({ readyState: "READY" })
  })

  test("rejects every project, config, deployment, or readiness mismatch", async () => {
    const expectedProject = { orgId: "team_Test123", projectId: "prj_Test456" }
    for (const body of [
      { id: "prj_Other", accountId: "team_Test123", rootDirectory: null },
      { id: "prj_Test456", accountId: "team_Other", rootDirectory: null },
      { id: "prj_Test456", accountId: "team_Test123", rootDirectory: "" },
      { id: "prj_Test456", accountId: "team_Test123", rootDirectory: "." },
    ]) {
      expect(() => parseNativeVercelProjectBinding(body, expectedProject)).toThrow()
    }

    const root = await makeTempDir()
    for (const [name, body] of [
      ["fluid-false", { fluid: false }],
      ["extra", { fluid: true, extra: true }],
      ["wrong-command", { fluid: true, buildCommand: "other" }],
    ] as const) {
      const path = join(root, `${name}.json`)
      await writeFile(path, `${JSON.stringify(body)}\n`, "utf8")
      await expect(readNativeVercelConfigEvidence(path)).rejects.toThrow()
    }

    const expected = {
      attemptLowerBoundMs: 1_799_999_700_000,
      attemptUpperBoundMs: 1_800_000_300_000,
      canonicalOrigin: "https://dawn-source-abc.vercel.app",
      deploymentId: "dpl_Source123",
      marker: `vclrun_${"a".repeat(32)}`,
      orgId: "team_Test123",
      projectId: "prj_Test456",
    }
    const valid = {
      id: "dpl_Source123",
      url: "dawn-source-abc.vercel.app",
      projectId: "prj_Test456",
      ownerId: "team_Test123",
      createdAt: 1_800_000_000_000,
      target: "preview",
      meta: { dawnVercelRun: `vclrun_${"a".repeat(32)}` },
    }
    for (const body of [
      { ...valid, id: "dpl_Other" },
      { ...valid, url: "other.vercel.app" },
      { ...valid, url: "https://dawn-source-abc.vercel.app" },
      { ...valid, projectId: "prj_Other" },
      { ...valid, ownerId: "team_Other" },
      { ...valid, createdAt: "1800000000000" },
      { ...valid, createdAt: 1_800_000_000_000.5 },
      { ...valid, createdAt: expected.attemptLowerBoundMs - 1 },
      { ...valid, createdAt: expected.attemptUpperBoundMs + 1 },
      { ...valid, target: "production" },
      { ...valid, target: "staging" },
      { ...valid, target: undefined },
      { ...valid, meta: undefined },
      { ...valid, meta: { dawnVercelRun: 1 } },
      { ...valid, meta: { dawnVercelRun: `vclrun_${"b".repeat(32)}` } },
    ]) {
      expect(() => parseNativeVercelDeploymentBinding(body, expected)).toThrow()
    }
    for (const stdout of [
      '{"id":"dpl_Other","url":"dawn-source-abc.vercel.app","readyState":"READY"}',
      '{"id":"dpl_Source123","url":"other.vercel.app","readyState":"READY"}',
      '{"id":"dpl_Source123","url":"dawn-source-abc.vercel.app","readyState":"BUILDING"}',
      '{"id":"dpl_Source123","url":"dawn-source-abc.vercel.app","readyState":"READY","error":{"code":"BOOT_FAILED"}}',
      '{"id":"dpl_Source123","url":"dawn-source-abc.vercel.app","readyState":"READY","protection":{"enabled":true}}',
    ]) {
      expect(() => parseNativeVercelInspectReceipt(stdout, expected)).toThrow()
    }
  })
})

describe("marker reconciliation", () => {
  const orgId = "team_Test123"
  const projectId = "prj_Test456"
  const attemptStartMs = 1_800_000_000_000

  function attemptEvidence() {
    return deriveNativeAttemptEvidence(
      {
        githubJob: "vercel-native",
        githubRepositoryId: "123456",
        githubRunAttempt: "2",
        githubRunId: "987654",
        kind: "source",
        logicalAttemptIndex: "0",
      },
      attemptStartMs,
    )
  }

  function fakeClock(start = attemptStartMs) {
    let current = start
    const sleeps: number[] = []
    return {
      clock: {
        now: () => current,
        sleep: async (milliseconds: number) => {
          sleeps.push(milliseconds)
          current += milliseconds
        },
      },
      jump: (milliseconds: number) => {
        current += milliseconds
      },
      sleeps,
    }
  }

  function listRow(
    attempt: ReturnType<typeof attemptEvidence>,
    overrides: Readonly<Record<string, unknown>> = {},
  ) {
    return {
      uid: "dpl_Reconciled1",
      url: "dawn-reconciled-abc.vercel.app",
      created: attemptStartMs,
      meta: { dawnVercelRun: attempt.marker },
      ...overrides,
    }
  }

  function authoritativeBody(
    attempt: ReturnType<typeof attemptEvidence>,
    overrides: Readonly<Record<string, unknown>> = {},
  ) {
    return {
      id: "dpl_Reconciled1",
      url: "dawn-reconciled-abc.vercel.app",
      projectId,
      ownerId: orgId,
      createdAt: attemptStartMs,
      target: null,
      meta: { dawnVercelRun: attempt.marker },
      ...overrides,
    }
  }

  test("polls every page through a final quiet-boundary query and authenticates each live ID", async () => {
    const attempt = attemptEvidence()
    const { clock, sleeps } = fakeClock()
    const requests: Array<{ readonly method: string; readonly path: string }> = []
    const persisted: unknown[] = []
    const firstPageUntilValues: number[] = []
    let pollIndex = 0
    let activePollUntil = 0
    let authoritativeReads = 0

    const result = await reconcileNativeMarker({
      apiClient: {
        request: async (method, path) => {
          requests.push({ method, path })
          if (path.startsWith("/v9/projects/")) {
            return {
              body: { id: projectId, accountId: orgId, rootDirectory: null },
              status: 200,
            }
          }
          if (path.startsWith("/v13/deployments/")) {
            authoritativeReads += 1
            return { body: authoritativeBody(attempt), status: 200 }
          }
          const query = new URL(path, "https://api.vercel.com")
          expect(query.pathname).toBe("/v6/deployments")
          expect(query.searchParams.get("teamId")).toBe(orgId)
          expect(query.searchParams.get("projectId")).toBe(projectId)
          expect(query.searchParams.get("meta-dawnVercelRun")).toBe(attempt.marker)
          expect(query.searchParams.get("since")).toBe(String(attempt.attemptLowerBoundMs))
          expect(query.searchParams.get("limit")).toBe("100")
          const until = Number(query.searchParams.get("until"))
          if (until !== activePollUntil - 1) {
            activePollUntil = until
            firstPageUntilValues.push(until)
            pollIndex += 1
            if (pollIndex === 1) {
              return { body: { deployments: [], pagination: { next: until - 1 } }, status: 200 }
            }
          }
          if (until === activePollUntil - 1) {
            return {
              body: {
                deployments: [listRow(attempt, { state: "DELETED" })],
                pagination: {},
              },
              status: 200,
            }
          }
          if (pollIndex === 2) {
            return {
              body: { deployments: [listRow(attempt, { state: "DELETED" })], pagination: {} },
              status: 200,
            }
          }
          return {
            body: {
              deployments: [listRow(attempt), listRow(attempt)],
              pagination: {},
            },
            status: 200,
          }
        },
      },
      attempt,
      clock,
      orgId,
      persistDeploymentBinding: async (binding) => {
        persisted.push(binding)
      },
      projectId,
    })

    expect(requests[0]).toEqual({
      method: "GET",
      path: `/v9/projects/${projectId}?teamId=${orgId}`,
    })
    expect(requests[1]).toEqual({
      method: "GET",
      path:
        `/v6/deployments?teamId=${orgId}&projectId=${projectId}` +
        `&meta-dawnVercelRun=${attempt.marker}&since=${attempt.attemptLowerBoundMs}` +
        `&until=${attemptStartMs + 300_000}&limit=100`,
    })
    expect(firstPageUntilValues.slice(0, 3)).toEqual([
      attemptStartMs + 300_000,
      attemptStartMs + 302_000,
      attemptStartMs + 304_000,
    ])
    expect(firstPageUntilValues.at(-1)).toBe(firstPageUntilValues.at(-2))
    expect(sleeps.length).toBeGreaterThanOrEqual(15)
    expect(sleeps.every((value) => value === 2_000)).toBe(true)
    expect(authoritativeReads).toBe(1)
    expect(persisted).toEqual(result.deployments)
    expect(result).toEqual({
      deployments: [
        {
          canonicalOrigin: "https://dawn-reconciled-abc.vercel.app",
          createdAt: attemptStartMs,
          deploymentId: "dpl_Reconciled1",
          marker: attempt.marker,
          ownerIdMatched: true,
          projectIdMatched: true,
          target: "preview",
        },
      ],
      expectedCardinality: true,
      pollIntervalMs: 2_000,
      quietIntervalMs: 30_000,
    })
  })

  test.each([
    ["non-integer", (until: number) => until - 0.5],
    ["non-decreasing", (until: number) => until],
    ["increasing", (until: number) => until + 1],
    ["unsafe", () => Number.MAX_SAFE_INTEGER + 1],
  ])("rejects a %s pagination cursor", async (_label, nextCursor) => {
    const attempt = attemptEvidence()
    const { clock } = fakeClock()
    await expect(
      reconcileNativeMarker({
        apiClient: {
          request: async (_method, path) => {
            if (path.startsWith("/v9/")) {
              return { body: { id: projectId, accountId: orgId }, status: 200 }
            }
            const until = Number(new URL(path, "https://api.vercel.com").searchParams.get("until"))
            return {
              body: { deployments: [], pagination: { next: nextCursor(until) } },
              status: 200,
            }
          },
        },
        attempt,
        clock,
        orgId,
        persistDeploymentBinding: async () => {},
        projectId,
      }),
    ).rejects.toThrow(/cursor|pagination/)
  })

  test("rejects repeated cursor cycles and a 101st page", async () => {
    for (const mode of ["cycle", "overflow"] as const) {
      const attempt = attemptEvidence()
      const { clock } = fakeClock()
      let pages = 0
      const seenUntil: number[] = []
      await expect(
        reconcileNativeMarker({
          apiClient: {
            request: async (_method, path) => {
              if (path.startsWith("/v9/")) {
                return { body: { id: projectId, accountId: orgId }, status: 200 }
              }
              pages += 1
              const until = Number(
                new URL(path, "https://api.vercel.com").searchParams.get("until"),
              )
              seenUntil.push(until)
              const next = mode === "cycle" && pages === 3 ? seenUntil[1] : until - 1
              return { body: { deployments: [], pagination: { next } }, status: 200 }
            },
          },
          attempt,
          clock,
          orgId,
          persistDeploymentBinding: async () => {},
          projectId,
        }),
      ).rejects.toThrow(/cursor|pagination|100 pages/)
      expect(pages).toBe(mode === "overflow" ? 100 : 3)
    }
  })

  test.each([
    { uid: "project-name" },
    { url: "https://dawn-reconciled-abc.vercel.app" },
    { created: String(attemptStartMs) },
    { created: attemptStartMs - 300_001 },
    { created: attemptStartMs + 300_001 },
    { meta: { dawnVercelRun: `vclrun_${"b".repeat(32)}` } },
  ])("rejects a malformed or out-of-window v6 row: %j", async (override) => {
    const attempt = attemptEvidence()
    const { clock } = fakeClock()
    let authoritativeReads = 0
    await expect(
      reconcileNativeMarker({
        apiClient: {
          request: async (_method, path) => {
            if (path.startsWith("/v9/")) {
              return { body: { id: projectId, accountId: orgId }, status: 200 }
            }
            if (path.startsWith("/v13/")) {
              authoritativeReads += 1
              return { body: authoritativeBody(attempt), status: 200 }
            }
            return {
              body: { deployments: [listRow(attempt, override)], pagination: {} },
              status: 200,
            }
          },
        },
        attempt,
        clock,
        orgId,
        persistDeploymentBinding: async () => {},
        projectId,
      }),
    ).rejects.toThrow()
    expect(authoritativeReads).toBe(0)
  })

  test("rejects project/list failures and malformed list responses before authorization", async () => {
    const attempt = attemptEvidence()
    for (const mode of [
      "project-status",
      "project-binding",
      "list-status",
      "list-shape",
    ] as const) {
      const { clock } = fakeClock()
      const paths: string[] = []
      await expect(
        reconcileNativeMarker({
          apiClient: {
            request: async (_method, path) => {
              paths.push(path)
              if (path.startsWith("/v9/")) {
                if (mode === "project-status") {
                  return { body: { error: "forbidden" }, status: 403 }
                }
                return {
                  body: {
                    id: mode === "project-binding" ? "prj_Other" : projectId,
                    accountId: orgId,
                  },
                  status: 200,
                }
              }
              if (mode === "list-status") {
                return { body: { error: "unavailable" }, status: 503 }
              }
              return { body: { deployments: "not-an-array", pagination: {} }, status: 200 }
            },
          },
          attempt,
          clock,
          orgId,
          persistDeploymentBinding: async () => {
            throw new Error("binding must not persist")
          },
          projectId,
        }),
      ).rejects.toThrow()
      expect(paths.some((path) => path.startsWith("/v13/"))).toBe(false)
      if (mode === "project-status" || mode === "project-binding") {
        expect(paths).toHaveLength(1)
      }
    }
  })

  test("validates reconciliation scope and persisted attempt evidence before any request", async () => {
    const validAttempt = attemptEvidence()
    for (const options of [
      { attempt: validAttempt, orgId: "team_Test123?redirect=1", projectId },
      { attempt: validAttempt, orgId, projectId: "prj_Test456/escape" },
      {
        attempt: { ...validAttempt, marker: `vclrun_${"b".repeat(32)}` },
        orgId,
        projectId,
      },
      {
        attempt: { ...validAttempt, attemptLowerBoundMs: validAttempt.attemptLowerBoundMs - 1 },
        orgId,
        projectId,
      },
    ]) {
      let requests = 0
      const { clock } = fakeClock()
      await expect(
        reconcileNativeMarker({
          apiClient: {
            request: async () => {
              requests += 1
              return { body: {}, status: 500 }
            },
          },
          attempt: options.attempt,
          clock,
          orgId: options.orgId,
          persistDeploymentBinding: async () => {},
          projectId: options.projectId,
        }),
      ).rejects.toThrow(/attempt|marker|scope|organization|project/)
      expect(requests).toBe(0)
    }
  })

  test("treats only v13 404 as a disappeared candidate and rejects every other status", async () => {
    const attempt = attemptEvidence()
    for (const status of [401, 403, 410, 429, 500]) {
      const { clock } = fakeClock()
      let persisted = 0
      await expect(
        reconcileNativeMarker({
          apiClient: {
            request: async (_method, path) => {
              if (path.startsWith("/v9/")) {
                return { body: { id: projectId, accountId: orgId }, status: 200 }
              }
              if (path.startsWith("/v13/")) return { body: { error: "failure" }, status }
              return {
                body: { deployments: [listRow(attempt)], pagination: {} },
                status: 200,
              }
            },
          },
          attempt,
          clock,
          orgId,
          persistDeploymentBinding: async () => {
            persisted += 1
          },
          projectId,
        }),
      ).rejects.toThrow()
      expect(persisted).toBe(0)
    }

    const tombstoneClock = fakeClock()
    let listCalls = 0
    let persisted = 0
    const tombstone = await reconcileNativeMarker({
      apiClient: {
        request: async (_method, path) => {
          if (path.startsWith("/v9/")) {
            return { body: { id: projectId, accountId: orgId }, status: 200 }
          }
          if (path.startsWith("/v13/")) return { body: {}, status: 404 }
          listCalls += 1
          return {
            body: {
              deployments: [listRow(attempt, listCalls === 1 ? {} : { state: "DELETED" })],
              pagination: {},
            },
            status: 200,
          }
        },
      },
      attempt,
      clock: tombstoneClock.clock,
      orgId,
      persistDeploymentBinding: async () => {
        persisted += 1
      },
      projectId,
    })
    expect(tombstone.deployments).toEqual([])
    expect(tombstone.expectedCardinality).toBe(true)
    expect(persisted).toBe(0)
  })

  test.each([
    { id: "dpl_Other" },
    { url: "other.vercel.app" },
    { createdAt: attemptStartMs + 1 },
    { projectId: "prj_Other" },
    { ownerId: "team_Other" },
    { target: "production" },
    { meta: { dawnVercelRun: `vclrun_${"b".repeat(32)}` } },
  ])("rejects an unauthorized v13 candidate before persistence: %j", async (override) => {
    const attempt = attemptEvidence()
    const { clock } = fakeClock()
    let persisted = 0
    await expect(
      reconcileNativeMarker({
        apiClient: {
          request: async (_method, path) => {
            if (path.startsWith("/v9/")) {
              return { body: { id: projectId, accountId: orgId }, status: 200 }
            }
            if (path.startsWith("/v13/")) {
              return { body: authoritativeBody(attempt, override), status: 200 }
            }
            return {
              body: { deployments: [listRow(attempt)], pagination: {} },
              status: 200,
            }
          },
        },
        attempt,
        clock,
        orgId,
        persistDeploymentBinding: async () => {
          persisted += 1
        },
        projectId,
      }),
    ).rejects.toThrow()
    expect(persisted).toBe(0)
  })

  test("rejects a later conflicting row for an already authenticated deployment", async () => {
    const attempt = attemptEvidence()
    const { clock } = fakeClock()
    let listCalls = 0
    let authoritativeReads = 0
    await expect(
      reconcileNativeMarker({
        apiClient: {
          request: async (_method, path) => {
            if (path.startsWith("/v9/")) {
              return { body: { id: projectId, accountId: orgId }, status: 200 }
            }
            if (path.startsWith("/v13/")) {
              authoritativeReads += 1
              return { body: authoritativeBody(attempt), status: 200 }
            }
            listCalls += 1
            return {
              body: {
                deployments: [
                  listRow(attempt, listCalls > 1 ? { url: "dawn-conflict-def.vercel.app" } : {}),
                ],
                pagination: {},
              },
              status: 200,
            }
          },
        },
        attempt,
        clock,
        orgId,
        persistDeploymentBinding: async () => {},
        projectId,
      }),
    ).rejects.toThrow(/conflict|changed|mismatch/)
    expect(authoritativeReads).toBe(1)
  })

  test("fails the total deadline and reports cardinality without dropping authenticated IDs", async () => {
    const attempt = attemptEvidence()
    const fastClock = fakeClock()
    let polls = 0
    fastClock.clock.sleep = async (milliseconds: number) => {
      expect(milliseconds).toBe(2_000)
      fastClock.jump(180_000)
    }
    await expect(
      reconcileNativeMarker({
        apiClient: {
          request: async (_method, path) => {
            if (path.startsWith("/v9/")) {
              return { body: { id: projectId, accountId: orgId }, status: 200 }
            }
            polls += 1
            return { body: { deployments: [], pagination: {} }, status: 200 }
          },
        },
        attempt,
        clock: fastClock.clock,
        orgId,
        persistDeploymentBinding: async () => {},
        projectId,
      }),
    ).rejects.toThrow(/deadline/)
    expect(polls).toBe(1)

    const cardinalityClock = fakeClock()
    const persisted: string[] = []
    let listCalls = 0
    const cardinality = await reconcileNativeMarker({
      apiClient: {
        request: async (_method, path) => {
          if (path.startsWith("/v9/")) {
            return { body: { id: projectId, accountId: orgId }, status: 200 }
          }
          if (path.startsWith("/v13/deployments/dpl_Reconciled1")) {
            return { body: authoritativeBody(attempt), status: 200 }
          }
          if (path.startsWith("/v13/deployments/dpl_Reconciled2")) {
            return {
              body: authoritativeBody(attempt, {
                id: "dpl_Reconciled2",
                url: "dawn-reconciled-def.vercel.app",
              }),
              status: 200,
            }
          }
          listCalls += 1
          return {
            body: {
              deployments: [
                listRow(attempt),
                listRow(attempt, {
                  uid: "dpl_Reconciled2",
                  url: "dawn-reconciled-def.vercel.app",
                }),
              ],
              pagination: {},
            },
            status: 200,
          }
        },
      },
      attempt,
      clock: cardinalityClock.clock,
      orgId,
      persistDeploymentBinding: async ({ deploymentId }) => {
        persisted.push(deploymentId)
      },
      projectId,
    })
    expect(listCalls).toBeGreaterThan(1)
    expect(cardinality.expectedCardinality).toBe(false)
    expect(cardinality.deployments.map(({ deploymentId }) => deploymentId)).toEqual([
      "dpl_Reconciled1",
      "dpl_Reconciled2",
    ])
    expect(persisted).toEqual(["dpl_Reconciled1", "dpl_Reconciled2"])
  })

  test("rejects a final boundary page that completes after the 180-second deadline", async () => {
    const attempt = attemptEvidence()
    let current = attemptStartMs
    let boundaryReturned = false
    let boundaryNowCalls = 0
    const clock = {
      now: () => {
        if (boundaryReturned) {
          boundaryNowCalls += 1
          if (boundaryNowCalls === 2) current += 150_001
        }
        return current
      },
      sleep: async (milliseconds: number) => {
        current += milliseconds
      },
    }
    let priorUntil: number | undefined
    await expect(
      reconcileNativeMarker({
        apiClient: {
          request: async (_method, path) => {
            if (path.startsWith("/v9/")) {
              return { body: { id: projectId, accountId: orgId }, status: 200 }
            }
            const until = Number(new URL(path, "https://api.vercel.com").searchParams.get("until"))
            if (until === priorUntil) boundaryReturned = true
            priorUntil = until
            return { body: { deployments: [], pagination: {} }, status: 200 }
          },
        },
        attempt,
        clock,
        orgId,
        persistDeploymentBinding: async () => {},
        projectId,
      }),
    ).rejects.toThrow(/180|deadline/)
  })

  test("resets quiet for a newly observed live ID even when its first v13 read is 404", async () => {
    const attempt = attemptEvidence()
    const observed = fakeClock()
    let authoritativeReads = 0
    const result = await reconcileNativeMarker({
      apiClient: {
        request: async (_method, path) => {
          if (path.startsWith("/v9/")) {
            return { body: { id: projectId, accountId: orgId }, status: 200 }
          }
          if (path.startsWith("/v13/")) {
            authoritativeReads += 1
            return { body: {}, status: 404 }
          }
          return {
            body: {
              deployments:
                observed.clock.now() - attemptStartMs >= 28_000 ? [listRow(attempt)] : [],
              pagination: {},
            },
            status: 200,
          }
        },
      },
      attempt,
      clock: observed.clock,
      orgId,
      persistDeploymentBinding: async () => {},
      projectId,
    })
    expect(result.deployments).toEqual([])
    expect(observed.clock.now() - attemptStartMs).toBeGreaterThanOrEqual(58_000)
    expect(authoritativeReads).toBeGreaterThanOrEqual(16)
  })
})

describe("authenticated cleanup", () => {
  const orgId = "team_Test123"
  const projectId = "prj_Test456"
  const marker = `vclrun_${"a".repeat(32)}`

  function binding(deploymentId: string, suffix: string) {
    return {
      canonicalOrigin: `https://dawn-cleanup-${suffix}.vercel.app`,
      createdAt: 1_800_000_000_000,
      deploymentId,
      marker,
      ownerIdMatched: true as const,
      projectIdMatched: true as const,
      target: "preview" as const,
    }
  }

  function bodyFor(value: ReturnType<typeof binding>) {
    return {
      id: value.deploymentId,
      url: new URL(value.canonicalOrigin).hostname,
      projectId,
      ownerId: orgId,
      createdAt: value.createdAt,
      target: null,
      meta: { dawnVercelRun: value.marker },
    }
  }

  function fakeClock() {
    let current = 1_800_000_000_000
    const sleeps: number[] = []
    return {
      clock: {
        now: () => current,
        sleep: async (milliseconds: number) => {
          sleeps.push(milliseconds)
          current += milliseconds
        },
      },
      jump: (milliseconds: number) => {
        current += milliseconds
      },
      sleeps,
    }
  }

  function reconciliation(...deployments: ReturnType<typeof binding>[]) {
    return {
      deployments,
      expectedCardinality: deployments.length <= 1,
      pollIntervalMs: 2_000 as const,
      quietIntervalMs: 30_000 as const,
    }
  }

  test("requires the cleanup project preflight before any deployment action", async () => {
    const value = binding("dpl_Preflight1", "preflight")
    for (const mode of ["status", "binding"] as const) {
      const { clock } = fakeClock()
      const requests: string[] = []
      await expect(
        cleanupNativeDeployments({
          apiClient: {
            request: async (_method, path) => {
              requests.push(path)
              return mode === "status"
                ? { body: { error: "forbidden" }, status: 403 }
                : { body: { id: "prj_Other", accountId: orgId }, status: 200 }
            },
          },
          clock,
          manifest: [{ binding: value, deploymentId: value.deploymentId }],
          orgId,
          persistDeploymentAbsent: async () => {},
          persistDeleteReceipt: async () => {},
          projectId,
          reconciliation: reconciliation(value),
        }),
      ).rejects.toThrow(/project|status 403/)
      expect(requests).toEqual([`/v9/projects/${projectId}?teamId=${orgId}`])
    }
  })

  test("validates cleanup scope and deployment IDs before any request", async () => {
    for (const options of [
      { deploymentId: "dpl_Safe1", orgId: "team_Test123?redirect=1", projectId },
      { deploymentId: "dpl_Safe1", orgId, projectId: "prj_Test456/escape" },
      { deploymentId: "unsafe/id", orgId, projectId },
    ]) {
      const { clock } = fakeClock()
      let requests = 0
      await expect(
        cleanupNativeDeployments({
          apiClient: {
            request: async () => {
              requests += 1
              return { body: {}, status: 500 }
            },
          },
          clock,
          manifest: [
            {
              deleteReceipt: { state: "DELETED", uid: options.deploymentId },
              deploymentId: options.deploymentId,
            },
          ],
          orgId: options.orgId,
          persistDeploymentAbsent: async () => {},
          persistDeleteReceipt: async () => {},
          projectId: options.projectId,
          reconciliation: reconciliation(),
        }),
      ).rejects.toThrow(/scope|organization|project|deployment/)
      expect(requests).toBe(0)
    }
  })

  test("rejects forged reconciliation cardinality before any request", async () => {
    const one = binding("dpl_Forge1", "forge-one")
    const two = binding("dpl_Forge2", "forge-two")
    const { clock } = fakeClock()
    let requests = 0
    await expect(
      cleanupNativeDeployments({
        apiClient: {
          request: async () => {
            requests += 1
            return { body: {}, status: 500 }
          },
        },
        clock,
        manifest: [],
        orgId,
        persistDeploymentAbsent: async () => {},
        persistDeleteReceipt: async () => {},
        projectId,
        reconciliation: { ...reconciliation(one, two), expectedCardinality: true },
      }),
    ).rejects.toThrow(/cardinality|reconciliation/)
    expect(requests).toBe(0)
  })

  test.each(["authority-less", "contradictory"])(
    "aggregates an %s manifest record after cleaning every valid target",
    async (mode) => {
      const invalidBinding = binding("dpl_InvalidRecord1", "invalid-record")
      const valid = binding("dpl_ValidRecord1", "valid-record")
      const { clock } = fakeClock()
      const deletes: string[] = []
      let validReads = 0
      let caught: unknown
      try {
        await cleanupNativeDeployments({
          apiClient: {
            request: async (method, path) => {
              if (path.startsWith("/v9/")) {
                return { body: { id: projectId, accountId: orgId }, status: 200 }
              }
              const deploymentId = path.split("/deployments/")[1]?.split("?", 1)[0] as string
              if (method === "DELETE") {
                deletes.push(deploymentId)
                return { body: { uid: deploymentId, state: "DELETED" }, status: 200 }
              }
              if (deploymentId !== valid.deploymentId) {
                throw new Error("invalid target must not reach the Vercel API")
              }
              validReads += 1
              return validReads === 1
                ? { body: bodyFor(valid), status: 200 }
                : { body: {}, status: 404 }
            },
          },
          clock,
          manifest: [
            mode === "authority-less"
              ? { deploymentId: invalidBinding.deploymentId }
              : { binding: invalidBinding, deploymentId: "dpl_Contradiction1" },
            { binding: valid, deploymentId: valid.deploymentId },
          ],
          orgId,
          persistDeploymentAbsent: async () => {},
          persistDeleteReceipt: async () => {},
          projectId,
          reconciliation: reconciliation(valid),
        })
      } catch (error) {
        caught = error
      }
      expect(caught).toBeInstanceOf(AggregateError)
      expect(deletes).toEqual([valid.deploymentId])
    },
  )

  test("preflights scope, unions records, deletes exact IDs, and cleans all on cardinality failure", async () => {
    const one = binding("dpl_Cleanup1", "one")
    const two = binding("dpl_Cleanup2", "two")
    const three = binding("dpl_Cleanup3", "three")
    const { clock } = fakeClock()
    const requests: Array<{ readonly method: string; readonly path: string }> = []
    const reads = new Map<string, number>()
    const deleteReceipts: string[] = []
    const absent: string[] = []

    await expect(
      cleanupNativeDeployments({
        apiClient: {
          request: async (method, path) => {
            requests.push({ method, path })
            if (path.startsWith("/v9/")) {
              return {
                body: { id: projectId, accountId: orgId, rootDirectory: null },
                status: 200,
              }
            }
            const deploymentId = path.split("/deployments/")[1]?.split("?", 1)[0] as string
            const value = [one, two, three].find((entry) => entry.deploymentId === deploymentId)
            if (!value) return { body: {}, status: 404 }
            if (method === "DELETE") {
              return { body: { uid: deploymentId, state: "DELETED" }, status: 200 }
            }
            const count = reads.get(deploymentId) ?? 0
            reads.set(deploymentId, count + 1)
            return count === 0 ? { body: bodyFor(value), status: 200 } : { body: {}, status: 404 }
          },
        },
        clock,
        manifest: [
          { binding: one, deploymentId: one.deploymentId },
          { binding: three, deploymentId: three.deploymentId },
        ],
        orgId,
        persistDeploymentAbsent: async (deploymentId) => {
          absent.push(deploymentId)
        },
        persistDeleteReceipt: async ({ uid }) => {
          deleteReceipts.push(uid)
        },
        projectId,
        reconciliation: reconciliation(one, two),
      }),
    ).rejects.toThrow(/cardinality/)

    expect(requests[0]).toEqual({
      method: "GET",
      path: `/v9/projects/${projectId}?teamId=${orgId}`,
    })
    expect(requests.filter(({ method }) => method === "DELETE").map(({ path }) => path)).toEqual([
      `/v13/deployments/dpl_Cleanup1?teamId=${orgId}`,
      `/v13/deployments/dpl_Cleanup3?teamId=${orgId}`,
      `/v13/deployments/dpl_Cleanup2?teamId=${orgId}`,
    ])
    expect(requests.every(({ path }) => !path.includes("url="))).toBe(true)
    expect(deleteReceipts).toEqual(["dpl_Cleanup1", "dpl_Cleanup3", "dpl_Cleanup2"])
    expect(absent).toEqual(["dpl_Cleanup1", "dpl_Cleanup3", "dpl_Cleanup2"])
  })

  test("accepts absence only with prior authority and an exact follow-up GET", async () => {
    const prior = binding("dpl_Absent1", "absent")
    const { clock } = fakeClock()
    const requests: Array<{ readonly method: string; readonly path: string }> = []
    const absent: string[] = []
    const result = await cleanupNativeDeployments({
      apiClient: {
        request: async (method, path) => {
          requests.push({ method, path })
          if (path.startsWith("/v9/")) {
            return { body: { id: projectId, accountId: orgId }, status: 200 }
          }
          return { body: { error: { code: "not_found" } }, status: 404 }
        },
      },
      clock,
      manifest: [{ binding: prior, deploymentId: prior.deploymentId }],
      orgId,
      persistDeploymentAbsent: async (deploymentId) => {
        absent.push(deploymentId)
      },
      persistDeleteReceipt: async () => {
        throw new Error("DELETE receipt must not persist for pre-delete absence")
      },
      projectId,
      reconciliation: reconciliation(prior),
    })
    expect(result).toEqual({ deploymentAbsent: true, deploymentIds: [prior.deploymentId] })
    expect(requests.filter(({ path }) => path.startsWith("/v13/"))).toEqual([
      { method: "GET", path: `/v13/deployments/${prior.deploymentId}?teamId=${orgId}` },
      { method: "GET", path: `/v13/deployments/${prior.deploymentId}?teamId=${orgId}` },
    ])
    expect(absent).toEqual([prior.deploymentId])
  })

  test("accepts DELETE-time 404 only after an exact follow-up GET also returns 404", async () => {
    const prior = binding("dpl_DeleteRace1", "delete-race")
    const { clock } = fakeClock()
    const requests: Array<{ readonly method: string; readonly path: string }> = []
    const result = await cleanupNativeDeployments({
      apiClient: {
        request: async (method, path) => {
          requests.push({ method, path })
          if (path.startsWith("/v9/")) {
            return { body: { id: projectId, accountId: orgId }, status: 200 }
          }
          if (method === "DELETE") return { body: {}, status: 404 }
          return requests.filter(({ path: seen }) => seen.startsWith("/v13/")).length === 1
            ? { body: bodyFor(prior), status: 200 }
            : { body: {}, status: 404 }
        },
      },
      clock,
      manifest: [{ binding: prior, deploymentId: prior.deploymentId }],
      orgId,
      persistDeploymentAbsent: async () => {},
      persistDeleteReceipt: async () => {
        throw new Error("a 404 DELETE must not create a successful-delete receipt")
      },
      projectId,
      reconciliation: reconciliation(prior),
    })
    expect(result.deploymentAbsent).toBe(true)
    expect(requests.filter(({ path }) => path.startsWith("/v13/"))).toEqual([
      { method: "GET", path: `/v13/deployments/${prior.deploymentId}?teamId=${orgId}` },
      { method: "DELETE", path: `/v13/deployments/${prior.deploymentId}?teamId=${orgId}` },
      { method: "GET", path: `/v13/deployments/${prior.deploymentId}?teamId=${orgId}` },
    ])
  })

  test.each(["pre-delete", "delete-time"])(
    "rejects %s 404 when its required follow-up says the deployment exists",
    async (phase) => {
      const prior = binding("dpl_FalseAbsence1", "false-absence")
      const { clock } = fakeClock()
      let exactRequests = 0
      let absent = 0
      await expect(
        cleanupNativeDeployments({
          apiClient: {
            request: async (method, path) => {
              if (path.startsWith("/v9/")) {
                return { body: { id: projectId, accountId: orgId }, status: 200 }
              }
              exactRequests += 1
              if (phase === "pre-delete") {
                return exactRequests === 1
                  ? { body: {}, status: 404 }
                  : { body: bodyFor(prior), status: 200 }
              }
              if (method === "DELETE") return { body: {}, status: 404 }
              return { body: bodyFor(prior), status: 200 }
            },
          },
          clock,
          manifest: [{ binding: prior, deploymentId: prior.deploymentId }],
          orgId,
          persistDeploymentAbsent: async () => {
            absent += 1
          },
          persistDeleteReceipt: async () => {},
          projectId,
          reconciliation: reconciliation(prior),
        }),
      ).rejects.toThrow(/404|absen|still exists|follow-up/)
      expect(absent).toBe(0)
    },
  )

  test("resumes a persisted delete, and polls an accepted delete every two seconds", async () => {
    for (const mode of ["persisted", "fresh"] as const) {
      const value = binding(mode === "persisted" ? "dpl_Persisted1" : "dpl_Fresh1", mode)
      const { clock, sleeps } = fakeClock()
      let exactReads = 0
      let deleteCalls = 0
      let persistedReceipts = 0
      await expect(
        cleanupNativeDeployments({
          apiClient: {
            request: async (method, path) => {
              if (path.startsWith("/v9/")) {
                return { body: { id: projectId, accountId: orgId }, status: 200 }
              }
              if (method === "DELETE") {
                deleteCalls += 1
                return { body: { uid: value.deploymentId, state: "DELETED" }, status: 200 }
              }
              exactReads += 1
              if (mode === "persisted") return { body: {}, status: 404 }
              return exactReads < 3
                ? { body: bodyFor(value), status: 200 }
                : { body: {}, status: 404 }
            },
          },
          clock,
          manifest: [
            {
              ...(mode === "persisted"
                ? { deleteReceipt: { state: "DELETED" as const, uid: value.deploymentId } }
                : { binding: value }),
              deploymentId: value.deploymentId,
            },
          ],
          orgId,
          persistDeploymentAbsent: async () => {},
          persistDeleteReceipt: async () => {
            persistedReceipts += 1
          },
          projectId,
          reconciliation: mode === "persisted" ? reconciliation() : reconciliation(value),
        }),
      ).resolves.toEqual({ deploymentAbsent: true, deploymentIds: [value.deploymentId] })
      expect(deleteCalls).toBe(mode === "persisted" ? 0 : 1)
      expect(persistedReceipts).toBe(mode === "persisted" ? 0 : 1)
      expect(sleeps.every((milliseconds) => milliseconds === 2_000)).toBe(true)
      if (mode === "fresh") expect(sleeps).toEqual([2_000])
    }
  })

  test.each([
    ["unauthorized", 401, { error: "unauthorized" }],
    ["forbidden", 403, { error: "forbidden" }],
    ["gone", 410, { error: "gone" }],
    ["rate limited", 429, { error: "rate_limited" }],
    ["wrong uid", 200, { uid: "dpl_Other", state: "DELETED" }],
    ["wrong state", 200, { uid: "dpl_Failure1", state: "READY" }],
  ])("rejects %s instead of claiming deletion", async (_label, status, body) => {
    const value = binding("dpl_Failure1", "failure")
    const { clock } = fakeClock()
    const absent: string[] = []
    await expect(
      cleanupNativeDeployments({
        apiClient: {
          request: async (method, path) => {
            if (path.startsWith("/v9/")) {
              return { body: { id: projectId, accountId: orgId }, status: 200 }
            }
            if (method === "GET") return { body: bodyFor(value), status: 200 }
            return { body, status }
          },
        },
        clock,
        manifest: [{ binding: value, deploymentId: value.deploymentId }],
        orgId,
        persistDeploymentAbsent: async (deploymentId) => {
          absent.push(deploymentId)
        },
        persistDeleteReceipt: async () => {},
        projectId,
        reconciliation: reconciliation(value),
      }),
    ).rejects.toThrow()
    expect(absent).toEqual([])
  })

  test.each([
    { id: "dpl_Other" },
    { url: "other.vercel.app" },
    { createdAt: 1_800_000_000_001 },
    { projectId: "prj_Other" },
    { ownerId: "team_Other" },
    { target: "production" },
    { meta: { dawnVercelRun: `vclrun_${"b".repeat(32)}` } },
  ])("blocks DELETE when the pre-delete binding mismatches: %j", async (override) => {
    const value = binding("dpl_Mismatch1", "mismatch")
    const { clock } = fakeClock()
    let deletes = 0
    await expect(
      cleanupNativeDeployments({
        apiClient: {
          request: async (method, path) => {
            if (path.startsWith("/v9/")) {
              return { body: { id: projectId, accountId: orgId }, status: 200 }
            }
            if (method === "DELETE") {
              deletes += 1
              return { body: { uid: value.deploymentId, state: "DELETED" }, status: 200 }
            }
            return { body: { ...bodyFor(value), ...override }, status: 200 }
          },
        },
        clock,
        manifest: [{ binding: value, deploymentId: value.deploymentId }],
        orgId,
        persistDeploymentAbsent: async () => {},
        persistDeleteReceipt: async () => {},
        projectId,
        reconciliation: reconciliation(value),
      }),
    ).rejects.toThrow()
    expect(deletes).toBe(0)
  })

  test("rejects contradictory persisted cleanup records before any request", async () => {
    const value = binding("dpl_Record1", "record")
    for (const record of [
      { binding: value, deploymentId: "dpl_Other" },
      {
        deleteReceipt: { state: "DELETED" as const, uid: "dpl_Other" },
        deploymentId: value.deploymentId,
      },
    ]) {
      let requests = 0
      const { clock } = fakeClock()
      await expect(
        cleanupNativeDeployments({
          apiClient: {
            request: async () => {
              requests += 1
              return { body: {}, status: 500 }
            },
          },
          clock,
          manifest: [record],
          orgId,
          persistDeploymentAbsent: async () => {},
          persistDeleteReceipt: async () => {},
          projectId,
          reconciliation: reconciliation(),
        }),
      ).rejects.toThrow(/mismatch|match/)
      expect(requests).toBe(0)
    }
  })

  test("continues exact-ID cleanup after an earlier failure and aggregates cardinality", async () => {
    const one = binding("dpl_Aggregate1", "aggregate-one")
    const two = binding("dpl_Aggregate2", "aggregate-two")
    const { clock } = fakeClock()
    const deletes: string[] = []
    const reads = new Map<string, number>()
    let caught: unknown
    try {
      await cleanupNativeDeployments({
        apiClient: {
          request: async (method, path) => {
            if (path.startsWith("/v9/")) {
              return { body: { id: projectId, accountId: orgId }, status: 200 }
            }
            const deploymentId = path.split("/deployments/")[1]?.split("?", 1)[0] as string
            const value = deploymentId === one.deploymentId ? one : two
            if (method === "DELETE") {
              deletes.push(deploymentId)
              return deploymentId === one.deploymentId
                ? { body: { error: "forbidden" }, status: 403 }
                : { body: { uid: deploymentId, state: "DELETED" }, status: 200 }
            }
            const count = reads.get(deploymentId) ?? 0
            reads.set(deploymentId, count + 1)
            return count === 0 ? { body: bodyFor(value), status: 200 } : { body: {}, status: 404 }
          },
        },
        clock,
        manifest: [
          { binding: one, deploymentId: one.deploymentId },
          { binding: two, deploymentId: two.deploymentId },
        ],
        orgId,
        persistDeploymentAbsent: async () => {},
        persistDeleteReceipt: async () => {},
        projectId,
        reconciliation: reconciliation(one, two),
      })
    } catch (error) {
      caught = error
    }
    expect(caught).toBeInstanceOf(AggregateError)
    expect((caught as AggregateError).errors).toHaveLength(2)
    expect(String(caught)).toMatch(/cleanup|cardinality/)
    expect(deletes).toEqual([one.deploymentId, two.deploymentId])
  })

  test("accepts genuine absence on the final exact 60-second boundary GET", async () => {
    const value = binding("dpl_Boundary1", "boundary")
    const { clock, sleeps } = fakeClock()
    let reads = 0
    await expect(
      cleanupNativeDeployments({
        apiClient: {
          request: async (method, path) => {
            if (path.startsWith("/v9/")) {
              return { body: { id: projectId, accountId: orgId }, status: 200 }
            }
            if (method === "DELETE") {
              return { body: { uid: value.deploymentId, state: "DELETED" }, status: 200 }
            }
            reads += 1
            return reads < 32 ? { body: bodyFor(value), status: 200 } : { body: {}, status: 404 }
          },
        },
        clock,
        manifest: [{ binding: value, deploymentId: value.deploymentId }],
        orgId,
        persistDeploymentAbsent: async () => {},
        persistDeleteReceipt: async () => {},
        projectId,
        reconciliation: reconciliation(value),
      }),
    ).resolves.toEqual({ deploymentAbsent: true, deploymentIds: [value.deploymentId] })
    expect(sleeps).toHaveLength(30)
    expect(reads).toBe(32)
  })

  test("rejects a 404 absence read that completes after the 60-second deadline", async () => {
    const value = binding("dpl_SlowAbsence1", "slow-absence")
    const delayed = fakeClock()
    let reads = 0
    await expect(
      cleanupNativeDeployments({
        apiClient: {
          request: async (method, path) => {
            if (path.startsWith("/v9/")) {
              return { body: { id: projectId, accountId: orgId }, status: 200 }
            }
            if (method === "DELETE") {
              return { body: { uid: value.deploymentId, state: "DELETED" }, status: 200 }
            }
            reads += 1
            if (reads === 1) return { body: bodyFor(value), status: 200 }
            delayed.jump(60_001)
            return { body: {}, status: 404 }
          },
        },
        clock: delayed.clock,
        manifest: [{ binding: value, deploymentId: value.deploymentId }],
        orgId,
        persistDeploymentAbsent: async () => {},
        persistDeleteReceipt: async () => {},
        projectId,
        reconciliation: reconciliation(value),
      }),
    ).rejects.toThrow(/60|deadline|timeout/)
  })

  test("never acts on an unvalidated manifest ID and times out exact-ID absence polling", async () => {
    const { clock } = fakeClock()
    let deploymentRequests = 0
    await expect(
      cleanupNativeDeployments({
        apiClient: {
          request: async (_method, path) => {
            if (path.startsWith("/v9/")) {
              return { body: { id: projectId, accountId: orgId }, status: 200 }
            }
            deploymentRequests += 1
            return { body: {}, status: 404 }
          },
        },
        clock,
        manifest: [{ deploymentId: "dpl_Unvalidated1" }],
        orgId,
        persistDeploymentAbsent: async () => {},
        persistDeleteReceipt: async () => {},
        projectId,
        reconciliation: reconciliation(),
      }),
    ).rejects.toThrow(/validated|authority/)
    expect(deploymentRequests).toBe(0)

    const value = binding("dpl_Timeout1", "timeout")
    const timeoutClock = fakeClock()
    await expect(
      cleanupNativeDeployments({
        apiClient: {
          request: async (method, path) => {
            if (path.startsWith("/v9/")) {
              return { body: { id: projectId, accountId: orgId }, status: 200 }
            }
            if (method === "DELETE") {
              return { body: { uid: value.deploymentId, state: "DELETED" }, status: 200 }
            }
            return { body: bodyFor(value), status: 200 }
          },
        },
        clock: timeoutClock.clock,
        manifest: [{ binding: value, deploymentId: value.deploymentId }],
        orgId,
        persistDeploymentAbsent: async () => {},
        persistDeleteReceipt: async () => {},
        projectId,
        reconciliation: reconciliation(value),
      }),
    ).rejects.toThrow(/60|deadline|timeout/)
    expect(timeoutClock.sleeps).toHaveLength(30)
  })
})

describe("causal SSE", () => {
  const encoder = new TextEncoder()

  function readerFor(chunks: readonly Uint8Array[]) {
    let index = 0
    return {
      read: async () =>
        index < chunks.length
          ? { done: false, value: chunks[index++] as Uint8Array }
          : { done: true },
    }
  }

  test("frames CRLF and split UTF-8, ignores heartbeats, joins data lines, and parses JSON", async () => {
    const source = [
      ": heartbeat\r\n\r\n",
      "event: chunk\r\n",
      "data: {\r\n",
      'data:   "text": "café"\r\n',
      "data: }\r\n\r\n",
      "event: done\n",
      'data: {"output":{"ok":true}}\n\n',
    ].join("")
    const bytes = encoder.encode(source)
    const chunks = Array.from(bytes, (byte) => Uint8Array.of(byte))
    const frames = createNativeSseFrameReader(readerFor(chunks))
    await expect(frames.nextMeaningfulFrame()).resolves.toEqual({
      data: { text: "café" },
      event: "chunk",
      index: 0,
    })
    await expect(frames.nextMeaningfulFrame()).resolves.toEqual({
      data: { output: { ok: true } },
      event: "done",
      index: 1,
    })
    await expect(frames.nextMeaningfulFrame()).resolves.toBeNull()
  })

  test("preserves one pending meaningful-frame promise across the full one-second race", async () => {
    vi.useFakeTimers()
    try {
      const pendingReads: Array<(result: { done: boolean; value?: Uint8Array }) => void> = []
      const frames = createNativeSseFrameReader({
        read: async () =>
          await new Promise((resolve) => {
            pendingReads.push(resolve)
          }),
      })
      const pendingFrame = frames.nextMeaningfulFrame()
      await Promise.resolve()
      expect(pendingReads).toHaveLength(1)
      pendingReads.shift()?.({
        done: false,
        value: encoder.encode(': ping\r\n\r\nevent: chunk\r\ndata: "after'),
      })
      for (let index = 0; index < 4; index += 1) await Promise.resolve()
      expect(pendingReads).toHaveLength(1)

      const race = Promise.race([
        pendingFrame.then(() => "frame" as const),
        new Promise<"timeout">((resolve) => setTimeout(() => resolve("timeout"), 1_000)),
      ])
      await vi.advanceTimersByTimeAsync(1_000)
      await expect(race).resolves.toBe("timeout")

      pendingReads.shift()?.({ done: false, value: encoder.encode('-release"\r\n\r\n') })
      await expect(pendingFrame).resolves.toEqual({
        data: "after-release",
        event: "chunk",
        index: 0,
      })
    } finally {
      vi.useRealTimers()
    }
  })

  test.each([
    ["after-release", { data: "after-release", event: "chunk", index: 0 }],
    ["done", { data: { output: {} }, event: "done", index: 0 }],
    ["EOF", null],
  ])("rejects %s before authorization", (_label, frame) => {
    expect(() => assertNativePreReleaseSseFrame(frame as never)).toThrow(/before|release|EOF|frame/)
  })

  test.each([
    ["wrong payload", { data: "other", event: "chunk", index: 0 }],
    ["wrong event", { data: "before-release", event: "done", index: 0 }],
    ["negative index", { data: "before-release", event: "chunk", index: -1 }],
    ["fractional index", { data: "before-release", event: "chunk", index: 0.5 }],
  ])("rejects a %s first public frame", (_label, frame) => {
    expect(() => assertNativePreReleaseSseFrame(frame as never)).toThrow()
  })

  test("requires exact public ordering and done data after authorization", () => {
    const barrierId = `b-vcl-${"a".repeat(32)}`
    const before = { data: "before-release", event: "chunk" as const, index: 2 }
    expect(assertNativePreReleaseSseFrame(before)).toEqual(before)
    expect(
      assertNativePostReleaseSseFrames({
        after: { data: "after-release", event: "chunk", index: 4 },
        barrierId,
        before,
        done: {
          data: { output: { barrierId, released: true } },
          event: "done",
          index: 5,
        },
        eof: null,
      }),
    ).toEqual({ afterFrameIndex: 4, doneFrameIndex: 5, eofAfterDone: true })

    for (const invalid of [
      {
        after: { data: "after-release", event: "chunk" as const, index: 2 },
        done: {
          data: { output: { barrierId, released: true } },
          event: "done" as const,
          index: 5,
        },
        eof: null,
      },
      {
        after: { data: "after-release", event: "chunk" as const, index: 4 },
        done: {
          data: { output: { barrierId, released: false } },
          event: "done" as const,
          index: 5,
        },
        eof: null,
      },
      {
        after: { data: "after-release", event: "chunk" as const, index: 4 },
        done: {
          data: { output: { barrierId, released: true } },
          event: "chunk" as const,
          index: 5,
        },
        eof: null,
      },
      {
        after: { data: "wrong", event: "chunk" as const, index: 4 },
        done: {
          data: { output: { barrierId, released: true } },
          event: "done" as const,
          index: 5,
        },
        eof: null,
      },
      {
        after: { data: "after-release", event: "done" as const, index: 4 },
        done: {
          data: { output: { barrierId, released: true } },
          event: "done" as const,
          index: 5,
        },
        eof: null,
      },
      {
        after: { data: "after-release", event: "chunk" as const, index: 4 },
        done: {
          data: { output: { barrierId, released: true } },
          event: "done" as const,
          index: 4,
        },
        eof: null,
      },
      {
        after: { data: "after-release", event: "chunk" as const, index: 4 },
        done: {
          data: { output: { barrierId, released: true } },
          event: "done" as const,
          index: 4.5,
        },
        eof: null,
      },
      {
        after: { data: "after-release", event: "chunk" as const, index: 4 },
        done: {
          data: { output: { barrierId, released: true } },
          event: "done" as const,
          index: 5,
        },
        eof: { data: "extra", event: "chunk" as const, index: 6 },
      },
      {
        after: { data: "after-release", event: "chunk" as const, index: -1 },
        done: {
          data: { output: { barrierId, released: true } },
          event: "done" as const,
          index: 5,
        },
        eof: null,
      },
      {
        after: { data: "after-release", event: "chunk" as const, index: 4 },
        done: {
          data: { output: { barrierId: `b-vcl-${"b".repeat(32)}`, released: true } },
          event: "done" as const,
          index: 5,
        },
        eof: null,
      },
      {
        after: { data: "after-release", event: "chunk" as const, index: 4 },
        done: {
          data: { output: { barrierId, released: true, extra: true } },
          event: "done" as const,
          index: 5,
        },
        eof: null,
      },
      {
        after: { data: "after-release", event: "chunk" as const, index: 4 },
        done: {
          data: { output: { barrierId, released: true }, extra: true },
          event: "done" as const,
          index: 5,
        },
        eof: null,
      },
    ]) {
      expect(() => assertNativePostReleaseSseFrames({ barrierId, before, ...invalid })).toThrow()
    }
  })

  test("rejects incomplete EOF, malformed JSON, and raw internal events", async () => {
    for (const source of [
      'event: chunk\ndata: "incomplete',
      "event: chunk\ndata: not-json\n\n",
      'event: on_chain_end\ndata: {"output":true}\n\n',
      'data: "missing-event"\n\n',
      'event: chunk\nevent: done\ndata: "duplicate"\n\n',
      "event: chunk\n\n",
      'unknown: field\nevent: chunk\ndata: "before-release"\n\n',
    ]) {
      const frames = createNativeSseFrameReader(readerFor([encoder.encode(source)]))
      await expect(frames.nextMeaningfulFrame()).rejects.toThrow(
        /SSE|JSON|internal|event|incomplete/,
      )
    }

    const invalidUtf8 = createNativeSseFrameReader(readerFor([Uint8Array.of(0xc3)]))
    await expect(invalidUtf8.nextMeaningfulFrame()).rejects.toThrow(/UTF|SSE|incomplete|decode/)
  })

  test("runs the identical persisted state, middleware, causal stream, later request, and log proof", async () => {
    const canonicalOrigin = "https://dawn-native-blackbox.vercel.app"
    const deploymentId = "dpl_BlackBox123"
    const orgId = "team_Test123"
    const projectId = "prj_Test456"
    const ids = {
      unknownThreadId: `t-vcl-${"1".repeat(32)}`,
      stateThreadId: `t-vcl-${"2".repeat(32)}`,
      releaseThreadId: `t-vcl-${"3".repeat(32)}`,
      streamThreadId: `t-vcl-${"4".repeat(32)}`,
      laterThreadId: `t-vcl-${"5".repeat(32)}`,
      targetBarrierId: `b-vcl-${"f".repeat(32)}`,
      sentinelBarrierId: `b-vcl-${"0".repeat(32)}`,
      stateMarkers: [`log-vcl-${"8".repeat(32)}`, `log-vcl-${"9".repeat(32)}`] as const,
      logMarker: `log-vcl-${"a".repeat(32)}`,
    }
    const releaseAuthorization = createNativeReleaseAuthorization()
    const expectedPrivateHeaders = new Headers()
    releaseAuthorization.apply(expectedPrivateHeaders)
    const expectedReleaseCredential = expectedPrivateHeaders.get("x-dawn-vercel-release") as string
    const events: string[] = []
    const requests: Array<{
      readonly body?: unknown
      readonly headers: Headers
      readonly method: string
      readonly redirect: string
      readonly timeoutMs: number
      readonly url: string
    }> = []
    const databaseRequests: Array<{
      readonly params: readonly unknown[]
      readonly sql: string
      readonly timeoutMs: number
    }> = []
    const deadlineCalls: Array<{ readonly label: string; readonly timeoutMs: number }> = []
    const functionalStages: Array<{ readonly evidence: unknown; readonly stage: string }> = []
    const runtimeSnapshots: string[] = []
    const sseEvidence: unknown[] = []
    let nowMs = 1_800_000_000_000
    let truncatedQuietSleep = false
    let truncatedQuietRemainder = false
    let stateTurn = 0
    let targetReleased = false
    let streamController: ReadableStreamDefaultController<Uint8Array> | undefined
    const response = (
      path: string,
      status: number,
      body: ReadableStream<Uint8Array> | string | null,
      headers: Record<string, string> = { "content-type": "application/json" },
    ): Response => {
      const value = new Response(body, { headers, status })
      Object.defineProperty(value, "url", { value: `${canonicalOrigin}${path}` })
      Object.defineProperty(value, "redirected", { value: false })
      return value
    }
    const jsonResponse = (path: string, status: number, body: unknown): Response =>
      response(path, status, JSON.stringify(body))
    const statusOnlyResponse = (path: string, status: number, body: unknown): Response =>
      response(
        path,
        status,
        new ReadableStream<Uint8Array>({
          cancel: () => {
            events.push(`cancel:${path}`)
          },
          start: (controller) => {
            controller.enqueue(encoder.encode(JSON.stringify(body)))
          },
        }),
      )

    const result = await runNativeVercelBlackBox({
      canonicalOrigin,
      clock: {
        now: () => nowMs,
        sleep: async (milliseconds) => {
          events.push(`sleep:${milliseconds}`)
          if (milliseconds === 1_000 && !truncatedQuietSleep) {
            truncatedQuietSleep = true
            nowMs += 999
          } else if (milliseconds === 1 && !truncatedQuietRemainder) {
            truncatedQuietRemainder = true
          } else {
            nowMs += milliseconds
          }
        },
      },
      database: {
        query: async (request) => {
          databaseRequests.push(request)
          events.push(`sql:${request.sql.split("\n", 1)[0]}`)
          if (request.sql.includes("CREATE TABLE IF NOT EXISTS")) return { rows: [] }
          if (request.sql.includes("INSERT INTO public.dawn_vercel_test_barriers")) {
            expect(request.params).toEqual([ids.targetBarrierId, ids.sentinelBarrierId])
            return { rows: [] }
          }
          if (request.sql.includes("FROM public.dawn_checkpoints")) {
            expect(request.params).toEqual([ids.stateThreadId])
            return { rows: [{ checkpoint_count: 1 }] }
          }
          if (request.sql.includes("FROM public.dawn_vercel_test_barriers")) {
            return {
              rows: [
                { barrier_id: ids.sentinelBarrierId, released: false },
                { barrier_id: ids.targetBarrierId, released: targetReleased },
              ],
            }
          }
          throw new Error("unexpected native black-box SQL")
        },
      },
      deploymentId,
      ids,
      logBoundary: {
        logs: async ({ deploymentId: requestedDeploymentId, queryEndIso, queryStartIso }) => {
          events.push(`logs:${queryStartIso}:${queryEndIso}`)
          expect(requestedDeploymentId).toBe(deploymentId)
          return `${JSON.stringify({
            id: "request-log-anchor",
            deploymentId,
            projectId,
            responseStatusCode: 200,
            level: "info",
            message: `dawn-vercel-fixture-log ${ids.logMarker}`,
            logs: [{ level: "info", message: `dawn-vercel-fixture-log ${ids.logMarker}` }],
          })}\n`
        },
      },
      orgId,
      persistBarrier: async ({ barrierId, role }) => {
        events.push(`persist-barrier:${role}:${barrierId}`)
      },
      persistDispatch: async (dispatch) => {
        events.push(`persist-dispatch:${dispatch}`)
      },
      persistRuntimeLogSnapshot: async (stdout) => {
        runtimeSnapshots.push(stdout)
      },
      persistStage: async (stage, evidence) => {
        functionalStages.push({ evidence, stage })
        events.push(`persist-stage:${stage}`)
      },
      persistSseEvidence: async (evidence) => {
        sseEvidence.push(evidence)
      },
      persistThread: async (threadId) => {
        events.push(`persist-thread:${threadId}`)
      },
      projectId,
      releaseAuthorization,
      request: async (request) => {
        requests.push(request)
        const path = new URL(request.url).pathname
        events.push(`http:${request.method}:${path}`)
        nowMs += 25
        const body = request.body as Record<string, unknown> | undefined
        if (path === `/threads/${ids.unknownThreadId}/runs/wait`) {
          expect(body).toEqual({ input: {}, route: "/unknown#agent" })
          return statusOnlyResponse(path, 404, { error: "unknown route" })
        }
        if (path === `/threads/${ids.stateThreadId}/runs/wait`) {
          stateTurn += 1
          expect(body).toEqual(
            nativeAgentRunBody("/state#agent", ids.stateMarkers[stateTurn - 1] as string),
          )
          return jsonResponse(path, 200, {
            visits: stateTurn,
            markers: ids.stateMarkers.slice(0, stateTurn),
          })
        }
        if (path === `/threads/${ids.stateThreadId}/state`) {
          expect(request.method).toBe("GET")
          return jsonResponse(path, 200, {
            values: { visits: 2, markers: [...ids.stateMarkers] },
          })
        }
        if (path === `/threads/${ids.releaseThreadId}/runs/wait`) {
          expect(body).toEqual({
            input: { barrierId: ids.targetBarrierId },
            route: "/release#graph",
          })
          const releaseHeader = request.headers.get("x-dawn-vercel-release")
          if (releaseHeader === null || releaseHeader === "incorrect-release-credential") {
            return statusOnlyResponse(path, 401, { error: "unauthorized" })
          }
          expect(releaseHeader).toBe(expectedReleaseCredential)
          targetReleased = true
          streamController?.enqueue(
            encoder.encode(
              `: ping\r\n\r\nevent: chunk\r\ndata: "after-release"\r\n\r\nevent: done\r\ndata: {"output":{"barrierId":"${ids.targetBarrierId}","released":true}}\r\n\r\n`,
            ),
          )
          streamController?.close()
          return jsonResponse(path, 200, { barrierId: ids.targetBarrierId, released: true })
        }
        if (path === `/threads/${ids.streamThreadId}/runs/stream`) {
          expect(body).toEqual(nativeAgentRunBody("/stream#agent", ids.targetBarrierId))
          const stream = new ReadableStream<Uint8Array>({
            start(controller) {
              streamController = controller
              controller.enqueue(
                encoder.encode(': ping\r\n\r\nevent: chunk\r\ndata: "before-release"\r\n\r\n'),
              )
            },
          })
          return response(path, 200, stream, {
            "content-type": "text/event-stream; charset=utf-8",
          })
        }
        if (path === `/threads/${ids.laterThreadId}/runs/wait`) {
          expect(body).toEqual(nativeAgentRunBody("/state#agent", ids.logMarker))
          return jsonResponse(path, 200, { visits: 1, markers: [ids.logMarker] })
        }
        throw new Error(`unexpected native black-box path ${path}`)
      },
      withTimeout: async (label, timeoutMs, operation) => {
        deadlineCalls.push({ label, timeoutMs })
        return await operation
      },
    })

    expect(result).toEqual({
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
        preReleaseQuietMs: 1_000,
        authorizedReleaseAfterBeforeFrame: true,
        afterFrameIndex: 1,
        doneFrameIndex: 2,
        eofAfterDone: true,
      },
      laterRequest: { succeeded: true, logMarkerSeen: true },
      logs: {
        pollIntervalMs: 2_000,
        quietIntervalMs: 30_000,
        queryStartIso: new Date(1_800_000_000_000).toISOString(),
        queryEndIso: new Date(nowMs).toISOString(),
        uniqueRowVersions: 1,
        exactDeploymentOnly: true,
        noTruncation: true,
        noErrors: true,
      },
    })
    expect(runtimeSnapshots.length).toBeGreaterThan(0)
    expect(runtimeSnapshots.at(-1)).toContain(ids.logMarker)
    expect(sseEvidence).toHaveLength(4)
    expect(sseEvidence[0]).toEqual({
      before: expect.objectContaining({ event: "chunk" }),
    })
    expect(sseEvidence.at(-1)).toEqual(
      expect.objectContaining({
        after: expect.objectContaining({ event: "chunk" }),
        before: expect.objectContaining({ event: "chunk" }),
        done: expect.objectContaining({ event: "done" }),
        eof: true,
      }),
    )
    expect(events.filter((event) => event.startsWith("cancel:/threads/"))).toEqual([
      `cancel:/threads/${ids.unknownThreadId}/runs/wait`,
      `cancel:/threads/${ids.releaseThreadId}/runs/wait`,
      `cancel:/threads/${ids.releaseThreadId}/runs/wait`,
    ])
    expect(functionalStages).toEqual([
      { evidence: result.state, stage: "state" },
      { evidence: result.routes, stage: "routes" },
      { evidence: result.stream, stage: "stream" },
      { evidence: result.logs, stage: "logs" },
    ])
    expect(requests.every((request) => request.redirect === "manual")).toBe(true)
    expect(
      requests.every((request) => Number.isFinite(request.timeoutMs) && request.timeoutMs > 0),
    ).toBe(true)
    expect(
      requests
        .filter(({ method }) => method === "POST")
        .every(({ headers }) => headers.get("content-type") === "application/json"),
    ).toBe(true)
    expect(
      requests
        .find(({ url }) => url.endsWith(`/threads/${ids.streamThreadId}/runs/stream`))
        ?.headers.get("accept"),
    ).toBe("text/event-stream")
    expect(
      requests
        .filter(({ url }) => !url.endsWith(`/threads/${ids.releaseThreadId}/runs/wait`))
        .every(({ headers }) => headers.get("x-dawn-vercel-release") === null),
    ).toBe(true)
    expect(
      requests
        .filter(({ url }) => url.endsWith(`/threads/${ids.releaseThreadId}/runs/wait`))
        .map(({ headers }) => headers.get("x-dawn-vercel-release")),
    ).toEqual([null, "incorrect-release-credential", expectedReleaseCredential])
    expect(
      databaseRequests.every(({ timeoutMs }) => Number.isFinite(timeoutMs) && timeoutMs > 0),
    ).toBe(true)
    expect(deadlineCalls.length).toBeGreaterThanOrEqual(3)
    expect(
      deadlineCalls.every(({ timeoutMs }) => Number.isFinite(timeoutMs) && timeoutMs > 0),
    ).toBe(true)
    expect(events.indexOf(`persist-thread:${ids.unknownThreadId}`)).toBeLessThan(
      events.indexOf(`http:POST:/threads/${ids.unknownThreadId}/runs/wait`),
    )
    expect(events.indexOf(`persist-thread:${ids.stateThreadId}`)).toBeLessThan(
      events.indexOf(`http:POST:/threads/${ids.stateThreadId}/runs/wait`),
    )
    expect(events.indexOf(`persist-thread:${ids.releaseThreadId}`)).toBeLessThan(
      events.indexOf(`http:POST:/threads/${ids.releaseThreadId}/runs/wait`),
    )
    expect(events.indexOf(`persist-thread:${ids.streamThreadId}`)).toBeLessThan(
      events.indexOf(`http:POST:/threads/${ids.streamThreadId}/runs/stream`),
    )
    expect(events.indexOf(`persist-barrier:target:${ids.targetBarrierId}`)).toBeLessThan(
      events.indexOf("sql:CREATE TABLE IF NOT EXISTS public.dawn_vercel_test_barriers ("),
    )
    expect(events.indexOf(`persist-barrier:sentinel:${ids.sentinelBarrierId}`)).toBeLessThan(
      events.indexOf("sql:CREATE TABLE IF NOT EXISTS public.dawn_vercel_test_barriers ("),
    )
    expect(events.indexOf("persist-dispatch:state")).toBeGreaterThan(
      events.indexOf("sql:SELECT COUNT(*)::integer AS checkpoint_count"),
    )
    expect(events.indexOf("persist-dispatch:release")).toBeLessThan(
      events.indexOf("persist-dispatch:stream"),
    )
    expect(events.indexOf("persist-dispatch:stream")).toBeLessThan(
      events.indexOf(`persist-thread:${ids.laterThreadId}`),
    )
    expect(events.findIndex((entry) => entry.startsWith("logs:"))).toBeGreaterThan(
      events.indexOf(`http:POST:/threads/${ids.laterThreadId}/runs/wait`),
    )
    expect(events.filter((entry) => entry === "sleep:1000")).toHaveLength(1)
    expect(events.filter((entry) => entry === "sleep:1")).toHaveLength(2)
    expect(events.indexOf(`http:POST:/threads/${ids.releaseThreadId}/runs/wait`)).toBeLessThan(
      events.indexOf("sleep:1000"),
    )
    expect(
      events.lastIndexOf(`http:POST:/threads/${ids.releaseThreadId}/runs/wait`),
    ).toBeGreaterThan(events.indexOf("sleep:1000"))
    expect(new Set(databaseRequests.map(({ sql }) => sql))).toEqual(
      new Set([
        [
          "SELECT COUNT(*)::integer AS checkpoint_count",
          "FROM public.dawn_checkpoints",
          "WHERE thread_id = $1",
        ].join("\n"),
        [
          "INSERT INTO public.dawn_vercel_test_barriers (barrier_id, released)",
          "VALUES ($1, false), ($2, false)",
        ].join("\n"),
        [
          "CREATE TABLE IF NOT EXISTS public.dawn_vercel_test_barriers (",
          "  barrier_id text PRIMARY KEY,",
          "  released boolean NOT NULL DEFAULT false",
          ")",
        ].join("\n"),
        [
          "SELECT barrier_id, released",
          "FROM public.dawn_vercel_test_barriers",
          "WHERE barrier_id = ANY($1::text[])",
          "ORDER BY barrier_id",
        ].join("\n"),
      ]),
    )
    const barrierSelectSql = [
      "SELECT barrier_id, released",
      "FROM public.dawn_vercel_test_barriers",
      "WHERE barrier_id = ANY($1::text[])",
      "ORDER BY barrier_id",
    ].join("\n")
    expect(databaseRequests.filter(({ sql }) => sql === barrierSelectSql)).toHaveLength(4)
    const serializedNonHeaderEvidence = JSON.stringify({
      bodies: requests.map(({ body }) => body),
      databaseRequests,
      deadlineCalls,
      events,
      result,
      urls: requests.map(({ url }) => url),
    })
    expect(serializedNonHeaderEvidence).not.toContain(expectedReleaseCredential)
  })

  test.each([
    "malformed ID",
    "duplicate ID",
    "thread persistence",
    "barrier persistence",
    "dispatch persistence",
    "release dispatch persistence",
    "unknown status",
    "state status",
    "state redirect",
    "state JSON",
    "response JSON secret",
    "response header secret",
    "state turn",
    "state marker",
    "state GET",
    "physical checkpoint",
    "checkpoint missing row",
    "checkpoint string",
    "checkpoint fractional",
    "checkpoint duplicate rows",
    "unauthorized status",
    "unauthorized mutation",
    "barrier missing row",
    "barrier duplicate row",
    "barrier extra row",
    "barrier nonboolean",
    "stream status",
    "stream redirect",
    "stream origin",
    "stream MIME",
    "stream body",
    "quiet clock",
    "early post-release frame",
    "early done frame",
    "early EOF",
    "SSE secret",
    "authorized response",
    "authorized JSON",
    "authorized SQL state",
    "transport secret",
    "later request",
    "later JSON",
    "log secret",
  ] as const)("fails closed on %s without advancing later evidence", async (fault) => {
    const canonicalOrigin = "https://dawn-native-blackbox.vercel.app"
    const deploymentId = "dpl_BlackBox123"
    const projectId = "prj_Test456"
    const validIds = {
      unknownThreadId: `t-vcl-${"1".repeat(32)}`,
      stateThreadId: `t-vcl-${"2".repeat(32)}`,
      releaseThreadId: `t-vcl-${"3".repeat(32)}`,
      streamThreadId: `t-vcl-${"4".repeat(32)}`,
      laterThreadId: `t-vcl-${"5".repeat(32)}`,
      targetBarrierId: `b-vcl-${"6".repeat(32)}`,
      sentinelBarrierId: `b-vcl-${"7".repeat(32)}`,
      stateMarkers: [`log-vcl-${"8".repeat(32)}`, `log-vcl-${"9".repeat(32)}`] as const,
      logMarker: `log-vcl-${"a".repeat(32)}`,
    }
    const ids = {
      ...validIds,
      ...(fault === "malformed ID" ? { unknownThreadId: "../unsafe" } : {}),
      ...(fault === "duplicate ID" ? { releaseThreadId: validIds.stateThreadId } : {}),
    }
    let nowMs = 1_800_000_000_000
    let requestCount = 0
    let databaseCount = 0
    let quietSleepCalls = 0
    const databaseSql: string[] = []
    let dispatchCount = 0
    let stateTurn = 0
    let barrierReadCount = 0
    let targetReleased = false
    let streamReaderAcquisitions = 0
    let streamReaderCancelCalls = 0
    let streamReadsInFlight = 0
    let streamMaxReadsInFlight = 0
    const cancelledResponsePaths: string[] = []
    let streamController: ReadableStreamDefaultController<Uint8Array> | undefined
    const releaseAuthorization = createNativeReleaseAuthorization()
    const expectedPrivateHeaders = new Headers()
    releaseAuthorization.apply(expectedPrivateHeaders)
    const expectedReleaseCredential = expectedPrivateHeaders.get("x-dawn-vercel-release") as string
    const makeResponse = (
      path: string,
      status: number,
      body: ReadableStream<Uint8Array> | string | null,
      headers: Record<string, string> = { "content-type": "application/json" },
      responseOrigin = canonicalOrigin,
      redirected = false,
      trackCancellation = false,
    ): Response => {
      const trackedBody =
        trackCancellation && typeof body === "string"
          ? new ReadableStream<Uint8Array>({
              cancel: () => {
                cancelledResponsePaths.push(path)
              },
              start: (controller) => {
                controller.enqueue(encoder.encode(body))
              },
            })
          : body
      const value = new Response(trackedBody, { headers, status })
      Object.defineProperty(value, "url", { value: `${responseOrigin}${path}` })
      Object.defineProperty(value, "redirected", { value: redirected })
      return value
    }
    const makeJson = (
      path: string,
      status: number,
      body: unknown,
      trackCancellation = false,
    ): Response =>
      makeResponse(
        path,
        status,
        JSON.stringify(body),
        undefined,
        undefined,
        undefined,
        trackCancellation,
      )

    const operation = runNativeVercelBlackBox({
      canonicalOrigin,
      clock: {
        now: () => nowMs,
        sleep: async (milliseconds) => {
          quietSleepCalls += 1
          if (fault !== "quiet clock") nowMs += milliseconds
        },
      },
      database: {
        query: async ({ params, sql }) => {
          databaseCount += 1
          databaseSql.push(sql)
          if (
            sql ===
            [
              "CREATE TABLE IF NOT EXISTS public.dawn_vercel_test_barriers (",
              "  barrier_id text PRIMARY KEY,",
              "  released boolean NOT NULL DEFAULT false",
              ")",
            ].join("\n")
          ) {
            return { rows: [] }
          }
          if (
            sql ===
            [
              "SELECT COUNT(*)::integer AS checkpoint_count",
              "FROM public.dawn_checkpoints",
              "WHERE thread_id = $1",
            ].join("\n")
          ) {
            expect(params).toEqual([validIds.stateThreadId])
            if (fault === "checkpoint missing row") return { rows: [] }
            if (fault === "checkpoint duplicate rows") {
              return { rows: [{ checkpoint_count: 1 }, { checkpoint_count: 1 }] }
            }
            return {
              rows: [
                {
                  checkpoint_count:
                    fault === "physical checkpoint"
                      ? 0
                      : fault === "checkpoint string"
                        ? "1"
                        : fault === "checkpoint fractional"
                          ? 1.5
                          : 1,
                },
              ],
            }
          }
          if (
            sql ===
            [
              "INSERT INTO public.dawn_vercel_test_barriers (barrier_id, released)",
              "VALUES ($1, false), ($2, false)",
            ].join("\n")
          ) {
            expect(params).toEqual([validIds.targetBarrierId, validIds.sentinelBarrierId])
            return { rows: [] }
          }
          if (
            sql ===
            [
              "SELECT barrier_id, released",
              "FROM public.dawn_vercel_test_barriers",
              "WHERE barrier_id = ANY($1::text[])",
              "ORDER BY barrier_id",
            ].join("\n")
          ) {
            barrierReadCount += 1
            expect(params).toEqual([[validIds.targetBarrierId, validIds.sentinelBarrierId]])
            if (fault === "barrier missing row") {
              return { rows: [{ barrier_id: validIds.targetBarrierId, released: false }] }
            }
            if (fault === "barrier duplicate row") {
              return {
                rows: [
                  { barrier_id: validIds.targetBarrierId, released: false },
                  { barrier_id: validIds.targetBarrierId, released: false },
                ],
              }
            }
            if (fault === "barrier extra row") {
              return {
                rows: [
                  { barrier_id: validIds.targetBarrierId, released: false },
                  { barrier_id: validIds.sentinelBarrierId, released: false },
                  { barrier_id: `b-vcl-${"b".repeat(32)}`, released: false },
                ],
              }
            }
            const unauthorizedMutation = fault === "unauthorized mutation" && barrierReadCount === 1
            return {
              rows: [
                {
                  barrier_id: validIds.targetBarrierId,
                  released:
                    fault === "barrier nonboolean"
                      ? "false"
                      : fault === "authorized SQL state" && targetReleased
                        ? false
                        : targetReleased || unauthorizedMutation,
                },
                {
                  barrier_id: validIds.sentinelBarrierId,
                  released: fault === "authorized SQL state" && targetReleased,
                },
              ],
            }
          }
          throw new Error("unexpected black-box SQL")
        },
      },
      deploymentId,
      ids,
      logBoundary: {
        logs: async () =>
          `${JSON.stringify({
            id: "request-log-anchor",
            deploymentId,
            projectId,
            responseStatusCode: 200,
            level: "info",
            message: `dawn-vercel-fixture-log ${validIds.logMarker}`,
            ...(fault === "log secret" ? { echoed: expectedReleaseCredential } : {}),
            logs: [{ level: "info", message: `dawn-vercel-fixture-log ${validIds.logMarker}` }],
          })}\n`,
      },
      orgId: "team_Test123",
      persistBarrier: async () => {
        if (fault === "barrier persistence") throw new Error("barrier persist failed")
      },
      persistDispatch: async (dispatch) => {
        dispatchCount += 1
        if (fault === "dispatch persistence") throw new Error("dispatch persist failed")
        if (fault === "release dispatch persistence" && dispatch === "release") {
          throw new Error("release dispatch persist failed")
        }
      },
      persistThread: async () => {
        if (fault === "thread persistence") throw new Error("persist failed")
      },
      projectId,
      releaseAuthorization,
      request: (request) => {
        if (
          fault === "transport secret" &&
          request.headers.get("x-dawn-vercel-release") === expectedReleaseCredential
        ) {
          throw new Error(expectedReleaseCredential)
        }
        requestCount += 1
        const path = new URL(request.url).pathname
        const body = request.body as Record<string, unknown> | undefined
        if (path === `/threads/${validIds.unknownThreadId}/runs/wait`) {
          return makeJson(
            path,
            fault === "unknown status" ? 200 : 404,
            fault === "unknown status" ? { ok: true } : { error: "unknown" },
            fault === "unknown status",
          )
        }
        if (path === `/threads/${validIds.stateThreadId}/runs/wait`) {
          stateTurn += 1
          const markers = validIds.stateMarkers.slice(0, stateTurn)
          if (fault === "state JSON" && stateTurn === 1) {
            return makeResponse(path, 200, "{not-json")
          }
          return makeResponse(
            path,
            fault === "state status" && stateTurn === 1 ? 201 : 200,
            JSON.stringify({
              visits: fault === "state turn" && stateTurn === 1 ? 2 : stateTurn,
              markers:
                fault === "state marker" && stateTurn === 1 ? [validIds.stateMarkers[1]] : markers,
              ...(fault === "response JSON secret" && stateTurn === 1
                ? { echoed: expectedReleaseCredential }
                : {}),
            }),
            {
              "content-type": "application/json",
              ...(fault === "response header secret" && stateTurn === 1
                ? { "x-echo": expectedReleaseCredential }
                : {}),
            },
            canonicalOrigin,
            fault === "state redirect" && stateTurn === 1,
            stateTurn === 1 &&
              (fault === "state status" ||
                fault === "state redirect" ||
                fault === "response header secret"),
          )
        }
        if (path === `/threads/${validIds.stateThreadId}/state`) {
          return makeJson(path, 200, {
            values: {
              visits: fault === "state GET" ? 1 : 2,
              markers: [...validIds.stateMarkers],
            },
          })
        }
        if (path === `/threads/${validIds.releaseThreadId}/runs/wait`) {
          const releaseHeader = request.headers.get("x-dawn-vercel-release")
          if (releaseHeader === null || releaseHeader === "incorrect-release-credential") {
            return makeJson(
              path,
              fault === "unauthorized status" ? 200 : 401,
              {
                error: "unauthorized",
              },
              fault === "unauthorized status",
            )
          }
          expect(releaseHeader).toBe(expectedReleaseCredential)
          targetReleased = true
          streamController?.enqueue(
            encoder.encode(
              `event: chunk\ndata: "after-release"\n\nevent: done\ndata: {"output":{"barrierId":"${validIds.targetBarrierId}","released":true}}\n\n`,
            ),
          )
          if (fault !== "release dispatch persistence") streamController?.close()
          if (fault === "authorized JSON") return makeResponse(path, 200, "{not-json")
          return makeJson(
            path,
            200,
            fault === "authorized response"
              ? { barrierId: validIds.sentinelBarrierId, released: true }
              : { barrierId: validIds.targetBarrierId, released: true },
          )
        }
        if (path === `/threads/${validIds.streamThreadId}/runs/stream`) {
          if (fault === "stream body") {
            return makeResponse(path, 200, null, { "content-type": "text/event-stream" })
          }
          const stream = new ReadableStream<Uint8Array>({
            cancel: () => {
              cancelledResponsePaths.push(path)
            },
            start(controller) {
              streamController = controller
              if (fault === "SSE secret") {
                const splitAt = Math.floor(expectedReleaseCredential.length / 2)
                controller.enqueue(
                  encoder.encode(`: ${expectedReleaseCredential.slice(0, splitAt)}`),
                )
                controller.enqueue(
                  encoder.encode(`${expectedReleaseCredential.slice(splitAt)}\n\n`),
                )
              }
              controller.enqueue(encoder.encode('event: chunk\ndata: "before-release"\n\n'))
              if (fault === "early post-release frame") {
                controller.enqueue(encoder.encode('event: chunk\ndata: "after-release"\n\n'))
              }
              if (fault === "early done frame") {
                controller.enqueue(
                  encoder.encode(
                    `event: done\ndata: {"output":{"barrierId":"${validIds.targetBarrierId}","released":true}}\n\n`,
                  ),
                )
              }
              if (fault === "early EOF") controller.close()
            },
          })
          const getReader = stream.getReader.bind(stream)
          Object.defineProperty(stream, "getReader", {
            value: () => {
              streamReaderAcquisitions += 1
              const reader = getReader()
              return new Proxy(reader, {
                get(target, property) {
                  if (property === "cancel") {
                    return async (reason?: unknown) => {
                      streamReaderCancelCalls += 1
                      return await target.cancel(reason)
                    }
                  }
                  if (property === "read") {
                    return async () => {
                      streamReadsInFlight += 1
                      streamMaxReadsInFlight = Math.max(streamMaxReadsInFlight, streamReadsInFlight)
                      try {
                        return await target.read()
                      } finally {
                        streamReadsInFlight -= 1
                      }
                    }
                  }
                  const value = Reflect.get(target, property, target)
                  return typeof value === "function" ? value.bind(target) : value
                },
              })
            },
          })
          return makeResponse(
            path,
            fault === "stream status" ? 201 : 200,
            stream,
            {
              "content-type": fault === "stream MIME" ? "application/json" : "text/event-stream",
            },
            fault === "stream origin" ? "https://attacker.invalid" : canonicalOrigin,
            fault === "stream redirect",
          )
        }
        if (path === `/threads/${validIds.laterThreadId}/runs/wait`) {
          if (fault === "later JSON") return makeResponse(path, 200, "{not-json")
          return makeJson(
            path,
            fault === "later request" ? 500 : 200,
            fault === "later request"
              ? { error: "failed" }
              : { visits: 1, markers: [validIds.logMarker] },
            fault === "later request",
          )
        }
        throw new Error(`unexpected black-box path ${path}: ${JSON.stringify(body)}`)
      },
      withTimeout: async (_label, _timeoutMs, pending) => await pending,
    })

    const failure = await operation.then(
      () => undefined,
      (error: unknown) => error,
    )
    expect(failure).toBeInstanceOf(Error)
    expect((failure as Error).message).toMatch(
      /native|black-box|persist|state|route|stream|release|barrier|checkpoint|later|thread ID/i,
    )
    expect((failure as Error).message).not.toContain(expectedReleaseCredential)
    if (fault === "malformed ID" || fault === "duplicate ID" || fault === "thread persistence") {
      expect(requestCount).toBe(0)
      expect(databaseCount).toBe(0)
      expect(dispatchCount).toBe(0)
    }
    if (fault === "barrier persistence") {
      expect(databaseSql).not.toContain(
        [
          "CREATE TABLE IF NOT EXISTS public.dawn_vercel_test_barriers (",
          "  barrier_id text PRIMARY KEY,",
          "  released boolean NOT NULL DEFAULT false",
          ")",
        ].join("\n"),
      )
      expect(databaseSql).not.toContain(
        [
          "INSERT INTO public.dawn_vercel_test_barriers (barrier_id, released)",
          "VALUES ($1, false), ($2, false)",
        ].join("\n"),
      )
    }
    if (fault === "dispatch persistence") {
      expect(requestCount).toBe(1)
      expect(databaseCount).toBe(0)
    }
    if (
      fault === "stream status" ||
      fault === "stream redirect" ||
      fault === "stream origin" ||
      fault === "stream MIME" ||
      fault === "stream body"
    ) {
      expect(streamReaderAcquisitions).toBe(0)
    }
    if (
      fault === "unknown status" ||
      fault === "state status" ||
      fault === "state redirect" ||
      fault === "response header secret" ||
      fault === "unauthorized status" ||
      fault === "stream status" ||
      fault === "stream redirect" ||
      fault === "stream origin" ||
      fault === "stream MIME" ||
      fault === "later request"
    ) {
      expect(cancelledResponsePaths.length).toBeGreaterThan(0)
    }
    if (
      fault === "early post-release frame" ||
      fault === "early done frame" ||
      fault === "SSE secret" ||
      fault === "quiet clock" ||
      fault === "release dispatch persistence"
    ) {
      expect(streamReaderCancelCalls).toBeGreaterThan(0)
    }
    if (fault === "release dispatch persistence") {
      expect(streamReaderAcquisitions).toBe(1)
      expect(streamMaxReadsInFlight).toBe(1)
      expect(cancelledResponsePaths).toContain(`/threads/${validIds.streamThreadId}/runs/stream`)
    }
    if (fault === "quiet clock") expect(quietSleepCalls).toBe(9)
  })
})

describe("runtime log scan", () => {
  const deploymentId = "dpl_LogScan1"
  const projectId = "prj_Test456"
  const logMarker = `log-vcl-${"a".repeat(32)}`

  function validLogRow(overrides: Readonly<Record<string, unknown>> = {}) {
    return {
      id: "request-1",
      deploymentId,
      projectId,
      responseStatusCode: 200,
      level: "info",
      message: "request completed",
      messageTruncated: false,
      logs: [
        {
          level: "info",
          message: `dawn-vercel-fixture-log ${logMarker}`,
          messageTruncated: false,
          context: { sequence: 1 },
        },
      ],
      timestamp: 1_800_000_000_000,
      ...overrides,
    }
  }

  function scan(rows: readonly unknown[]) {
    return scanNativeVercelLogJsonl({
      deploymentId,
      logMarker,
      projectId,
      stdout: rows.map((row) => JSON.stringify(row)).join("\n"),
    })
  }

  test("fingerprints complete repeated rows and rescans changed nested content", () => {
    const first = scan([validLogRow()])
    const unchanged = scan([validLogRow()])
    const changed = scan([
      validLogRow({
        logs: [
          {
            level: "info",
            message: `dawn-vercel-fixture-log ${logMarker}`,
            messageTruncated: false,
            context: { sequence: 2 },
          },
        ],
      }),
    ])
    expect(first.markerOccurrences).toBe(1)
    expect(first.versions).toHaveLength(1)
    expect(first.versions[0]).toMatchObject({
      fingerprint: expect.stringMatching(/^[a-f0-9]{64}$/),
      id: "request-1",
      markerOccurrences: 1,
    })
    expect(unchanged.versions[0]?.fingerprint).toBe(first.versions[0]?.fingerprint)
    expect(changed.versions[0]?.fingerprint).not.toBe(first.versions[0]?.fingerprint)

    const reordered = scan([
      {
        timestamp: 1_800_000_000_000,
        logs: [
          {
            context: { sequence: 1 },
            messageTruncated: false,
            message: `dawn-vercel-fixture-log ${logMarker}`,
            level: "info",
          },
        ],
        messageTruncated: false,
        message: "request completed",
        level: "info",
        responseStatusCode: 200,
        projectId,
        deploymentId,
        id: "request-1",
      },
    ])
    expect(reordered.versions[0]?.fingerprint).toBe(first.versions[0]?.fingerprint)

    const duplicateAndChanged = scan([
      validLogRow(),
      validLogRow(),
      validLogRow({ message: "request completed again" }),
    ])
    expect(duplicateAndChanged.versions).toHaveLength(2)
    expect(new Set(duplicateAndChanged.versions.map(({ fingerprint }) => fingerprint)).size).toBe(2)
  })

  test("accepts empty eventual-consistency polls, omitted truncation flags, and trailing newline", () => {
    expect(scanNativeVercelLogJsonl({ deploymentId, logMarker, projectId, stdout: "" })).toEqual({
      markerOccurrences: 0,
      versions: [],
    })
    const row = validLogRow({
      logs: [{ level: "info", message: `dawn-vercel-fixture-log ${logMarker}` }],
      messageTruncated: undefined,
    })
    delete (row as { messageTruncated?: unknown }).messageTruncated
    expect(
      scanNativeVercelLogJsonl({
        deploymentId,
        logMarker,
        projectId,
        stdout: `${JSON.stringify(row)}\n`,
      }),
    ).toMatchObject({ markerOccurrences: 1, versions: [{ id: "request-1" }] })

    const projectedMessage = `dawn-vercel-fixture-log ${logMarker}`
    expect(
      scan([
        validLogRow({
          message: projectedMessage,
          logs: [{ level: "info", message: projectedMessage }],
        }),
      ]),
    ).toMatchObject({
      markerOccurrences: 1,
      versions: [{ markerOccurrences: 1 }],
    })
    expect(
      scan([
        validLogRow({
          message: projectedMessage,
          logs: [
            { level: "info", message: projectedMessage, sequence: 1 },
            { level: "info", message: projectedMessage, sequence: 2 },
          ],
        }),
      ]),
    ).toMatchObject({ markerOccurrences: 2, versions: [{ markerOccurrences: 2 }] })

    expect(
      scan([
        validLogRow({
          responseStatusCode: 0,
        }),
      ]),
    ).toMatchObject({ markerOccurrences: 1, versions: [{ id: "request-1" }] })
  })

  test.each([
    ["empty request ID", { id: "" }],
    ["missing request ID", { id: undefined }],
    ["whitespace request ID", { id: "   " }],
    ["nonstring request ID", { id: 1 }],
    ["wrong deployment", { deploymentId: "dpl_Other" }],
    ["nonstring deployment", { deploymentId: 1 }],
    ["wrong project echo", { projectId: "prj_Other" }],
    ["nonstring project echo", { projectId: 1 }],
    ["5xx", { responseStatusCode: 500 }],
    ["missing status", { responseStatusCode: undefined }],
    ["string status", { responseStatusCode: "200" }],
    ["fractional status", { responseStatusCode: 200.5 }],
    ["negative status", { responseStatusCode: -1 }],
    ["invalid low status sentinel", { responseStatusCode: 1 }],
    ["invalid status range", { responseStatusCode: 99 }],
    ["invalid high status range", { responseStatusCode: 600 }],
    ["top truncation", { messageTruncated: true }],
    ["malformed truncation", { messageTruncated: "false" }],
    ["top error level", { level: "ERROR" }],
    ["missing top level", { level: undefined }],
    ["missing top message", { message: undefined }],
    ["missing logs", { logs: undefined }],
    ["top error field", { error: false }],
    ["top fatal field", { fatal: { message: "failure" } }],
    ["unhandled error", { message: "Unhandled rejection" }],
    ["uncaught error", { message: "UNCAUGHT exception" }],
    ["pool failure", { message: "pool connection failure" }],
    ["connection terminated", { message: "Connection terminated unexpectedly" }],
    ["connection refused", { message: "connection refused" }],
    ["connection reset", { message: "ECONNRESET connection reset" }],
    ["pool exhausted", { message: "pool exhausted" }],
    ["handler crashed", { message: "handler crashed" }],
    ["invocation failed", { message: "Function Invocation Failed" }],
    ["leak detected", { message: "resource leak detected" }],
    ["handler error", { message: "request handler error" }],
    ["leak error", { message: "resource leak failure" }],
    ["lifecycle error", { message: "lifecycle timeout error" }],
    ["non-array logs", { logs: {} }],
    ["malformed nested entry", { logs: ["not-an-object"] }],
    ["missing nested fields", { logs: [{}] }],
    ["missing nested level", { logs: [{ message: "ok" }] }],
    ["missing nested message", { logs: [{ level: "info" }] }],
    ["nested truncation", { logs: [{ level: "info", message: "ok", messageTruncated: true }] }],
    [
      "malformed nested truncation",
      { logs: [{ level: "info", message: "ok", messageTruncated: "false" }] },
    ],
    ["nested fatal level", { logs: [{ level: "FaTaL", message: "boom" }] }],
    ["nested error field", { logs: [{ level: "info", message: "ok", error: "boom" }] }],
    ["nested fatal field", { logs: [{ level: "info", message: "ok", fatal: false }] }],
  ])("rejects %s in every row version", (_label, override) => {
    expect(() => scan([{ ...validLogRow(), ...override }])).toThrow(
      /log|error|trunc|scope|status|ID/,
    )
  })

  test("rejects malformed JSONL and a saturated 1,000-row response", () => {
    expect(() =>
      scanNativeVercelLogJsonl({ deploymentId, logMarker, projectId, stdout: "{not-json}\n" }),
    ).toThrow(/JSON|log/)
    expect(() =>
      scan(Array.from({ length: 1_000 }, (_, index) => validLogRow({ id: `r-${index}` }))),
    ).toThrow(/1,000|1000|saturat|limit/)
  })

  test("persists each raw runtime snapshot before a failing scan", async () => {
    const snapshots: string[] = []
    await expect(
      pollNativeVercelRuntimeLogs({
        clock: { now: () => 1_800_000_000_000, sleep: async () => undefined },
        deploymentId,
        logBoundary: { logs: async () => '{"id":"incomplete"}\n' },
        logMarker,
        orgId: "team_Test123",
        persistSnapshot: async (stdout) => {
          snapshots.push(stdout)
        },
        projectId,
        queryStartMs: 1_800_000_000_000,
      }),
    ).rejects.toThrow(/log|scope|status|malformed/)
    expect(snapshots).toEqual(['{"id":"incomplete"}\n'])
  })

  test("does not treat benign handler and connection messages as failures", () => {
    expect(() =>
      scan([
        validLogRow({
          logs: [
            { level: "info", message: "connection established" },
            { level: "info", message: "handler completed" },
          ],
        }),
      ]),
    ).not.toThrow()
  })

  test.each([
    [
      "pg connection security warning",
      "The SSL modes 'prefer', 'require', and 'verify-ca' are treated as aliases for 'verify-full'",
    ],
    [
      "deprecated Buffer constructor warning",
      "[DEP0005] DeprecationWarning: Buffer() is deprecated",
    ],
  ])("rejects the exact %s even when its response status is otherwise valid", (_label, message) => {
    expect(() =>
      scan([
        validLogRow({
          level: "error",
          logs: [{ level: "error", message }],
          message,
        }),
      ]),
    ).toThrow(/runtime error|error level|level reports/)
  })

  test("polls the exact command until one marker and a resettable final quiet boundary", async () => {
    const startMs = 1_800_000_000_000
    let current = startMs
    const sleeps: number[] = []
    const requests: Array<{
      readonly deploymentId: string
      readonly queryEndIso: string
      readonly queryStartIso: string
    }> = []
    const clock = {
      now: () => current,
      sleep: async (milliseconds: number) => {
        sleeps.push(milliseconds)
        current += milliseconds
      },
    }
    const markerRow = validLogRow({ id: "request-marker", responseStatusCode: 0 })
    const otherRow = (sequence: number) =>
      validLogRow({
        id: "request-other",
        logs: [{ level: "info", message: "handler completed", context: { sequence } }],
      })
    const result = await pollNativeVercelRuntimeLogs({
      clock,
      deploymentId,
      logBoundary: {
        logs: async (request) => {
          requests.push(request)
          const elapsed = current - startMs
          const rows = elapsed < 4_000 ? [] : [markerRow, otherRow(elapsed >= 28_000 ? 2 : 1)]
          return rows.length === 0 ? "" : `${rows.map((row) => JSON.stringify(row)).join("\n")}\n`
        },
      },
      logMarker,
      orgId: "team_Test123",
      projectId,
      queryStartMs: startMs,
    })
    const startIso = new Date(startMs).toISOString()
    expect(requests[0]).toEqual({
      deploymentId,
      queryEndIso: startIso,
      queryStartIso: startIso,
    })
    const untils = requests.map(({ queryEndIso }) => queryEndIso)
    for (const request of requests) {
      expect(request).toEqual({
        deploymentId,
        queryEndIso: request.queryEndIso,
        queryStartIso: startIso,
      })
      expect(Number.isNaN(Date.parse(request.queryEndIso))).toBe(false)
    }
    expect(new Set(untils).size).toBeGreaterThan(2)
    expect(untils.at(-1)).toBe(untils.at(-2))
    expect(sleeps.every((milliseconds) => milliseconds === 2_000)).toBe(true)
    expect(current - startMs).toBeGreaterThanOrEqual(58_000)
    expect(result).toEqual({
      exactDeploymentOnly: true,
      markerOccurrences: 1,
      noErrors: true,
      noTruncation: true,
      pollIntervalMs: 2_000,
      queryEndIso: new Date(current).toISOString(),
      queryStartIso: startIso,
      quietIntervalMs: 30_000,
      uniqueRowVersions: 3,
    })
  })

  // Vercel finalizes a request row AFTER the invocation returns: responseStatusCode
  // goes 0 -> 200 and cache "" -> "MISS". That rewrite is a new fingerprint for the
  // SAME row id, and when the row carries the marker it used to be counted twice,
  // failing a healthy deployment purely on poll timing. The sibling test above
  // mutates a row too, but only a marker-less one, so it never caught this.
  test("counts one marker row across the versions Vercel writes as a request settles", async () => {
    const startMs = 1_800_000_000_000
    let current = startMs
    const clock = {
      now: () => current,
      sleep: async (milliseconds: number) => {
        current += milliseconds
      },
    }
    const inFlight = validLogRow({ cache: "", id: "request-marker", responseStatusCode: 0 })
    const settled = validLogRow({ cache: "MISS", id: "request-marker", responseStatusCode: 200 })
    const result = await pollNativeVercelRuntimeLogs({
      clock,
      deploymentId,
      logBoundary: {
        logs: async () => {
          const elapsed = current - startMs
          if (elapsed < 4_000) return ""
          return `${JSON.stringify(elapsed < 10_000 ? inFlight : settled)}\n`
        },
      },
      logMarker,
      orgId: "team_Test123",
      projectId,
      queryStartMs: startMs,
    })
    // Both versions are still reported as distinct row versions -- the quiet-interval
    // logic depends on seeing them -- but they are ONE marker occurrence.
    expect(result.markerOccurrences).toBe(1)
    expect(result.uniqueRowVersions).toBe(2)
  })

  test("rejects duplicate marker versions, child failure, and the 180-second deadline", async () => {
    const startMs = 1_800_000_000_000
    const base = {
      deploymentId,
      logMarker,
      orgId: "team_Test123",
      projectId,
      queryStartMs: startMs,
    }
    await expect(
      pollNativeVercelRuntimeLogs({
        ...base,
        clock: { now: () => startMs, sleep: async () => {} },
        logBoundary: {
          logs: async () =>
            `${JSON.stringify(validLogRow({ id: "marker-one" }))}\n${JSON.stringify(
              validLogRow({ id: "marker-two" }),
            )}\n`,
        },
      }),
    ).rejects.toThrow(/marker|exactly one|occurrence/)

    await expect(
      pollNativeVercelRuntimeLogs({
        ...base,
        clock: { now: () => startMs, sleep: async () => {} },
        logBoundary: { logs: async () => Promise.reject(new Error("child failure")) },
      }),
    ).rejects.toThrow(/child|command|exit|log/)

    let current = startMs
    let calls = 0
    await expect(
      pollNativeVercelRuntimeLogs({
        ...base,
        clock: {
          now: () => current,
          sleep: async (milliseconds) => {
            expect(milliseconds).toBe(2_000)
            current += 180_000
          },
        },
        logBoundary: {
          logs: async () => {
            calls += 1
            return ""
          },
        },
      }),
    ).rejects.toThrow(/180|deadline/)
    expect(calls).toBe(1)
  })

  test("rejects an explicit 5xx version after the same row first reports unavailable status", async () => {
    const startMs = 1_800_000_000_000
    let current = startMs
    let calls = 0
    await expect(
      pollNativeVercelRuntimeLogs({
        clock: {
          now: () => current,
          sleep: async (milliseconds) => {
            current += milliseconds
          },
        },
        deploymentId,
        logBoundary: {
          logs: async () => {
            calls += 1
            return `${JSON.stringify(validLogRow({ responseStatusCode: calls === 1 ? 0 : 500 }))}\n`
          },
        },
        logMarker,
        orgId: "team_Test123",
        projectId,
        queryStartMs: startMs,
      }),
    ).rejects.toThrow(/5xx|status/)
    expect(calls).toBe(2)
  })

  // A later version of one row is the same request re-reported, so a benign rewrite
  // must NOT count twice (see the settling test above). What must still reject is a
  // genuine second occurrence: the row's own logs growing to carry the marker twice.
  test("counts a changed version of the same marker row and rejects the second occurrence", async () => {
    const startMs = 1_800_000_000_000
    let current = startMs
    let calls = 0
    const markerEntry = (version: number) => ({
      level: "info",
      message: `dawn-vercel-fixture-log ${logMarker}`,
      context: { version },
    })
    await expect(
      pollNativeVercelRuntimeLogs({
        clock: {
          now: () => current,
          sleep: async (milliseconds) => {
            current += milliseconds
          },
        },
        deploymentId,
        logBoundary: {
          logs: async () => {
            calls += 1
            return `${JSON.stringify(
              validLogRow({
                logs: calls === 1 ? [markerEntry(1)] : [markerEntry(1), markerEntry(2)],
              }),
            )}\n`
          },
        },
        logMarker,
        orgId: "team_Test123",
        projectId,
        queryStartMs: startMs,
      }),
    ).rejects.toThrow(/marker|occurrence|exactly one/)
    expect(calls).toBe(2)
  })

  test("restarts a full quiet interval when the first final-boundary query finds a new row", async () => {
    const startMs = 1_800_000_000_000
    let current = startMs
    let previousUntil: string | undefined
    let boundaryQueries = 0
    let injected = false
    const requests: string[] = []
    const result = await pollNativeVercelRuntimeLogs({
      clock: {
        now: () => current,
        sleep: async (milliseconds) => {
          current += milliseconds
        },
      },
      deploymentId,
      logBoundary: {
        logs: async ({ queryEndIso }) => {
          requests.push(queryEndIso)
          const isBoundary = queryEndIso === previousUntil
          previousUntil = queryEndIso
          if (isBoundary) boundaryQueries += 1
          const rows = [validLogRow({ id: "marker-row" })]
          if (isBoundary && !injected) {
            rows.push(
              validLogRow({
                id: "boundary-row",
                logs: [{ level: "info", message: "handler completed" }],
              }),
            )
            injected = true
          } else if (injected) {
            rows.push(
              validLogRow({
                id: "boundary-row",
                logs: [{ level: "info", message: "handler completed" }],
              }),
            )
          }
          return `${rows.map((row) => JSON.stringify(row)).join("\n")}\n`
        },
      },
      logMarker,
      orgId: "team_Test123",
      projectId,
      queryStartMs: startMs,
    })
    expect(result.uniqueRowVersions).toBe(2)
    expect(current - startMs).toBeGreaterThanOrEqual(60_000)
    expect(boundaryQueries).toBe(2)
    expect(requests.length).toBeGreaterThan(30)
  })

  test("rejects otherwise successful log evidence returned after the 180-second deadline", async () => {
    const startMs = 1_800_000_000_000
    let current = startMs
    await expect(
      pollNativeVercelRuntimeLogs({
        clock: { now: () => current, sleep: async () => {} },
        deploymentId,
        logBoundary: {
          logs: async () => {
            current += 180_001
            return `${JSON.stringify(validLogRow())}\n`
          },
        },
        logMarker,
        orgId: "team_Test123",
        projectId,
        queryStartMs: startMs,
      }),
    ).rejects.toThrow(/180|deadline/)
  })

  test("does not accrue quiet evidence while the proven marker row disappears", async () => {
    const startMs = 1_800_000_000_000
    let current = startMs
    let calls = 0
    await expect(
      pollNativeVercelRuntimeLogs({
        clock: {
          now: () => current,
          sleep: async (milliseconds) => {
            expect(milliseconds).toBe(2_000)
            current += milliseconds
          },
        },
        deploymentId,
        logBoundary: {
          logs: async () => {
            calls += 1
            return calls === 1 ? `${JSON.stringify(validLogRow())}\n` : ""
          },
        },
        logMarker,
        orgId: "team_Test123",
        projectId,
        queryStartMs: startMs,
      }),
    ).rejects.toThrow(/180|deadline|marker|log/)
    expect(calls).toBeGreaterThan(2)
  })
})

describe("database cleanup", () => {
  const barrierIds = [`b-vcl-${"a".repeat(32)}`, `b-vcl-${"b".repeat(32)}`] as const
  const threadIds = [`t-vcl-${"c".repeat(32)}`, `t-vcl-${"d".repeat(32)}`] as const
  const tables = [
    "public.dawn_vercel_test_barriers",
    "public.dawn_writes",
    "public.dawn_checkpoints",
    "public.dawn_threads",
  ] as const
  const toRegclassSql =
    "SELECT CASE WHEN to_regclass($1) IS NULL THEN NULL ELSE $1::text END AS relation"
  const deleteSql = (table: string, column: "barrier_id" | "thread_id") =>
    `DELETE FROM ${table} WHERE ${column} = $1`
  const verifySql = (table: string, column: "barrier_id" | "thread_id") =>
    `SELECT COUNT(*)::integer AS remaining FROM ${table} WHERE ${column} = $1`

  test("uses only allowlisted existence checks and exact per-resource deletion and verification", async () => {
    const requests: Array<{
      readonly params: readonly unknown[]
      readonly sql: string
      readonly timeoutMs: number
    }> = []
    const cleanedBarriers: string[] = []
    const cleanedThreads: string[] = []
    const existing = new Set<string>(tables)
    const options = {
      barrierIds,
      database: {
        query: async (request: (typeof requests)[number]) => {
          requests.push(request)
          if (request.sql === toRegclassSql) {
            const table = request.params[0] as string
            return { rows: [{ relation: existing.has(table) ? table : null }] }
          }
          if (request.sql.startsWith("DELETE FROM ")) return { rows: [] }
          if (request.sql.startsWith("SELECT COUNT(*)::integer AS remaining FROM ")) {
            return { rows: [{ remaining: 0 }] }
          }
          throw new Error("unexpected database cleanup SQL")
        },
      },
      persistBarrierCleaned: async (barrierId: string) => {
        cleanedBarriers.push(barrierId)
      },
      persistThreadCleaned: async (threadId: string) => {
        cleanedThreads.push(threadId)
      },
      threadIds,
    }

    await expect(cleanupNativeDatabase(options)).resolves.toEqual({ databaseRowsAbsent: true })
    await expect(cleanupNativeDatabase(options)).resolves.toEqual({ databaseRowsAbsent: true })

    expect(requests.every(({ timeoutMs }) => Number.isFinite(timeoutMs) && timeoutMs > 0)).toBe(
      true,
    )
    expect(requests.some(({ sql }) => /\$1/.test(sql))).toBe(true)
    expect(requests.every(({ sql }) => !sql.includes("undefined"))).toBe(true)
    const expectedMutations = [
      ...barrierIds.flatMap((barrierId) => [
        {
          sql: deleteSql("public.dawn_vercel_test_barriers", "barrier_id"),
          params: [barrierId],
        },
        {
          sql: verifySql("public.dawn_vercel_test_barriers", "barrier_id"),
          params: [barrierId],
        },
      ]),
      ...threadIds.flatMap((threadId) =>
        ["public.dawn_writes", "public.dawn_checkpoints", "public.dawn_threads"].flatMap(
          (table) => [
            { sql: deleteSql(table, "thread_id"), params: [threadId] },
            { sql: verifySql(table, "thread_id"), params: [threadId] },
          ],
        ),
      ),
    ]
    const expectedRun = [
      ...tables.map((table) => ({ params: [table], sql: toRegclassSql })),
      ...expectedMutations,
    ]
    expect(requests.map(({ sql, params }) => ({ sql, params }))).toEqual([
      ...expectedRun,
      ...expectedRun,
    ])
    expect(cleanedBarriers).toEqual([...barrierIds, ...barrierIds])
    expect(cleanedThreads).toEqual([...threadIds, ...threadIds])
  })

  test("treats absent partial-migration tables as verified zero-resource postconditions", async () => {
    const mutationSql: string[] = []
    const cleaned: string[] = []
    await expect(
      cleanupNativeDatabase({
        barrierIds,
        database: {
          query: async ({ params, sql }) => {
            if (sql !== toRegclassSql) mutationSql.push(sql)
            return { rows: [{ relation: params[0] && null }] }
          },
        },
        persistBarrierCleaned: async (id) => {
          cleaned.push(id)
        },
        persistThreadCleaned: async (id) => {
          cleaned.push(id)
        },
        threadIds,
      }),
    ).resolves.toEqual({ databaseRowsAbsent: true })
    expect(mutationSql).toEqual([])
    expect(cleaned).toEqual([...barrierIds, ...threadIds])
  })

  test("deletes only tables present in a partial migration and still verifies each resource", async () => {
    const existing = new Set(["public.dawn_vercel_test_barriers", "public.dawn_checkpoints"])
    const requests: Array<{ readonly params: readonly unknown[]; readonly sql: string }> = []
    const cleaned: string[] = []
    await expect(
      cleanupNativeDatabase({
        barrierIds,
        database: {
          query: async ({ params, sql }) => {
            requests.push({ params, sql })
            if (sql === toRegclassSql) {
              const table = params[0] as string
              return { rows: [{ relation: existing.has(table) ? table : null }] }
            }
            if (sql.startsWith("DELETE FROM ")) return { rows: [] }
            return { rows: [{ remaining: 0 }] }
          },
        },
        persistBarrierCleaned: async (id) => {
          cleaned.push(`barrier:${id}`)
        },
        persistThreadCleaned: async (id) => {
          cleaned.push(`thread:${id}`)
        },
        threadIds,
      }),
    ).resolves.toEqual({ databaseRowsAbsent: true })
    expect(requests.slice(4).map(({ sql, params }) => ({ sql, params }))).toEqual([
      ...barrierIds.flatMap((barrierId) => [
        {
          sql: deleteSql("public.dawn_vercel_test_barriers", "barrier_id"),
          params: [barrierId],
        },
        {
          sql: verifySql("public.dawn_vercel_test_barriers", "barrier_id"),
          params: [barrierId],
        },
      ]),
      ...threadIds.flatMap((threadId) => [
        { sql: deleteSql("public.dawn_checkpoints", "thread_id"), params: [threadId] },
        { sql: verifySql("public.dawn_checkpoints", "thread_id"), params: [threadId] },
      ]),
    ])
    expect(cleaned).toEqual([
      ...barrierIds.map((id) => `barrier:${id}`),
      ...threadIds.map((id) => `thread:${id}`),
    ])
  })

  test("attempts every independent resource and aggregates delete, verification, and persistence failures", async () => {
    const threeThreads = [...threadIds, `t-vcl-${"e".repeat(32)}`] as const
    const attempted: string[] = []
    const cleanedBarriers: string[] = []
    const cleanedThreads: string[] = []
    const caught = await cleanupNativeDatabase({
      barrierIds,
      database: {
        query: async ({ params, sql }) => {
          attempted.push(`${sql}\0${JSON.stringify(params)}`)
          if (sql === toRegclassSql) {
            return { rows: [{ relation: params[0] }] }
          }
          if (
            sql === deleteSql("public.dawn_vercel_test_barriers", "barrier_id") &&
            params[0] === barrierIds[0]
          ) {
            throw new Error("first barrier delete failed")
          }
          if (
            sql === deleteSql("public.dawn_writes", "thread_id") &&
            params[0] === threeThreads[0]
          ) {
            throw new Error("first thread writes delete failed")
          }
          if (
            sql === verifySql("public.dawn_checkpoints", "thread_id") &&
            params[0] === threeThreads[1]
          ) {
            return { rows: [{ remaining: 1 }] }
          }
          if (sql.startsWith("SELECT COUNT(*)::integer AS remaining")) {
            return { rows: [{ remaining: 0 }] }
          }
          return { rows: [] }
        },
      },
      persistBarrierCleaned: async (id) => {
        cleanedBarriers.push(id)
      },
      persistThreadCleaned: async (id) => {
        cleanedThreads.push(id)
      },
      threadIds: threeThreads,
    }).then(
      () => undefined,
      (error: unknown) => error,
    )
    expect(caught).toBeInstanceOf(AggregateError)
    expect((caught as AggregateError).errors).toHaveLength(3)
    expect(cleanedBarriers).toEqual([barrierIds[1]])
    expect(cleanedThreads).toEqual([threeThreads[2]])
    for (const id of [...barrierIds, ...threeThreads]) {
      expect(attempted.some((entry) => entry.includes(JSON.stringify([id])))).toBe(true)
    }
    for (const threadId of threeThreads) {
      expect(
        attempted
          .filter((entry) => entry.endsWith(`\0${JSON.stringify([threadId])}`))
          .map((entry) => entry.split("\0", 1)[0]),
      ).toEqual(
        ["public.dawn_writes", "public.dawn_checkpoints", "public.dawn_threads"].flatMap(
          (table) => [deleteSql(table, "thread_id"), verifySql(table, "thread_id")],
        ),
      )
      for (const table of [
        "public.dawn_writes",
        "public.dawn_checkpoints",
        "public.dawn_threads",
      ] as const) {
        expect(attempted).toContain(
          `${deleteSql(table, "thread_id")}\0${JSON.stringify([threadId])}`,
        )
      }
    }
  })

  test("continues after synchronous cleaned-flag persistence failures", async () => {
    const attempted: string[] = []
    const successfullyPersisted: string[] = []
    const caught = await cleanupNativeDatabase({
      barrierIds,
      database: {
        query: ({ params, sql }) => {
          expect(sql).toBe(toRegclassSql)
          return Promise.resolve({ rows: [{ relation: params[0] && null }] })
        },
      },
      persistBarrierCleaned: (id) => {
        attempted.push(`barrier:${id}`)
        if (id === barrierIds[0]) throw new Error("raw barrier persistence failure")
        successfullyPersisted.push(`barrier:${id}`)
        return Promise.resolve()
      },
      persistThreadCleaned: (id) => {
        attempted.push(`thread:${id}`)
        if (id === threadIds[0]) throw new Error("raw thread persistence failure")
        successfullyPersisted.push(`thread:${id}`)
        return Promise.resolve()
      },
      threadIds,
    }).then(
      () => undefined,
      (error: unknown) => error,
    )
    expect(attempted).toEqual([
      `barrier:${barrierIds[0]}`,
      `barrier:${barrierIds[1]}`,
      `thread:${threadIds[0]}`,
      `thread:${threadIds[1]}`,
    ])
    expect(successfullyPersisted).toEqual([`barrier:${barrierIds[1]}`, `thread:${threadIds[1]}`])
    expect(caught).toBeInstanceOf(AggregateError)
    expect((caught as AggregateError).errors.map((error) => (error as Error).message)).toEqual([
      "native Vercel database cleanup barrier persistence failed",
      "native Vercel database cleanup thread persistence failed",
    ])
  })

  test.each([
    ["missing existence row", []],
    [
      "duplicate existence rows",
      [
        { relation: "public.dawn_vercel_test_barriers" },
        { relation: "public.dawn_vercel_test_barriers" },
      ],
    ],
    ["mismatched relation", [{ relation: "public.other" }]],
    ["nonstring relation", [{ relation: 1 }]],
    ["missing relation field", [{ wrong: null }]],
    ["additional relation field", [{ relation: "public.dawn_vercel_test_barriers", extra: true }]],
  ] as const)("rejects %s without mutating the affected table", async (_label, malformedRows) => {
    const mutated: string[] = []
    const caught = await cleanupNativeDatabase({
      barrierIds,
      database: {
        query: async ({ params, sql }) => {
          if (sql === toRegclassSql) {
            return {
              rows:
                params[0] === "public.dawn_vercel_test_barriers"
                  ? [...malformedRows]
                  : [{ relation: null }],
            }
          }
          mutated.push(sql)
          return { rows: [] }
        },
      },
      persistBarrierCleaned: async () => {},
      persistThreadCleaned: async () => {},
      threadIds,
    }).then(
      () => undefined,
      (error: unknown) => error,
    )
    expect(caught).toBeInstanceOf(AggregateError)
    expect(mutated).toEqual([])
  })

  test.each([
    ["missing verification row", []],
    ["duplicate verification rows", [{ remaining: 0 }, { remaining: 0 }]],
    ["string remaining count", [{ remaining: "0" }]],
    ["fractional remaining count", [{ remaining: 0.5 }]],
    ["negative remaining count", [{ remaining: -1 }]],
    ["nonzero remaining count", [{ remaining: 1 }]],
    ["missing remaining field", [{ wrong: 0 }]],
    ["additional remaining field", [{ remaining: 0, extra: true }]],
  ] as const)("rejects %s and still cleans a later barrier", async (_label, malformedRows) => {
    let verification = 0
    const cleaned: string[] = []
    const caught = await cleanupNativeDatabase({
      barrierIds,
      database: {
        query: async ({ params, sql }) => {
          if (sql === toRegclassSql) {
            return {
              rows: [
                {
                  relation: params[0] === "public.dawn_vercel_test_barriers" ? params[0] : null,
                },
              ],
            }
          }
          if (sql.startsWith("DELETE FROM ")) return { rows: [] }
          verification += 1
          return { rows: verification === 1 ? [...malformedRows] : [{ remaining: 0 }] }
        },
      },
      persistBarrierCleaned: async (id) => {
        cleaned.push(id)
      },
      persistThreadCleaned: async () => {},
      threadIds: [],
    }).then(
      () => undefined,
      (error: unknown) => error,
    )
    expect(caught).toBeInstanceOf(AggregateError)
    expect(cleaned).toEqual([barrierIds[1]])
  })

  test("rejects malformed or duplicate cleanup IDs before any query or persistence", async () => {
    for (const input of [
      { barrierIds: ["../unsafe"], threadIds },
      { barrierIds: [barrierIds[0], barrierIds[0]], threadIds },
      { barrierIds, threadIds: ["unsafe"] },
      { barrierIds, threadIds: [threadIds[0], threadIds[0]] },
    ]) {
      let calls = 0
      await expect(
        cleanupNativeDatabase({
          ...input,
          database: {
            query: async () => {
              calls += 1
              return { rows: [] }
            },
          },
          persistBarrierCleaned: async () => {
            calls += 1
          },
          persistThreadCleaned: async () => {
            calls += 1
          },
        }),
      ).rejects.toThrow(/barrier|thread|duplicate|cleanup/i)
      expect(calls).toBe(0)
    }
  })
})

describe("native failure aggregation", () => {
  test("preserves the primary as cause and first error while attempting every cleanup", async () => {
    const primary = new Error("primary native failure")
    const calls: string[] = []
    const caught = await runNativeCleanupWithPrimaryFailure({
      cleanupOperations: [
        {
          label: "deployment cleanup",
          run: async () => {
            calls.push("deployment")
            throw new Error("raw deployment failure")
          },
        },
        {
          label: "database cleanup",
          run: async () => {
            calls.push("database")
            throw new Error("raw database failure")
          },
        },
        {
          label: "diagnostic cleanup",
          run: async () => {
            calls.push("diagnostic")
          },
        },
      ],
      primaryFailure: primary,
    }).then(
      () => undefined,
      (error: unknown) => error,
    )
    expect(calls).toEqual(["deployment", "database", "diagnostic"])
    expect(caught).toBeInstanceOf(AggregateError)
    expect((caught as AggregateError).cause).toBe(primary)
    expect((caught as AggregateError).errors[0]).toBe(primary)
    expect(
      (caught as AggregateError).errors.slice(1).map((error) => (error as Error).message),
    ).toEqual(["native Vercel deployment cleanup failed", "native Vercel database cleanup failed"])
  })

  test("returns a primary-only AggregateError even when every cleanup succeeds", async () => {
    const primary = new Error("primary native failure")
    const calls: string[] = []
    const caught = await runNativeCleanupWithPrimaryFailure({
      cleanupOperations: [
        { label: "deployment cleanup", run: async () => void calls.push("deployment") },
        { label: "database cleanup", run: async () => void calls.push("database") },
      ],
      primaryFailure: primary,
    }).then(
      () => undefined,
      (error: unknown) => error,
    )
    expect(calls).toEqual(["deployment", "database"])
    expect(caught).toBeInstanceOf(AggregateError)
    expect((caught as AggregateError).cause).toBe(primary)
    expect((caught as AggregateError).errors).toEqual([primary])
  })

  test("aggregates sanitized synchronous and asynchronous cleanup failures without a cause", async () => {
    const rawSecret = "cleanup-secret-that-must-not-escape"
    const calls: string[] = []
    const caught = await runNativeCleanupWithPrimaryFailure({
      cleanupOperations: [
        {
          label: "deployment cleanup",
          run: () => {
            calls.push("deployment")
            throw new Error(rawSecret)
          },
        },
        {
          label: "database cleanup",
          run: async () => {
            calls.push("database")
            throw new Error(rawSecret)
          },
        },
        { label: "diagnostic cleanup", run: async () => void calls.push("diagnostic") },
      ],
    }).then(
      () => undefined,
      (error: unknown) => error,
    )
    expect(calls).toEqual(["deployment", "database", "diagnostic"])
    expect(caught).toBeInstanceOf(AggregateError)
    expect(Object.hasOwn(caught as object, "cause")).toBe(false)
    expect((caught as AggregateError).errors.map((error) => (error as Error).message)).toEqual([
      "native Vercel deployment cleanup failed",
      "native Vercel database cleanup failed",
    ])
    expect(
      [String(caught), ...(caught as AggregateError).errors.map((error) => String(error))].join(
        "\n",
      ),
    ).not.toContain(rawSecret)
  })

  test("returns only after every successful cleanup when there is no primary", async () => {
    const calls: string[] = []
    await expect(
      runNativeCleanupWithPrimaryFailure({
        cleanupOperations: [
          { label: "deployment cleanup", run: async () => void calls.push("deployment") },
          { label: "database cleanup", run: async () => void calls.push("database") },
        ],
      }),
    ).resolves.toBeUndefined()
    expect(calls).toEqual(["deployment", "database"])
  })
})

describe("native orchestration and evidence closure", () => {
  const protectedValues = [
    "vercel-token-secret",
    "team_Secret123",
    "prj_Secret456",
    "postgres://database-secret",
    'release"secret',
  ] as const
  const attemptStartMs = 1_800_000_000_000
  const attemptFor = (kind: "prebuilt" | "source", logicalAttemptIndex: string) =>
    deriveNativeAttemptEvidence(
      {
        githubJob: "vercel-native",
        githubRepositoryId: "123456",
        githubRunAttempt: "2",
        githubRunId: "987654",
        kind,
        logicalAttemptIndex,
      },
      attemptStartMs + Number(logicalAttemptIndex),
    )
  const bindingFor = (
    kind: "prebuilt" | "source",
    marker: string,
  ): {
    readonly canonicalOrigin: string
    readonly createdAt: number
    readonly deploymentId: string
    readonly marker: string
    readonly ownerIdMatched: true
    readonly projectIdMatched: true
    readonly target: "preview"
  } => {
    const deployment = validDeployment(kind)
    return {
      canonicalOrigin: deployment.canonicalOrigin,
      createdAt: attemptStartMs,
      deploymentId: deployment.deploymentId,
      marker,
      ownerIdMatched: true,
      projectIdMatched: true,
      target: "preview",
    }
  }
  const withoutCleanup = (kind: "prebuilt" | "source") => {
    const { cleanup: _cleanup, ...deployment } = validDeployment(kind)
    return deployment
  }
  const seedCleanupEvidence = async (
    store: Awaited<ReturnType<typeof createNativeEvidenceStore>>,
  ) => {
    await store.persistProjectBindingVerified()
    const bindings = []
    const barrierIds = []
    const threadIds = []
    for (const [kind, index] of [
      ["source", "0"],
      ["prebuilt", "1"],
    ] as const) {
      const attempt = attemptFor(kind, index)
      const binding = bindingFor(kind, attempt.marker)
      const barrierId = `b-vcl-${kind === "source" ? "8" : "9"}`.padEnd(
        38,
        kind === "source" ? "8" : "9",
      )
      const threadId = `t-vcl-${kind === "source" ? "a" : "b"}`.padEnd(
        38,
        kind === "source" ? "a" : "b",
      )
      await store.persistAttempt(attempt)
      await store.persistDeploymentReceipt(attempt.marker, {
        canonicalOrigin: binding.canonicalOrigin,
        deploymentId: binding.deploymentId,
      })
      await store.persistDeploymentBinding(attempt.marker, binding)
      await store.persistBarrier({ barrierId, kind, role: "target" })
      await store.persistThread({ kind, threadId })
      await store.persistDeploymentEvidence(kind, withoutCleanup(kind))
      bindings.push(binding)
      barrierIds.push(barrierId)
      threadIds.push(threadId)
    }
    return { barrierIds, bindings, threadIds }
  }
  const sourceBuildPayloads = [
    "Build complete: .dawn/build",
    "3 route(s) compiled",
    "targets: vercel",
    "wrote .vercel/output/config.json",
    "wrote .vercel/output/functions/index.func/.vc-config.json",
    "wrote .vercel/output/functions/index.func/index.mjs",
    "wrote vercel.json",
  ] as const
  const sourceDeployCommand = {
    command: "deploy" as const,
    positionalPathAbsent: true as const,
    prebuiltFlagCount: 0 as const,
  }
  const prebuiltDeployCommand = {
    command: "deploy" as const,
    positionalPathAbsent: true as const,
    prebuiltFlagCount: 1 as const,
  }
  const buildTranscript = (deploymentId: string, payloads: readonly string[]) =>
    [
      pinnedVercelVersionStderr.trimEnd(),
      `Fetching deployment "${deploymentId}" in fixture-team`,
      ...payloads.map(
        (payload, index) =>
          `${new Date(Date.UTC(2026, 7, 10, 0, 0, index)).toISOString()}  ${payload}`,
      ),
      "status\t● Ready",
      "",
    ].join("\n")

  test("prepares source and prebuilt fixtures at the immediate deploy boundary with no build credential", async () => {
    const source = await makeUploadFixture("source")
    await mkdir(join(source.root, "node_modules"), { recursive: true })
    await writeFile(join(source.root, "node_modules", "ambient"), "remove me", "utf8")
    let sourceDeployed = false
    await expect(
      prepareNativeFixtureDeployment({
        deploy: async () => {
          sourceDeployed = true
          await expect(lstat(join(source.root, "node_modules"))).rejects.toMatchObject({
            code: "ENOENT",
          })
          await expect(lstat(join(source.root, ".dawn"))).rejects.toMatchObject({ code: "ENOENT" })
          await expect(lstat(join(source.root, ".vercel", "output"))).rejects.toMatchObject({
            code: "ENOENT",
          })
          return {
            canonicalOrigin: "https://dawn-source-abc.vercel.app",
            commandEvidence: sourceDeployCommand,
            deploymentId: "dpl_Source1",
          }
        },
        expectedTarballs: source.expectedTarballs,
        fixtureRoot: source.root,
        kind: "source",
        orgId: "team_Test123",
        parentEnv: {
          PATH: process.env.PATH,
          DATABASE_URL: protectedValues[3],
          DAWN_VERCEL_TOKEN: protectedValues[0],
          RELEASE_TOKEN: protectedValues[4],
          VERCEL_TOKEN: protectedValues[0],
        },
        projectId: "prj_Test456",
        protectedValues,
        runBuildChild: async () => {
          throw new Error("source must not run a local build")
        },
        validateOutput: async () => {
          throw new Error("source must not validate local prebuilt output")
        },
        writeDiagnostic: async () => {
          throw new Error("source must not write a local-build diagnostic")
        },
      }),
    ).resolves.toMatchObject({
      commandEvidence: sourceDeployCommand,
      localOutputValidated: false,
      sourceTree: { dawnAbsent: true, nodeModulesAbsent: true, prebuiltOutputAbsent: true },
    })
    expect(sourceDeployed).toBe(true)

    const prebuilt = await makeUploadFixture("source")
    const dawnExecutable = join(prebuilt.root, "node_modules", ".bin", "dawn")
    await mkdir(dirname(dawnExecutable), { recursive: true })
    await writeFile(dawnExecutable, "#!/usr/bin/env node\n", { encoding: "utf8", mode: 0o700 })
    const buildRequests: NativeVercelChildRequest[] = []
    const diagnostics: Array<{ readonly contents: string; readonly name: string }> = []
    let outputValidated = false
    let prebuiltDeployed = false
    await expect(
      prepareNativeFixtureDeployment({
        deploy: async () => {
          prebuiltDeployed = true
          expect(outputValidated).toBe(true)
          return {
            canonicalOrigin: "https://dawn-prebuilt-def.vercel.app",
            commandEvidence: prebuiltDeployCommand,
            deploymentId: "dpl_Prebuilt2",
          }
        },
        expectedTarballs: prebuilt.expectedTarballs,
        fixtureRoot: prebuilt.root,
        kind: "prebuilt",
        orgId: "team_Test123",
        parentEnv: {
          PATH: process.env.PATH,
          DATABASE_URL: protectedValues[3],
          DAWN_VERCEL_TOKEN: protectedValues[0],
          NOW_TOKEN: protectedValues[0],
          RELEASE_TOKEN: protectedValues[4],
        },
        projectId: "prj_Test456",
        protectedValues,
        runBuildChild: async (request) => {
          buildRequests.push(request)
          await mkdir(join(prebuilt.root, ".vercel", "output", "functions", "index.func"), {
            recursive: true,
          })
          await writeFile(join(prebuilt.root, ".vercel", "output", "config.json"), "{}\n", "utf8")
          await writeFile(
            join(prebuilt.root, ".vercel", "output", "functions", "index.func", "index.mjs"),
            "export default { fetch() {} }\n",
            "utf8",
          )
          return { exitCode: 0, stderr: "", stdout: "Build complete\n" }
        },
        validateOutput: async (outputRoot) => {
          expect(outputRoot).toBe(join(prebuilt.root, ".vercel", "output"))
          outputValidated = true
        },
        writeDiagnostic: async (name, contents) => {
          diagnostics.push({ contents, name })
        },
      }),
    ).resolves.toMatchObject({
      commandEvidence: prebuiltDeployCommand,
      localOutputValidated: true,
    })
    expect(prebuiltDeployed).toBe(true)
    expect(buildRequests).toHaveLength(1)
    expect(buildRequests[0]).toMatchObject({
      args: ["build"],
      cwd: prebuilt.root,
      executable: dawnExecutable,
      timeoutMs: 120_000,
    })
    expect(buildRequests[0]?.env).not.toHaveProperty("DATABASE_URL")
    expect(buildRequests[0]?.env).not.toHaveProperty("DAWN_VERCEL_TOKEN")
    expect(buildRequests[0]?.env).not.toHaveProperty("NOW_TOKEN")
    expect(buildRequests[0]?.env).not.toHaveProperty("RELEASE_TOKEN")
    expect(diagnostics).toEqual([
      {
        contents: "stdout:\nBuild complete\nstderr:\n",
        name: "prebuilt-local-build.log",
      },
    ])
  })

  test("rejects stale source output and protected prebuilt bundles before deploy", async () => {
    const staleSource = await makeUploadFixture("source")
    await mkdir(join(staleSource.root, ".dawn"))
    let deployCalls = 0
    await expect(
      prepareNativeFixtureDeployment({
        deploy: async () => {
          deployCalls += 1
          return {
            canonicalOrigin: "https://dawn-source-abc.vercel.app",
            commandEvidence: sourceDeployCommand,
            deploymentId: "dpl_Source1",
          }
        },
        expectedTarballs: staleSource.expectedTarballs,
        fixtureRoot: staleSource.root,
        kind: "source",
        orgId: "team_Test123",
        parentEnv: {},
        projectId: "prj_Test456",
        protectedValues,
        runBuildChild: async () => ({ exitCode: 0, stderr: "", stdout: "" }),
        validateOutput: async () => {},
        writeDiagnostic: async () => {},
      }),
    ).rejects.toThrow(/source|\.dawn|upload/)

    const unsafePrebuilt = await makeUploadFixture("source")
    const dawnExecutable = join(unsafePrebuilt.root, "node_modules", ".bin", "dawn")
    await mkdir(dirname(dawnExecutable), { recursive: true })
    await writeFile(dawnExecutable, "#!/usr/bin/env node\n", "utf8")
    await expect(
      prepareNativeFixtureDeployment({
        deploy: async () => {
          deployCalls += 1
          return {
            canonicalOrigin: "https://dawn-prebuilt-def.vercel.app",
            commandEvidence: prebuiltDeployCommand,
            deploymentId: "dpl_Prebuilt2",
          }
        },
        expectedTarballs: unsafePrebuilt.expectedTarballs,
        fixtureRoot: unsafePrebuilt.root,
        kind: "prebuilt",
        orgId: "team_Test123",
        parentEnv: {},
        projectId: "prj_Test456",
        protectedValues,
        runBuildChild: async () => {
          await mkdir(join(unsafePrebuilt.root, ".vercel", "output", "functions", "index.func"), {
            recursive: true,
          })
          await writeFile(
            join(unsafePrebuilt.root, ".vercel", "output", "functions", "index.func", "index.mjs"),
            `export const leaked = ${JSON.stringify(protectedValues[3])}\n`,
            "utf8",
          )
          return { exitCode: 0, stderr: "", stdout: "safe\n" }
        },
        validateOutput: async () => {},
        writeDiagnostic: async () => {},
      }),
    ).rejects.toThrow(/protected|bundle|output/)
    expect(deployCalls).toBe(0)
  })

  test("captures and sanitizes failed local build output and synchronous child failures", async () => {
    for (const failure of ["nonzero", "synchronous"] as const) {
      const fixture = await makeUploadFixture("source")
      const dawnExecutable = join(fixture.root, "node_modules", ".bin", "dawn")
      await mkdir(dirname(dawnExecutable), { recursive: true })
      await writeFile(dawnExecutable, "#!/usr/bin/env node\n", "utf8")
      const diagnostics: string[] = []
      let deployCalls = 0
      const caught = await prepareNativeFixtureDeployment({
        deploy: async () => {
          deployCalls += 1
          return {
            canonicalOrigin: "https://dawn-prebuilt-def.vercel.app",
            commandEvidence: prebuiltDeployCommand,
            deploymentId: "dpl_Prebuilt2",
          }
        },
        expectedTarballs: fixture.expectedTarballs,
        fixtureRoot: fixture.root,
        kind: "prebuilt",
        orgId: "team_Test123",
        parentEnv: {},
        projectId: "prj_Test456",
        protectedValues,
        runBuildChild: (request) => {
          expect(request.timeoutMs).toBe(120_000)
          if (failure === "synchronous") throw new Error(protectedValues[0])
          return Promise.resolve({
            exitCode: 1,
            stderr: `stderr ${encodeURIComponent(protectedValues[4])}\n`,
            stdout: `stdout ${protectedValues[3]}\n`,
          })
        },
        validateOutput: async () => {},
        writeDiagnostic: async (name, contents) => {
          expect(name).toBe("prebuilt-local-build.log")
          diagnostics.push(contents)
        },
      }).then(
        () => undefined,
        (error: unknown) => error,
      )
      expect(caught).toBeInstanceOf(Error)
      expect(String(caught)).not.toMatch(/vercel-token-secret|database-secret|release%22secret/)
      expect(deployCalls).toBe(0)
      if (failure === "nonzero") {
        expect(diagnostics).toEqual(["stdout:\nstdout [REDACTED]\nstderr:\nstderr [REDACTED]\n"])
      } else {
        expect(diagnostics).toEqual([])
      }
    }
  })

  test("projects actual deploy argv and parses the exact package-local inspect build-log command", async () => {
    const jobRoot = await realpath(await makeTempDir())
    const sourceRoot = join(jobRoot, "source")
    const prebuiltRoot = join(jobRoot, "prebuilt")
    const globalConfigDir = join(jobRoot, "global-config")
    await mkdir(sourceRoot)
    await mkdir(prebuiltRoot)
    await mkdir(globalConfigDir, { mode: 0o700 })
    for (const root of [sourceRoot, prebuiltRoot]) {
      await writeFile(join(root, "vercel.json"), '{"fluid":true}\n', "utf8")
    }
    const requests: NativeVercelChildRequest[] = []
    let buildLogStdout = ""
    let buildLogStderr = buildTranscript("dpl_Source1", sourceBuildPayloads)
    const boundary = await createNativePinnedVercelBoundary({
      cliPackageRoot,
      databaseUrl: protectedValues[3],
      fixtureRoots: [sourceRoot, prebuiltRoot],
      globalConfigDir,
      jobRoot,
      orgId: "team_Test123",
      parentEnv: { PATH: process.env.PATH, RELEASE_TOKEN: protectedValues[4] },
      projectId: "prj_Test456",
      releaseCredential: protectedValues[4],
      runChild: async (request) => {
        requests.push(request)
        if (request.args[0] === "--version") {
          return { exitCode: 0, stderr: pinnedVercelVersionStderr, stdout: "58.9.0\n" }
        }
        if (request.args.includes("--logs")) {
          return { exitCode: 0, stderr: buildLogStderr, stdout: buildLogStdout }
        }
        if (request.args.includes("--prebuilt")) {
          return {
            exitCode: 0,
            stderr: "",
            stdout: '{"id":"dpl_Prebuilt2","url":"dawn-prebuilt-def.vercel.app"}\n',
          }
        }
        return {
          exitCode: 0,
          stderr: "",
          stdout: '{"id":"dpl_Source1","url":"dawn-source-abc.vercel.app"}\n',
        }
      },
      token: protectedValues[0],
    })
    await boundary.assertVersion()
    await expect(
      boundary.deploy({
        fixtureRoot: sourceRoot,
        kind: "source",
        localConfigPath: join(sourceRoot, "vercel.json"),
        marker: `vclrun_${"c".repeat(32)}`,
      }),
    ).resolves.toMatchObject({ commandEvidence: sourceDeployCommand })
    await expect(
      boundary.deploy({
        fixtureRoot: prebuiltRoot,
        kind: "prebuilt",
        localConfigPath: join(prebuiltRoot, "vercel.json"),
        marker: `vclrun_${"d".repeat(32)}`,
      }),
    ).resolves.toMatchObject({ commandEvidence: prebuiltDeployCommand })
    const buildLogs = await boundary.inspectBuildLogs({ deploymentId: "dpl_Source1" })
    expect(buildLogs.evidence.events.map(({ text }) => text)).toEqual(sourceBuildPayloads)
    expect(buildLogs.redactedTranscript).toBe(buildLogStderr)
    const artifactDir = await makeTempDir()
    const store = await createNativeEvidenceStore({ artifactDir, protectedValues })
    await store.writeDiagnostic("source-build.log", buildLogs.redactedTranscript)
    expect(await readFile(join(artifactDir, "source-build.log"), "utf8")).toBe(buildLogStderr)

    const inspectRequest = requests.at(-1) as NativeVercelChildRequest
    expect(inspectRequest).toMatchObject({
      args: [
        "inspect",
        "dpl_Source1",
        "--logs",
        "--scope",
        "team_Test123",
        "--non-interactive",
        "--global-config",
        globalConfigDir,
      ],
      cwd: jobRoot,
      executable: join(cliPackageRoot, "node_modules", ".bin", "vercel"),
      timeoutMs: 120_000,
    })
    expect(inspectRequest.env).toMatchObject({
      VERCEL_ORG_ID: "team_Test123",
      VERCEL_PROJECT_ID: "prj_Test456",
      VERCEL_TOKEN: protectedValues[0],
    })
    expect(inspectRequest.env).not.toHaveProperty("DATABASE_URL")
    expect(inspectRequest.env).not.toHaveProperty("RELEASE_TOKEN")

    buildLogStderr = [
      pinnedVercelVersionStderr.trimEnd(),
      'Fetching deployment "dpl_Source1" in fixture-team',
      "> Deployment events polling error: timeout",
      "status\t● Ready",
      "",
    ].join("\n")
    await expect(boundary.inspectBuildLogs({ deploymentId: "dpl_Source1" })).rejects.toThrow(
      /inspect|build|log/,
    )
    buildLogStderr = buildTranscript("dpl_Source1", sourceBuildPayloads)
    buildLogStdout = "\u001b[2K"
    await expect(boundary.inspectBuildLogs({ deploymentId: "dpl_Source1" })).rejects.toThrow(
      /stdout|inspect|build|log/,
    )
  })

  test("derives kind-specific provenance only from verified tree, command, and complete build logs", () => {
    const sourceLogs = parseNativeVercelBuildLogTranscript({
      deploymentId: "dpl_Source1",
      stderr: buildTranscript("dpl_Source1", sourceBuildPayloads),
      stdout: "",
    })
    const prebuiltLogs = parseNativeVercelBuildLogTranscript({
      deploymentId: "dpl_Prebuilt2",
      stderr: buildTranscript("dpl_Prebuilt2", ["Using prebuilt build output"]),
      stdout: "",
    })
    const normalizedBlank = parseNativeVercelBuildLogTranscript({
      deploymentId: "dpl_Source1",
      stderr: `\u001b[36m${buildTranscript("dpl_Source1", ["", ...sourceBuildPayloads]).replaceAll(
        "\n",
        "\u001b[39m\r\n\u001b[36m",
      )}\u001b[39m`,
      stdout: "",
    })
    expect(normalizedBlank.events[0]).toMatchObject({ text: "" })
    expect(
      parseNativeBuildProvenance({
        deployCommand: sourceDeployCommand,
        inspectBuildLogs: normalizedBlank,
        kind: "source",
        localOutputValidated: false,
        sourceTree: { dawnAbsent: true, nodeModulesAbsent: true, prebuiltOutputAbsent: true },
      }),
    ).toMatchObject({ remoteBuildObserved: true })
    expect(
      parseNativeBuildProvenance({
        deployCommand: sourceDeployCommand,
        inspectBuildLogs: sourceLogs,
        kind: "source",
        localOutputValidated: false,
        sourceTree: { dawnAbsent: true, nodeModulesAbsent: true, prebuiltOutputAbsent: true },
      }),
    ).toEqual({ cleanSource: true, prebuiltOutputAbsent: true, remoteBuildObserved: true })
    expect(
      parseNativeBuildProvenance({
        deployCommand: prebuiltDeployCommand,
        inspectBuildLogs: prebuiltLogs,
        kind: "prebuilt",
        localOutputValidated: true,
        sourceTree: { dawnAbsent: false, nodeModulesAbsent: false, prebuiltOutputAbsent: false },
      }),
    ).toEqual({
      localOutputValidated: true,
      prebuiltDeployObserved: true,
      remoteSourceBuildAbsent: true,
    })

    const noisySourceLogs = parseNativeVercelBuildLogTranscript({
      deploymentId: "dpl_Source1",
      stderr: buildTranscript("dpl_Source1", [
        "Running build in Washington, D.C., USA (East) - iad1",
        sourceBuildPayloads[0],
        "Cloning completed: 132.000ms",
        sourceBuildPayloads[1],
        sourceBuildPayloads[2],
        "Restored build cache from previous deployment",
        sourceBuildPayloads[3],
        sourceBuildPayloads[4],
        "Installing dependencies...",
        sourceBuildPayloads[5],
        sourceBuildPayloads[6],
        "Build completed in /vercel/output [14s]",
      ]),
      stdout: "",
    })
    expect(
      parseNativeBuildProvenance({
        deployCommand: sourceDeployCommand,
        inspectBuildLogs: noisySourceLogs,
        kind: "source",
        localOutputValidated: false,
        sourceTree: { dawnAbsent: true, nodeModulesAbsent: true, prebuiltOutputAbsent: true },
      }),
    ).toEqual({ cleanSource: true, prebuiltOutputAbsent: true, remoteBuildObserved: true })

    const prebuiltWithoutEvents = parseNativeVercelBuildLogTranscript({
      deploymentId: "dpl_Prebuilt2",
      stderr: buildTranscript("dpl_Prebuilt2", []),
      stdout: "",
    })
    expect(prebuiltWithoutEvents.events).toEqual([])
    expect(
      parseNativeBuildProvenance({
        deployCommand: prebuiltDeployCommand,
        inspectBuildLogs: prebuiltWithoutEvents,
        kind: "prebuilt",
        localOutputValidated: true,
        sourceTree: { dawnAbsent: false, nodeModulesAbsent: false, prebuiltOutputAbsent: false },
      }),
    ).toEqual({
      localOutputValidated: true,
      prebuiltDeployObserved: true,
      remoteSourceBuildAbsent: true,
    })

    const duplicatedSourceLogs = {
      ...sourceLogs,
      events: [...sourceLogs.events, sourceLogs.events[0] as (typeof sourceLogs.events)[number]],
    }
    const reorderedSourceLogs = {
      ...sourceLogs,
      events: [
        sourceLogs.events[1] as (typeof sourceLogs.events)[number],
        sourceLogs.events[0] as (typeof sourceLogs.events)[number],
        ...sourceLogs.events.slice(2),
      ],
    }

    for (const malformed of [
      {
        deployCommand: sourceDeployCommand,
        inspectBuildLogs: duplicatedSourceLogs,
        kind: "source" as const,
        localOutputValidated: false,
        sourceTree: { dawnAbsent: true, nodeModulesAbsent: true, prebuiltOutputAbsent: true },
      },
      {
        deployCommand: sourceDeployCommand,
        inspectBuildLogs: reorderedSourceLogs,
        kind: "source" as const,
        localOutputValidated: false,
        sourceTree: { dawnAbsent: true, nodeModulesAbsent: true, prebuiltOutputAbsent: true },
      },
      {
        deployCommand: { ...sourceDeployCommand, extra: true },
        inspectBuildLogs: sourceLogs,
        kind: "source" as const,
        localOutputValidated: false,
        sourceTree: { dawnAbsent: true, nodeModulesAbsent: true, prebuiltOutputAbsent: true },
      },
      {
        deployCommand: prebuiltDeployCommand,
        inspectBuildLogs: sourceLogs,
        kind: "source" as const,
        localOutputValidated: false,
        sourceTree: { dawnAbsent: true, nodeModulesAbsent: true, prebuiltOutputAbsent: true },
      },
      {
        deployCommand: sourceDeployCommand,
        inspectBuildLogs: parseNativeVercelBuildLogTranscript({
          deploymentId: "dpl_Source1",
          stderr: buildTranscript("dpl_Source1", sourceBuildPayloads.slice(0, -1)),
          stdout: "",
        }),
        kind: "source" as const,
        localOutputValidated: false,
        sourceTree: { dawnAbsent: true, nodeModulesAbsent: true, prebuiltOutputAbsent: true },
      },
      {
        deployCommand: prebuiltDeployCommand,
        inspectBuildLogs: sourceLogs,
        kind: "prebuilt" as const,
        localOutputValidated: true,
        sourceTree: { dawnAbsent: false, nodeModulesAbsent: false, prebuiltOutputAbsent: false },
      },
      {
        deployCommand: sourceDeployCommand,
        inspectBuildLogs: sourceLogs,
        kind: "source" as const,
        localOutputValidated: false,
        sourceTree: { dawnAbsent: false, nodeModulesAbsent: true, prebuiltOutputAbsent: true },
      },
    ]) {
      expect(() => parseNativeBuildProvenance(malformed)).toThrow(
        /provenance|source|prebuilt|build/,
      )
    }
    expect(() =>
      parseNativeBuildProvenance({
        deployCommand: sourceDeployCommand,
        inspectBuildLogs: parseNativeVercelBuildLogTranscript({
          deploymentId: "dpl_Source1",
          stderr: buildTranscript("dpl_Source1", [...sourceBuildPayloads, protectedValues[0]]),
          stdout: "",
        }),
        kind: "source",
        localOutputValidated: false,
        protectedValues,
        sourceTree: { dawnAbsent: true, nodeModulesAbsent: true, prebuiltOutputAbsent: true },
      }),
    ).toThrow(/protected|provenance|build/)

    for (const malformed of [
      {
        deploymentId: "dpl_Source1",
        stderr: buildTranscript("dpl_Source1", []),
        stdout: "bytes",
      },
      {
        deploymentId: "dpl_Source1",
        stderr: buildTranscript("dpl_Different", sourceBuildPayloads),
        stdout: "",
      },
      {
        deploymentId: "dpl_Source1",
        stderr: [
          pinnedVercelVersionStderr.trimEnd(),
          'Fetching deployment "dpl_Source1" in fixture-team',
          "> Deployment events polling error: timeout",
          "status\t● Ready",
          "",
        ].join("\n"),
        stdout: "",
      },
      {
        deploymentId: "dpl_Source1",
        stderr: buildTranscript("dpl_Source1", sourceBuildPayloads).replace(
          pinnedVercelVersionStderr.trimEnd(),
          `Vercel CLI 58.9.0 (Node.js ${process.versions.node}.unexpected)`,
        ),
        stdout: "",
      },
      {
        deploymentId: "dpl_Source1",
        stderr: buildTranscript("dpl_Source1", sourceBuildPayloads).replace("● Ready", "● Error"),
        stdout: "",
      },
      {
        deploymentId: "dpl_Source1",
        stderr: buildTranscript("dpl_Source1", sourceBuildPayloads).replace(
          "2026-08-10T00:00:00.000Z",
          "not-a-time",
        ),
        stdout: "",
      },
    ]) {
      expect(() => parseNativeVercelBuildLogTranscript(malformed)).toThrow(/inspect|build|log/)
    }
  })

  test("composes each deployment only from preparation, deploy, inspect, black-box, and reconciliation seams", async () => {
    const order: string[] = []
    const execute = async (kind: "prebuilt" | "source") => {
      const fixture = await makeUploadFixture("source")
      if (kind === "source") {
        await mkdir(join(fixture.root, "node_modules"), { recursive: true })
      } else {
        const dawnExecutable = join(fixture.root, "node_modules", ".bin", "dawn")
        await mkdir(dirname(dawnExecutable), { recursive: true })
        await writeFile(dawnExecutable, "#!/usr/bin/env node\n", "utf8")
      }
      const attempt = attemptFor(kind, kind === "source" ? "0" : "1")
      const binding = bindingFor(kind, attempt.marker)
      const complete = validDeployment(kind)
      const functional = {
        laterRequest: complete.laterRequest,
        logs: complete.logs,
        middleware: complete.middleware,
        routes: complete.routes,
        state: complete.state,
        stream: complete.stream,
      }
      return await runNativeDeploymentKind({
        deployAttempt: async () => {
          order.push(`${kind}-deploy`)
          return {
            attempt,
            binding,
            canonicalOrigin: complete.canonicalOrigin,
            commandEvidence: kind === "source" ? sourceDeployCommand : prebuiltDeployCommand,
            config: complete.config,
            deploymentId: complete.deploymentId,
            readyState: "READY" as const,
          }
        },
        expectedTarballs: fixture.expectedTarballs,
        fixtureRoot: fixture.root,
        inspectBuildLogs: async ({ deploymentId }) => {
          order.push(`${kind}-inspect-build-logs`)
          const redactedTranscript = buildTranscript(
            deploymentId,
            kind === "source" ? sourceBuildPayloads : ["Using prebuilt build output"],
          )
          return {
            evidence: parseNativeVercelBuildLogTranscript({
              deploymentId,
              stderr: redactedTranscript,
              stdout: "",
            }),
            redactedTranscript,
          }
        },
        kind,
        orgId: "team_Test123",
        parentEnv: {
          PATH: process.env.PATH,
          DATABASE_URL: protectedValues[3],
          VERCEL_TOKEN: protectedValues[0],
        },
        projectId: "prj_Test456",
        protectedValues,
        reconcile: async (evidence) => {
          order.push(`${kind}-reconcile`)
          expect(evidence).toBe(attempt)
          return {
            deployments: [binding],
            expectedCardinality: true,
            pollIntervalMs: 2_000 as const,
            quietIntervalMs: 30_000 as const,
          }
        },
        runBlackBox: async ({ canonicalOrigin, deploymentId }) => {
          order.push(`${kind}-black-box`)
          expect({ canonicalOrigin, deploymentId }).toEqual({
            canonicalOrigin: complete.canonicalOrigin,
            deploymentId: complete.deploymentId,
          })
          return functional
        },
        runBuildChild: async (request) => {
          order.push(`${kind}-local-build`)
          expect(kind).toBe("prebuilt")
          expect(request.env).not.toHaveProperty("DATABASE_URL")
          expect(request.env).not.toHaveProperty("VERCEL_TOKEN")
          await mkdir(join(fixture.root, ".vercel", "output", "functions", "index.func"), {
            recursive: true,
          })
          await writeFile(join(fixture.root, ".vercel", "output", "config.json"), "{}\n", "utf8")
          await writeFile(
            join(fixture.root, ".vercel", "output", "functions", "index.func", "index.mjs"),
            "export default { fetch() {} }\n",
            "utf8",
          )
          return { exitCode: 0, stderr: "", stdout: "Build complete\n" }
        },
        validateOutput: async () => {
          order.push(`${kind}-validate-output`)
        },
        writeDiagnostic: async (name) => {
          expect([
            `${kind}-build.log`,
            ...(kind === "prebuilt" ? ["prebuilt-local-build.log"] : []),
          ]).toContain(name)
          order.push(`${kind}-${name}`)
        },
      })
    }

    await expect(execute("source")).resolves.toEqual(withoutCleanup("source"))
    await expect(execute("prebuilt")).resolves.toEqual(withoutCleanup("prebuilt"))
    expect(order).toEqual([
      "source-deploy",
      "source-inspect-build-logs",
      "source-source-build.log",
      "source-black-box",
      "source-reconcile",
      "prebuilt-local-build",
      "prebuilt-prebuilt-local-build.log",
      "prebuilt-validate-output",
      "prebuilt-deploy",
      "prebuilt-inspect-build-logs",
      "prebuilt-prebuilt-build.log",
      "prebuilt-black-box",
      "prebuilt-reconcile",
    ])
  })

  test.each(["empty", "mismatched", "cardinality"] as const)(
    "rejects %s reconciliation instead of manufacturing true receipt evidence",
    async (variant) => {
      const fixture = await makeUploadFixture("source")
      const attempt = attemptFor("source", "0")
      const binding = bindingFor("source", attempt.marker)
      const complete = validDeployment("source")
      const mismatched = {
        ...binding,
        canonicalOrigin: "https://dawn-other-xyz.vercel.app",
        deploymentId: "dpl_Other3",
      }
      const reconciled =
        variant === "empty" ? [] : variant === "mismatched" ? [mismatched] : [binding, mismatched]
      const functional = {
        laterRequest: complete.laterRequest,
        logs: complete.logs,
        middleware: complete.middleware,
        routes: complete.routes,
        state: complete.state,
        stream: complete.stream,
      }
      await expect(
        runNativeDeploymentKind({
          deployAttempt: async () => ({
            attempt,
            binding,
            canonicalOrigin: complete.canonicalOrigin,
            commandEvidence: sourceDeployCommand,
            config: complete.config,
            deploymentId: complete.deploymentId,
            readyState: "READY" as const,
          }),
          expectedTarballs: fixture.expectedTarballs,
          fixtureRoot: fixture.root,
          inspectBuildLogs: async () => {
            const redactedTranscript = buildTranscript(complete.deploymentId, sourceBuildPayloads)
            return {
              evidence: parseNativeVercelBuildLogTranscript({
                deploymentId: complete.deploymentId,
                stderr: redactedTranscript,
                stdout: "",
              }),
              redactedTranscript,
            }
          },
          kind: "source",
          orgId: "team_Test123",
          parentEnv: {},
          projectId: "prj_Test456",
          protectedValues,
          reconcile: async () => ({
            deployments: reconciled,
            expectedCardinality: reconciled.length <= 1,
            pollIntervalMs: 2_000 as const,
            quietIntervalMs: 30_000 as const,
          }),
          runBlackBox: async () => functional,
          runBuildChild: async () => {
            throw new Error("source must not build locally")
          },
          validateOutput: async () => {},
          writeDiagnostic: async () => {},
        }),
      ).rejects.toThrow(/reconciliation|binding|cardinality/)
    },
  )

  test("persists a closed incremental cleanup manifest without deleting resource history", async () => {
    const artifactDir = await makeTempDir()
    const store = await createNativeEvidenceStore({ artifactDir, protectedValues })
    const attempt = attemptFor("source", "0")
    const binding = bindingFor("source", attempt.marker)
    const threadId = `t-vcl-${"1".repeat(32)}`
    const barrierId = `b-vcl-${"2".repeat(32)}`
    await store.persistDeploymentStage("source", "config", { target: "vercel" })
    await expect(
      store.persistDeploymentStage("source", "config", { target: "vercel" }),
    ).resolves.toBeUndefined()
    await expect(
      store.persistDeploymentStage("source", "config", { target: "conflict" }),
    ).rejects.toThrow(/stage|conflict|evidence/)
    await store.persistDeploymentStage("source", "readiness", { readyState: "READY" })
    const stagedPartial = JSON.parse(
      await readFile(join(artifactDir, "receipt.partial.json"), "utf8"),
    )
    expect(stagedPartial).toMatchObject({
      complete: false,
      stages: {
        source: {
          config: { target: "vercel" },
          readiness: { readyState: "READY" },
        },
      },
    })
    expect(() => parseNativeReceipt(stagedPartial)).toThrow()
    await store.persistAttempt(attempt)
    await store.persistDeploymentReceipt(attempt.marker, {
      canonicalOrigin: binding.canonicalOrigin,
      deploymentId: binding.deploymentId,
    })
    await store.persistDeploymentBinding(attempt.marker, binding)
    await store.persistThread({ kind: "source", threadId })
    await store.persistBarrier({ barrierId, kind: "source", role: "target" })

    const beforeCleanup = parseNativeCleanupManifest(
      JSON.parse(await readFile(join(artifactDir, "cleanup-manifest.json"), "utf8")),
    )
    expect(beforeCleanup).toMatchObject({
      schemaVersion: 1,
      attempts: [
        {
          attempt,
          binding,
          cleaned: false,
          deploymentReceipt: {
            canonicalOrigin: binding.canonicalOrigin,
            deploymentId: binding.deploymentId,
          },
        },
      ],
      barriers: [{ barrierId, cleaned: false, kind: "source", role: "target" }],
      databaseRowsAbsent: false,
      threads: [{ cleaned: false, kind: "source", threadId }],
    })
    await store.persistDeploymentCleaned(binding.deploymentId, {
      state: "DELETED",
      uid: binding.deploymentId,
    })
    await store.persistBarrierCleaned(barrierId)
    await store.persistThreadCleaned(threadId)
    await store.persistDatabaseRowsAbsent()

    const afterCleanup = parseNativeCleanupManifest(
      JSON.parse(await readFile(join(artifactDir, "cleanup-manifest.json"), "utf8")),
    )
    expect(afterCleanup).toMatchObject({
      attempts: [{ cleaned: true, deleteReceipt: { state: "DELETED", uid: binding.deploymentId } }],
      barriers: [{ barrierId, cleaned: true }],
      databaseRowsAbsent: true,
      threads: [{ cleaned: true, threadId }],
    })
    expect(afterCleanup.attempts).toHaveLength(1)
    expect(afterCleanup.barriers).toHaveLength(1)
    expect(afterCleanup.threads).toHaveLength(1)
    const cleanupHistory = JSON.parse(
      await readFile(join(artifactDir, "cleanup-history.json"), "utf8"),
    )
    expect(cleanupHistory).toBeInstanceOf(Array)
    expect(cleanupHistory.length).toBeGreaterThan(5)
    expect(cleanupHistory.at(-1)).toEqual(afterCleanup)

    await expect(store.persistThread({ kind: "prebuilt", threadId })).rejects.toThrow(
      /duplicate|conflict|thread/,
    )
    await expect(
      store.persistDeploymentCleaned(binding.deploymentId, {
        state: "DELETED",
        uid: "dpl_Different",
      }),
    ).rejects.toThrow(/deployment|delete|uid/)
    await expect(store.writeDiagnostic("../.vercel/project.json", "unsafe")).rejects.toThrow(
      /diagnostic|path/,
    )
    const manifestBeforeReservedWrite = await readFile(
      join(artifactDir, "cleanup-manifest.json"),
      "utf8",
    )
    const partialBeforeReservedWrite = await readFile(
      join(artifactDir, "receipt.partial.json"),
      "utf8",
    )
    for (const reserved of [
      "cleanup-history.json",
      "cleanup-manifest.json",
      "receipt.partial.json",
      "receipt.json",
      "unknown.log",
    ]) {
      await expect(store.writeDiagnostic(reserved, "unsafe overwrite")).rejects.toThrow(
        /diagnostic|path/,
      )
    }
    expect(await readFile(join(artifactDir, "cleanup-manifest.json"), "utf8")).toBe(
      manifestBeforeReservedWrite,
    )
    expect(await readFile(join(artifactDir, "receipt.partial.json"), "utf8")).toBe(
      partialBeforeReservedWrite,
    )
    await expect(
      store.writeDiagnostic("source-build.log", `prefix ${protectedValues[0]} suffix`),
    ).resolves.toBeUndefined()
    expect(await readFile(join(artifactDir, "source-build.log"), "utf8")).toBe(
      "prefix [REDACTED] suffix",
    )

    const symlinkArtifacts = await makeTempDir()
    const symlinkStore = await createNativeEvidenceStore({
      artifactDir: symlinkArtifacts,
      protectedValues,
    })
    await writeFile(join(symlinkArtifacts, "outside.log"), "outside", "utf8")
    await symlink("outside.log", join(symlinkArtifacts, "source-build.log"))
    await expect(symlinkStore.writeDiagnostic("source-build.log", "replacement")).rejects.toThrow(
      /symlink|regular|diagnostic/,
    )
    expect(await readFile(join(symlinkArtifacts, "outside.log"), "utf8")).toBe("outside")
  })

  test.each([
    ["additional key", { extra: true }],
    ["wrong schema", { schemaVersion: 2 }],
    [
      "duplicate thread",
      {
        threads: [
          { cleaned: false, kind: "source", threadId: `t-vcl-${"1".repeat(32)}` },
          { cleaned: false, kind: "source", threadId: `t-vcl-${"1".repeat(32)}` },
        ],
      },
    ],
    ["malformed attempt", { attempts: [{ attempt: { marker: "unsafe" }, cleaned: false }] }],
  ] as const)("rejects a cleanup manifest with %s", async (_label, replacement) => {
    const artifactDir = await makeTempDir()
    const store = await createNativeEvidenceStore({ artifactDir, protectedValues })
    const original = JSON.parse(await readFile(join(artifactDir, "cleanup-manifest.json"), "utf8"))
    expect(() => parseNativeCleanupManifest({ ...original, ...replacement })).toThrow(/manifest/)
    await expect(
      writeFile(
        join(artifactDir, "cleanup-manifest.json"),
        `${JSON.stringify({ ...original, ...replacement })}\n`,
        "utf8",
      ).then(() => createNativeEvidenceStore({ artifactDir, protectedValues })),
    ).rejects.toThrow(/manifest/)
    void store
  })

  test("keeps manifest, partial, and final targets intact across injected atomic rename failures", async () => {
    const artifactDir = await makeTempDir()
    const files = new Map<string, string>()
    let failedTarget: string | undefined
    const atomicJsonOps: AtomicJsonFileOps = {
      randomSuffix: () => "atomic-test",
      remove: async (path) => {
        files.delete(path)
      },
      rename: async (from, to) => {
        if (to === failedTarget) throw new Error("injected atomic rename failure")
        const contents = files.get(from)
        if (contents === undefined) throw new Error("missing atomic temp file")
        files.set(to, contents)
        files.delete(from)
      },
      writeFile: async (path, contents) => {
        if (files.has(path)) throw new Error("atomic temp file already exists")
        files.set(path, contents)
      },
    }
    const store = await createNativeEvidenceStore({
      artifactDir,
      atomicJsonOps,
      protectedValues,
    })
    const manifestPath = join(artifactDir, "cleanup-manifest.json")
    const historyPath = join(artifactDir, "cleanup-history.json")
    const partialPath = join(artifactDir, "receipt.partial.json")
    const finalPath = join(artifactDir, "receipt.json")
    const initialManifest = files.get(manifestPath)
    failedTarget = manifestPath
    await expect(
      store.persistThread({ kind: "source", threadId: `t-vcl-${"7".repeat(32)}` }),
    ).rejects.toThrow(/rename|atomic|persist/)
    expect(files.get(manifestPath)).toBe(initialManifest)
    expect([...files.keys()].some((path) => path.includes("atomic-test"))).toBe(false)

    failedTarget = historyPath
    const historyFailureThread = `t-vcl-${"8".repeat(32)}`
    await expect(
      store.persistThread({ kind: "source", threadId: historyFailureThread }),
    ).rejects.toThrow(/rename|atomic|persist/)
    expect(store.readManifest().threads).toContainEqual({
      cleaned: false,
      kind: "source",
      threadId: historyFailureThread,
    })
    await expect(
      store.persistThread({ kind: "source", threadId: historyFailureThread }),
    ).rejects.toThrow(/duplicate|thread|conflict/)

    failedTarget = undefined
    await store.persistThread({ kind: "source", threadId: `t-vcl-${"7".repeat(32)}` })
    await store.persistProjectBindingVerified()
    for (const [kind, index] of [
      ["source", "0"],
      ["prebuilt", "1"],
    ] as const) {
      const attempt = attemptFor(kind, index)
      const binding = bindingFor(kind, attempt.marker)
      await store.persistAttempt(attempt)
      await store.persistDeploymentReceipt(attempt.marker, {
        canonicalOrigin: binding.canonicalOrigin,
        deploymentId: binding.deploymentId,
      })
      await store.persistDeploymentBinding(attempt.marker, binding)
      failedTarget = partialPath
      const beforePartial = files.get(partialPath)
      await expect(store.persistDeploymentEvidence(kind, withoutCleanup(kind))).rejects.toThrow(
        /rename|atomic|partial|persist/,
      )
      expect(files.get(partialPath)).toBe(beforePartial)
      expect([...files.keys()].some((path) => path.includes("atomic-test"))).toBe(false)
      failedTarget = undefined
      await store.persistDeploymentEvidence(kind, withoutCleanup(kind))
      await store.persistDeploymentCleaned(binding.deploymentId, {
        state: "DELETED",
        uid: binding.deploymentId,
      })
    }
    await store.persistThreadCleaned(`t-vcl-${"7".repeat(32)}`)
    await store.persistDatabaseRowsAbsent()
    failedTarget = finalPath
    await expect(store.finalizeReceipt()).rejects.toThrow(/rename|atomic|final|receipt/)
    expect(files.has(finalPath)).toBe(false)
    expect(files.get(partialPath)).toContain('"complete": false')
    expect([...files.keys()].some((path) => path.includes("atomic-test"))).toBe(false)
  })

  test("reopens authoritative manifest state after an interrupted cleanup-history write", async () => {
    const artifactDir = await makeTempDir()
    const historyPath = join(artifactDir, "cleanup-history.json")
    let failHistoryRename = false
    const store = await createNativeEvidenceStore({
      artifactDir,
      atomicJsonOps: {
        randomSuffix: () => `${Date.now()}-${Math.random()}`,
        remove: async (path) => {
          await rm(path, { force: true })
        },
        rename: async (from, to) => {
          if (to === historyPath && failHistoryRename) {
            failHistoryRename = false
            throw new Error("injected history rename failure")
          }
          await rename(from, to)
        },
        writeFile: async (path, contents) => {
          await writeFile(path, contents, { encoding: "utf8", flag: "wx", mode: 0o600 })
        },
      },
      protectedValues,
    })
    failHistoryRename = true
    const threadId = `t-vcl-${"9".repeat(32)}`
    await expect(store.persistThread({ kind: "source", threadId })).rejects.toThrow(
      /history|rename|atomic/,
    )
    const reopened = await createNativeEvidenceStore({ artifactDir, protectedValues })
    expect(reopened.readManifest().threads).toEqual([{ cleaned: false, kind: "source", threadId }])
    const history = JSON.parse(await readFile(historyPath, "utf8"))
    expect(history.at(-1)).toEqual(reopened.readManifest())
    expect(
      history.filter((entry: unknown) => JSON.stringify(entry) === JSON.stringify(history.at(-1))),
    ).toHaveLength(1)

    const unsafeArtifacts = await makeTempDir()
    await createNativeEvidenceStore({ artifactDir: unsafeArtifacts, protectedValues })
    const unsafePartialPath = join(unsafeArtifacts, "receipt.partial.json")
    const unsafePartial = JSON.parse(await readFile(unsafePartialPath, "utf8"))
    unsafePartial.stages = {
      source: { config: { leaked: encodeURIComponent(protectedValues[0] as string) } },
    }
    await writeFile(unsafePartialPath, JSON.stringify(unsafePartial), "utf8")
    await expect(
      createNativeEvidenceStore({ artifactDir: unsafeArtifacts, protectedValues }),
    ).rejects.toThrow(/protected|partial|evidence/)

    const symlinkArtifacts = await makeTempDir()
    await writeFile(join(symlinkArtifacts, "outside.json"), "{}", "utf8")
    await symlink("outside.json", join(symlinkArtifacts, "cleanup-manifest.json"))
    await expect(
      createNativeEvidenceStore({ artifactDir: symlinkArtifacts, protectedValues }),
    ).rejects.toThrow(/symlink|control|regular/)
  })

  test("prepares only a fixed, whole-directory-rescanned diagnostic upload", async () => {
    const artifactDir = await makeTempDir()
    const store = await createNativeEvidenceStore({ artifactDir, protectedValues })
    await store.writeDiagnostic("source-build.log", "safe source build\n")
    await store.writeDiagnostic("prebuilt-runtime.jsonl", '{"safe":true}\n')
    await mkdir(join(artifactDir, "fixtures", "source", ".vercel"), { recursive: true })
    await writeFile(
      join(artifactDir, "fixtures", "source", ".vercel", "project.json"),
      JSON.stringify({ orgId: protectedValues[1], projectId: protectedValues[2] }),
      "utf8",
    )
    await writeFile(join(artifactDir, "unknown-secret.txt"), protectedValues[0], "utf8")
    const result = await prepareNativeArtifactUpload({ artifactDir, protectedValues })
    expect(result.files.sort()).toEqual([
      "cleanup-history.json",
      "cleanup-manifest.json",
      "prebuilt-runtime.jsonl",
      "receipt.partial.json",
      "source-build.log",
    ])
    expect(await readdir(result.uploadDir)).toEqual(result.files)
    expect(result.files).not.toContain("project.json")
    expect(result.files).not.toContain("unknown-secret.txt")
    for (const name of result.files) {
      const stats = await lstat(join(result.uploadDir, name))
      expect(stats.isFile() && !stats.isSymbolicLink()).toBe(true)
    }

    for (const secret of protectedValues) {
      for (const leaked of [secret, encodeURIComponent(secret)]) {
        const unsafeDir = await makeTempDir()
        await createNativeEvidenceStore({ artifactDir: unsafeDir, protectedValues })
        await writeFile(join(unsafeDir, "cleanup-history.json"), leaked, "utf8")
        await expect(
          prepareNativeArtifactUpload({ artifactDir: unsafeDir, protectedValues }),
        ).rejects.toThrow(/protected|artifact|upload/)
        await expect(lstat(join(unsafeDir, "upload"))).rejects.toMatchObject({ code: "ENOENT" })
      }
    }

    const symlinkDir = await makeTempDir()
    await createNativeEvidenceStore({ artifactDir: symlinkDir, protectedValues })
    await writeFile(join(symlinkDir, "outside.log"), "safe", "utf8")
    await symlink("outside.log", join(symlinkDir, "source-build.log"))
    await expect(
      prepareNativeArtifactUpload({ artifactDir: symlinkDir, protectedValues }),
    ).rejects.toThrow(/symlink|regular|artifact/)
    await expect(
      prepareNativeArtifactUpload({ artifactDir: "relative-artifacts", protectedValues }),
    ).rejects.toThrow(/absolute|artifact/)
  })

  test("drives reconciliation, exact deployment cleanup, and database cleanup from one manifest", async () => {
    const artifactDir = await makeTempDir()
    const store = await createNativeEvidenceStore({ artifactDir, protectedValues })
    const seeded = await seedCleanupEvidence(store)
    const bindingByMarker = new Map(seeded.bindings.map((binding) => [binding.marker, binding]))
    const bindingById = new Map(seeded.bindings.map((binding) => [binding.deploymentId, binding]))
    const deleted = new Set<string>()
    const apiRequests: Array<{ readonly method: string; readonly path: string }> = []
    let nowMs = attemptStartMs
    const result = await cleanupNativeEvidenceStore({
      apiClient: {
        request: async (method, path) => {
          apiRequests.push({ method, path })
          if (path.startsWith("/v9/projects/")) {
            return {
              body: { accountId: "team_Test123", id: "prj_Test456", rootDirectory: null },
              status: 200,
            }
          }
          if (path.startsWith("/v6/deployments?")) {
            const marker = new URL(path, "https://api.vercel.com").searchParams.get(
              "meta-dawnVercelRun",
            )
            const binding = bindingByMarker.get(marker ?? "")
            if (!binding) throw new Error("unexpected reconciliation marker")
            return {
              body: {
                deployments: [
                  {
                    created: binding.createdAt,
                    meta: { dawnVercelRun: binding.marker },
                    state: deleted.has(binding.deploymentId) ? "DELETED" : "READY",
                    uid: binding.deploymentId,
                    url: new URL(binding.canonicalOrigin).hostname,
                  },
                ],
                pagination: { next: null },
              },
              status: 200,
            }
          }
          const deploymentMatch = /^\/v13\/deployments\/(dpl_[A-Za-z0-9]+)\?teamId=/.exec(path)
          const deploymentId = deploymentMatch?.[1]
          const binding = deploymentId ? bindingById.get(deploymentId) : undefined
          if (!binding) throw new Error("unexpected exact deployment request")
          if (method === "DELETE") {
            deleted.add(binding.deploymentId)
            return {
              body: { state: "DELETED", uid: binding.deploymentId },
              status: 200,
            }
          }
          if (deleted.has(binding.deploymentId)) return { body: {}, status: 404 }
          return {
            body: {
              createdAt: binding.createdAt,
              id: binding.deploymentId,
              meta: { dawnVercelRun: binding.marker },
              ownerId: "team_Test123",
              projectId: "prj_Test456",
              target: null,
              url: new URL(binding.canonicalOrigin).hostname,
            },
            status: 200,
          }
        },
      },
      clock: {
        now: () => nowMs,
        sleep: async (milliseconds) => {
          nowMs += milliseconds
        },
      },
      database: {
        query: async ({ params, sql, timeoutMs }) => {
          expect(timeoutMs).toBeGreaterThan(0)
          expect(sql).toContain("to_regclass($1)")
          expect(params).toHaveLength(1)
          return { rows: [{ relation: null }] }
        },
      },
      orgId: "team_Test123",
      projectId: "prj_Test456",
      store,
    })
    expect(result).toEqual({ databaseRowsAbsent: true, deploymentAbsent: true })
    expect(deleted).toEqual(new Set(["dpl_Source1", "dpl_Prebuilt2"]))
    expect(
      apiRequests.filter(({ method, path }) => method === "DELETE" && path.includes("/v13/")),
    ).toEqual([
      { method: "DELETE", path: "/v13/deployments/dpl_Source1?teamId=team_Test123" },
      { method: "DELETE", path: "/v13/deployments/dpl_Prebuilt2?teamId=team_Test123" },
    ])
    const manifest = parseNativeCleanupManifest(
      JSON.parse(await readFile(join(artifactDir, "cleanup-manifest.json"), "utf8")),
    )
    expect(manifest.attempts.every(({ cleaned }) => cleaned)).toBe(true)
    expect(manifest.barriers.every(({ cleaned }) => cleaned)).toBe(true)
    expect(manifest.threads.every(({ cleaned }) => cleaned)).toBe(true)
    expect(manifest.databaseRowsAbsent).toBe(true)
    await expect(store.finalizeReceipt()).resolves.toEqual(validReceipt())
  })

  test("recovers and cleans a marker-only spawn-started attempt with no receipt or binding", async () => {
    const artifactDir = await makeTempDir()
    const store = await createNativeEvidenceStore({ artifactDir, protectedValues })
    const attempt = attemptFor("source", "0")
    const binding = bindingFor("source", attempt.marker)
    await store.persistProjectBindingVerified()
    await store.persistAttempt(attempt)

    let deleted = false
    let nowMs = attemptStartMs
    const requests: Array<{ readonly method: string; readonly path: string }> = []
    await expect(
      cleanupNativeEvidenceStore({
        apiClient: {
          request: async (method, path) => {
            requests.push({ method, path })
            if (path.startsWith("/v9/projects/")) {
              return {
                body: { accountId: "team_Test123", id: "prj_Test456", rootDirectory: null },
                status: 200,
              }
            }
            if (path.startsWith("/v6/deployments?")) {
              return {
                body: {
                  deployments: [
                    {
                      created: binding.createdAt,
                      meta: { dawnVercelRun: binding.marker },
                      state: deleted ? "DELETED" : "READY",
                      uid: binding.deploymentId,
                      url: new URL(binding.canonicalOrigin).hostname,
                    },
                  ],
                  pagination: { next: null },
                },
                status: 200,
              }
            }
            expect(path).toBe(`/v13/deployments/${binding.deploymentId}?teamId=team_Test123`)
            if (method === "DELETE") {
              deleted = true
              return {
                body: { state: "DELETED", uid: binding.deploymentId },
                status: 200,
              }
            }
            if (deleted) return { body: {}, status: 404 }
            return {
              body: {
                createdAt: binding.createdAt,
                id: binding.deploymentId,
                meta: { dawnVercelRun: binding.marker },
                ownerId: "team_Test123",
                projectId: "prj_Test456",
                target: null,
                url: new URL(binding.canonicalOrigin).hostname,
              },
              status: 200,
            }
          },
        },
        clock: {
          now: () => nowMs,
          sleep: async (milliseconds) => {
            nowMs += milliseconds
          },
        },
        database: {
          query: async () => ({ rows: [{ relation: null }] }),
        },
        orgId: "team_Test123",
        projectId: "prj_Test456",
        store,
      }),
    ).resolves.toEqual({ databaseRowsAbsent: true, deploymentAbsent: true })

    expect(
      requests
        .map(({ method, path }) => `${method} ${path}`)
        .filter((entry) => entry.includes("v13")),
    ).toEqual([
      `GET /v13/deployments/${binding.deploymentId}?teamId=team_Test123`,
      `GET /v13/deployments/${binding.deploymentId}?teamId=team_Test123`,
      `DELETE /v13/deployments/${binding.deploymentId}?teamId=team_Test123`,
      `GET /v13/deployments/${binding.deploymentId}?teamId=team_Test123`,
    ])
    const manifest = parseNativeCleanupManifest(
      JSON.parse(await readFile(join(artifactDir, "cleanup-manifest.json"), "utf8")),
    )
    expect(manifest.attempts).toEqual([
      {
        attempt,
        binding,
        cleaned: true,
        deleteReceipt: { state: "DELETED", uid: binding.deploymentId },
        reconciliation: { expectedCardinality: true, zeroLive: false },
      },
    ])
    expect(manifest.databaseRowsAbsent).toBe(true)
  })

  test("retains and cleans every authenticated candidate while cardinality still fails", async () => {
    const artifactDir = await makeTempDir()
    const store = await createNativeEvidenceStore({ artifactDir, protectedValues })
    const attempt = attemptFor("source", "0")
    const receiptBinding = bindingFor("source", attempt.marker)
    const extraBinding = {
      ...receiptBinding,
      canonicalOrigin: "https://dawn-extra-abc.vercel.app",
      deploymentId: "dpl_Extra3",
    }
    await store.persistProjectBindingVerified()
    await store.persistAttempt(attempt)
    await store.persistDeploymentReceipt(attempt.marker, {
      canonicalOrigin: receiptBinding.canonicalOrigin,
      deploymentId: receiptBinding.deploymentId,
    })
    await store.persistDeploymentBinding(attempt.marker, extraBinding)
    await store.persistDeploymentBinding(attempt.marker, extraBinding)

    const bindings = [extraBinding, receiptBinding]
    const deleted = new Set<string>()
    const deleteAttempts: string[] = []
    let nowMs = attemptStartMs
    const caught = await cleanupNativeEvidenceStore({
      apiClient: {
        request: async (method, path) => {
          if (path.startsWith("/v9/projects/")) {
            return {
              body: { accountId: "team_Test123", id: "prj_Test456", rootDirectory: null },
              status: 200,
            }
          }
          if (path.startsWith("/v6/deployments?")) {
            return {
              body: {
                deployments: bindings.map((binding) => ({
                  created: binding.createdAt,
                  meta: { dawnVercelRun: binding.marker },
                  state: deleted.has(binding.deploymentId) ? "DELETED" : "READY",
                  uid: binding.deploymentId,
                  url: new URL(binding.canonicalOrigin).hostname,
                })),
                pagination: { next: null },
              },
              status: 200,
            }
          }
          const deploymentId = /^\/v13\/deployments\/(dpl_[A-Za-z0-9]+)/.exec(path)?.[1]
          const binding = bindings.find((candidate) => candidate.deploymentId === deploymentId)
          if (!binding) throw new Error("unexpected duplicate-candidate request")
          if (method === "DELETE") {
            deleteAttempts.push(binding.deploymentId)
            deleted.add(binding.deploymentId)
            return { body: { state: "DELETED", uid: binding.deploymentId }, status: 200 }
          }
          if (deleted.has(binding.deploymentId)) return { body: {}, status: 404 }
          return {
            body: {
              createdAt: binding.createdAt,
              id: binding.deploymentId,
              meta: { dawnVercelRun: binding.marker },
              ownerId: "team_Test123",
              projectId: "prj_Test456",
              target: null,
              url: new URL(binding.canonicalOrigin).hostname,
            },
            status: 200,
          }
        },
      },
      clock: {
        now: () => nowMs,
        sleep: async (milliseconds) => {
          nowMs += milliseconds
        },
      },
      database: { query: async () => ({ rows: [{ relation: null }] }) },
      orgId: "team_Test123",
      projectId: "prj_Test456",
      store,
    }).then(
      () => undefined,
      (error: unknown) => error,
    )
    expect(caught).toBeInstanceOf(AggregateError)
    expect(deleteAttempts).toEqual([receiptBinding.deploymentId, "dpl_Extra3"])
    const manifest = store.readManifest()
    expect(manifest.attempts[0]?.binding?.deploymentId).toBe(receiptBinding.deploymentId)
    expect(manifest.attempts[0]?.cleaned).toBe(true)
    expect(manifest.attempts[0]?.additionalDeployments).toEqual([
      {
        binding: extraBinding,
        cleaned: true,
        deleteReceipt: { state: "DELETED", uid: extraBinding.deploymentId },
      },
    ])
    expect(manifest.attempts[0]).toMatchObject({
      reconciliation: { expectedCardinality: false, zeroLive: false },
    })
    expect(() =>
      parseNativeCleanupManifest({
        ...manifest,
        attempts: [
          {
            additionalDeployments: [{ binding: extraBinding, cleaned: false }],
            attempt,
            cleaned: false,
            reconciliation: { expectedCardinality: true, zeroLive: true },
          },
        ],
      }),
    ).toThrow(/zero|reconciliation|manifest|deployment/)
  })

  test("persists authenticated zero-live reconciliation and cleans it idempotently", async () => {
    const artifactDir = await makeTempDir()
    const store = await createNativeEvidenceStore({ artifactDir, protectedValues })
    const attempt = attemptFor("source", "0")
    await store.persistProjectBindingVerified()
    await store.persistAttempt(attempt)
    let nowMs = attemptStartMs
    let deletes = 0
    const cleanup = () =>
      cleanupNativeEvidenceStore({
        apiClient: {
          request: async (method, path) => {
            if (method === "DELETE") deletes += 1
            if (path.startsWith("/v9/projects/")) {
              return {
                body: { accountId: "team_Test123", id: "prj_Test456", rootDirectory: null },
                status: 200,
              }
            }
            if (path.startsWith("/v6/deployments?")) {
              return { body: { deployments: [], pagination: { next: null } }, status: 200 }
            }
            throw new Error("zero-live cleanup must not address an exact deployment")
          },
        },
        clock: {
          now: () => nowMs,
          sleep: async (milliseconds) => {
            nowMs += milliseconds
          },
        },
        database: { query: async () => ({ rows: [{ relation: null }] }) },
        orgId: "team_Test123",
        projectId: "prj_Test456",
        store,
      })
    await expect(cleanup()).resolves.toEqual({ databaseRowsAbsent: true, deploymentAbsent: true })
    await expect(cleanup()).resolves.toEqual({ databaseRowsAbsent: true, deploymentAbsent: true })
    expect(deletes).toBe(0)
    expect(store.readManifest().attempts).toEqual([
      {
        attempt,
        cleaned: true,
        reconciliation: { expectedCardinality: true, zeroLive: true },
      },
    ])
  })

  test("retries a dirty additional deployment even after the main deployment is clean", async () => {
    const artifactDir = await makeTempDir()
    const store = await createNativeEvidenceStore({ artifactDir, protectedValues })
    const attempt = attemptFor("source", "0")
    const main = bindingFor("source", attempt.marker)
    const extra = {
      ...main,
      canonicalOrigin: "https://dawn-extra-retry.vercel.app",
      deploymentId: "dpl_ExtraRetry4",
    }
    await store.persistProjectBindingVerified()
    await store.persistAttempt(attempt)
    await store.persistDeploymentReceipt(attempt.marker, {
      canonicalOrigin: main.canonicalOrigin,
      deploymentId: main.deploymentId,
    })
    await store.persistDeploymentBinding(attempt.marker, main)
    await store.persistDeploymentBinding(attempt.marker, extra)
    await store.persistReconciliation(attempt.marker, {
      expectedCardinality: false,
      zeroLive: false,
    })
    await store.persistDeploymentCleaned(main.deploymentId, {
      state: "DELETED",
      uid: main.deploymentId,
    })
    let nowMs = attemptStartMs
    let extraDeleted = false
    const exactRequests: string[] = []
    const caught = await cleanupNativeEvidenceStore({
      apiClient: {
        request: async (method, path) => {
          if (path.startsWith("/v9/projects/")) {
            return {
              body: { accountId: "team_Test123", id: "prj_Test456", rootDirectory: null },
              status: 200,
            }
          }
          if (path.startsWith("/v6/deployments?")) {
            return {
              body: {
                deployments: [
                  {
                    created: extra.createdAt,
                    meta: { dawnVercelRun: extra.marker },
                    state: extraDeleted ? "DELETED" : "READY",
                    uid: extra.deploymentId,
                    url: new URL(extra.canonicalOrigin).hostname,
                  },
                ],
                pagination: { next: null },
              },
              status: 200,
            }
          }
          exactRequests.push(`${method} ${path}`)
          if (method === "DELETE") {
            extraDeleted = true
            return { body: { state: "DELETED", uid: extra.deploymentId }, status: 200 }
          }
          if (extraDeleted) return { body: {}, status: 404 }
          return {
            body: {
              createdAt: extra.createdAt,
              id: extra.deploymentId,
              meta: { dawnVercelRun: extra.marker },
              ownerId: "team_Test123",
              projectId: "prj_Test456",
              target: null,
              url: new URL(extra.canonicalOrigin).hostname,
            },
            status: 200,
          }
        },
      },
      clock: {
        now: () => nowMs,
        sleep: async (milliseconds) => {
          nowMs += milliseconds
        },
      },
      database: { query: async () => ({ rows: [{ relation: null }] }) },
      orgId: "team_Test123",
      projectId: "prj_Test456",
      store,
    }).then(
      () => undefined,
      (error: unknown) => error,
    )
    expect(caught).toBeInstanceOf(AggregateError)
    expect(exactRequests.every((request) => !request.includes(main.deploymentId))).toBe(true)
    expect(exactRequests).toContain(
      `DELETE /v13/deployments/${extra.deploymentId}?teamId=team_Test123`,
    )
    expect(store.readManifest().attempts[0]?.additionalDeployments?.[0]?.cleaned).toBe(true)
    await expect(store.finalizeReceipt()).rejects.toThrow(/cleanup|cardinality|dirty/)
  })

  test("retains dirty flags while independently aggregating deployment and database cleanup failures", async () => {
    const artifactDir = await makeTempDir()
    const store = await createNativeEvidenceStore({ artifactDir, protectedValues })
    const seeded = await seedCleanupEvidence(store)
    const bindingByMarker = new Map(seeded.bindings.map((binding) => [binding.marker, binding]))
    const bindingById = new Map(seeded.bindings.map((binding) => [binding.deploymentId, binding]))
    const attemptedDeletes: string[] = []
    let databaseCalls = 0
    let nowMs = attemptStartMs
    const caught = await cleanupNativeEvidenceStore({
      apiClient: {
        request: async (method, path) => {
          if (path.startsWith("/v9/projects/")) {
            return {
              body: { accountId: "team_Test123", id: "prj_Test456", rootDirectory: null },
              status: 200,
            }
          }
          if (path.startsWith("/v6/deployments?")) {
            const marker = new URL(path, "https://api.vercel.com").searchParams.get(
              "meta-dawnVercelRun",
            )
            const binding = bindingByMarker.get(marker ?? "") as (typeof seeded.bindings)[number]
            return {
              body: {
                deployments: [
                  {
                    created: binding.createdAt,
                    meta: { dawnVercelRun: binding.marker },
                    state: "READY",
                    uid: binding.deploymentId,
                    url: new URL(binding.canonicalOrigin).hostname,
                  },
                ],
                pagination: { next: null },
              },
              status: 200,
            }
          }
          const deploymentId = /^\/v13\/deployments\/(dpl_[A-Za-z0-9]+)/.exec(path)?.[1]
          const binding = deploymentId ? bindingById.get(deploymentId) : undefined
          if (!binding) throw new Error("unexpected deployment request")
          if (method === "DELETE") {
            attemptedDeletes.push(binding.deploymentId)
            return { body: { error: "injected" }, status: 500 }
          }
          return {
            body: {
              createdAt: binding.createdAt,
              id: binding.deploymentId,
              meta: { dawnVercelRun: binding.marker },
              ownerId: "team_Test123",
              projectId: "prj_Test456",
              target: null,
              url: new URL(binding.canonicalOrigin).hostname,
            },
            status: 200,
          }
        },
      },
      clock: {
        now: () => nowMs,
        sleep: async (milliseconds) => {
          nowMs += milliseconds
        },
      },
      database: {
        query: () => {
          databaseCalls += 1
          throw new Error(protectedValues[3])
        },
      },
      orgId: "team_Test123",
      projectId: "prj_Test456",
      store,
    }).then(
      () => undefined,
      (error: unknown) => error,
    )
    expect(attemptedDeletes).toEqual(["dpl_Source1", "dpl_Prebuilt2"])
    expect(databaseCalls).toBe(4)
    expect(caught).toBeInstanceOf(AggregateError)
    expect(String(caught)).not.toContain(protectedValues[3])
    const manifest = parseNativeCleanupManifest(
      JSON.parse(await readFile(join(artifactDir, "cleanup-manifest.json"), "utf8")),
    )
    expect(manifest.attempts.some(({ cleaned }) => cleaned)).toBe(false)
    expect(manifest.databaseRowsAbsent).toBe(false)
    await expect(store.finalizeReceipt()).rejects.toThrow(/cleanup|dirty|receipt/)
  })

  test("closes receipt.partial.json only after both complete kinds and all cleanup postconditions", async () => {
    const artifactDir = await makeTempDir()
    const store = await createNativeEvidenceStore({ artifactDir, protectedValues })
    const order: string[] = []
    const resources = new Map<"prebuilt" | "source", { barrierId: string; threadId: string }>()
    await store.persistProjectBindingVerified()
    const receipt = await runNativeVercelOrchestration({
      cleanupDatabase: async () => {
        order.push("cleanup-database")
        for (const { barrierId, threadId } of resources.values()) {
          await store.persistBarrierCleaned(barrierId)
          await store.persistThreadCleaned(threadId)
        }
        await store.persistDatabaseRowsAbsent()
      },
      cleanupDeployments: async () => {
        order.push("cleanup-deployments")
        for (const kind of ["source", "prebuilt"] as const) {
          const deploymentId = validDeployment(kind).deploymentId
          await store.persistDeploymentCleaned(deploymentId, {
            state: "DELETED",
            uid: deploymentId,
          })
        }
      },
      runKind: async (kind) => {
        order.push(`run-${kind}`)
        const attempt = attemptFor(kind, kind === "source" ? "0" : "1")
        const binding = bindingFor(kind, attempt.marker)
        const threadId = `t-vcl-${kind === "source" ? "3" : "4"}`.padEnd(
          38,
          kind === "source" ? "3" : "4",
        )
        const barrierId = `b-vcl-${kind === "source" ? "5" : "6"}`.padEnd(
          38,
          kind === "source" ? "5" : "6",
        )
        resources.set(kind, { barrierId, threadId })
        await store.persistAttempt(attempt)
        await store.persistDeploymentReceipt(attempt.marker, {
          canonicalOrigin: binding.canonicalOrigin,
          deploymentId: binding.deploymentId,
        })
        await store.persistDeploymentBinding(attempt.marker, binding)
        await store.persistReconciliation(attempt.marker, {
          expectedCardinality: true,
          zeroLive: false,
        })
        await store.persistThread({ kind, threadId })
        await store.persistBarrier({ barrierId, kind, role: "target" })
        return withoutCleanup(kind)
      },
      store,
    })
    expect(receipt).toEqual(validReceipt())
    expect(order).toEqual(["run-source", "run-prebuilt", "cleanup-deployments", "cleanup-database"])
    expect(
      parseNativeReceipt(JSON.parse(await readFile(join(artifactDir, "receipt.json"), "utf8"))),
    ).toEqual(validReceipt())
    const partial = JSON.parse(await readFile(join(artifactDir, "receipt.partial.json"), "utf8"))
    expect(partial).toMatchObject({ complete: false, deployments: expect.any(Object) })
    expect(() => parseNativeReceipt(partial)).toThrow()
  })

  test("wires the actual native lane through assembly, both deployment kinds, shared cleanup, and finalization", async () => {
    const artifactDir = await makeTempDir()
    const sourceRoot = join(artifactDir, "assembled-source")
    const prebuiltRoot = join(artifactDir, "assembled-prebuilt")
    const calls: string[] = []
    const resources = new Map<"prebuilt" | "source", string>()
    const receipt = await runNativeVercelLane({
      env: {
        DAWN_TEST_VERCEL: "1",
        DAWN_VERCEL_ARTIFACT_DIR: artifactDir,
        DAWN_VERCEL_DATABASE_URL: protectedValues[3],
        DAWN_VERCEL_ORG_ID: "team_Test123",
        DAWN_VERCEL_PROJECT_ID: "prj_Test456",
        DAWN_VERCEL_TOKEN: protectedValues[0],
        GITHUB_JOB: "vercel-native",
        GITHUB_REPOSITORY_ID: "123456",
        GITHUB_RUN_ATTEMPT: "2",
        GITHUB_RUN_ID: "987654",
      },
      dependencies: {
        assembleFixtures: async (assemblyOptions) => {
          calls.push("assemble")
          expect(assemblyOptions.repoRoot).toBe(repoRoot)
          return {
            artifacts: [
              {
                packageJson: { name: "@dawn-ai/cli", version: "0.0.0" },
                packageName: "@dawn-ai/cli",
                packageVersion: "0.0.0",
                tarballName: "fixture.tgz",
                tarballPath: join(artifactDir, "fixture.tgz"),
              },
            ],
            closure: [],
            prebuilt: {
              kind: "prebuilt",
              lockfilePath: join(prebuiltRoot, "pnpm-lock.yaml"),
              root: prebuiltRoot,
            },
            runRoot: join(artifactDir, "run"),
            source: {
              kind: "source",
              lockfilePath: join(sourceRoot, "pnpm-lock.yaml"),
              root: sourceRoot,
            },
          }
        },
        cleanupEvidenceStore: async ({ store }) => {
          calls.push("cleanup")
          for (const kind of ["source", "prebuilt"] as const) {
            const deploymentId = validDeployment(kind).deploymentId
            await store.persistDeploymentCleaned(deploymentId, {
              state: "DELETED",
              uid: deploymentId,
            })
            const resourceId = resources.get(kind) as string
            await store.persistThreadCleaned(resourceId)
          }
          await store.persistDatabaseRowsAbsent()
          return { databaseRowsAbsent: true, deploymentAbsent: true }
        },
        runDeploymentKind: async ({ expectedTarballs, fixtureRoot, kind, store }) => {
          calls.push(`run-${kind}`)
          expect(expectedTarballs).toEqual(["fixture.tgz"])
          expect(fixtureRoot).toBe(kind === "source" ? sourceRoot : prebuiltRoot)
          if (kind === "source") await store.persistProjectBindingVerified()
          const attempt = attemptFor(kind, kind === "source" ? "0" : "1")
          const binding = bindingFor(kind, attempt.marker)
          const threadId = `t-vcl-${kind === "source" ? "c" : "d"}`.padEnd(
            38,
            kind === "source" ? "c" : "d",
          )
          resources.set(kind, threadId)
          await store.persistAttempt(attempt)
          await store.persistDeploymentReceipt(attempt.marker, {
            canonicalOrigin: binding.canonicalOrigin,
            deploymentId: binding.deploymentId,
          })
          await store.persistDeploymentBinding(attempt.marker, binding)
          await store.persistReconciliation(attempt.marker, {
            expectedCardinality: true,
            zeroLive: false,
          })
          await store.persistThread({ kind, threadId })
          return withoutCleanup(kind)
        },
      },
    })
    expect(receipt).toEqual(validReceipt())
    expect(calls).toEqual(["assemble", "run-source", "run-prebuilt", "cleanup"])
    expect(
      parseNativeReceipt(JSON.parse(await readFile(join(artifactDir, "receipt.json"), "utf8"))),
    ).toEqual(validReceipt())
  })

  test("binds the env-only native lane to the real assembly, deployment, and shared-cleanup helpers", () => {
    const dependencies = createNativeVercelLaneDependencies()
    expect(dependencies.assembleFixtures).toBe(assembleNativeFixtures)
    expect(dependencies.runDeploymentKind).toBe(runNativeDeploymentKind)
    expect(dependencies.cleanupEvidenceStore).toBe(cleanupNativeEvidenceStore)
    expect(dependencies.createEvidenceStore).toBe(createNativeEvidenceStore)
    expect(dependencies.runLocalCommand).toBe(runNativeLocalChild)
    expect(dependencies.runVercelChild).toBe(runNativeLocalChild)
    expect(dependencies.createFetchAdapters).toBe(createNativeFetchAdapters)
    expect(dependencies.createDatabase).toBe(createNativePostgresDatabase)
    expect(dependencies.createPinnedBoundary).toBe(createNativePinnedVercelBoundary)
    expect(dependencies.runBlackBox).toBe(runNativeVercelBlackBox)
    expect(dependencies.validateOutput).toBe(validateVercelOutput)
    expect(dependencies.createClock()).toMatchObject({
      now: expect.any(Function),
      sleep: expect.any(Function),
    })
    expect(dependencies.createBlackBoxEvidencePersistence).toBe(
      createNativeBlackBoxEvidencePersistence,
    )
  })

  test("default evidence wiring writes incremental event and runtime artifacts", async () => {
    const artifactDir = await makeTempDir()
    const store = await createNativeEvidenceStore({ artifactDir, protectedValues })
    const dependencies = createNativeVercelLaneDependencies()
    const persistence = dependencies.createBlackBoxEvidencePersistence({
      kind: "source",
      store,
    })
    await persistence.persistDispatch("state")
    await persistence.persistSseEvidence({
      after: { data: "after-release", event: "chunk", index: 1 },
      before: { data: "before-release", event: "chunk", index: 0 },
      done: { data: { output: "done" }, event: "done", index: 2 },
    })
    await persistence.persistRuntimeLogSnapshot('{"id":"safe-runtime-row"}')
    await persistence.persistRuntimeLogSnapshot('{"id":"later-runtime-row"}')
    expect(JSON.parse(await readFile(join(artifactDir, "source-events.json"), "utf8"))).toEqual([
      { dispatch: "state" },
      {
        sse: {
          after: { data: "after-release", event: "chunk", index: 1 },
          before: { data: "before-release", event: "chunk", index: 0 },
          done: { data: { output: "done" }, event: "done", index: 2 },
        },
      },
    ])
    expect(await readFile(join(artifactDir, "source-runtime.jsonl"), "utf8")).toBe(
      '{"id":"safe-runtime-row"}\n{"id":"later-runtime-row"}',
    )
    expect(JSON.parse(await readFile(join(artifactDir, "cleanup-history.json"), "utf8"))).toEqual([
      store.readManifest(),
    ])
  })

  test("runs the default lane compositor through leaf seams and preserves staged files after failure", async () => {
    const artifactDir = await makeTempDir()
    const source = await makeUploadFixture("source")
    const prebuilt = await makeUploadFixture("source")
    const vercelConfig = `${JSON.stringify({
      $schema: "https://openapi.vercel.sh/vercel.json",
      buildCommand: "node node_modules/@dawn-ai/cli/dist/index.js build",
      fluid: true,
    })}\n`
    await writeFile(join(source.root, "vercel.json"), vercelConfig, "utf8")
    await writeFile(join(prebuilt.root, "vercel.json"), vercelConfig, "utf8")
    const dawnExecutable = join(prebuilt.root, "node_modules", ".bin", "dawn")
    await mkdir(dirname(dawnExecutable), { recursive: true })
    await writeFile(dawnExecutable, "#!/usr/bin/env node\n", { encoding: "utf8", mode: 0o700 })
    const bindings = new Map<string, ReturnType<typeof bindingFor>>()
    const deleted = new Set<string>()
    let nowMs = Date.now()
    const deployFor = (kind: "prebuilt" | "source", marker: string) => {
      const binding = {
        ...bindingFor(kind, marker),
        createdAt: nowMs,
      }
      bindings.set(marker, binding)
      return {
        canonicalOrigin: binding.canonicalOrigin,
        commandEvidence: kind === "source" ? sourceDeployCommand : prebuiltDeployCommand,
        deploymentId: binding.deploymentId,
      }
    }
    const caught = await runNativeVercelLane({
      env: {
        DAWN_TEST_VERCEL: "1",
        DAWN_VERCEL_ARTIFACT_DIR: artifactDir,
        DAWN_VERCEL_DATABASE_URL: protectedValues[3],
        DAWN_VERCEL_ORG_ID: "team_Test123",
        DAWN_VERCEL_PROJECT_ID: "prj_Test456",
        DAWN_VERCEL_TOKEN: protectedValues[0],
        GITHUB_JOB: "vercel-native",
        GITHUB_REPOSITORY_ID: "123456",
        GITHUB_RUN_ATTEMPT: "2",
        GITHUB_RUN_ID: "987654",
      },
      dependencies: {
        assembleFixtures: async (options) => {
          expect(options.repoRoot).toBe(repoRoot)
          return {
            artifacts: source.expectedTarballs.map((tarballName, index) => ({
              packageJson: { name: `fixture-${index}`, version: "0.0.0" },
              packageName: `fixture-${index}`,
              packageVersion: "0.0.0",
              tarballName,
              tarballPath: join(source.root, "vendor", tarballName),
            })),
            closure: [],
            prebuilt: {
              kind: "prebuilt",
              lockfilePath: join(prebuilt.root, "pnpm-lock.yaml"),
              root: prebuilt.root,
            },
            runRoot: join(artifactDir, "run"),
            source: {
              kind: "source",
              lockfilePath: join(source.root, "pnpm-lock.yaml"),
              root: source.root,
            },
          }
        },
        createClock: () => ({
          now: () => nowMs,
          sleep: async (milliseconds) => {
            nowMs += milliseconds
          },
        }),
        createDatabase: async () => ({
          close: async () => undefined,
          database: createNativeBoundedDatabase({
            query: async () => ({ rows: [{ relation: null }] }),
          }),
        }),
        createFetchAdapters: () => ({
          apiTransport: async (request) => {
            const url = new URL(request.url)
            if (url.pathname.startsWith("/v9/projects/")) {
              return {
                body: { accountId: "team_Test123", id: "prj_Test456", rootDirectory: null },
                status: 200,
              }
            }
            if (url.pathname === "/v6/deployments") {
              const binding = bindings.get(url.searchParams.get("meta-dawnVercelRun") ?? "")
              return {
                body: {
                  deployments:
                    binding && !deleted.has(binding.deploymentId)
                      ? [
                          {
                            created: binding.createdAt,
                            meta: { dawnVercelRun: binding.marker },
                            state: "READY",
                            uid: binding.deploymentId,
                            url: new URL(binding.canonicalOrigin).hostname,
                          },
                        ]
                      : [],
                  pagination: { next: null },
                },
                status: 200,
              }
            }
            const deploymentId = url.pathname.split("/").at(-1) as string
            const binding = [...bindings.values()].find(
              (candidate) => candidate.deploymentId === deploymentId,
            )
            if (!binding || deleted.has(deploymentId)) return { body: {}, status: 404 }
            if (request.method === "DELETE") {
              deleted.add(deploymentId)
              return { body: { state: "DELETED", uid: deploymentId }, status: 200 }
            }
            return {
              body: {
                createdAt: binding.createdAt,
                id: deploymentId,
                meta: { dawnVercelRun: binding.marker },
                ownerId: "team_Test123",
                projectId: "prj_Test456",
                target: null,
                url: new URL(binding.canonicalOrigin).hostname,
              },
              status: 200,
            }
          },
          blackBoxRequest: async () => new Response(),
          withTimeout: async (_label, _timeoutMs, operation) => await operation,
        }),
        createPinnedBoundary: async () => ({
          assertVersion: async () => undefined,
          deploy: async ({ kind, marker }) => deployFor(kind, marker),
          inspect: async () => ({ readyState: "READY" as const }),
          inspectBuildLogs: async ({ deploymentId }) => {
            const kind = deploymentId === "dpl_Source1" ? "source" : "prebuilt"
            const transcript = buildTranscript(
              deploymentId,
              kind === "source" ? sourceBuildPayloads : ["Using prebuilt build output"],
            )
            return {
              evidence: parseNativeVercelBuildLogTranscript({
                deploymentId,
                stderr: transcript,
                stdout: "",
              }),
              redactedTranscript: transcript,
            }
          },
          logs: async () => "",
        }),
        runBlackBox: async (options) => {
          await options.persistDispatch("state")
          await options.persistSseEvidence?.({
            after: { data: "after-release", event: "chunk", index: 1 },
            before: { data: "before-release", event: "chunk", index: 0 },
            done: { data: { output: "done" }, event: "done", index: 2 },
          })
          await options.persistRuntimeLogSnapshot?.('{"id":"safe-runtime-row"}\n')
          const kind = options.canonicalOrigin.includes("prebuilt") ? "prebuilt" : "source"
          const complete = withoutCleanup(kind)
          const persistStage = options.persistStage
          if (!persistStage) throw new Error("injected functional stage persistence is missing")
          await persistStage("state", complete.state)
          await persistStage("routes", complete.routes)
          await persistStage("stream", complete.stream)
          if (kind === "prebuilt") throw new Error("injected later failure")
          await persistStage("logs", complete.logs)
          return {
            laterRequest: complete.laterRequest,
            logs: complete.logs,
            middleware: complete.middleware,
            routes: complete.routes,
            state: complete.state,
            stream: complete.stream,
          }
        },
        runVercelChild: async (request) => {
          const output = join(request.cwd, ".vercel", "output", "functions", "index.func")
          await mkdir(output, { recursive: true })
          await writeFile(join(request.cwd, ".vercel", "output", "config.json"), "{}\n", "utf8")
          await writeFile(join(output, "index.mjs"), "export default {}\n", "utf8")
          return { exitCode: 0, stderr: "", stdout: "Build complete\n" }
        },
        validateOutput: async () => undefined,
      },
    }).then(
      () => undefined,
      (error: unknown) => error,
    )
    expect(caught).toBeInstanceOf(AggregateError)
    for (const name of [
      "source-build.log",
      "source-events.json",
      "source-runtime.jsonl",
      "prebuilt-build.log",
      "prebuilt-events.json",
      "prebuilt-local-build.log",
      "prebuilt-runtime.jsonl",
      "receipt.partial.json",
      "cleanup-history.json",
    ]) {
      expect((await readFile(join(artifactDir, name), "utf8")).length).toBeGreaterThan(0)
    }
    const partial = JSON.parse(await readFile(join(artifactDir, "receipt.partial.json"), "utf8"))
    expect(await readFile(join(artifactDir, "prebuilt-local-build.log"), "utf8")).toContain(
      "Build complete",
    )
    expect(partial.deployments).toHaveProperty("source")
    expect(partial.deployments).not.toHaveProperty("prebuilt")
    expect(partial.complete).toBe(false)
    expect(partial.stages.source).toMatchObject({
      logs: expect.any(Object),
      routes: expect.any(Object),
      state: expect.any(Object),
      stream: expect.any(Object),
    })
    expect(partial.stages.prebuilt).toMatchObject({
      deploy: expect.any(Object),
      provenance: expect.any(Object),
      readiness: { readyState: "READY" },
      routes: expect.any(Object),
      state: expect.any(Object),
      stream: expect.any(Object),
    })
    expect(partial.stages.prebuilt).not.toHaveProperty("logs")
  })

  test("owns default database close across initialization, primary failure, and close deadlines", async () => {
    const artifactDir = await makeTempDir()
    const sourceRoot = join(artifactDir, "source")
    const prebuiltRoot = join(artifactDir, "prebuilt")
    const closeAfterInitFailure = vi.fn(async () => undefined)
    await expect(
      runNativeVercelLane({
        env: {
          DAWN_TEST_VERCEL: "1",
          DAWN_VERCEL_ARTIFACT_DIR: artifactDir,
          DAWN_VERCEL_DATABASE_URL: protectedValues[3],
          DAWN_VERCEL_ORG_ID: "team_Test123",
          DAWN_VERCEL_PROJECT_ID: "prj_Test456",
          DAWN_VERCEL_TOKEN: protectedValues[0],
          GITHUB_JOB: "vercel-native",
          GITHUB_REPOSITORY_ID: "123456",
          GITHUB_RUN_ATTEMPT: "2",
          GITHUB_RUN_ID: "987654",
        },
        dependencies: {
          assembleFixtures: async (assemblyOptions) => {
            expect(assemblyOptions.repoRoot).toBe(repoRoot)
            return {
              artifacts: [],
              closure: [],
              prebuilt: {
                kind: "prebuilt",
                lockfilePath: join(prebuiltRoot, "pnpm-lock.yaml"),
                root: prebuiltRoot,
              },
              runRoot: join(artifactDir, "run"),
              source: {
                kind: "source",
                lockfilePath: join(sourceRoot, "pnpm-lock.yaml"),
                root: sourceRoot,
              },
            }
          },
          createDatabase: async () => ({
            close: closeAfterInitFailure,
            database: createNativeBoundedDatabase({ query: async () => ({ rows: [] }) }),
          }),
          createPinnedBoundary: async () => {
            throw new Error("protected boundary initialization detail")
          },
        },
      }),
    ).rejects.toThrow(/native|initialization|boundary|execution/)
    expect(closeAfterInitFailure).toHaveBeenCalledTimes(1)

    const primary = new Error("primary failure")
    const secondary = new Error("secondary cleanup failure")
    const combined = await runNativeOwnedOperation({
      close: async () => {
        throw new Error("sensitive close failure")
      },
      closeTimeoutMs: 50,
      operation: async () => {
        throw new AggregateError([primary, secondary], "orchestration failed", {
          cause: primary,
        })
      },
    }).then(
      () => undefined,
      (error: unknown) => error,
    )
    expect(combined).toBeInstanceOf(AggregateError)
    expect((combined as AggregateError).errors.slice(0, 2)).toEqual([primary, secondary])
    expect((combined as Error & { cause?: unknown }).cause).toBe(primary)
    expect(String(combined)).not.toContain("sensitive close failure")

    const closeStartedAt = Date.now()
    await expect(
      runNativeOwnedOperation({
        close: () => new Promise<never>(() => {}),
        closeTimeoutMs: 25,
        operation: async () => "complete",
      }),
    ).rejects.toThrow(/close|deadline|resource/)
    expect(Date.now() - closeStartedAt).toBeLessThan(1_000)
  })

  test("runs sanitized explicit-env children and kills them at a finite deadline", async () => {
    const root = await makeTempDir()
    const completed = await runNativeLocalChild({
      args: [
        "-e",
        "process.stdout.write(JSON.stringify({safe:process.env.SAFE_VALUE,secret:process.env.DAWN_VERCEL_TOKEN}))",
      ],
      cwd: root,
      env: { SAFE_VALUE: "present" },
      executable: process.execPath,
      timeoutMs: 2_000,
    })
    expect(completed).toEqual({
      exitCode: 0,
      stderr: "",
      stdout: '{"safe":"present"}',
    })
    await expect(
      runNativeLocalChild({
        args: ["-e", "setInterval(() => {}, 1_000)"],
        cwd: root,
        env: {},
        executable: process.execPath,
        timeoutMs: 50,
      }),
    ).rejects.toThrow(/timeout|deadline|child/)

    if (process.platform !== "win32") {
      const sentinel = join(root, "grandchild-leak.txt")
      const grandchildScript = `setTimeout(() => require("node:fs").writeFileSync(${JSON.stringify(sentinel)}, "leaked"), 250)`
      const parentScript = [
        'const { spawn } = require("node:child_process")',
        `spawn(process.execPath, ["-e", ${JSON.stringify(grandchildScript)}])`,
        "setInterval(() => {}, 1000)",
      ].join(";")
      await expect(
        runNativeLocalChild({
          args: ["-e", parentScript],
          cwd: root,
          env: {},
          executable: process.execPath,
          timeoutMs: 50,
        }),
      ).rejects.toThrow(/timeout|deadline|child/)
      await new Promise((resolve) => setTimeout(resolve, 350))
      await expect(lstat(sentinel)).rejects.toMatchObject({ code: "ENOENT" })
    }

    const fakeChild = new EventEmitter() as EventEmitter & {
      kill: () => boolean
      pid: number
      stderr: PassThrough
      stdout: PassThrough
    }
    fakeChild.pid = 4242
    fakeChild.stdout = new PassThrough()
    fakeChild.stderr = new PassThrough()
    fakeChild.kill = () => false
    const noCloseKills: number[] = []
    const noCloseRunner = createNativeChildRunner({
      killProcessTree: (child) => {
        noCloseKills.push(child.pid as number)
        return false
      },
      spawnChild: () => fakeChild,
    })
    const noCloseStartedAt = Date.now()
    await expect(
      noCloseRunner({
        args: [],
        cwd: root,
        env: {},
        executable: process.execPath,
        timeoutMs: 25,
      }),
    ).rejects.toThrow(/timeout|deadline|child/)
    expect(Date.now() - noCloseStartedAt).toBeLessThan(1_000)
    expect(noCloseKills).toEqual([4242])

    const overflowChild = new EventEmitter() as typeof fakeChild
    overflowChild.pid = 4343
    overflowChild.stdout = new PassThrough()
    overflowChild.stderr = new PassThrough()
    overflowChild.kill = () => false
    const overflowKills: number[] = []
    const overflowRunner = createNativeChildRunner({
      killProcessTree: (child) => {
        overflowKills.push(child.pid as number)
        throw new Error("injected kill failure")
      },
      spawnChild: () => overflowChild,
    })
    const overflowPromise = overflowRunner({
      args: [],
      cwd: root,
      env: {},
      executable: process.execPath,
      timeoutMs: 2_000,
    })
    overflowChild.stdout.write(Buffer.alloc(8 * 1024 * 1024 + 1))
    await expect(overflowPromise).rejects.toThrow(/output|bounded|child/)
    expect(overflowKills).toEqual([4343])

    const staleChild = new EventEmitter() as typeof fakeChild
    staleChild.pid = 4344
    staleChild.stdout = new PassThrough()
    staleChild.stderr = new PassThrough()
    staleChild.kill = () => true
    const staleKills = vi.fn(() => true)
    const staleRunner = createNativeChildRunner({
      killProcessTree: staleKills,
      spawnChild: () => staleChild,
    })
    const stalePromise = staleRunner({
      args: [],
      cwd: root,
      env: {},
      executable: process.execPath,
      timeoutMs: 1_000,
    })
    staleChild.emit("error", new Error("spawn failed"))
    staleChild.emit("close", 1, null)
    await expect(stalePromise).rejects.toThrow(/spawn|child/)
    await Promise.resolve()
    expect(staleKills).not.toHaveBeenCalled()
  })

  test("decodes split UTF-8 child output without corrupting readiness evidence", async () => {
    const root = await makeTempDir()
    const child = new EventEmitter() as EventEmitter & {
      kill: () => boolean
      pid: number
      stderr: PassThrough
      stdout: PassThrough
    }
    child.pid = 4444
    child.stdout = new PassThrough()
    child.stderr = new PassThrough()
    child.kill = () => true
    const runner = createNativeChildRunner({ spawnChild: () => child })
    const result = runner({
      args: [],
      cwd: root,
      env: {},
      executable: process.execPath,
      timeoutMs: 1_000,
    })
    const ready = Buffer.from("● Ready")
    child.stdout.write(ready.subarray(0, 1))
    child.stdout.write(ready.subarray(1, 2))
    child.stdout.write(ready.subarray(2))
    const stderr = Buffer.from("● stderr")
    child.stderr.write(stderr.subarray(0, 2))
    child.stderr.write(stderr.subarray(2))
    child.emit("close", 0, null)
    await expect(result).resolves.toEqual({
      exitCode: 0,
      stderr: "● stderr",
      stdout: "● Ready",
    })
  })

  test("observes bounded Windows tree termination and rejects unsafe PIDs", async () => {
    const killer = new EventEmitter() as EventEmitter & {
      kill: (signal?: NodeJS.Signals) => boolean
    }
    const killerKill = vi.fn((_signal?: NodeJS.Signals) => true)
    killer.kill = killerKill
    const spawnCalls: Array<{ executable: string; args: readonly string[] }> = []
    const successful = runNativeWindowsTaskkill(4512, (executable, args) => {
      spawnCalls.push({ executable, args })
      return killer
    })
    killer.emit("close", 0)
    await expect(successful).resolves.toBe(true)
    expect(spawnCalls).toEqual([{ executable: "taskkill", args: ["/PID", "4512", "/T", "/F"] }])

    const stalledKiller = new EventEmitter() as typeof killer
    const stalledKillerKill = vi.fn((_signal?: NodeJS.Signals) => true)
    stalledKiller.kill = stalledKillerKill
    const startedAt = Date.now()
    await expect(runNativeWindowsTaskkill(4513, () => stalledKiller, 25)).resolves.toBe(false)
    expect(Date.now() - startedAt).toBeLessThan(1_000)
    expect(stalledKillerKill).toHaveBeenCalledWith("SIGKILL")

    const invalidSpawn = vi.fn()
    for (const invalidPid of [0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1]) {
      await expect(runNativeWindowsTaskkill(invalidPid, invalidSpawn)).resolves.toBe(false)
    }
    expect(invalidSpawn).not.toHaveBeenCalled()

    const root = await makeTempDir()
    const windowsChild = new EventEmitter() as EventEmitter & {
      kill: (signal?: NodeJS.Signals) => boolean
      pid: number
      stderr: PassThrough
      stdout: PassThrough
    }
    windowsChild.pid = 4514
    windowsChild.stdout = new PassThrough()
    windowsChild.stderr = new PassThrough()
    const windowsChildKill = vi.fn((_signal?: NodeJS.Signals) => false)
    windowsChild.kill = windowsChildKill
    const dispatched: number[] = []
    const windowsRunner = createNativeChildRunner({
      platform: "win32",
      runWindowsTaskkill: async (pid) => {
        dispatched.push(pid)
        return await new Promise<boolean>(() => {})
      },
      spawnChild: () => windowsChild,
    })
    await expect(
      windowsRunner({
        args: [],
        cwd: root,
        env: {},
        executable: process.execPath,
        timeoutMs: 25,
      }),
    ).rejects.toThrow(/timeout|deadline|child/)
    expect(dispatched).toEqual([4514])
    expect(windowsChildKill).toHaveBeenCalledWith("SIGKILL")
  })

  test("binds manual-redirect timed fetch, body deadlines, and bounded SQL at leaf adapters", async () => {
    const fetchCalls: Array<{ readonly input: string; readonly init: RequestInit }> = []
    const adapters = createNativeFetchAdapters(async (input, init = {}) => {
      fetchCalls.push({ input: String(input), init })
      return new Response('{"ok":true}', {
        headers: { "content-type": "application/json" },
        status: 200,
      })
    })
    await expect(
      adapters.apiTransport({
        headers: { authorization: "Bearer redacted" },
        method: "GET",
        redirect: "manual",
        timeoutMs: 250,
        url: "https://api.vercel.com/v9/projects/prj_Test456?teamId=team_Test123",
      }),
    ).resolves.toEqual({ body: { ok: true }, status: 200 })
    await expect(
      adapters.blackBoxRequest({
        body: { safe: true },
        headers: new Headers({ "content-type": "application/json" }),
        method: "POST",
        redirect: "manual",
        timeoutMs: 250,
        url: "https://dawn-source-abc.vercel.app/threads/t-vcl-test/runs/wait",
      }),
    ).resolves.toBeInstanceOf(Response)
    expect(fetchCalls).toHaveLength(2)
    for (const { init } of fetchCalls) {
      expect(init.redirect).toBe("manual")
      expect(init.signal).toBeInstanceOf(AbortSignal)
    }
    expect(fetchCalls[1]?.init.body).toBe('{"safe":true}')
    await expect(
      adapters.withTimeout("body read", 25, new Promise<never>(() => {})),
    ).rejects.toThrow(/body read|timeout|deadline/)

    const database = createNativeBoundedDatabase({
      query: async (sql, params) => ({ rows: [{ params, sql }] }),
    })
    await expect(
      database.query({ params: ["bound"], sql: "SELECT $1", timeoutMs: 250 }),
    ).resolves.toEqual({ rows: [{ params: ["bound"], sql: "SELECT $1" }] })
    const blockedDatabase = createNativeBoundedDatabase({
      query: () => new Promise<never>(() => {}),
    })
    await expect(
      blockedDatabase.query({ params: [], sql: "SELECT 1", timeoutMs: 25 }),
    ).rejects.toThrow(/database|query|timeout|deadline/)
  })

  test("aborts stalled headers and bodies and stops incrementally at the API byte cap", async () => {
    const alreadyExpired = createNativeDeadlineOwner(5)
    await new Promise((resolve) => setTimeout(resolve, 20))
    const lateAbort = vi.fn()
    alreadyExpired.onAbort(lateAbort)
    expect(lateAbort).toHaveBeenCalledTimes(1)
    expect(alreadyExpired.aborted()).toBe(true)

    let headerAborted = false
    const stalledHeaders = createNativeFetchAdapters(
      async (_input, init = {}) =>
        await new Promise<Response>((_resolve, reject) => {
          init.signal?.addEventListener(
            "abort",
            () => {
              headerAborted = true
              reject(new Error("aborted"))
            },
            { once: true },
          )
        }),
    )
    await expect(
      stalledHeaders.apiTransport({
        headers: {},
        method: "GET",
        redirect: "manual",
        timeoutMs: 25,
        url: "https://api.vercel.com/v9/projects/prj_Test456?teamId=team_Test123",
      }),
    ).rejects.toThrow(/fetch|deadline|timeout/)
    expect(headerAborted).toBe(true)

    let bodyAborted = false
    let bodyCancelled = false
    const stalledBody = createNativeFetchAdapters(async (_input, init = {}) => {
      const signal = init.signal
      return new Response(
        new ReadableStream({
          cancel: () => {
            bodyCancelled = true
          },
          start: () => {
            signal?.addEventListener(
              "abort",
              () => {
                bodyAborted = true
              },
              { once: true },
            )
          },
        }),
        { status: 200 },
      )
    })
    await expect(
      stalledBody.apiTransport({
        headers: {},
        method: "GET",
        redirect: "manual",
        timeoutMs: 25,
        url: "https://api.vercel.com/v13/deployments/dpl_Test?teamId=team_Test123",
      }),
    ).rejects.toThrow(/body|deadline|API/)
    expect(bodyAborted).toBe(true)
    expect(bodyCancelled).toBe(true)

    let pulls = 0
    let overflowCancelled = false
    const overflowing = createNativeFetchAdapters(
      async () =>
        new Response(
          new ReadableStream({
            cancel: () => {
              overflowCancelled = true
            },
            pull: (controller) => {
              pulls += 1
              controller.enqueue(new Uint8Array(600_000))
            },
          }),
        ),
    )
    await expect(
      overflowing.apiTransport({
        headers: {},
        method: "GET",
        redirect: "manual",
        timeoutMs: 1_000,
        url: "https://api.vercel.com/v6/deployments?teamId=team_Test123",
      }),
    ).rejects.toThrow(/body|bounded|limit/)
    expect(pulls).toBeLessThanOrEqual(3)
    expect(overflowCancelled).toBe(true)

    const blackBoxResponse = await stalledBody.blackBoxRequest({
      headers: new Headers(),
      method: "GET",
      redirect: "manual",
      timeoutMs: 25,
      url: "https://dawn-source-abc.vercel.app/threads/t-vcl-test/state",
    })
    await expect(blackBoxResponse.json()).rejects.toThrow()

    const validThenStalled = createNativeFetchAdapters(
      async () =>
        new Response(
          new ReadableStream({
            start: (controller) => controller.enqueue(new TextEncoder().encode('{"ok":true}')),
          }),
        ),
    )
    const validJsonResponse = await validThenStalled.blackBoxRequest({
      headers: new Headers(),
      method: "GET",
      redirect: "manual",
      timeoutMs: 25,
      url: "https://dawn-source-abc.vercel.app/threads/t-vcl-test/state",
    })
    await expect(validJsonResponse.json()).rejects.toThrow(/deadline|abort|body|stream/)
    const stalledSseResponse = await validThenStalled.blackBoxRequest({
      headers: new Headers(),
      method: "GET",
      redirect: "manual",
      timeoutMs: 25,
      url: "https://dawn-source-abc.vercel.app/threads/t-vcl-test/runs/stream",
    })
    const stalledSseReader = stalledSseResponse.body?.getReader()
    await expect(stalledSseReader?.read()).resolves.toMatchObject({ done: false })
    await expect(stalledSseReader?.read()).rejects.toThrow(/deadline|abort|body|stream/)
  })

  test("constructs the default Postgres pool and sends bounded query configuration", async () => {
    const constructed: unknown[] = []
    const queries: unknown[] = []
    let ended = 0
    class FakePool {
      constructor(options: unknown) {
        constructed.push(options)
      }
      on() {}
      async end() {
        ended += 1
      }
      async query(config: unknown) {
        queries.push(config)
        return { rows: [{ ok: true }] }
      }
    }
    const postgres = await createNativePostgresDatabase("postgres://fixture", async () => ({
      Pool: FakePool,
    }))
    expect(constructed).toEqual([
      {
        connectionString: "postgres://fixture",
        connectionTimeoutMillis: 10_000,
        idleTimeoutMillis: 30_000,
        max: 2,
        query_timeout: 5_000,
        statement_timeout: 5_000,
      },
    ])
    await expect(
      postgres.database.query({ params: ["bound"], sql: "SELECT $1", timeoutMs: 250 }),
    ).resolves.toEqual({ rows: [{ ok: true }] })
    expect(queries).toEqual([{ query_timeout: 250, text: "SELECT $1", values: ["bound"] }])

    for (const malformed of [
      { params: [], sql: "", timeoutMs: 250 },
      { params: [], sql: "SELECT 1", timeoutMs: 0 },
    ]) {
      await expect(postgres.database.query(malformed)).rejects.toThrow(/database|query|malformed/)
    }
    expect(queries).toHaveLength(1)
    await postgres.close()
    expect(ended).toBe(1)

    class ThrowingPool {
      on() {}
      async end() {}
      query(): Promise<{ readonly rows: unknown[] }> {
        throw new Error(protectedValues[3])
      }
    }
    const throwing = await createNativePostgresDatabase("postgres://fixture", async () => ({
      Pool: ThrowingPool,
    }))
    await expect(
      throwing.database.query({ params: [], sql: "SELECT 1", timeoutMs: 250 }),
    ).rejects.not.toThrow(protectedValues[3])
  })

  test("attempts cleanup after a primary failure but never manufactures missing functional evidence", async () => {
    const artifactDir = await makeTempDir()
    const store = await createNativeEvidenceStore({ artifactDir, protectedValues })
    const primary = new Error("prebuilt functional proof failed")
    const calls: string[] = []
    const caught = await runNativeVercelOrchestration({
      cleanupDatabase: async () => {
        calls.push("database")
        await store.persistDatabaseRowsAbsent()
      },
      cleanupDeployments: async () => {
        calls.push("deployments")
        await store.persistDeploymentCleaned("dpl_Source1", {
          state: "DELETED",
          uid: "dpl_Source1",
        })
      },
      runKind: async (kind) => {
        calls.push(kind)
        if (kind === "prebuilt") throw primary
        const attempt = attemptFor(kind, "0")
        const binding = bindingFor(kind, attempt.marker)
        await store.persistAttempt(attempt)
        await store.persistDeploymentReceipt(attempt.marker, {
          canonicalOrigin: binding.canonicalOrigin,
          deploymentId: binding.deploymentId,
        })
        await store.persistDeploymentBinding(attempt.marker, binding)
        return withoutCleanup(kind)
      },
      store,
    }).then(
      () => undefined,
      (error: unknown) => error,
    )
    expect(calls).toEqual(["source", "prebuilt", "deployments", "database"])
    expect(caught).toBeInstanceOf(AggregateError)
    expect((caught as AggregateError).cause).toBe(primary)
    expect((caught as AggregateError).errors[0]).toBe(primary)
    await expect(readFile(join(artifactDir, "receipt.json"), "utf8")).rejects.toMatchObject({
      code: "ENOENT",
    })
    const partial = JSON.parse(await readFile(join(artifactDir, "receipt.partial.json"), "utf8"))
    expect(partial.deployments).toHaveProperty("source")
    expect(partial.deployments).not.toHaveProperty("prebuilt")
  })

  test("runs the workflow cleanup CLI modes through the shared store without external access", async () => {
    // @ts-expect-error The checked-in workflow entrypoint is intentionally plain ESM.
    const cleanupModule = await import("./helpers/vercel-native-cleanup.mjs")
    expect(cleanupModule.runNativeVercelCleanup).toBeTypeOf("function")
    expect(cleanupModule.runNativeVercelCleanupCli).toBeTypeOf("function")
    await expect(cleanupModule.runNativeVercelCleanupCli({ argv: [], env: {} })).rejects.toThrow(
      /mode|cleanup|receipt|artifact/,
    )
    await expect(
      cleanupModule.runNativeVercelCleanupCli({
        argv: ["--cleanup", "--assert-receipt"],
        env: {},
      }),
    ).rejects.toThrow(/mode|exclusive|argument/)

    const artifactDir = await makeTempDir()
    const assertionStore = await createNativeEvidenceStore({ artifactDir, protectedValues })
    const assertionSeed = await seedCleanupEvidence(assertionStore)
    for (const binding of assertionSeed.bindings) {
      await assertionStore.persistReconciliation(binding.marker, {
        expectedCardinality: true,
        zeroLive: false,
      })
      await assertionStore.persistDeploymentCleaned(binding.deploymentId, {
        state: "DELETED",
        uid: binding.deploymentId,
      })
    }
    for (const barrierId of assertionSeed.barrierIds) {
      await assertionStore.persistBarrierCleaned(barrierId)
    }
    for (const threadId of assertionSeed.threadIds) {
      await assertionStore.persistThreadCleaned(threadId)
    }
    await assertionStore.persistDatabaseRowsAbsent()
    await assertionStore.finalizeReceipt()
    await writeFile(
      join(artifactDir, "vitest.json"),
      JSON.stringify({
        numFailedTestSuites: 0,
        numFailedTests: 0,
        numPassedTestSuites: 14,
        numPassedTests: 280,
        numPendingTestSuites: 0,
        numPendingTests: 0,
        numTodoTests: 0,
        numTotalTestSuites: 14,
        numTotalTests: 280,
        success: true,
        testResults: [
          {
            assertionResults: [
              ...Array.from({ length: 279 }, (_, index) => ({
                status: "passed",
                title: `validates pure helper ${index}`,
              })),
              { status: "passed", title: "runs two native Vercel previews" },
            ],
            name: join(cliPackageRoot, "test", "vercel-native-lane.test.ts"),
            status: "passed",
          },
        ],
      }),
      "utf8",
    )
    await expect(
      cleanupModule.runNativeVercelCleanupCli({
        argv: ["--assert-receipt"],
        env: { DAWN_VERCEL_ARTIFACT_DIR: artifactDir },
      }),
    ).resolves.toMatchObject({ mode: "assert-receipt" })
    const manifestPath = join(artifactDir, "cleanup-manifest.json")
    const receiptPath = join(artifactDir, "receipt.json")
    const closedManifest = await readFile(manifestPath, "utf8")
    const closedReceipt = await readFile(receiptPath, "utf8")
    const mismatchedReceipt = JSON.parse(closedReceipt)
    mismatchedReceipt.deployments[0].deploymentId = "dpl_MismatchedReceipt01"
    mismatchedReceipt.deployments[0].canonicalOrigin = "https://mismatched-receipt.vercel.app"
    await writeFile(receiptPath, JSON.stringify(mismatchedReceipt), "utf8")
    await expect(
      cleanupModule.runNativeVercelCleanupCli({
        argv: ["--assert-receipt"],
        env: { DAWN_VERCEL_ARTIFACT_DIR: artifactDir },
      }),
    ).rejects.toThrow(/receipt does not match cleanup manifest/)
    await writeFile(receiptPath, closedReceipt, "utf8")
    const zeroLiveManifest = JSON.parse(closedManifest)
    for (const attempt of zeroLiveManifest.attempts) {
      delete attempt.binding
      delete attempt.deleteReceipt
      delete attempt.deploymentReceipt
      delete attempt.additionalDeployments
      attempt.cleaned = true
      attempt.reconciliation = { expectedCardinality: true, zeroLive: true }
    }
    await writeFile(manifestPath, JSON.stringify(zeroLiveManifest), "utf8")
    await expect(
      cleanupModule.runNativeVercelCleanupCli({
        argv: ["--assert-receipt"],
        env: { DAWN_VERCEL_ARTIFACT_DIR: artifactDir },
      }),
    ).rejects.toThrow(/cleanup|receipt|manifest|binding/)
    await writeFile(manifestPath, closedManifest, "utf8")
    const receiptRealPath = join(artifactDir, "receipt.real.json")
    await rename(receiptPath, receiptRealPath)
    await symlink(receiptRealPath, receiptPath)
    await expect(
      cleanupModule.runNativeVercelCleanupCli({
        argv: ["--assert-receipt"],
        env: { DAWN_VERCEL_ARTIFACT_DIR: artifactDir },
      }),
    ).rejects.toThrow(/receipt|evidence|regular|symlink|unreadable/)
    await rm(receiptPath)
    await rename(receiptRealPath, receiptPath)
    const artifactParent = await makeTempDir()
    const symlinkedArtifactDir = join(artifactParent, "artifact-link")
    await symlink(artifactDir, symlinkedArtifactDir)
    await expect(
      cleanupModule.runNativeVercelCleanupCli({
        argv: ["--assert-receipt"],
        env: { DAWN_VERCEL_ARTIFACT_DIR: symlinkedArtifactDir },
      }),
    ).rejects.toThrow(/artifact|directory|regular|symlink/)
    const invalidVitestPath = join(artifactDir, "vitest.json")
    const validVitest = await readFile(invalidVitestPath, "utf8")
    const incompleteVitest = JSON.parse(validVitest)
    incompleteVitest.numPendingTests = 1
    incompleteVitest.numPassedTests = 279
    await writeFile(invalidVitestPath, JSON.stringify(incompleteVitest), "utf8")
    await expect(
      cleanupModule.runNativeVercelCleanupCli({
        argv: ["--assert-receipt"],
        env: { DAWN_VERCEL_ARTIFACT_DIR: artifactDir },
      }),
    ).rejects.toThrow(/Vitest|successful|passed/)
    await writeFile(invalidVitestPath, validVitest, "utf8")
    const dirtyManifest = JSON.parse(closedManifest)
    dirtyManifest.attempts[0].cleaned = false
    await writeFile(manifestPath, JSON.stringify(dirtyManifest), "utf8")
    await expect(
      cleanupModule.runNativeVercelCleanupCli({
        argv: ["--assert-receipt"],
        env: { DAWN_VERCEL_ARTIFACT_DIR: artifactDir },
      }),
    ).rejects.toThrow(/cleanup|closed|manifest/)
    await writeFile(manifestPath, closedManifest, "utf8")
    const missingVitestArtifacts = await makeTempDir()
    await createNativeEvidenceStore({
      artifactDir: missingVitestArtifacts,
      protectedValues,
    })
    await expect(
      cleanupModule.runNativeVercelCleanupCli({
        argv: ["--prepare-artifacts"],
        env: {
          DAWN_VERCEL_ARTIFACT_DIR: missingVitestArtifacts,
          DAWN_VERCEL_DATABASE_URL: protectedValues[3],
          DAWN_VERCEL_ORG_ID: protectedValues[1],
          DAWN_VERCEL_PROJECT_ID: protectedValues[2],
          DAWN_VERCEL_TOKEN: protectedValues[0],
        },
      }),
    ).rejects.toThrow(/Vitest|vitest|artifact|evidence/)
    await expect(
      cleanupModule.runNativeVercelCleanupCli({
        argv: ["--prepare-artifacts"],
        env: {
          DAWN_VERCEL_ARTIFACT_DIR: artifactDir,
          DAWN_VERCEL_DATABASE_URL: protectedValues[3],
          DAWN_VERCEL_ORG_ID: protectedValues[1],
          DAWN_VERCEL_PROJECT_ID: protectedValues[2],
          DAWN_VERCEL_TOKEN: protectedValues[0],
        },
      }),
    ).resolves.toMatchObject({ mode: "prepare-artifacts" })
    expect(await readdir(join(artifactDir, "upload"))).toContain("vitest.json")

    const cleanupScript = join(cliPackageRoot, "test", "helpers", "vercel-native-cleanup.mjs")
    await expect(
      runNativeLocalChild({
        args: ["--check", cleanupScript],
        cwd: repoRoot,
        env: {},
        executable: process.execPath,
        timeoutMs: 10_000,
      }),
    ).resolves.toMatchObject({ exitCode: 0, stderr: "" })
    const asserted = await runNativeLocalChild({
      args: [cleanupScript, "--assert-receipt"],
      cwd: repoRoot,
      env: { DAWN_VERCEL_ARTIFACT_DIR: artifactDir },
      executable: process.execPath,
      timeoutMs: 20_000,
    })
    expect(asserted).toMatchObject({ exitCode: 0, stderr: "" })
    expect(JSON.parse(asserted.stdout)).toMatchObject({ mode: "assert-receipt" })
    const prepared = await runNativeLocalChild({
      args: [cleanupScript, "--prepare-artifacts"],
      cwd: repoRoot,
      env: {
        DAWN_VERCEL_ARTIFACT_DIR: artifactDir,
        DAWN_VERCEL_DATABASE_URL: protectedValues[3],
        DAWN_VERCEL_ORG_ID: protectedValues[1],
        DAWN_VERCEL_PROJECT_ID: protectedValues[2],
        DAWN_VERCEL_TOKEN: protectedValues[0],
      },
      executable: process.execPath,
      timeoutMs: 20_000,
    })
    expect(prepared).toMatchObject({ exitCode: 0, stderr: "" })
    expect(JSON.parse(prepared.stdout)).toMatchObject({ mode: "prepare-artifacts" })
    for (const args of [["--unknown"], ["--assert-receipt", "--prepare-artifacts"]]) {
      await expect(
        runNativeLocalChild({
          args: [cleanupScript, ...args],
          cwd: repoRoot,
          env: { DAWN_VERCEL_ARTIFACT_DIR: artifactDir },
          executable: process.execPath,
          timeoutMs: 20_000,
        }),
      ).resolves.toMatchObject({ exitCode: 1, stderr: "native Vercel cleanup command failed\n" })
    }

    const cleanupArtifacts = await makeTempDir()
    await createNativeEvidenceStore({ artifactDir: cleanupArtifacts, protectedValues })
    let cleanupCalls = 0
    let closes = 0
    await expect(
      cleanupModule.runNativeVercelCleanup({
        dependencies: {
          cleanupEvidenceStore: async () => {
            cleanupCalls += 1
            return { databaseRowsAbsent: true, deploymentAbsent: true }
          },
          createDatabase: async () => ({
            close: async () => {
              closes += 1
            },
            database: createNativeBoundedDatabase({ query: async () => ({ rows: [] }) }),
          }),
        },
        env: {
          DAWN_VERCEL_ARTIFACT_DIR: cleanupArtifacts,
          DAWN_VERCEL_DATABASE_URL: protectedValues[3],
          DAWN_VERCEL_ORG_ID: protectedValues[1],
          DAWN_VERCEL_PROJECT_ID: protectedValues[2],
          DAWN_VERCEL_TOKEN: protectedValues[0],
        },
      }),
    ).resolves.toEqual({ finalized: false, mode: "cleanup" })
    expect(cleanupCalls).toBe(1)
    expect(closes).toBe(1)
    await expect(lstat(join(cleanupArtifacts, "receipt.json"))).rejects.toMatchObject({
      code: "ENOENT",
    })

    let initializationCloseCalls = 0
    const initializationFailure = await cleanupModule
      .runNativeVercelCleanup({
        dependencies: {
          createDatabase: async () => ({
            close: async () => {
              initializationCloseCalls += 1
              throw new Error(protectedValues[3])
            },
            database: createNativeBoundedDatabase({ query: async () => ({ rows: [] }) }),
          }),
          createFetchAdapters: () => {
            throw new Error(protectedValues[0])
          },
        },
        env: {
          DAWN_VERCEL_ARTIFACT_DIR: cleanupArtifacts,
          DAWN_VERCEL_DATABASE_URL: protectedValues[3],
          DAWN_VERCEL_ORG_ID: protectedValues[1],
          DAWN_VERCEL_PROJECT_ID: protectedValues[2],
          DAWN_VERCEL_TOKEN: protectedValues[0],
        },
      })
      .then(
        () => undefined,
        (error: unknown) => error,
      )
    expect(initializationFailure).toBeInstanceOf(AggregateError)
    expect(initializationCloseCalls).toBe(1)
    expect((initializationFailure as AggregateError).errors[0]).toMatchObject({
      message: "native Vercel cleanup initialization failed",
    })
    expect(String(initializationFailure)).not.toContain(protectedValues[0])
    expect(String(initializationFailure)).not.toContain(protectedValues[3])

    const completeArtifacts = await makeTempDir()
    const completeStore = await createNativeEvidenceStore({
      artifactDir: completeArtifacts,
      protectedValues,
    })
    const seeded = await seedCleanupEvidence(completeStore)
    for (const binding of seeded.bindings) {
      await completeStore.persistReconciliation(binding.marker, {
        expectedCardinality: true,
        zeroLive: false,
      })
      await completeStore.persistDeploymentCleaned(binding.deploymentId, {
        state: "DELETED",
        uid: binding.deploymentId,
      })
    }
    for (const barrierId of seeded.barrierIds) await completeStore.persistBarrierCleaned(barrierId)
    for (const threadId of seeded.threadIds) await completeStore.persistThreadCleaned(threadId)
    await completeStore.persistDatabaseRowsAbsent()
    await expect(
      cleanupModule.runNativeVercelCleanup({
        dependencies: {
          cleanupEvidenceStore: async () => ({
            databaseRowsAbsent: true,
            deploymentAbsent: true,
          }),
          createDatabase: async () => ({
            close: async () => undefined,
            database: createNativeBoundedDatabase({ query: async () => ({ rows: [] }) }),
          }),
        },
        env: {
          DAWN_VERCEL_ARTIFACT_DIR: completeArtifacts,
          DAWN_VERCEL_DATABASE_URL: protectedValues[3],
          DAWN_VERCEL_ORG_ID: protectedValues[1],
          DAWN_VERCEL_PROJECT_ID: protectedValues[2],
          DAWN_VERCEL_TOKEN: protectedValues[0],
        },
      }),
    ).resolves.toEqual({ finalized: true, mode: "cleanup" })
    await expect(readFile(join(completeArtifacts, "receipt.json"), "utf8")).resolves.toContain(
      '"schemaVersion": 1',
    )

    let failureCloseCalls = 0
    const failure = await cleanupModule
      .runNativeVercelCleanup({
        dependencies: {
          cleanupEvidenceStore: async () => {
            throw new Error(protectedValues[0])
          },
          createDatabase: async () => ({
            close: async () => {
              failureCloseCalls += 1
              throw new Error(protectedValues[3])
            },
            database: createNativeBoundedDatabase({ query: async () => ({ rows: [] }) }),
          }),
        },
        env: {
          DAWN_VERCEL_ARTIFACT_DIR: cleanupArtifacts,
          DAWN_VERCEL_DATABASE_URL: protectedValues[3],
          DAWN_VERCEL_ORG_ID: protectedValues[1],
          DAWN_VERCEL_PROJECT_ID: protectedValues[2],
          DAWN_VERCEL_TOKEN: protectedValues[0],
        },
      })
      .then(
        () => undefined,
        (error: unknown) => error,
      )
    expect(failure).toBeInstanceOf(AggregateError)
    expect(failureCloseCalls).toBe(1)
    expect(String(failure)).not.toContain(protectedValues[0])
    expect(String(failure)).not.toContain(protectedValues[3])
  })

  test("retains the primary before independent deployment, database, and closure failures", async () => {
    const artifactDir = await makeTempDir()
    const store = await createNativeEvidenceStore({ artifactDir, protectedValues })
    const primary = new Error("primary functional failure")
    const calls: string[] = []
    const caught = await runNativeVercelOrchestration({
      cleanupDatabase: async () => {
        calls.push("database")
        throw new Error(protectedValues[3])
      },
      cleanupDeployments: async () => {
        calls.push("deployments")
        throw new Error(protectedValues[0])
      },
      runKind: async (kind) => {
        calls.push(kind)
        throw primary
      },
      store,
    }).then(
      () => undefined,
      (error: unknown) => error,
    )
    expect(calls).toEqual(["source", "deployments", "database"])
    expect(caught).toBeInstanceOf(AggregateError)
    expect((caught as AggregateError).cause).toBe(primary)
    expect((caught as AggregateError).errors[0]).toBe(primary)
    expect((caught as AggregateError).errors.map((error) => String(error)).join("\n")).not.toMatch(
      /vercel-token-secret|database-secret/,
    )
    await expect(lstat(join(artifactDir, "receipt.json"))).rejects.toMatchObject({ code: "ENOENT" })
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
    expect(files["src/lib/database.ts"]).toContain(
      'databaseUrl.searchParams.set("sslmode", "verify-full")',
    )
    expect(files["src/lib/database.ts"]).toContain("connectionString: nativeDatabaseUrl()")
    expect(files["src/lib/database.ts"]).not.toContain("connectionString: process.env.DATABASE_URL")

    const databaseModuleRoot = await makeTempDir()
    const pgStubRoot = join(databaseModuleRoot, "node_modules", "pg")
    await mkdir(pgStubRoot, { recursive: true })
    await writeFile(
      join(pgStubRoot, "package.json"),
      JSON.stringify({ exports: "./index.mjs", name: "pg", type: "module" }),
      "utf8",
    )
    await writeFile(
      join(pgStubRoot, "index.mjs"),
      `export class Pool {
  constructor(options) { this.options = options }
  on() { return this }
}
`,
      "utf8",
    )
    const transformedDatabase = await transform(files["src/lib/database.ts"] as string, {
      format: "esm",
      loader: "ts",
      target: "node24",
    })
    const databaseModulePath = join(databaseModuleRoot, "database.mjs")
    await writeFile(databaseModulePath, transformedDatabase.code, "utf8")
    const priorDatabaseUrl = process.env.DATABASE_URL
    try {
      process.env.DATABASE_URL =
        "postgres://fixture:password@localhost:5432/dawn?application_name=native&sslmode=require"
      const configured = (await import(`${pathToFileURL(databaseModulePath).href}?configured`)) as {
        readonly pool: { readonly options: { readonly connectionString?: string } }
      }
      expect(configured.pool.options.connectionString).toBe(
        "postgres://fixture:password@localhost:5432/dawn?application_name=native&sslmode=verify-full",
      )

      delete process.env.DATABASE_URL
      const absent = (await import(`${pathToFileURL(databaseModulePath).href}?absent`)) as {
        readonly pool: { readonly options: { readonly connectionString?: string } }
      }
      expect(absent.pool.options.connectionString).toBeUndefined()

      const malformedDatabaseUrl = "postgres-secret-not-a-url"
      process.env.DATABASE_URL = malformedDatabaseUrl
      let malformedError: unknown
      try {
        await import(`${pathToFileURL(databaseModulePath).href}?malformed`)
      } catch (error) {
        malformedError = error
      }
      expect(malformedError).toBeInstanceOf(Error)
      expect((malformedError as Error).message).toBe("native fixture DATABASE_URL is malformed")
      expect(JSON.stringify(malformedError)).not.toContain(malformedDatabaseUrl)
    } finally {
      if (priorDatabaseUrl === undefined) delete process.env.DATABASE_URL
      else process.env.DATABASE_URL = priorDatabaseUrl
    }

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

const NATIVE_VERCEL_GATED_TEST_TIMEOUT_MS = 30 * 60_000
const NATIVE_VERCEL_CI_JOB_TIMEOUT_MS = 45 * 60_000

interface NativeVercelGatedTestContext {
  readonly task: { readonly timeout: number }
}

type NativeVercelGatedTestRegistrar = (
  name: string,
  handler: (context: NativeVercelGatedTestContext) => Promise<void>,
  timeoutMs: number,
) => void

function registerNativeVercelGatedTest(register: NativeVercelGatedTestRegistrar): void {
  register(
    "runs two native Vercel previews",
    async ({ task }) => {
      expect(task.timeout).toBe(NATIVE_VERCEL_GATED_TEST_TIMEOUT_MS)
      expect(task.timeout).toBeLessThan(NATIVE_VERCEL_CI_JOB_TIMEOUT_MS)
      await runNativeVercelLane({ env: process.env })
    },
    NATIVE_VERCEL_GATED_TEST_TIMEOUT_MS,
  )
}

test("registers the protected native lane with a finite timeout below its CI job budget", () => {
  const registrations: Array<{
    readonly handler: (context: NativeVercelGatedTestContext) => Promise<void>
    readonly name: string
    readonly timeoutMs: number
  }> = []
  registerNativeVercelGatedTest((name, handler, timeoutMs) => {
    registrations.push({ handler, name, timeoutMs })
  })
  expect(registrations).toEqual([
    {
      handler: expect.any(Function),
      name: "runs two native Vercel previews",
      timeoutMs: 30 * 60_000,
    },
  ])
  expect(registrations[0]?.timeoutMs).toBeLessThan(45 * 60_000)
})

const nativeEnabled = nativeLaneEnabled(process.env.DAWN_TEST_VERCEL)
const nativeTest = nativeEnabled ? test : test.skip

registerNativeVercelGatedTest((name, handler, timeoutMs) => {
  nativeTest(name, handler, timeoutMs)
})
