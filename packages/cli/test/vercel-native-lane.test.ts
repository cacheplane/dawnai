import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { afterEach, describe, expect, test } from "vitest"

import {
  type AtomicJsonFileOps,
  assertBarrierId,
  assertDeploymentId,
  assertLogMarker,
  assertReconciliationMarker,
  assertThreadId,
  canonicalizeVercelOrigin,
  createSecretRedactor,
  nativeLaneEnabled,
  parseNativeReceipt,
  readNativeLaneEnvironment,
  sanitizeChildEnvironment,
  writeAtomicJson,
  writeFinalReceipt,
} from "./helpers/vercel-native-fixture.js"

const tempDirs: string[] = []

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

const nativeEnabled = nativeLaneEnabled(process.env.DAWN_TEST_VERCEL)
const nativeTest = nativeEnabled ? test : test.skip

nativeTest("runs two native Vercel previews", async () => {
  readNativeLaneEnvironment(process.env)
  throw new Error("native Vercel orchestration is not implemented")
})
