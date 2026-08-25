import assert from "node:assert/strict"
import { createHash } from "node:crypto"
import { existsSync, readFileSync, realpathSync } from "node:fs"
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { afterEach, describe, it } from "node:test"
import { fileURLToPath } from "node:url"

import {
  assertCleanDependencySpecs,
  assertInstalledCoreResolution,
  expectedFilesForPackage,
  isRetryableNpmViewError,
  MAX_WAIT_ATTEMPTS,
  MAX_WAIT_DELAY_MS,
  MAX_WAIT_TOTAL_MS,
  NPM_VIEW_TIMEOUT_MS,
  normalizeCliArgs,
  npmView,
  packageSets,
  publicNpmEnvironment,
  readBoundedRegularFile,
  resolvePackageSet,
  resolveRequestedVersion,
  run,
  validateExactPublishedPackageEvidence,
  validatePackageMetadata,
  validatePublishedWaitOptions,
  waitForPublishedVersions,
} from "./lib/published-artifacts.mjs"
import {
  resolveTypeScriptBin,
  runTypeScriptToolingProbe,
  typescriptToolingConsumerSource,
  typescriptToolingProbeSource,
  typescriptToolingSourceFiles,
  typescriptToolingTypeScriptConfig,
} from "./lib/typescript-tooling-probe.mjs"
import * as publishedSmoke from "./published-artifact-smoke.mjs"
import {
  parsePublishedArtifactVerifyArgs,
  runPublishedArtifactVerify,
} from "./published-artifact-verify.mjs"
import { CANONICAL_RELEASE_PACKAGE_ORDER, canonicalManifestBytes } from "./release/manifest.mjs"
import { parseSmokeResult } from "./release/smoke-result.mjs"

const {
  agUiEsmProbeSource,
  agUiProbeCommands,
  agUiTypeProbeSource,
  agUiTypeScriptConfig,
  assertNoNativeInstallOutput,
  assertNoNativeLifecycleScripts,
  installTypeScriptTooling,
  parseDockerMappedHostPort,
  pgvectorDatabaseUrl,
  readInstalledPackageManifests,
  runPublishedArtifactSmoke,
  runCommand,
  selectedPackageInstallArgs,
  shouldRunAgUiProbe,
  shouldRunOpenAiSmoke,
  shouldRunTypeScriptToolingProbe,
  typescriptToolingInstallArgs,
} = publishedSmoke

const tempRoots = []
const typescriptPackagePath = fileURLToPath(import.meta.resolve("typescript/package.json"))
const typescriptPackage = JSON.parse(readFileSync(typescriptPackagePath, "utf8"))
const typescriptCompilerPath = resolvePackageBinPath(
  typescriptPackagePath,
  typescriptPackage,
  "tsc",
)

function resolvePackageBinPath(packagePath, packageManifest, binName) {
  const bin =
    typeof packageManifest.bin === "string" ? packageManifest.bin : packageManifest.bin?.[binName]
  if (!bin) {
    throw new Error(`Package manifest does not declare a ${binName} binary`)
  }
  return join(dirname(packagePath), bin)
}

afterEach(async () => {
  await Promise.all(tempRoots.splice(0).map((root) => rm(root, { force: true, recursive: true })))
})

describe("resolvePackageSet", () => {
  it("resolves the memory-pgvector-core package set", () => {
    assert.deepEqual(resolvePackageSet("memory-pgvector-core"), [
      "@dawn-ai/memory-pgvector",
      "@dawn-ai/memory",
      "@dawn-ai/langchain",
    ])
  })

  it("rejects unknown package sets", () => {
    assert.throws(() => resolvePackageSet("unknown"), /Unknown package set/)
  })

  it("resolves the TypeScript tooling package set", () => {
    assert.deepEqual(resolvePackageSet("typescript-tooling"), [
      "@dawn-ai/sdk",
      "@dawn-ai/core",
      "@dawn-ai/vite-plugin",
      "@dawn-ai/cli",
    ])
  })

  it("resolves the Docker sandbox package set", () => {
    assert.deepEqual(resolvePackageSet("docker-sandbox"), ["@dawn-ai/sandbox"])
  })
})

describe("packageSets", () => {
  it("includes the AG-UI package set", () => {
    assert.deepEqual(packageSets["ag-ui"], ["@dawn-ai/ag-ui"])
  })

  it("includes the public package set placeholder", () => {
    assert.equal(packageSets.public, null)
  })

  it("includes SDK, Core, Vite, and CLI in the TypeScript tooling package set", () => {
    assert.deepEqual(packageSets["typescript-tooling"], [
      "@dawn-ai/sdk",
      "@dawn-ai/core",
      "@dawn-ai/vite-plugin",
      "@dawn-ai/cli",
    ])
  })

  it("includes the Docker sandbox package set", () => {
    assert.deepEqual(packageSets["docker-sandbox"], ["@dawn-ai/sandbox"])
  })
})

describe("waitForPublishedVersions", () => {
  it("accepts exact wait-budget boundaries and the release configuration", () => {
    assert.deepEqual(
      validatePublishedWaitOptions({
        attempts: MAX_WAIT_ATTEMPTS,
        delayMs: 0,
        requestTimeoutMs: NPM_VIEW_TIMEOUT_MS,
      }),
      { worstCaseMs: MAX_WAIT_TOTAL_MS },
    )
    assert.deepEqual(
      validatePublishedWaitOptions({
        attempts: 1,
        delayMs: MAX_WAIT_DELAY_MS,
        requestTimeoutMs: NPM_VIEW_TIMEOUT_MS,
      }),
      { worstCaseMs: NPM_VIEW_TIMEOUT_MS },
    )
    assert.deepEqual(
      validatePublishedWaitOptions({
        attempts: 18,
        delayMs: 10_000,
        requestTimeoutMs: NPM_VIEW_TIMEOUT_MS,
      }),
      { worstCaseMs: 440_000 },
    )
  })

  it("rejects oversized delays, attempts, timeouts, and total budgets", () => {
    for (const [options, expected] of [
      [
        {
          attempts: 1,
          delayMs: 2 ** 31,
          requestTimeoutMs: NPM_VIEW_TIMEOUT_MS,
        },
        new RegExp(`delayMs.*at most ${MAX_WAIT_DELAY_MS}`),
      ],
      [
        { attempts: 1, delayMs: 60_000, requestTimeoutMs: NPM_VIEW_TIMEOUT_MS },
        new RegExp(`delayMs.*at most ${MAX_WAIT_DELAY_MS}`),
      ],
      [
        { attempts: MAX_WAIT_ATTEMPTS + 1, delayMs: 0, requestTimeoutMs: 1 },
        new RegExp(`attempts.*at most ${MAX_WAIT_ATTEMPTS}`),
      ],
      [
        { attempts: Number.MAX_SAFE_INTEGER, delayMs: 0, requestTimeoutMs: 1 },
        new RegExp(`attempts.*at most ${MAX_WAIT_ATTEMPTS}`),
      ],
      [
        { attempts: 1, delayMs: 0, requestTimeoutMs: NPM_VIEW_TIMEOUT_MS + 1 },
        new RegExp(`requestTimeoutMs.*at most ${NPM_VIEW_TIMEOUT_MS}`),
      ],
      [
        {
          attempts: MAX_WAIT_ATTEMPTS,
          delayMs: 1,
          requestTimeoutMs: NPM_VIEW_TIMEOUT_MS,
        },
        new RegExp(
          `worst-case wait.*${MAX_WAIT_TOTAL_MS + MAX_WAIT_ATTEMPTS - 1}ms.*limit.*${MAX_WAIT_TOTAL_MS}ms`,
          "i",
        ),
      ],
    ]) {
      assert.throws(() => validatePublishedWaitOptions(options), expected)
    }
  })

  it("returns immediately when every package has the exact version", async () => {
    const calls = []
    const delays = []

    await waitForPublishedVersions({
      packages: ["@dawn-ai/core", "@dawn-ai/vite-plugin"],
      version: "0.9.0",
      attempts: 3,
      delayMs: 10_000,
      async npmViewImpl(packageName) {
        calls.push(packageName)
        return { versions: ["0.8.15", "0.9.0"], tags: { latest: "0.9.0" } }
      },
      async delay(ms) {
        delays.push(ms)
      },
    })

    assert.deepEqual(calls, ["@dawn-ai/core", "@dawn-ai/vite-plugin"])
    assert.deepEqual(delays, [])
  })

  it("checks outstanding packages concurrently", async () => {
    const calls = []
    const resolvers = new Map()

    await waitForPublishedVersions({
      packages: ["@dawn-ai/core", "@dawn-ai/vite-plugin", "@dawn-ai/cli"],
      version: "0.9.0",
      attempts: 1,
      delayMs: 0,
      requestTimeoutMs: 100,
      npmViewImpl(packageName) {
        calls.push(packageName)
        const promise = new Promise((resolvePromise) => {
          resolvers.set(packageName, resolvePromise)
        })
        if (resolvers.size === 3) {
          for (const resolvePromise of resolvers.values()) {
            resolvePromise({ versions: ["0.9.0"] })
          }
        }
        return promise
      },
      async delay() {},
    })

    assert.deepEqual(calls, ["@dawn-ai/core", "@dawn-ai/vite-plugin", "@dawn-ai/cli"])
  })

  it("times out a never-resolving injected registry request", async () => {
    const startedAt = Date.now()

    await assert.rejects(
      waitForPublishedVersions({
        packages: ["@dawn-ai/core"],
        version: "0.9.0",
        attempts: 1,
        delayMs: 0,
        requestTimeoutMs: 10,
        npmViewImpl: async () => new Promise(() => {}),
        async delay() {},
      }),
      (error) => {
        assert.equal(error.code, "ETIMEDOUT")
        assert.match(error.message, /@dawn-ai\/core.*timed out.*10ms/i)
        return true
      },
    )

    assert.ok(Date.now() - startedAt < 500, "hung registry request must remain bounded")
  })

  it("retries only missing packages in deterministic order", async () => {
    const calls = []
    const delays = []
    const packageAttempts = new Map()

    await waitForPublishedVersions({
      packages: ["@dawn-ai/core", "@dawn-ai/vite-plugin", "@dawn-ai/core", "@dawn-ai/cli"],
      version: "0.9.0",
      attempts: 3,
      delayMs: 25,
      async npmViewImpl(packageName) {
        calls.push(packageName)
        const attempt = (packageAttempts.get(packageName) ?? 0) + 1
        packageAttempts.set(packageName, attempt)
        const visibleAfter = packageName === "@dawn-ai/vite-plugin" ? 3 : 1
        return { versions: attempt >= visibleAfter ? ["0.9.0"] : [] }
      },
      async delay(ms) {
        delays.push(ms)
      },
    })

    assert.deepEqual(calls, [
      "@dawn-ai/core",
      "@dawn-ai/vite-plugin",
      "@dawn-ai/cli",
      "@dawn-ai/vite-plugin",
      "@dawn-ai/vite-plugin",
    ])
    assert.deepEqual(delays, [25, 25])
  })

  it("names only the packages still missing after the bounded attempts", async () => {
    const calls = []
    const delays = []

    await assert.rejects(
      waitForPublishedVersions({
        packages: ["@dawn-ai/core", "@dawn-ai/vite-plugin", "@dawn-ai/cli"],
        version: "0.9.0",
        attempts: 2,
        delayMs: 250,
        async npmViewImpl(packageName) {
          calls.push(packageName)
          return {
            versions: packageName === "@dawn-ai/vite-plugin" ? [] : ["0.9.0"],
          }
        },
        async delay(ms) {
          delays.push(ms)
        },
      }),
      (error) => {
        assert.match(error.message, /@dawn-ai\/vite-plugin@0\.9\.0/)
        assert.doesNotMatch(error.message, /@dawn-ai\/core@0\.9\.0/)
        assert.doesNotMatch(error.message, /@dawn-ai\/cli@0\.9\.0/)
        assert.match(error.message, /2 attempts/)
        assert.match(error.message, /250ms/)
        return true
      },
    )

    assert.deepEqual(calls, [
      "@dawn-ai/core",
      "@dawn-ai/vite-plugin",
      "@dawn-ai/cli",
      "@dawn-ai/vite-plugin",
    ])
    assert.deepEqual(delays, [250])
  })

  it("treats transient npm view errors as not yet visible and reports the last error", async () => {
    let calls = 0
    const delays = []

    await assert.rejects(
      waitForPublishedVersions({
        packages: ["@dawn-ai/core"],
        version: "0.9.0",
        attempts: 3,
        delayMs: 5,
        async npmViewImpl() {
          calls += 1
          throw Object.assign(new Error(`registry E500 on call ${calls}`), {
            code: "E500",
          })
        },
        async delay(ms) {
          delays.push(ms)
        },
      }),
      /@dawn-ai\/core@0\.9\.0.*registry E500 on call 3/s,
    )

    assert.equal(calls, 3)
    assert.deepEqual(delays, [5, 5])
  })

  it("classifies only availability and network registry failures as retryable", () => {
    for (const error of [
      { code: "E404" },
      { code: "E429" },
      { code: "E500" },
      { code: "E503" },
      { code: "E503", retryable: false },
      { code: "ETIMEDOUT" },
      { code: "ECONNRESET" },
      { code: "ENOTFOUND" },
      { code: "EAI_AGAIN" },
      { statusCode: 404 },
      { statusCode: 429 },
      { statusCode: 502 },
    ]) {
      assert.equal(isRetryableNpmViewError(error), true, JSON.stringify(error))
    }

    for (const error of [
      { code: "E401" },
      { code: "E401", retryable: true },
      { code: "E403" },
      { code: "EUSAGE" },
      { code: "ECONFIG" },
      { code: "EINVALIDJSON" },
      { statusCode: 401 },
      { statusCode: 403 },
      new Error("unknown programmer error"),
    ]) {
      assert.equal(isRetryableNpmViewError(error), false, JSON.stringify(error))
    }
  })

  it("retries retryable registry failures and recovers", async () => {
    for (const registryError of [
      { code: "E404" },
      { statusCode: 429 },
      { statusCode: 503 },
      { code: "ECONNRESET" },
      { code: "ETIMEDOUT" },
    ]) {
      let calls = 0
      const delays = []
      await waitForPublishedVersions({
        packages: ["@dawn-ai/core"],
        version: "0.9.0",
        attempts: 2,
        delayMs: 1,
        requestTimeoutMs: 100,
        async npmViewImpl() {
          calls += 1
          if (calls === 1) {
            throw Object.assign(new Error("retryable registry failure"), registryError)
          }
          return { versions: ["0.9.0"] }
        },
        async delay(ms) {
          delays.push(ms)
        },
      })

      assert.equal(calls, 2, JSON.stringify(registryError))
      assert.deepEqual(delays, [1], JSON.stringify(registryError))
    }
  })

  it("fails fatal registry and response errors immediately without delaying", async () => {
    for (const failure of [
      Object.assign(new Error("authentication required"), { code: "E401" }),
      Object.assign(new Error("access forbidden"), { statusCode: 403 }),
      Object.assign(new Error("invalid npm config"), { code: "ECONFIG" }),
      Object.assign(new Error("npm usage error"), { code: "EUSAGE" }),
      Object.assign(new Error("malformed registry JSON"), {
        code: "EINVALIDJSON",
      }),
      new Error("unknown programmer error"),
    ]) {
      let calls = 0
      const delays = []
      await assert.rejects(
        waitForPublishedVersions({
          packages: ["@dawn-ai/core"],
          version: "0.9.0",
          attempts: 3,
          delayMs: 1,
          requestTimeoutMs: 100,
          async npmViewImpl() {
            calls += 1
            throw failure
          },
          async delay(ms) {
            delays.push(ms)
          },
        }),
        (error) => error === failure,
      )
      assert.equal(calls, 1)
      assert.deepEqual(delays, [])
    }

    await assert.rejects(
      waitForPublishedVersions({
        packages: ["@dawn-ai/core"],
        version: "0.9.0",
        attempts: 3,
        delayMs: 1,
        requestTimeoutMs: 100,
        async npmViewImpl() {
          return { versions: "0.9.0" }
        },
        async delay() {
          assert.fail("invalid response shape must not delay")
        },
      }),
      /versions.*array/i,
    )
  })

  it("validates inputs before calling injected functions", async () => {
    let calls = 0
    const npmViewImpl = async () => {
      calls += 1
      return { versions: [] }
    }
    const delay = async () => {
      calls += 1
    }
    const invalidCases = [
      [{ packages: [], version: "0.9.0", attempts: 1, delayMs: 0 }, /packages.*non-empty/i],
      [{ packages: [""], version: "0.9.0", attempts: 1, delayMs: 0 }, /package.*non-empty/i],
      [{ packages: ["core"], version: "", attempts: 1, delayMs: 0 }, /version.*non-empty/i],
      [
        { packages: ["core"], version: "0.9.0", attempts: 0, delayMs: 0 },
        /attempts.*positive integer/i,
      ],
      [
        { packages: ["core"], version: "0.9.0", attempts: 1.5, delayMs: 0 },
        /attempts.*positive integer/i,
      ],
      [
        { packages: ["core"], version: "0.9.0", attempts: 1, delayMs: -1 },
        /delayMs.*non-negative integer/i,
      ],
      [
        {
          packages: ["core"],
          version: "0.9.0",
          attempts: 1,
          delayMs: Number.POSITIVE_INFINITY,
        },
        /delayMs.*non-negative integer/i,
      ],
      [
        {
          packages: ["core"],
          version: "0.9.0",
          attempts: 1,
          delayMs: 0,
          npmViewImpl: null,
        },
        /npmViewImpl.*function/i,
      ],
      [
        {
          packages: ["core"],
          version: "0.9.0",
          attempts: 1,
          delayMs: 0,
          delay: null,
        },
        /delay.*function/i,
      ],
    ]

    for (const [options, expected] of invalidCases) {
      await assert.rejects(
        waitForPublishedVersions({
          ...options,
          npmViewImpl,
          delay,
          ...options,
        }),
        expected,
      )
    }
    assert.equal(calls, 0)
  })
})

describe("npmView", () => {
  it("forwards the bounded request timeout to both npm queries", async () => {
    const calls = []
    const view = await npmView("@dawn-ai/core", {
      requestTimeoutMs: 321,
      async npmJsonImpl(args, options) {
        calls.push({ args, options })
        return args.at(-1) === "versions" ? ["0.9.0"] : { latest: "0.9.0" }
      },
    })

    assert.deepEqual(view, { versions: ["0.9.0"], tags: { latest: "0.9.0" } })
    assert.deepEqual(calls, [
      {
        args: ["view", "@dawn-ai/core", "versions"],
        options: { timeoutMs: 321 },
      },
      {
        args: ["view", "@dawn-ai/core", "dist-tags"],
        options: { timeoutMs: 321 },
      },
    ])
  })

  it("normalizes npm execution and JSON errors with retryability metadata", async () => {
    for (const [sourceError, expected] of [
      [new SyntaxError("Unexpected token"), { code: "EINVALIDJSON", retryable: false }],
      [
        Object.assign(new Error("npm failed"), {
          stderr: "npm error code E503",
        }),
        { code: "E503", retryable: true, statusCode: 503 },
      ],
      [
        Object.assign(new Error("npm failed"), {
          stderr: "npm error code E401",
        }),
        { code: "E401", retryable: false, statusCode: 401 },
      ],
      [
        Object.assign(new Error("getaddrinfo EAI_AGAIN"), {
          code: "EAI_AGAIN",
        }),
        { code: "EAI_AGAIN", retryable: true },
      ],
    ]) {
      await assert.rejects(
        npmView("@dawn-ai/core", {
          async npmJsonImpl() {
            throw sourceError
          },
        }),
        (error) => {
          for (const [key, value] of Object.entries(expected)) {
            assert.equal(error[key], value)
          }
          return true
        },
      )
    }
  })

  it("rejects malformed registry response shapes as fatal", async () => {
    await assert.rejects(
      npmView("@dawn-ai/core", {
        async npmJsonImpl(args) {
          return args.at(-1) === "versions" ? "0.9.0" : { latest: "0.9.0" }
        },
      }),
      (error) => {
        assert.equal(error.code, "EINVALIDRESPONSE")
        assert.equal(error.retryable, false)
        assert.match(error.message, /versions response must be an array/i)
        return true
      },
    )
  })
})

describe("published artifact verification CLI", () => {
  it("keeps the existing no-wait defaults", () => {
    assert.deepEqual(parsePublishedArtifactVerifyArgs([]), {
      packageSet: "memory-pgvector-core",
      version: "latest",
    })
  })

  it("parses bounded wait flags in split and equals forms", () => {
    assert.deepEqual(
      parsePublishedArtifactVerifyArgs([
        "--version",
        "0.9.0",
        "--package-set=typescript-tooling",
        "--wait-attempts",
        "18",
        "--wait-delay-ms=10000",
      ]),
      {
        packageSet: "typescript-tooling",
        version: "0.9.0",
        waitAttempts: 18,
        waitDelayMs: 10_000,
      },
    )
  })

  it("uses a bounded default delay when attempts enable waiting", () => {
    assert.deepEqual(parsePublishedArtifactVerifyArgs(["--version=0.9.0", "--wait-attempts=2"]), {
      packageSet: "memory-pgvector-core",
      version: "0.9.0",
      waitAttempts: 2,
      waitDelayMs: 10_000,
    })
  })

  it("accepts the exact maximum wait-attempt boundary", () => {
    assert.deepEqual(
      parsePublishedArtifactVerifyArgs([
        "--version=0.9.0",
        `--wait-attempts=${MAX_WAIT_ATTEMPTS}`,
        "--wait-delay-ms=0",
      ]),
      {
        packageSet: "memory-pgvector-core",
        version: "0.9.0",
        waitAttempts: MAX_WAIT_ATTEMPTS,
        waitDelayMs: 0,
      },
    )
  })

  it("accepts an exact prerelease version in wait mode", () => {
    assert.deepEqual(
      parsePublishedArtifactVerifyArgs([
        "--version=1.0.0-rc.1+build.5",
        "--wait-attempts=2",
        "--wait-delay-ms=0",
      ]),
      {
        packageSet: "memory-pgvector-core",
        version: "1.0.0-rc.1+build.5",
        waitAttempts: 2,
        waitDelayMs: 0,
      },
    )
  })

  it("preserves dist-tag selection in no-wait mode", () => {
    assert.deepEqual(parsePublishedArtifactVerifyArgs(["--version=next"]), {
      packageSet: "memory-pgvector-core",
      version: "next",
    })
  })

  it("rejects invalid or ambiguous wait options", () => {
    for (const [args, expected] of [
      [["--wait-delay-ms", "100"], /--wait-delay-ms requires --wait-attempts/],
      [["--wait-attempts", "2"], /--wait-attempts requires --version.*exact version/i],
      [
        ["--version", "0.9.0", "--wait-attempts", "0"],
        /--wait-attempts must be a positive integer/,
      ],
      [
        ["--version", "0.9.0", "--wait-attempts", "1.5"],
        /--wait-attempts must be a positive integer/,
      ],
      [
        ["--version", "0.9.0", "--wait-attempts", "2", "--wait-delay-ms", "-1"],
        /--wait-delay-ms must be a non-negative integer/,
      ],
      [
        ["--version", "0.9.0", "--wait-attempts", "2", "--wait-delay-ms", "nope"],
        /--wait-delay-ms must be a non-negative integer/,
      ],
      [
        ["--version", "0.9.0", "--wait-attempts", "2", "--wait-delay-ms="],
        /--wait-delay-ms must be a non-negative integer/,
      ],
      [
        ["--version", "next", "--wait-attempts", "2"],
        /--wait-attempts requires --version.*exact version/i,
      ],
      [
        ["--version", "^0.9.0", "--wait-attempts", "2"],
        /--wait-attempts requires --version.*exact version/i,
      ],
      [
        ["--version", "not-a-version", "--wait-attempts", "2"],
        /--wait-attempts requires --version.*exact version/i,
      ],
      [
        ["--version", "0.9.0", "--wait-attempts", String(MAX_WAIT_ATTEMPTS + 1)],
        new RegExp(`attempts.*at most ${MAX_WAIT_ATTEMPTS}`),
      ],
      [
        ["--version", "0.9.0", "--wait-attempts", "1", "--wait-delay-ms", "60000"],
        new RegExp(`delayMs.*at most ${MAX_WAIT_DELAY_MS}`),
      ],
      [
        [
          "--version",
          "0.9.0",
          "--wait-attempts",
          String(MAX_WAIT_ATTEMPTS),
          "--wait-delay-ms",
          "1",
        ],
        /worst-case wait.*limit/i,
      ],
    ]) {
      assert.throws(() => parsePublishedArtifactVerifyArgs(args), expected)
    }
  })

  it("waits for the selected exact versions before metadata verification", async () => {
    const events = []
    const result = await runPublishedArtifactVerify(
      {
        packageSet: "typescript-tooling",
        version: "0.9.0",
        waitAttempts: 18,
        waitDelayMs: 10_000,
      },
      {
        async readPublicPackages() {
          events.push({ type: "read-public" })
          return []
        },
        async waitForPublishedVersions(options) {
          events.push({ options, type: "wait" })
        },
        async verifyPackage(packageName, version) {
          events.push({ packageName, type: "verify", version })
        },
      },
    )

    assert.deepEqual(result, {
      failures: [],
      packageNames: ["@dawn-ai/sdk", "@dawn-ai/core", "@dawn-ai/vite-plugin", "@dawn-ai/cli"],
    })
    assert.deepEqual(events, [
      { type: "read-public" },
      {
        options: {
          attempts: 18,
          delayMs: 10_000,
          packages: ["@dawn-ai/sdk", "@dawn-ai/core", "@dawn-ai/vite-plugin", "@dawn-ai/cli"],
          version: "0.9.0",
        },
        type: "wait",
      },
      { packageName: "@dawn-ai/sdk", type: "verify", version: "0.9.0" },
      { packageName: "@dawn-ai/core", type: "verify", version: "0.9.0" },
      { packageName: "@dawn-ai/vite-plugin", type: "verify", version: "0.9.0" },
      { packageName: "@dawn-ai/cli", type: "verify", version: "0.9.0" },
    ])
  })

  it("does not poll in the existing manual no-wait path", async () => {
    let waited = false
    await runPublishedArtifactVerify(
      { packageSet: "ag-ui", version: "latest" },
      {
        async readPublicPackages() {
          return []
        },
        async waitForPublishedVersions() {
          waited = true
        },
        async verifyPackage() {},
      },
    )

    assert.equal(waited, false)
  })

  it("parses an exact release-mode invocation without changing manual defaults", () => {
    const digest = "b".repeat(64)
    assert.deepEqual(
      parsePublishedArtifactVerifyArgs([
        "--release-mode",
        "--version=0.8.22",
        `--commit-sha=${"a".repeat(40)}`,
        "--manifest",
        "/tmp/manifest.json",
        "--manifest-sha256",
        digest,
        "--result=/tmp/metadata-result.json",
      ]),
      {
        releaseMode: true,
        version: "0.8.22",
        commitSha: "a".repeat(40),
        manifest: "/tmp/manifest.json",
        manifestSha256: digest,
        result: "/tmp/metadata-result.json",
      },
    )
    assert.deepEqual(parsePublishedArtifactVerifyArgs([]), {
      packageSet: "memory-pgvector-core",
      version: "latest",
    })
  })

  it("rejects incomplete, dist-tag, and mixed release-mode invocations", () => {
    const required = [
      "--release-mode",
      "--version=0.8.22",
      `--commit-sha=${"a".repeat(40)}`,
      "--manifest=/tmp/manifest.json",
      `--manifest-sha256=${"b".repeat(64)}`,
      "--result=/tmp/result.json",
    ]
    assert.throws(
      () => parsePublishedArtifactVerifyArgs(required.filter((arg) => !arg.startsWith("--result"))),
      /--result.*required/i,
    )
    assert.throws(
      () =>
        parsePublishedArtifactVerifyArgs(
          required.map((arg) => (arg === "--version=0.8.22" ? "--version=latest" : arg)),
        ),
      /exact version/i,
    )
    assert.throws(
      () => parsePublishedArtifactVerifyArgs([...required, "--package-set=public"]),
      /--package-set.*release mode/i,
    )
    assert.throws(
      () => parsePublishedArtifactVerifyArgs([...required, "--wait-attempts=2"]),
      /wait.*release mode/i,
    )
  })

  it("verifies every sealed-manifest package and writes a correlated success receipt", async () => {
    const manifest = publishedReleaseManifest()
    const manifestBytes = canonicalManifestBytes(manifest)
    const digest = createHash("sha256").update(manifestBytes).digest("hex")
    const calls = []
    const writes = []
    const result = await runPublishedArtifactVerify(
      {
        releaseMode: true,
        version: manifest.version,
        commitSha: manifest.commitSha,
        manifest: "/inputs/manifest.json",
        manifestSha256: digest,
        result: "/outputs/result.json",
      },
      {
        env: { GITHUB_RUN_ID: "301", GITHUB_RUN_ATTEMPT: "4" },
        now: sequenceClock("2026-08-25T12:00:00.000Z", "2026-08-25T12:00:01.000Z"),
        async readFile(path) {
          assert.equal(path, "/inputs/manifest.json")
          return manifestBytes
        },
        async verifyReleasePackage(entry, context) {
          calls.push({ entry, context })
        },
        async writeFile(path, bytes) {
          writes.push({ path, bytes })
        },
        async mkdir() {},
      },
    )

    assert.deepEqual(result.failures, [])
    assert.deepEqual(result.packageNames, CANONICAL_RELEASE_PACKAGE_ORDER)
    assert.deepEqual(
      calls.map(({ entry }) => entry.name),
      CANONICAL_RELEASE_PACKAGE_ORDER,
    )
    assert.equal(
      calls.every(({ context }) => context.commitSha === manifest.commitSha),
      true,
    )
    assert.equal(writes.length, 1)
    assert.equal(writes[0].path, "/outputs/result.json")
    const receipt = parseSmokeResult(writes[0].bytes)
    assert.equal(receipt.lane, "metadata")
    assert.equal(receipt.workflowRunId, 301)
    assert.equal(receipt.runAttempt, 4)
    assert.equal(receipt.conclusion, "success")
    assert.equal(receipt.checks.length, CANONICAL_RELEASE_PACKAGE_ORDER.length + 1)
  })

  it("writes a failed receipt and preserves package failures", async () => {
    const manifest = publishedReleaseManifest()
    const manifestBytes = canonicalManifestBytes(manifest)
    const digest = createHash("sha256").update(manifestBytes).digest("hex")
    let receipt
    const result = await runPublishedArtifactVerify(
      {
        releaseMode: true,
        version: manifest.version,
        commitSha: manifest.commitSha,
        manifest: "/inputs/manifest.json",
        manifestSha256: digest,
        result: "/outputs/result.json",
      },
      {
        env: { GITHUB_RUN_ID: "302", GITHUB_RUN_ATTEMPT: "1" },
        now: sequenceClock("2026-08-25T12:00:00.000Z", "2026-08-25T12:00:01.000Z"),
        async readFile() {
          return manifestBytes
        },
        async verifyReleasePackage(entry) {
          if (entry.name === "@dawn-ai/core") throw new Error("provenance workflow mismatch")
        },
        async writeFile(_path, bytes) {
          receipt = parseSmokeResult(bytes)
        },
        async mkdir() {},
      },
    )

    assert.equal(result.failures.length, 1)
    assert.equal(receipt.conclusion, "failure")
    assert.deepEqual(
      receipt.checks.filter(({ conclusion }) => conclusion === "failure"),
      [
        {
          name: "package:@dawn-ai/core",
          conclusion: "failure",
          detail: "provenance workflow mismatch",
        },
      ],
    )
  })

  it("bounds and redacts release-mode package errors before writing the failed receipt", async () => {
    const manifest = publishedReleaseManifest()
    const manifestBytes = canonicalManifestBytes(manifest)
    const digest = createHash("sha256").update(manifestBytes).digest("hex")
    let receipt
    const result = await runPublishedArtifactVerify(
      {
        releaseMode: true,
        version: manifest.version,
        commitSha: manifest.commitSha,
        manifest: "/inputs/manifest.json",
        manifestSha256: digest,
        result: "/outputs/result.json",
      },
      {
        env: { GITHUB_RUN_ID: "303", GITHUB_RUN_ATTEMPT: "1" },
        now: sequenceClock("2026-08-25T12:00:00.000Z", "2026-08-25T12:00:01.000Z"),
        async readFile() {
          return manifestBytes
        },
        async verifyReleasePackage(entry) {
          if (entry.name === "@dawn-ai/core") {
            throw new Error(`npm_super_secret_token ${"💥".repeat(10_000)}`)
          }
        },
        async writeFile(_path, bytes) {
          receipt = parseSmokeResult(bytes)
        },
        async mkdir() {},
      },
    )

    assert.equal(result.failures.length, 1)
    assert.ok(receipt)
    const failure = receipt.checks.find(({ conclusion }) => conclusion === "failure")
    assert.equal(Buffer.byteLength(failure.detail, "utf8") <= 4_096, true)
    assert.doesNotMatch(failure.detail, /super_secret/u)
  })
})

describe("validateExactPublishedPackageEvidence", () => {
  it("accepts exact manifest digests, latest, registry signature, and provenance identity", () => {
    const entry = publishedReleaseManifest().packages[0]
    assert.doesNotThrow(() =>
      validateExactPublishedPackageEvidence({
        entry,
        commitSha: "a".repeat(40),
        workflow: ".github/workflows/release.yml",
        observation: exactPublishedObservation(entry),
        tarball: exactPublishedTarball(entry),
        signature: {
          status: "PRESENT",
          operation: "registry-signature",
          httpStatus: 200,
          code: null,
          signature: { status: "valid", keyid: "SHA256:key" },
        },
      }),
    )
  })

  it("fails closed on digest, latest, signature, workflow, or commit drift", () => {
    const entry = publishedReleaseManifest().packages[0]
    const baseline = {
      entry,
      commitSha: "a".repeat(40),
      workflow: ".github/workflows/release.yml",
      observation: exactPublishedObservation(entry),
      tarball: exactPublishedTarball(entry),
      signature: {
        status: "PRESENT",
        operation: "registry-signature",
        httpStatus: 200,
        code: null,
        signature: { status: "valid", keyid: "SHA256:key" },
      },
    }
    const cases = [
      [
        {
          ...baseline,
          tarball: { ...baseline.tarball, sha256: "f".repeat(64) },
        },
        /sha256/,
      ],
      [
        {
          ...baseline,
          observation: {
            ...baseline.observation,
            package: { ...baseline.observation.package, latest: "0.8.21" },
          },
        },
        /latest/,
      ],
      [
        {
          ...baseline,
          signature: {
            ...baseline.signature,
            signature: { status: "missing", keyid: null },
          },
        },
        /signature/,
      ],
      [
        {
          ...baseline,
          observation: {
            ...baseline.observation,
            package: {
              ...baseline.observation.package,
              provenance: {
                ...baseline.observation.package.provenance,
                workflow: ".github/workflows/other.yml",
              },
            },
          },
        },
        /workflow/,
      ],
      [{ ...baseline, commitSha: "c".repeat(40) }, /commit/],
    ]
    for (const [input, expected] of cases) {
      assert.throws(() => validateExactPublishedPackageEvidence(input), expected)
    }
  })
})

describe("published artifact workflow", () => {
  it("offers TypeScript tooling without enabling pgvector or OpenAI runtime work", () => {
    const workflow = readFileSync(
      join(
        dirname(fileURLToPath(import.meta.url)),
        "..",
        ".github",
        "workflows",
        "published-artifact-verify.yml",
      ),
      "utf8",
    )

    assert.match(workflow, /- typescript-tooling/)
    assert.match(workflow, /- docker-sandbox/)
    assert.match(
      workflow,
      /if \[ "\$DAWN_RUN_PGVECTOR" = "true" \] && \[ "\$DAWN_PACKAGE_SET" != "typescript-tooling" \] && \[ "\$DAWN_PACKAGE_SET" != "docker-sandbox" \]/,
    )
    assert.match(
      workflow,
      /if \[ "\$DAWN_PACKAGE_SET" = "typescript-tooling" \] \|\| \[ "\$DAWN_PACKAGE_SET" = "docker-sandbox" \]; then[\s\S]*does not support the OpenAI runtime smoke/,
    )
  })
})

describe("release workflow published TypeScript tooling verification", () => {
  const releaseWorkflowPath = join(
    dirname(fileURLToPath(import.meta.url)),
    "..",
    ".github",
    "workflows",
    "release.yml",
  )

  it("extracts the fixed-group version after backfill under the published condition", () => {
    const workflow = readFileSync(releaseWorkflowPath, "utf8")
    const backfillIndex = workflow.indexOf(
      "- name: Backfill tags/releases for bootstrapped packages",
    )
    const versionIndex = workflow.indexOf("- name: Read published version")

    assert.ok(backfillIndex >= 0, "release workflow must retain backfill")
    assert.ok(versionIndex > backfillIndex, "version extraction must follow backfill")
    assert.match(
      workflow,
      /- name: Read published version\n\s+if: \$\{\{ steps\.changesets\.outputs\.published == 'true' \}\}\n\s+run: \|\n\s+DAWN_PUBLISHED_VERSION="\$\(node -p "require\('\.\/packages\/core\/package\.json'\)\.version"\)"\n\s+printf 'DAWN_PUBLISHED_VERSION=%s\\n' "\$DAWN_PUBLISHED_VERSION" >> "\$GITHUB_ENV"/,
    )
  })

  it("verifies and then smokes the exact TypeScript tooling release", () => {
    const workflow = readFileSync(releaseWorkflowPath, "utf8")
    const verifyIndex = workflow.indexOf("- name: Verify published TypeScript tooling")
    const smokeIndex = workflow.indexOf("- name: Smoke published TypeScript tooling")

    assert.ok(verifyIndex >= 0, "release workflow must verify published tooling")
    assert.ok(smokeIndex > verifyIndex, "published smoke must follow metadata verification")
    assert.match(
      workflow,
      /- name: Verify published TypeScript tooling\n\s+if: \$\{\{ steps\.changesets\.outputs\.published == 'true' \}\}\n\s+run: pnpm published:verify -- --version "\$DAWN_PUBLISHED_VERSION" --package-set typescript-tooling --wait-attempts 18 --wait-delay-ms 10000/,
    )
    assert.match(
      workflow,
      /- name: Smoke published TypeScript tooling\n\s+if: \$\{\{ steps\.changesets\.outputs\.published == 'true' \}\}\n\s+run: pnpm published:smoke -- --version "\$DAWN_PUBLISHED_VERSION" --package-set typescript-tooling/,
    )
  })

  it("verifies and then runs the Docker recovery smoke against the published sandbox", () => {
    const workflow = readFileSync(releaseWorkflowPath, "utf8")
    const verifyIndex = workflow.indexOf("- name: Verify published Docker sandbox")
    const smokeIndex = workflow.indexOf("- name: Smoke published Docker sandbox PID recovery")

    assert.ok(verifyIndex >= 0, "release workflow must verify the published sandbox")
    assert.ok(smokeIndex > verifyIndex, "Docker recovery smoke must follow metadata verification")
    assert.match(
      workflow,
      /published:verify -- --version "\$DAWN_PUBLISHED_VERSION" --package-set docker-sandbox --wait-attempts 18 --wait-delay-ms 10000/,
    )
    assert.match(
      workflow,
      /published:smoke -- --version "\$DAWN_PUBLISHED_VERSION" --package-set docker-sandbox/,
    )
  })

  it("keeps each registry delay below one minute and the total wait bounded", () => {
    const workflow = readFileSync(releaseWorkflowPath, "utf8")
    const match = workflow.match(/--wait-attempts (\d+) --wait-delay-ms (\d+)/)

    assert.ok(match, "release verification must declare bounded wait settings")
    const attempts = Number(match[1])
    const delayMs = Number(match[2])
    assert.ok(delayMs < 60_000)
    assert.ok((attempts - 1) * delayMs < 30 * 60_000)
  })

  it("documents the manual rerun path when Changesets reports no publication", () => {
    const workflow = readFileSync(releaseWorkflowPath, "utf8")

    assert.doesNotMatch(workflow, /Runs last so it can never affect the actual publish/)
    assert.match(workflow, /published=false.*skip.*post-publish/is)
    assert.match(workflow, /Published Artifact Verification.*exact version.*typescript-tooling/is)
  })
})

describe("expectedFilesForPackage", () => {
  it("returns AG-UI entrypoint expectations", () => {
    assert.deepEqual(expectedFilesForPackage("@dawn-ai/ag-ui"), [
      "dist/activities.js",
      "dist/activities.d.ts",
      "dist/index.js",
      "dist/index.d.ts",
      "dist/sse.js",
      "dist/sse.d.ts",
      "README.md",
      "package.json",
    ])
  })

  it("returns memory-pgvector tarball expectations", () => {
    assert.deepEqual(expectedFilesForPackage("@dawn-ai/memory-pgvector"), [
      "dist/index.js",
      "dist/index.d.ts",
      "README.md",
      "package.json",
    ])
  })

  it("returns package-specific runtime expectations", () => {
    assert.deepEqual(expectedFilesForPackage("@dawn-ai/memory"), [
      "dist/index.js",
      "dist/index.d.ts",
      "README.md",
      "package.json",
    ])
    assert.deepEqual(expectedFilesForPackage("@dawn-ai/langchain"), [
      "dist/index.js",
      "dist/index.d.ts",
      "README.md",
      "package.json",
    ])
    assert.deepEqual(expectedFilesForPackage("@dawn-ai/sandbox"), [
      "dist/index.js",
      "dist/index.d.ts",
      "README.md",
      "package.json",
    ])
  })

  it("defaults to metadata and README expectations", () => {
    assert.deepEqual(expectedFilesForPackage("@dawn-ai/unknown"), ["README.md", "package.json"])
  })
})

describe("AG-UI installed probes", () => {
  it("resolves the TypeScript 7 compiler from its exported package manifest", () => {
    assert.equal(typescriptPackage.version, "7.0.2")
    assert.equal(existsSync(typescriptCompilerPath), true)
  })

  it("generates an ESM probe for the exact canonical root surface", () => {
    const source = agUiEsmProbeSource()

    assert.match(source, /import \* as root from "@dawn-ai\/ag-ui"/)
    assert.match(source, /import \{ encodeAgUiSse \} from "@dawn-ai\/ag-ui\/sse"/)
    assert.ok(
      source.includes(`assert.deepEqual(Object.keys(root).sort(), [
  "DAWN_PLAN_ACTIVITY_TYPE",
  "DAWN_SUBAGENT_ACTIVITY_TYPE",
  "createCounterIdFactory",
  "createDefaultIdFactory",
  "fromRunAgentInput",
  "toAguiEvents",
])`),
      "ESM probe must compare the complete sorted root export surface",
    )
    assert.match(source, /assert\.equal\(root\.DAWN_PLAN_ACTIVITY_TYPE, "dawn\.plan"\)/)
    assert.match(source, /assert\.equal\(root\.DAWN_SUBAGENT_ACTIVITY_TYPE, "dawn\.subagent"\)/)
    assert.ok(
      source.includes(`for (const exportName of [
  "createCounterIdFactory",
  "createDefaultIdFactory",
  "fromRunAgentInput",
  "toAguiEvents",
]) {
  assert.equal(typeof root[exportName], "function", \`canonical export \${exportName} must be a function\`)
}`),
      "ESM probe must verify every canonical root export is a function",
    )
    assert.match(source, /type: "RUN_STARTED"/)
    const exactSseAssertion = "assert.equal(encoded, `data: $" + "{JSON.stringify(event)}\\n\\n`)"
    assert.ok(source.includes(exactSseAssertion), "ESM probe must assert the exact SSE frame")
    assert.match(source, /JSON\.parse\(encoded\.slice\("data: "\.length, -2\)\)/)
    for (const field of ["type", "threadId", "runId"]) {
      assert.match(source, new RegExp(`payload\\.${field}`))
    }
  })

  it("generates a NodeNext consumer for root types and the SSE subpath", () => {
    const source = agUiTypeProbeSource()

    assert.match(source, /from "@dawn-ai\/ag-ui"/)
    for (const functionName of [
      "createCounterIdFactory",
      "createDefaultIdFactory",
      "fromRunAgentInput",
      "toAguiEvents",
    ]) {
      assert.match(source, new RegExp(`  ${functionName},`))
    }
    assert.ok(
      source.includes(`type RootValueSurface = readonly [
  typeof DAWN_PLAN_ACTIVITY_TYPE,
  typeof DAWN_SUBAGENT_ACTIVITY_TYPE,
  typeof createCounterIdFactory,
  typeof createDefaultIdFactory,
  typeof fromRunAgentInput,
  typeof toAguiEvents,
]`),
      "type probe must type-use every canonical root function declaration",
    )
    for (const typeName of [
      "IdFactory",
      "DawnMessage",
      "DawnRunInput",
      "DawnInterruptEnvelope",
      "DawnResumeRequest",
      "AguiOutboundEvent",
      "ToAguiOptions",
      "DawnAgentStreamChunk",
      "RunContext",
      "DawnPlanActivityContent",
      "DawnSubagentActivityContent",
    ]) {
      assert.match(source, new RegExp(`type ${typeName}`))
    }
    assert.ok(
      source.includes(`type RootTypeSurface = readonly [
  IdFactory,
  DawnMessage,
  DawnRunInput,
  DawnInterruptEnvelope,
  DawnResumeRequest,
  AguiOutboundEvent,
  ToAguiOptions,
  DawnAgentStreamChunk,
  RunContext,
  DawnPlanActivityContent,
  DawnSubagentActivityContent,
]`),
      "type probe must exercise every canonical root type",
    )
    for (const removedTypeName of [
      "MappedRunInput",
      "ResumeDecision",
      "AgUiTranslator",
      "AgUiEvent",
      "DawnStreamChunk",
      "DawnToolCallData",
      "DawnToolResultData",
      "RawChunk",
      "TranslatorOptions",
    ]) {
      assert.ok(
        source.includes(`// @ts-expect-error ${removedTypeName} was removed from the canonical root
import type { ${removedTypeName} } from "@dawn-ai/ag-ui"`),
        `type probe must reject restored ${removedTypeName}`,
      )
    }
    for (const removedFunctionName of [
      "createAgUiTranslator",
      "mapRunInput",
      "encodeAgUiSse",
      "fromAguiResume",
      "toAguiInterrupt",
      "asToolCallData",
      "asToolResultData",
    ]) {
      assert.ok(
        source.includes(`// @ts-expect-error ${removedFunctionName} was removed from the canonical root
import { ${removedFunctionName} } from "@dawn-ai/ag-ui"`),
        `type probe must reject restored ${removedFunctionName}`,
      )
    }
    assert.match(source, /from "@dawn-ai\/ag-ui\/sse"/)
    assert.match(source, /typeof encodeAgUiSse/)
    assert.deepEqual(agUiTypeScriptConfig(), {
      compilerOptions: {
        module: "NodeNext",
        moduleResolution: "NodeNext",
        noEmit: true,
        strict: true,
        target: "ES2022",
      },
      files: ["smoke-ag-ui.ts"],
    })
  })

  it("installs TypeScript and runs both probes", () => {
    assert.deepEqual(agUiProbeCommands(), [
      { command: "node", args: ["smoke-ag-ui.mjs"] },
      { command: "npm", args: ["install", "--save-dev", "typescript@7.0.2"] },
      {
        command: "npm",
        args: ["exec", "--", "tsc", "--project", "tsconfig.ag-ui.json"],
      },
    ])
  })

  it("selects the AG-UI probe only when the package is installed", () => {
    assert.equal(shouldRunAgUiProbe([{ name: "@dawn-ai/ag-ui", version: "1.0.0" }]), true)
    assert.equal(shouldRunAgUiProbe([{ name: "@dawn-ai/core", version: "1.0.0" }]), false)
  })

  it("executes generated ESM and type probes against a local package fixture", async () => {
    const root = await createAgUiProbeFixture()

    await runCommand(process.execPath, ["smoke-ag-ui.mjs"], { cwd: root })
    await compileAgUiTypeProbe(root)
  })

  it("rejects an installed SSE encoder with incorrect event data", async () => {
    const root = await createAgUiProbeFixture({
      sseSource: `export function encodeAgUiSse(event) {
  return "data: " + JSON.stringify({ ...event, threadId: "wrong-thread" }) + "\\n\\n"
}
`,
    })

    await assert.rejects(
      runCommand(process.execPath, ["smoke-ag-ui.mjs"], { cwd: root }),
      /deepStrictEqual|strictEqual/,
    )
  })

  it("fails type compilation if a removed root type reappears", async () => {
    const root = await createAgUiProbeFixture({
      extraRootDeclarations: "export type MappedRunInput = unknown\n",
    })

    await assert.rejects(compileAgUiTypeProbe(root), /Unused '@ts-expect-error' directive/)
  })

  it("fails type compilation if a canonical function declaration is missing", async () => {
    const root = await createAgUiProbeFixture({
      omitCanonicalDeclaration: "createDefaultIdFactory",
    })

    await assert.rejects(compileAgUiTypeProbe(root), /createDefaultIdFactory/)
  })

  it("fails type compilation if a removed root function declaration reappears", async () => {
    const root = await createAgUiProbeFixture({
      extraRootDeclarations: "export declare function mapRunInput(input: unknown): unknown\n",
    })

    await assert.rejects(compileAgUiTypeProbe(root), /Unused '@ts-expect-error' directive/)
  })
})

describe("TypeScript tooling installed probe", () => {
  it("generates a clean installed-package runtime probe with exact extraction assertions", () => {
    const source = typescriptToolingProbeSource()

    assert.match(source, /from "@dawn-ai\/core\/node"/)
    assert.match(source, /from "@dawn-ai\/vite-plugin"/)
    assert.doesNotMatch(source, /@dawn-ai\/core\/internal\/compiler/)
    assert.doesNotMatch(
      source,
      /(?:\.\.\/)+packages\/|packages\/core\/(?:src|dist)|packages\/vite-plugin\/(?:src|dist)/,
    )
    assert.match(source, /extractToolTypesForRoute/)
    assert.match(source, /extractToolSchemasForRoute/)
    assert.match(source, /dawnToolSchemaPlugin\(\)\.transform/)
    assert.match(source, /assert\.deepEqual\(types,/)
    assert.match(source, /assert\.deepEqual\(schemas,/)
    assert.match(source, /__dawnGeneratedDescription2/)
    assert.match(source, /__dawnGeneratedSchema2/)
    assert.match(source, /__dawnGeneratedZ2/)
    assert.match(source, /typescript\.version, expectedTypeScriptVersion/)
    assert.match(source, /coreCompiler\.version, "6\.0\.2"/)
    assert.match(source, /oldCompiler\.version, "6\.0\.2"/)
    assert.match(source, /coreCompilerManifest\.name, "@typescript\/typescript6"/)
    assert.match(source, /coreCompilerManifest\.version, "6\.0\.2"/)
    assert.match(source, /oldCompilerManifest\.name, "typescript"/)
    assert.match(source, /oldCompilerManifest\.version, "6\.0\.2"/)
    assert.match(source, /typeof coreCompiler\.createProgram, "function"/)
    assert.match(source, /typeof oldCompiler\.createSourceFile, "function"/)
    assert.match(source, /coreCompiler\.createProgram, oldCompiler\.createProgram/)
    assert.match(source, /coreCompiler\.createSourceFile, oldCompiler\.createSourceFile/)
  })

  it("builds representative shared and local tool sources without repository imports", () => {
    const files = typescriptToolingSourceFiles()

    assert.deepEqual(Object.keys(files).sort(), [
      "route/tools/fallback.ts",
      "route/tools/shadowed.ts",
      "shared/tool-inputs.ts",
      "shared/tools/mapped.ts",
      "shared/tools/shadowed.ts",
    ])
    assert.match(files["shared/tools/mapped.ts"], /import type .* from "\.\.\/tool-inputs\.js"/)
    assert.match(files["shared/tools/mapped.ts"], /\[K in keyof T\]\?: T\[K\]/)
    assert.match(files["shared/tools/mapped.ts"], /\/\*\*/)
    assert.match(files["route/tools/fallback.ts"], /Map<string, number> & \{ fixed: string \}/)
    assert.match(files["route/tools/shadowed.ts"], /Local shadow wins/)
    assert.match(files["shared/tools/shadowed.ts"], /must be shadowed/)
    for (const source of Object.values(files)) {
      assert.doesNotMatch(
        source,
        /(?:\.\.\/)+packages\/|packages\/(?:core|vite-plugin)\/(?:src|dist)/,
      )
    }
  })

  it("generates a NodeNext consumer and config that compile the transformed tool", () => {
    const source = typescriptToolingConsumerSource()

    assert.match(source, /from "\.\/generated-tool\.js"/)
    assert.match(source, /schema\.parse/)
    assert.match(source, /description/)
    assert.match(source, /async function runConsumer\(\)/)
    assert.doesNotMatch(source, /^const result:.*= await /m)
    assert.deepEqual(typescriptToolingTypeScriptConfig(), {
      compilerOptions: {
        module: "NodeNext",
        moduleResolution: "NodeNext",
        noEmit: true,
        strict: true,
        target: "ES2022",
      },
      files: ["generated-tool.ts", "typescript-tooling-consumer.ts"],
    })
  })

  it("writes all probe files and runs Node before the manifest-declared TypeScript 7 bin", async () => {
    const root = await createTypeScriptToolingRunnerFixture()
    const calls = []

    await runTypeScriptToolingProbe({
      root,
      expectedTypeScriptVersion: "7.0.2",
      async runCommand(command, args, options) {
        calls.push({ command, args, options })
      },
    })

    for (const relativePath of [
      ...Object.keys(typescriptToolingSourceFiles()),
      "typescript-tooling-probe.mjs",
      "typescript-tooling-consumer.ts",
      "tsconfig.typescript-tooling.json",
    ]) {
      assert.equal(existsSync(join(root, relativePath)), true, `${relativePath} must be written`)
    }
    assert.match(
      readFileSync(join(root, "typescript-tooling-probe.mjs"), "utf8"),
      /const expectedTypeScriptVersion = "7\.0\.2"/,
    )
    assert.deepEqual(calls, [
      {
        command: process.execPath,
        args: ["typescript-tooling-probe.mjs"],
        options: { cwd: root },
      },
      {
        command: process.execPath,
        args: [
          join(realpathSync(root), "node_modules", "typescript", "custom-bin", "tsc.mjs"),
          "--project",
          "tsconfig.typescript-tooling.json",
          "--noEmit",
        ],
        options: { cwd: root },
      },
    ])
  })

  it("resolves object and string TypeScript bins from the installed manifest", async () => {
    const objectRoot = await createTypeScriptToolingRunnerFixture()
    const stringRoot = await createTypeScriptToolingRunnerFixture({
      bin: "./custom-bin/tsc.mjs",
    })

    assert.equal(
      await resolveTypeScriptBin({
        root: objectRoot,
        expectedTypeScriptVersion: "7.0.2",
      }),
      join(realpathSync(objectRoot), "node_modules", "typescript", "custom-bin", "tsc.mjs"),
    )
    assert.equal(
      await resolveTypeScriptBin({
        root: stringRoot,
        expectedTypeScriptVersion: "7.0.2",
      }),
      join(realpathSync(stringRoot), "node_modules", "typescript", "custom-bin", "tsc.mjs"),
    )
  })

  it("rejects malformed or unsafe TypeScript bin declarations", async () => {
    const missingEntryRoot = await createTypeScriptToolingRunnerFixture({
      bin: {},
    })
    await assert.rejects(
      resolveTypeScriptBin({
        root: missingEntryRoot,
        expectedTypeScriptVersion: "7.0.2",
      }),
      new RegExp(
        `${escapeRegExp(join(realpathSync(missingEntryRoot), "node_modules", "typescript"))}.*tsc`,
        "s",
      ),
    )

    const absoluteRoot = await createTypeScriptToolingRunnerFixture()
    const absoluteTarget = join(absoluteRoot, "absolute-tsc.mjs")
    await writeFile(absoluteTarget, "", "utf8")
    await writeTypeScriptManifest(absoluteRoot, {
      bin: { tsc: absoluteTarget },
    })
    await assert.rejects(
      resolveTypeScriptBin({
        root: absoluteRoot,
        expectedTypeScriptVersion: "7.0.2",
      }),
      /absolute.*TypeScript.*bin|TypeScript.*bin.*absolute/i,
    )

    const traversalRoot = await createTypeScriptToolingRunnerFixture()
    await writeFile(join(traversalRoot, "node_modules", "outside-tsc.mjs"), "", "utf8")
    await writeTypeScriptManifest(traversalRoot, {
      bin: { tsc: "../outside-tsc.mjs" },
    })
    await assert.rejects(
      resolveTypeScriptBin({
        root: traversalRoot,
        expectedTypeScriptVersion: "7.0.2",
      }),
      /outside.*TypeScript.*package|contain/i,
    )
  })

  it("rejects missing and non-file TypeScript bin targets with path-rich diagnostics", async () => {
    const missingRoot = await createTypeScriptToolingRunnerFixture()
    const missingTarget = join(
      realpathSync(missingRoot),
      "node_modules",
      "typescript",
      "custom-bin",
      "tsc.mjs",
    )
    await rm(missingTarget)
    await assert.rejects(
      resolveTypeScriptBin({
        root: missingRoot,
        expectedTypeScriptVersion: "7.0.2",
      }),
      new RegExp(`${escapeRegExp(missingTarget)}.*(?:missing|unreadable)`, "is"),
    )

    const directoryRoot = await createTypeScriptToolingRunnerFixture()
    const directoryTarget = join(
      realpathSync(directoryRoot),
      "node_modules",
      "typescript",
      "custom-bin",
      "tsc.mjs",
    )
    await rm(directoryTarget)
    await mkdir(directoryTarget)
    await assert.rejects(
      resolveTypeScriptBin({
        root: directoryRoot,
        expectedTypeScriptVersion: "7.0.2",
      }),
      new RegExp(`${escapeRegExp(directoryTarget)}.*regular file`, "is"),
    )
  })

  it("rejects a TypeScript bin symlink that escapes its package", async (t) => {
    const root = await createTypeScriptToolingRunnerFixture()
    const target = join(root, "node_modules", "typescript", "custom-bin", "tsc.mjs")
    const outsideTarget = join(root, "outside-tsc.mjs")
    await rm(target)
    await writeFile(outsideTarget, "", "utf8")
    try {
      await symlink(outsideTarget, target)
    } catch (error) {
      if (error?.code === "EPERM" || error?.code === "EACCES") {
        t.skip(`symlinks unavailable: ${error.code}`)
        return
      }
      throw error
    }

    await assert.rejects(
      resolveTypeScriptBin({ root, expectedTypeScriptVersion: "7.0.2" }),
      /outside.*TypeScript.*package|contain/i,
    )
  })

  it("reports the installed TypeScript manifest path when JSON is malformed", async () => {
    const root = await createTypeScriptToolingRunnerFixture()
    const manifestPath = join(root, "node_modules", "typescript", "package.json")
    await writeFile(manifestPath, "{", "utf8")

    await assert.rejects(
      resolveTypeScriptBin({ root, expectedTypeScriptVersion: "7.0.2" }),
      new RegExp(`${escapeRegExp(manifestPath)}.*valid.*manifest`, "is"),
    )
  })

  it("validates runner options and the installed TypeScript version", async () => {
    await assert.rejects(runTypeScriptToolingProbe(), /options object/)
    await assert.rejects(
      runTypeScriptToolingProbe({
        root: "",
        runCommand: async () => {},
        expectedTypeScriptVersion: "7.0.2",
      }),
      /root must be a non-empty string/,
    )
    await assert.rejects(
      runTypeScriptToolingProbe({
        root: "/tmp/example",
        runCommand: null,
        expectedTypeScriptVersion: "7.0.2",
      }),
      /runCommand must be a function/,
    )
    await assert.rejects(
      runTypeScriptToolingProbe({
        root: "/tmp/example",
        runCommand: async () => {},
        expectedTypeScriptVersion: "",
      }),
      /expectedTypeScriptVersion must be a non-empty string/,
    )

    const root = await createTypeScriptToolingRunnerFixture({
      version: "7.0.1",
    })
    await assert.rejects(
      runTypeScriptToolingProbe({
        root,
        runCommand: async () => {},
        expectedTypeScriptVersion: "7.0.2",
      }),
      /installed TypeScript version 7\.0\.1, expected 7\.0\.2/,
    )
  })

  it("propagates command failures and does not continue to TypeScript", async () => {
    const root = await createTypeScriptToolingRunnerFixture()
    const failure = new Error("runtime probe failed")
    let calls = 0

    await assert.rejects(
      runTypeScriptToolingProbe({
        root,
        expectedTypeScriptVersion: "7.0.2",
        async runCommand() {
          calls += 1
          throw failure
        },
      }),
      (error) => error === failure,
    )
    assert.equal(calls, 1)
  })
})

describe("published TypeScript tooling smoke", () => {
  const packageVersion = "0.9.0"
  const toolingPackages = [
    { name: "@dawn-ai/sdk", version: packageVersion },
    { name: "@dawn-ai/core", version: packageVersion },
    { name: "@dawn-ai/vite-plugin", version: packageVersion },
    { name: "@dawn-ai/cli", version: packageVersion },
  ]

  it("selects the probe only when both Core and Vite are installed", () => {
    assert.equal(shouldRunTypeScriptToolingProbe(toolingPackages), true)
    assert.equal(
      shouldRunTypeScriptToolingProbe([
        { name: "extra", version: "1.0.0" },
        toolingPackages[2],
        toolingPackages[2],
        toolingPackages[1],
      ]),
      true,
    )
    assert.equal(shouldRunTypeScriptToolingProbe([toolingPackages[1], toolingPackages[3]]), false)
    assert.equal(shouldRunTypeScriptToolingProbe([toolingPackages[2], toolingPackages[3]]), false)
    assert.equal(shouldRunTypeScriptToolingProbe([toolingPackages[3]]), false)
  })

  it("uses separate exact, no-lock installs for selected Dawn packages and root tooling", () => {
    assert.deepEqual(selectedPackageInstallArgs(toolingPackages), [
      "install",
      "--save-exact",
      "--package-lock=false",
      "@dawn-ai/sdk@0.9.0",
      "@dawn-ai/core@0.9.0",
      "@dawn-ai/vite-plugin@0.9.0",
      "@dawn-ai/cli@0.9.0",
    ])
    assert.deepEqual(typescriptToolingInstallArgs(), [
      "install",
      "--ignore-scripts",
      "--save-exact",
      "--package-lock=false",
      "typescript@7.0.2",
      "tsx@4.23.0",
      "zod@4.4.3",
    ])
    assert.equal(
      typescriptToolingInstallArgs().some((arg) => arg.startsWith("@dawn-ai/")),
      false,
    )
  })

  it("enforces exact installed identities for all root tooling packages", async () => {
    const root = await mkdtemp(join(tmpdir(), "dawn-published-tooling-install-test-"))
    tempRoots.push(root)
    const calls = []

    await installTypeScriptTooling(root, {
      async runCommand(command, args, options) {
        calls.push({ args, command, options })
        await Promise.all([
          writeResolutionPackage(join(root, "node_modules", "typescript"), "typescript", "7.0.2"),
          writeResolutionPackage(join(root, "node_modules", "tsx"), "tsx", "4.23.0"),
          writeResolutionPackage(join(root, "node_modules", "zod"), "zod", "4.4.3"),
        ])
        return { stderr: "", stdout: "" }
      },
    })

    assert.deepEqual(calls, [
      {
        args: typescriptToolingInstallArgs(),
        command: "npm",
        options: { cwd: root },
      },
    ])

    await assert.rejects(
      installTypeScriptTooling(root, {
        async runCommand() {
          await writeResolutionPackage(join(root, "node_modules", "zod"), "zod", "4.4.2")
          return { stderr: "", stdout: "" }
        },
      }),
      /zod installed identity zod@4\.4\.2, expected zod@4\.4\.3/,
    )
  })

  it("installs selected packages, installs root tooling, checks Core identity, then probes offline", async () => {
    const harness = await createPublishedSmokeHarness({
      selectedPackages: toolingPackages,
    })

    await runPublishedArtifactSmoke(harness.options, harness.dependencies)

    assert.deepEqual(
      harness.events.map(({ type }) => type),
      [
        "select",
        "selected-install",
        "command",
        "tooling-install",
        "command",
        "core-resolution",
        "tooling-probe",
        "command",
        "command",
        "cleanup",
      ],
    )
    assert.deepEqual(harness.events[2], {
      args: selectedPackageInstallArgs(toolingPackages),
      command: "npm",
      cwd: harness.tempDir,
      type: "command",
    })
    assert.deepEqual(harness.events[4], {
      args: typescriptToolingInstallArgs(),
      command: "npm",
      cwd: harness.tempDir,
      type: "command",
    })
    assert.deepEqual(harness.events[5], {
      consumerRoot: harness.tempDir,
      expectedCoreVersion: packageVersion,
      type: "core-resolution",
    })
    assert.deepEqual(harness.events[6], {
      expectedTypeScriptVersion: "7.0.2",
      root: harness.tempDir,
      type: "tooling-probe",
    })

    const afterToolingInstall = harness.events.slice(5)
    assert.equal(
      afterToolingInstall.some(
        (event) => event.type === "command" && ["npm", "pnpm", "yarn"].includes(event.command),
      ),
      false,
    )
    assert.equal(
      harness.events.some(({ type }) => type === "docker"),
      false,
    )
    assert.equal(harness.cleaned, true)
  })

  it("propagates probe failures and still cleans the smoke root", async () => {
    const probeFailure = new Error("published TypeScript tooling probe failed")
    const harness = await createPublishedSmokeHarness({
      probeFailure,
      selectedPackages: toolingPackages,
    })

    await assert.rejects(
      runPublishedArtifactSmoke(harness.options, harness.dependencies),
      (error) => error === probeFailure,
    )

    assert.equal(harness.events.at(-1).type, "cleanup")
    assert.equal(harness.cleaned, true)
    assert.equal(
      harness.events.some(({ type }) => type === "docker"),
      false,
    )
  })

  it("propagates tooling-install failures and still cleans before probing", async () => {
    const toolingInstallFailure = new Error("root tooling install failed")
    const harness = await createPublishedSmokeHarness({
      selectedPackages: toolingPackages,
      toolingInstallFailure,
    })

    await assert.rejects(
      runPublishedArtifactSmoke(harness.options, harness.dependencies),
      (error) => error === toolingInstallFailure,
    )

    assert.equal(
      harness.events.some(({ type }) => type === "tooling-probe"),
      false,
    )
    assert.equal(harness.events.at(-1).type, "cleanup")
    assert.equal(harness.cleaned, true)
  })

  it("preserves AG-UI probing without installing TypeScript tooling", async () => {
    const harness = await createPublishedSmokeHarness({
      selectedPackages: [{ name: "@dawn-ai/ag-ui", version: packageVersion }],
    })

    await runPublishedArtifactSmoke(harness.options, harness.dependencies)

    assert.equal(
      harness.events.some(({ type }) => type === "ag-ui-probe"),
      true,
    )
    assert.equal(
      harness.events.some(({ type }) => type === "tooling-install"),
      false,
    )
    assert.equal(
      harness.events.some(({ type }) => type === "tooling-probe"),
      false,
    )
    assert.equal(harness.events.at(-1).type, "cleanup")
  })

  it("preserves the non-pgvector skip path for existing package sets", async () => {
    const harness = await createPublishedSmokeHarness({
      selectedPackages: [
        { name: "@dawn-ai/memory-pgvector", version: packageVersion },
        { name: "@dawn-ai/memory", version: packageVersion },
        { name: "@dawn-ai/langchain", version: packageVersion },
      ],
    })

    await runPublishedArtifactSmoke(harness.options, harness.dependencies)

    assert.equal(
      harness.events.some(({ type }) => type === "ag-ui-probe"),
      false,
    )
    assert.equal(
      harness.events.some(({ type }) => type === "tooling-install"),
      false,
    )
    assert.equal(
      harness.events.some(({ type }) => type === "tooling-probe"),
      false,
    )
    assert.equal(
      harness.events.some(({ type }) => type === "docker"),
      false,
    )
    assert.equal(harness.events.at(-1).type, "cleanup")
  })

  it("runs Docker PID recovery against an installed sandbox artifact before cleanup", async () => {
    const harness = await createPublishedSmokeHarness({
      selectedPackages: [{ name: "@dawn-ai/sandbox", version: packageVersion }],
    })

    await runPublishedArtifactSmoke(harness.options, harness.dependencies)

    assert.deepEqual(
      harness.events.map(({ type }) => type),
      ["select", "selected-install", "command", "docker", "docker-sandbox-probe", "cleanup"],
    )
    assert.deepEqual(harness.events[4], {
      root: harness.tempDir,
      type: "docker-sandbox-probe",
    })
  })

  it("uses the shared Task 8 helper to reject a different nested Core artifact", async () => {
    const root = await createCoreResolutionFixture({ nestedViteCore: true })

    await assert.rejects(
      assertInstalledCoreResolution({
        consumerRoot: root,
        expectedCoreVersion: packageVersion,
      }),
      /Vite resolves @dawn-ai\/core to .* expected root artifact/s,
    )
  })

  it("uses the shared Task 8 helper to enforce the exact installed Core version", async () => {
    const root = await createCoreResolutionFixture({ coreVersion: "0.8.9" })

    await assert.rejects(
      assertInstalledCoreResolution({
        consumerRoot: root,
        expectedCoreVersion: packageVersion,
      }),
      /resolved @dawn-ai\/core version 0\.8\.9, expected version 0\.9\.0/,
    )
  })
})

describe("resolveRequestedVersion", () => {
  it("resolves latest through dist-tags", () => {
    assert.equal(
      resolveRequestedVersion({
        requested: "latest",
        tags: { latest: "1.2.3" },
      }),
      "1.2.3",
    )
  })

  it("resolves arbitrary dist-tags through dist-tags", () => {
    assert.equal(
      resolveRequestedVersion({
        requested: "next",
        tags: { latest: "1.0.0", next: "1.1.0-beta.1" },
      }),
      "1.1.0-beta.1",
    )
  })

  it("passes explicit versions through", () => {
    assert.equal(
      resolveRequestedVersion({
        requested: "0.8.11",
        tags: { latest: "0.8.12" },
      }),
      "0.8.11",
    )
  })
})

describe("normalizeCliArgs", () => {
  it("removes the npm script argument separator", () => {
    assert.deepEqual(normalizeCliArgs(["--", "--version", "latest"]), ["--version", "latest"])
  })

  it("leaves direct node invocation arguments unchanged", () => {
    assert.deepEqual(normalizeCliArgs(["--version", "latest"]), ["--version", "latest"])
  })
})

describe("assertCleanDependencySpecs", () => {
  it("rejects workspace and file dependency specs", () => {
    assert.throws(
      () =>
        assertCleanDependencySpecs("@dawn-ai/demo", {
          dependencies: {
            "@dawn-ai/core": "workspace:*",
            local: "file:../local",
          },
        }),
      /workspace:\*|file:/,
    )
  })
})

describe("validatePackageMetadata", () => {
  it("requires standard public package fields", () => {
    const failures = validatePackageMetadata("@dawn-ai/demo", {
      name: "@dawn-ai/demo",
      version: "1.0.0",
      license: "MIT",
      repository: {
        type: "git",
        url: "git+https://github.com/cacheplane/dawnai.git",
      },
      homepage: "https://github.com/cacheplane/dawnai/tree/main/packages/demo#readme",
      bugs: { url: "https://github.com/cacheplane/dawnai/issues" },
      engines: { node: ">=22.13.0" },
      publishConfig: { access: "public" },
      exports: { ".": "./dist/index.js" },
      types: "./dist/index.d.ts",
    })

    assert.deepEqual(failures, [])
  })

  it("rejects package metadata with mismatched name or version", () => {
    const failures = validatePackageMetadata(
      "@dawn-ai/demo",
      {
        name: "@dawn-ai/other",
        version: "1.0.1",
        license: "MIT",
        repository: {
          type: "git",
          url: "git+https://github.com/cacheplane/dawnai.git",
        },
        homepage: "https://github.com/cacheplane/dawnai/tree/main/packages/demo#readme",
        bugs: { url: "https://github.com/cacheplane/dawnai/issues" },
        engines: { node: ">=22.13.0" },
        publishConfig: { access: "public" },
        exports: { ".": "./dist/index.js" },
        types: "./dist/index.d.ts",
      },
      "1.0.0",
    )

    assert.deepEqual(failures, [
      "@dawn-ai/demo: package.json name is @dawn-ai/other",
      "@dawn-ai/demo: package.json version is 1.0.1, expected 1.0.0",
    ])
  })

  it("accepts config packages with JSON exports and no top-level types", () => {
    const failures = validatePackageMetadata("@dawn-ai/config-biome", {
      name: "@dawn-ai/config-biome",
      version: "1.0.0",
      license: "MIT",
      repository: {
        type: "git",
        url: "git+https://github.com/cacheplane/dawnai.git",
      },
      homepage: "https://github.com/cacheplane/dawnai/tree/main/packages/config-biome#readme",
      bugs: { url: "https://github.com/cacheplane/dawnai/issues" },
      engines: { node: ">=22.13.0" },
      publishConfig: { access: "public" },
      exports: {
        ".": "./biome.json",
        "./biome": "./biome.json",
      },
    })

    assert.deepEqual(failures, [])
  })

  it("accepts a runnable app package that declares a dawnInspector server entry", () => {
    // @dawn-ai/inspector is deliberately neither importable nor a bin: it is a Next
    // standalone app that `dawn inspect` launches by resolving `dawnInspector.server`.
    // That IS its entry point, so the "must expose exports or bin" rule was reporting a
    // false positive on every published release since 0.8.14.
    const failures = validatePackageMetadata("@dawn-ai/inspector", {
      name: "@dawn-ai/inspector",
      version: "1.0.0",
      license: "MIT",
      repository: {
        type: "git",
        url: "git+https://github.com/cacheplane/dawnai.git",
      },
      homepage: "https://github.com/cacheplane/dawnai/tree/main/packages/inspector#readme",
      bugs: { url: "https://github.com/cacheplane/dawnai/issues" },
      engines: { node: ">=22.13.0" },
      publishConfig: { access: "public" },
      dawnInspector: {
        server: ".next/standalone/packages/inspector/server.js",
      },
    })

    assert.deepEqual(failures, [])
  })

  it("still rejects a package that declares no entry point at all", () => {
    const failures = validatePackageMetadata("@dawn-ai/nothing", {
      name: "@dawn-ai/nothing",
      version: "1.0.0",
      license: "MIT",
      repository: {
        type: "git",
        url: "git+https://github.com/cacheplane/dawnai.git",
      },
      homepage: "https://github.com/cacheplane/dawnai/tree/main/packages/nothing#readme",
      bugs: { url: "https://github.com/cacheplane/dawnai/issues" },
      engines: { node: ">=22.13.0" },
      publishConfig: { access: "public" },
    })

    assert.deepEqual(failures, [
      "@dawn-ai/nothing: package.json must expose exports, bin, or dawnInspector.server",
    ])
  })

  it("rejects a dawnInspector field that names no server", () => {
    const failures = validatePackageMetadata("@dawn-ai/inspector", {
      name: "@dawn-ai/inspector",
      version: "1.0.0",
      license: "MIT",
      repository: {
        type: "git",
        url: "git+https://github.com/cacheplane/dawnai.git",
      },
      homepage: "https://github.com/cacheplane/dawnai/tree/main/packages/inspector#readme",
      bugs: { url: "https://github.com/cacheplane/dawnai/issues" },
      engines: { node: ">=22.13.0" },
      publishConfig: { access: "public" },
      dawnInspector: {},
    })

    assert.deepEqual(failures, [
      "@dawn-ai/inspector: package.json must expose exports, bin, or dawnInspector.server",
    ])
  })
})

describe("shouldRunOpenAiSmoke", () => {
  it("skips when disabled", () => {
    assert.equal(shouldRunOpenAiSmoke({ enabled: false, env: {} }).status, "skip")
  })

  it("fails when enabled without OPENAI_API_KEY", () => {
    assert.throws(() => shouldRunOpenAiSmoke({ enabled: true, env: {} }), /OPENAI_API_KEY/)
  })
})

describe("parseDockerMappedHostPort", () => {
  it("extracts the dynamic localhost host and port from docker port output", () => {
    assert.deepEqual(parseDockerMappedHostPort("127.0.0.1:49157\n"), {
      host: "127.0.0.1",
      port: 49157,
    })
  })

  it("normalizes wildcard Docker hosts for client connections", () => {
    assert.deepEqual(parseDockerMappedHostPort("0.0.0.0:49157\n"), {
      host: "127.0.0.1",
      port: 49157,
    })
    assert.deepEqual(parseDockerMappedHostPort("[::]:49158\n"), {
      host: "127.0.0.1",
      port: 49158,
    })
  })
})

describe("pgvectorDatabaseUrl", () => {
  it("uses the mapped host and port", () => {
    assert.equal(
      pgvectorDatabaseUrl({ host: "127.0.0.1", port: 49157 }),
      "postgres://postgres:postgres@127.0.0.1:49157/postgres",
    )
  })
})

describe("runCommand", () => {
  it("removes OPENAI_API_KEY from child process environments by default", async () => {
    const previousOpenAiApiKey = process.env.OPENAI_API_KEY
    process.env.OPENAI_API_KEY = "sk-test-secret"

    try {
      const result = await runCommand(process.execPath, [
        "-e",
        "process.stdout.write(process.env.OPENAI_API_KEY ?? '')",
      ])

      assert.equal(result.stdout, "")
    } finally {
      if (previousOpenAiApiKey === undefined) {
        delete process.env.OPENAI_API_KEY
      } else {
        process.env.OPENAI_API_KEY = previousOpenAiApiKey
      }
    }
  })

  it("passes OPENAI_API_KEY only when explicitly allowed", async () => {
    const result = await runCommand(
      process.execPath,
      ["-e", "process.stdout.write(process.env.OPENAI_API_KEY ?? '')"],
      {
        env: { OPENAI_API_KEY: "sk-test-secret" },
        includeOpenAi: true,
      },
    )

    assert.equal(result.stdout, "sk-test-secret")
  })
})

describe("run", () => {
  it("terminates a child process that exceeds its timeout", async () => {
    const startedAt = Date.now()

    await assert.rejects(
      run(process.execPath, ["-e", "setInterval(() => {}, 1000)"], {
        stdio: "pipe",
        timeoutMs: 50,
      }),
      (error) => {
        assert.equal(error.code, "ETIMEDOUT")
        assert.equal(error.timeoutMs, 50)
        assert.match(error.message, /timed out after 50ms/i)
        return true
      },
    )

    assert.ok(Date.now() - startedAt < 1_000, "timed-out child must be terminated promptly")
  })

  it("removes OPENAI_API_KEY from child process environments by default", async () => {
    const previousOpenAiApiKey = process.env.OPENAI_API_KEY
    process.env.OPENAI_API_KEY = "sk-test-secret"

    try {
      const output = await run(
        process.execPath,
        ["-e", "process.stdout.write(process.env.OPENAI_API_KEY ?? '')"],
        { stdio: "pipe" },
      )

      assert.equal(output, "")
    } finally {
      if (previousOpenAiApiKey === undefined) {
        delete process.env.OPENAI_API_KEY
      } else {
        process.env.OPENAI_API_KEY = previousOpenAiApiKey
      }
    }
  })

  it("terminates a child whose captured output exceeds the byte bound", async () => {
    await assert.rejects(
      run(process.execPath, ["-e", "process.stdout.write('x'.repeat(4096))"], {
        stdio: "pipe",
        maxOutputBytes: 64,
      }),
      (error) => {
        assert.equal(error.code, "EOUTPUTLIMIT")
        assert.equal(error.maxOutputBytes, 64)
        return true
      },
    )
  })
})

describe("public npm file and environment boundaries", () => {
  it("constructs an isolated public-registry environment without inherited credentials", () => {
    const environment = publicNpmEnvironment({
      home: "/tmp/isolated-public-npm",
      env: {
        PATH: "/bin",
        HOME: "/Users/example",
        NODE_AUTH_TOKEN: "npm-secret",
        NPM_TOKEN: "npm-secret",
        GITHUB_TOKEN: "github-secret",
        ACTIONS_ID_TOKEN_REQUEST_TOKEN: "oidc-secret",
        AWS_SECRET_ACCESS_KEY: "cloud-secret",
      },
    })
    assert.deepEqual(environment, {
      PATH: "/bin",
      HOME: "/tmp/isolated-public-npm",
      USERPROFILE: "/tmp/isolated-public-npm",
      npm_config_registry: "https://registry.npmjs.org",
      npm_config_userconfig: "/tmp/isolated-public-npm/.npmrc",
      npm_config_cache: "/tmp/isolated-public-npm/.npm-cache",
      npm_config_always_auth: "false",
    })
    assert.doesNotMatch(JSON.stringify(environment), /secret|TOKEN|ACTIONS_ID/iu)
  })

  it("reads only bounded positive regular files and rejects symlinks", async () => {
    const root = await mkdtemp(join(tmpdir(), "dawn-bounded-file-test-"))
    tempRoots.push(root)
    const regular = join(root, "manifest.json")
    const empty = join(root, "empty.json")
    const link = join(root, "manifest-link.json")
    await writeFile(regular, "{}\n")
    await writeFile(empty, "")
    await symlink(regular, link)

    assert.equal((await readBoundedRegularFile(regular, 16, "Manifest")).toString("utf8"), "{}\n")
    await assert.rejects(readBoundedRegularFile(empty, 16, "Manifest"), /positive regular file/i)
    await assert.rejects(readBoundedRegularFile(regular, 2, "Manifest"), /within 2 bytes/i)
    await assert.rejects(readBoundedRegularFile(link, 16, "Manifest"), /ELOOP|symbolic link/i)
  })
})

describe("assertNoNativeLifecycleScripts", () => {
  it("rejects native lifecycle scripts", () => {
    assert.throws(
      () =>
        assertNoNativeLifecycleScripts([
          {
            manifest: {
              name: "native-addon",
              version: "1.0.0",
              scripts: { install: "node-gyp rebuild" },
            },
          },
        ]),
      /native-addon@1\.0\.0.*install.*node-gyp rebuild/,
    )
  })

  it("rejects bare prebuild lifecycle scripts", () => {
    assert.throws(
      () =>
        assertNoNativeLifecycleScripts([
          {
            manifest: {
              name: "native-addon",
              version: "1.0.0",
              scripts: { install: "prebuild --install" },
            },
          },
        ]),
      /native-addon@1\.0\.0.*install.*prebuild --install/,
    )
  })

  it("accepts ordinary JavaScript package scripts", () => {
    assert.doesNotThrow(() =>
      assertNoNativeLifecycleScripts([
        {
          manifest: {
            name: "plain-js",
            version: "1.0.0",
            scripts: {
              build: "tsc -p tsconfig.json",
              test: "node --test",
              postinstall: "node ./scripts/setup.js",
            },
          },
        },
      ]),
    )
  })

  it("rejects packages with binding.gyp even without lifecycle scripts", async () => {
    const tempDir = await mkdtemp(join(tmpdir(), "dawn-native-indicator-test-"))
    try {
      const packageDir = join(tempDir, "node_modules", "native-addon")
      await mkdir(packageDir, { recursive: true })
      await writeFile(
        join(packageDir, "package.json"),
        JSON.stringify({ name: "native-addon", version: "1.0.0" }),
        "utf8",
      )
      await writeFile(join(packageDir, "binding.gyp"), "{}", "utf8")

      const manifests = await readInstalledPackageManifests(join(tempDir, "node_modules"))
      assert.throws(
        () => assertNoNativeLifecycleScripts(manifests),
        /native-addon@1\.0\.0.*binding\.gyp/,
      )
    } finally {
      await rm(tempDir, { recursive: true, force: true })
    }
  })
})

describe("assertNoNativeInstallOutput", () => {
  it("rejects native install output markers beyond node-gyp", () => {
    for (const marker of [
      "prebuild",
      "node-pre-gyp",
      "cmake-js",
      "node-gyp-build",
      "prebuildify",
    ]) {
      assert.throws(
        () => assertNoNativeInstallOutput(`> native-addon install\n${marker} install\n`),
        /native build indicators/,
      )
    }
  })

  it("accepts ordinary npm install output", () => {
    assert.doesNotThrow(() =>
      assertNoNativeInstallOutput(
        "added 42 packages, and audited 42 packages in 1s\nfound 0 vulnerabilities\n",
      ),
    )
  })
})

async function createPublishedSmokeHarness({
  probeFailure,
  selectedPackages,
  toolingInstallFailure,
}) {
  const testRoot = await mkdtemp(join(tmpdir(), "dawn-published-smoke-orchestration-test-"))
  const tempDir = join(testRoot, "owned-smoke-root")
  const events = []
  let cleaned = false
  tempRoots.push(testRoot)

  const runCommandForHarness = async (command, args, options = {}) => {
    events.push({
      args: [...args],
      command,
      cwd: options.cwd,
      type: "command",
    })
    return { stderr: "", stdout: "" }
  }
  const dependencies = {
    async assertDockerAvailable() {
      events.push({ type: "docker" })
    },
    async assertInstalledCoreResolution(options) {
      events.push({ ...options, type: "core-resolution" })
    },
    async databaseUrlForPgvector() {
      events.push({ type: "docker" })
      return "postgres://unused"
    },
    async installTypeScriptTooling(root, { runCommand: command }) {
      events.push({ root, type: "tooling-install" })
      await command("npm", typescriptToolingInstallArgs(), { cwd: root })
      if (toolingInstallFailure) {
        throw toolingInstallFailure
      }
    },
    async makeTempDir(prefix) {
      assert.equal(prefix, "dawn-published-smoke-")
      await mkdir(tempDir)
      return tempDir
    },
    async removeContainer() {
      events.push({ type: "docker" })
    },
    async removeDir(path) {
      events.push({ path, type: "cleanup" })
      await rm(path, { force: true, recursive: true })
      cleaned = true
    },
    async runAgUiInstalledProbe(root) {
      events.push({ root, type: "ag-ui-probe" })
    },
    async runInstallSmoke(root, packages, { runCommand: command }) {
      events.push({ packages, root, type: "selected-install" })
      await command("npm", selectedPackageInstallArgs(packages), { cwd: root })
    },
    runCommand: runCommandForHarness,
    async runRuntimeSmoke() {
      events.push({ type: "docker" })
    },
    async runDockerSandboxInstalledProbe(root) {
      events.push({ root, type: "docker-sandbox-probe" })
    },
    async runTypeScriptToolingProbe({ expectedTypeScriptVersion, root, runCommand: command }) {
      events.push({ expectedTypeScriptVersion, root, type: "tooling-probe" })
      if (probeFailure) {
        throw probeFailure
      }
      await command(process.execPath, ["typescript-tooling-probe.mjs"], {
        cwd: root,
      })
      await command(process.execPath, ["typescript-tsc.mjs", "--noEmit"], {
        cwd: root,
      })
    },
    async selectedPackageVersions(options) {
      events.push({ options, type: "select" })
      return selectedPackages
    },
    async startPgvector() {
      events.push({ type: "docker" })
    },
    async waitForPgvector() {
      events.push({ type: "docker" })
    },
  }

  return {
    dependencies,
    events,
    get cleaned() {
      return cleaned
    },
    options: {
      openai: false,
      packageSet: "test-fixture",
      pgvector: false,
      version: "latest",
    },
    tempDir,
  }
}

async function createCoreResolutionFixture({ coreVersion = "0.9.0", nestedViteCore = false } = {}) {
  const root = await mkdtemp(join(tmpdir(), "dawn-published-core-resolution-test-"))
  const nodeModules = join(root, "node_modules")
  tempRoots.push(root)
  await Promise.all([
    writeFile(join(root, "package.json"), JSON.stringify({ type: "module" }), "utf8"),
    writeResolutionPackage(join(nodeModules, "@dawn-ai", "core"), "@dawn-ai/core", coreVersion),
    writeResolutionPackage(
      join(nodeModules, "@dawn-ai", "vite-plugin"),
      "@dawn-ai/vite-plugin",
      "0.9.0",
    ),
  ])
  if (nestedViteCore) {
    await writeResolutionPackage(
      join(nodeModules, "@dawn-ai", "vite-plugin", "node_modules", "@dawn-ai", "core"),
      "@dawn-ai/core",
      coreVersion,
    )
  }
  return root
}

async function writeResolutionPackage(root, name, version) {
  await mkdir(root, { recursive: true })
  await Promise.all([
    writeFile(join(root, "index.js"), "export {}\n", "utf8"),
    writeFile(
      join(root, "package.json"),
      JSON.stringify({ main: "./index.js", name, type: "module", version }),
      "utf8",
    ),
  ])
}

async function createTypeScriptToolingRunnerFixture({
  bin = { tsc: "./custom-bin/tsc.mjs" },
  version = "7.0.2",
} = {}) {
  const root = await mkdtemp(join(tmpdir(), "dawn-typescript-tooling-probe-test-"))
  const typescriptRoot = join(root, "node_modules", "typescript")
  tempRoots.push(root)
  await mkdir(join(typescriptRoot, "custom-bin"), { recursive: true })
  await Promise.all([
    writeFile(join(root, "package.json"), JSON.stringify({ type: "module" }), "utf8"),
    writeFile(
      join(typescriptRoot, "package.json"),
      JSON.stringify({
        name: "typescript",
        version,
        bin,
      }),
      "utf8",
    ),
    writeFile(join(typescriptRoot, "custom-bin", "tsc.mjs"), "", "utf8"),
  ])
  return root
}

async function writeTypeScriptManifest(root, overrides) {
  await writeFile(
    join(root, "node_modules", "typescript", "package.json"),
    JSON.stringify({ name: "typescript", version: "7.0.2", ...overrides }),
    "utf8",
  )
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
}

async function createAgUiProbeFixture(options = {}) {
  const root = await mkdtemp(join(tmpdir(), "dawn-ag-ui-probe-test-"))
  const packageRoot = join(root, "node_modules", "@dawn-ai", "ag-ui")
  const distRoot = join(packageRoot, "dist")
  tempRoots.push(root)
  await mkdir(distRoot, { recursive: true })

  const packageJson = {
    name: "@dawn-ai/ag-ui",
    type: "module",
    types: "./dist/index.d.ts",
    exports: {
      ".": { types: "./dist/index.d.ts", default: "./dist/index.js" },
      "./sse": { types: "./dist/sse.d.ts", default: "./dist/sse.js" },
    },
  }
  const rootJavaScript = `export function createCounterIdFactory() {}
export function createDefaultIdFactory() {}
export function fromRunAgentInput(input) { return input }
export function toAguiEvents(events) { return events }
export { DAWN_PLAN_ACTIVITY_TYPE, DAWN_SUBAGENT_ACTIVITY_TYPE } from "./activities.js"
`
  const canonicalFunctionDeclarations = {
    createCounterIdFactory: "export declare function createCounterIdFactory(): IdFactory",
    createDefaultIdFactory: "export declare function createDefaultIdFactory(): IdFactory",
    fromRunAgentInput: "export declare function fromRunAgentInput(input: unknown): DawnRunInput",
    toAguiEvents: `export declare function toAguiEvents(
  events: AsyncIterable<DawnAgentStreamChunk>,
  context: RunContext,
  options?: ToAguiOptions,
): AsyncIterable<AguiOutboundEvent>`,
  }
  const includedFunctionDeclarations = Object.entries(canonicalFunctionDeclarations)
    .filter(([name]) => name !== options.omitCanonicalDeclaration)
    .map(([, declaration]) => declaration)
    .join("\n")
  const rootDeclarations = `export type IdFactory = (kind: string) => string
export interface DawnMessage { readonly role: string; readonly content: string }
export interface DawnRunInput { readonly messages: readonly DawnMessage[] }
export interface DawnInterruptEnvelope { readonly interruptId: string }
export interface DawnResumeRequest { readonly interruptId: string; readonly value: unknown }
export interface AguiOutboundEvent { readonly type: string }
export interface ToAguiOptions { readonly idFactory?: IdFactory }
export type DawnAgentStreamChunk = { readonly type: string; readonly data?: unknown }
export interface RunContext { readonly threadId: string; readonly runId: string }
export {
  DAWN_PLAN_ACTIVITY_TYPE,
  DAWN_SUBAGENT_ACTIVITY_TYPE,
  type DawnPlanActivityContent,
  type DawnSubagentActivityContent,
} from "./activities.js"
${includedFunctionDeclarations}
${options.extraRootDeclarations ?? ""}`
  const activitiesJavaScript = `export const DAWN_PLAN_ACTIVITY_TYPE = "dawn.plan"
export const DAWN_SUBAGENT_ACTIVITY_TYPE = "dawn.subagent"
`
  const activitiesDeclarations = `export declare const DAWN_PLAN_ACTIVITY_TYPE: "dawn.plan"
export declare const DAWN_SUBAGENT_ACTIVITY_TYPE: "dawn.subagent"
export interface DawnPlanActivityContent {
  readonly todos: ReadonlyArray<{
    readonly content: string
    readonly status: "pending" | "in_progress" | "completed"
  }>
}
export interface DawnSubagentActivityContent {
  readonly name: string
  readonly depth: number
  readonly status: "running" | "completed" | "failed"
  readonly todos?: DawnPlanActivityContent["todos"]
  readonly tools: ReadonlyArray<{
    readonly name: string
    readonly status: "running" | "completed" | "incomplete"
  }>
  readonly totalToolCount: number
  readonly error?: string
}
`
  const sseJavaScript =
    options.sseSource ??
    `export function encodeAgUiSse(event) {
  return "data: " + JSON.stringify(event) + "\\n\\n"
}
`
  const sseDeclarations = `export declare function encodeAgUiSse(event: {
  readonly type: string
  readonly threadId: string
  readonly runId: string
}): string
`

  await Promise.all([
    writeFile(join(root, "package.json"), JSON.stringify({ type: "module" }), "utf8"),
    writeFile(join(root, "smoke-ag-ui.mjs"), agUiEsmProbeSource(), "utf8"),
    writeFile(join(root, "smoke-ag-ui.ts"), agUiTypeProbeSource(), "utf8"),
    writeFile(join(root, "tsconfig.ag-ui.json"), JSON.stringify(agUiTypeScriptConfig()), "utf8"),
    writeFile(join(packageRoot, "package.json"), JSON.stringify(packageJson), "utf8"),
    writeFile(join(distRoot, "activities.js"), activitiesJavaScript, "utf8"),
    writeFile(join(distRoot, "activities.d.ts"), activitiesDeclarations, "utf8"),
    writeFile(join(distRoot, "index.js"), rootJavaScript, "utf8"),
    writeFile(join(distRoot, "index.d.ts"), rootDeclarations, "utf8"),
    writeFile(join(distRoot, "sse.js"), sseJavaScript, "utf8"),
    writeFile(join(distRoot, "sse.d.ts"), sseDeclarations, "utf8"),
  ])

  return root
}

async function compileAgUiTypeProbe(root) {
  return runCommand(
    process.execPath,
    [typescriptCompilerPath, "--project", "tsconfig.ag-ui.json"],
    { cwd: root },
  )
}

function publishedReleaseManifest() {
  const version = "0.8.22"
  const commitSha = "a".repeat(40)
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
        filename: `${publishedTarballStem(name)}-${version}.tgz`,
        size: bytes.length,
        sha256: createHash("sha256").update(bytes).digest("hex"),
        sha512,
        npmIntegrity: `sha512-${Buffer.from(sha512, "hex").toString("base64")}`,
        access: "public",
      }
    }),
  }
}

function publishedTarballStem(name) {
  return name.startsWith("@") ? name.slice(1).replace("/", "-") : name
}

function exactPublishedObservation(entry) {
  const sha1 = createHash("sha1")
    .update(Buffer.from(`published-${entry.name}`))
    .digest("hex")
  return {
    status: "PRESENT",
    operation: "package-version",
    httpStatus: 200,
    code: null,
    package: {
      name: entry.name,
      version: entry.version,
      tarballUrl: `https://registry.npmjs.org/${entry.filename}`,
      shasum: sha1,
      integrity: entry.npmIntegrity,
      signatures: [{ keyid: "SHA256:key", sig: "signature" }],
      distTags: { latest: entry.version },
      latest: entry.version,
      provenance: {
        status: "PRESENT",
        url: "https://registry.npmjs.org/-/npm/v1/attestations/example",
        predicateTypes: ["https://slsa.dev/provenance/v1"],
        workflow: ".github/workflows/release.yml",
        commitSha: "a".repeat(40),
        repository: "https://github.com/cacheplane/dawnai",
        ref: `refs/tags/v${entry.version}`,
      },
    },
  }
}

function exactPublishedTarball(entry) {
  const sha1 = createHash("sha1")
    .update(Buffer.from(`published-${entry.name}`))
    .digest("hex")
  return {
    url: `https://registry.npmjs.org/${entry.filename}`,
    size: entry.size,
    sha1,
    sha256: entry.sha256,
    sha512: entry.sha512,
    contentBase64: Buffer.from(`published-${entry.name}`).toString("base64"),
  }
}

function sequenceClock(...timestamps) {
  let index = 0
  return () => new Date(timestamps[Math.min(index++, timestamps.length - 1)])
}
