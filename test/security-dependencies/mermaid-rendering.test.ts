import { readFileSync, realpathSync, statSync } from "node:fs"
import { createRequire } from "node:module"
import { dirname, resolve, sep } from "node:path"
import { fileURLToPath, pathToFileURL } from "node:url"
import { Worker } from "node:worker_threads"

import { describe, expect, it } from "vitest"
import { parseDocument } from "yaml"

const testDirectory = dirname(fileURLToPath(import.meta.url))
const repositoryRoot = resolve(testDirectory, "../..")
const workerUrl = new URL("./mermaid-render-worker.mjs", import.meta.url)
const maxWorkerMessageBytes = 2_048

type JsonRecord = Record<string, unknown>

interface UiDependencyReceipt {
  readonly app: string
  readonly appReactCoreRange: string
  readonly dompurify: string
  readonly mermaid: string
  readonly mermaidDompurifyRange: string
  readonly mermaidEsmUrl: string
  readonly reactCore: string
  readonly reactCoreStreamdownRange: string
  readonly streamdown: string
  readonly streamdownMermaidRange: string
}

interface WorkerReceipt {
  readonly cleanup: {
    readonly globalsRestored: boolean
    readonly realmClosed: boolean
  }
  readonly diagram: {
    readonly hasSvg: boolean
    readonly textLabels: number
    readonly utf8Bytes: number
  }
  readonly ok: true
  readonly securityCase?: {
    readonly activeConfigAfter?: {
      readonly markerAbsent: boolean
      readonly prototypeClean: boolean
    }
    readonly activeConfigBefore?: {
      readonly markerAbsent: boolean
      readonly prototypeClean: boolean
    }
    readonly diagnostic?: string
    readonly name: WorkerCaseName
    readonly prototypeCleanAfter: boolean
    readonly prototypeCleanBefore: boolean
    readonly safeCss?: boolean
    readonly sanitized?: boolean
    readonly settled: "fulfilled" | "rejected"
  }
}

type WorkerCaseName =
  | "architecture-prototype"
  | "config-prototype"
  | "css-sibling"
  | "radar-ticks"
  | "strict-integration"
  | "xy-axis"

const workerCaseNames = [
  "xy-axis",
  "architecture-prototype",
  "css-sibling",
  "config-prototype",
  "radar-ticks",
  "strict-integration",
] as const satisfies readonly WorkerCaseName[]

function requireRecord(value: unknown, label: string): JsonRecord {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} must be an object`)
  }
  return value as JsonRecord
}

function requireString(value: unknown, label: string): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`${label} must be a non-empty string`)
  }
  return value
}

function readManifest(path: string): JsonRecord {
  return requireRecord(JSON.parse(readFileSync(path, "utf8")), path)
}

function manifestDependency(
  manifest: JsonRecord,
  section: "dependencies" | "devDependencies",
  name: string,
): string {
  const dependencies = requireRecord(manifest[section], `${section}`)
  return requireString(dependencies[name], `${section}.${name}`)
}

function findOwningManifest(entryPath: string, packageName: string): string {
  let current = dirname(entryPath)
  for (;;) {
    const candidate = resolve(current, "package.json")
    try {
      const manifest = readManifest(candidate)
      if (manifest.name === packageName) return candidate
    } catch (error) {
      if (!(error instanceof Error) || !("code" in error) || error.code !== "ENOENT") {
        throw error
      }
    }
    const parent = dirname(current)
    if (parent === current) {
      throw new Error(`could not find ${packageName} above ${entryPath}`)
    }
    current = parent
  }
}

function requireAppDependencyLink(
  appManifestPath: string,
  childName: string,
  resolvedManifestPath: string,
): string {
  const logicalManifestPath = realpathSync(
    resolve(dirname(appManifestPath), "node_modules", ...childName.split("/"), "package.json"),
  )
  const physicalManifestPath = realpathSync(resolvedManifestPath)
  if (logicalManifestPath !== physicalManifestPath) {
    throw new Error(`app resolved ${childName} outside its own dependency link`)
  }
  return physicalManifestPath
}

function requirePnpmDependencyLink(
  parentManifestPath: string,
  childName: string,
  resolvedManifestPath: string,
): string {
  const pnpmMarker = `${sep}node_modules${sep}.pnpm${sep}`
  const snapshotStart = parentManifestPath.indexOf(pnpmMarker)
  const snapshotNodeModulesStart = parentManifestPath.indexOf(
    `${sep}node_modules${sep}`,
    snapshotStart + pnpmMarker.length,
  )
  if (snapshotStart < 0 || snapshotNodeModulesStart < 0) {
    throw new Error("parent package was not installed in the expected pnpm snapshot")
  }
  const snapshotNodeModules = parentManifestPath.slice(
    0,
    snapshotNodeModulesStart + `${sep}node_modules`.length,
  )
  const logicalManifestPath = realpathSync(
    resolve(snapshotNodeModules, ...childName.split("/"), "package.json"),
  )
  const physicalManifestPath = realpathSync(resolvedManifestPath)
  if (logicalManifestPath !== physicalManifestPath) {
    throw new Error(`parent package resolved ${childName} outside its own dependency link`)
  }
  return physicalManifestPath
}

function resolveUiDependencyReceipt(appRelativePath: string): UiDependencyReceipt {
  const appManifestPath = resolve(repositoryRoot, appRelativePath, "package.json")
  const appManifest = readManifest(appManifestPath)
  const fromApp = createRequire(appManifestPath)
  const reactCoreManifestPath = requireAppDependencyLink(
    appManifestPath,
    "@copilotkit/react-core",
    fromApp.resolve("@copilotkit/react-core/package.json"),
  )
  const reactCoreManifest = readManifest(reactCoreManifestPath)

  const streamdownEntry = createRequire(reactCoreManifestPath).resolve("streamdown")
  const streamdownManifestPath = requirePnpmDependencyLink(
    reactCoreManifestPath,
    "streamdown",
    findOwningManifest(streamdownEntry, "streamdown"),
  )
  const streamdownManifest = readManifest(streamdownManifestPath)

  const mermaidManifestPath = requirePnpmDependencyLink(
    streamdownManifestPath,
    "mermaid",
    createRequire(streamdownManifestPath).resolve("mermaid/package.json"),
  )
  const mermaidManifest = readManifest(mermaidManifestPath)
  const mermaidModule = requireString(mermaidManifest.module, "mermaid package module")
  const mermaidEsmPath = resolve(dirname(mermaidManifestPath), mermaidModule)
  if (!statSync(mermaidEsmPath).isFile()) {
    throw new Error("the resolved Mermaid ESM entry must be a regular file")
  }

  const dompurifyEntry = createRequire(mermaidManifestPath).resolve("dompurify")
  const dompurifyManifestPath = requirePnpmDependencyLink(
    mermaidManifestPath,
    "dompurify",
    findOwningManifest(dompurifyEntry, "dompurify"),
  )
  const dompurifyManifest = readManifest(dompurifyManifestPath)

  return {
    app: requireString(appManifest.name, "app name"),
    appReactCoreRange: manifestDependency(appManifest, "dependencies", "@copilotkit/react-core"),
    dompurify: requireString(dompurifyManifest.version, "dompurify version"),
    mermaid: requireString(mermaidManifest.version, "mermaid version"),
    mermaidDompurifyRange: manifestDependency(mermaidManifest, "dependencies", "dompurify"),
    mermaidEsmUrl: pathToFileURL(mermaidEsmPath).href,
    reactCore: requireString(reactCoreManifest.version, "react-core version"),
    reactCoreStreamdownRange: manifestDependency(reactCoreManifest, "dependencies", "streamdown"),
    streamdown: requireString(streamdownManifest.version, "streamdown version"),
    streamdownMermaidRange: manifestDependency(streamdownManifest, "dependencies", "mermaid"),
  }
}

function rootToolVersions(): Record<string, string> {
  const rootManifestPath = resolve(repositoryRoot, "package.json")
  const rootManifest = readManifest(rootManifestPath)
  const fromRoot = createRequire(rootManifestPath)
  const versions: Record<string, string> = {}
  for (const name of ["@playwright/test", "esbuild", "jsdom"] as const) {
    const declared = manifestDependency(rootManifest, "devDependencies", name)
    const manifestPath = fromRoot.resolve(`${name}/package.json`)
    const installed = requireString(readManifest(manifestPath).version, `${name} version`)
    versions[name] = `${declared}/${installed}`
  }
  return versions
}

function readLockfile(): JsonRecord {
  const document = parseDocument(readFileSync(resolve(repositoryRoot, "pnpm-lock.yaml"), "utf8"), {
    strict: true,
    uniqueKeys: true,
  })
  if (document.errors.length > 0 || document.warnings.length > 0) {
    throw new Error("pnpm lockfile must parse without errors or warnings")
  }
  return requireRecord(document.toJS({ maxAliasCount: 0 }), "pnpm lockfile")
}

function rootLockToolVersions(): JsonRecord {
  const lockfile = readLockfile()
  const rootImporter = requireRecord(
    requireRecord(lockfile.importers, "lockfile importers")["."],
    "root importer",
  )
  const devDependencies = requireRecord(
    rootImporter.devDependencies,
    "root importer devDependencies",
  )
  return Object.fromEntries(
    ["@playwright/test", "esbuild", "jsdom"].map((name) => [
      name,
      requireRecord(devDependencies[name], `root importer ${name}`),
    ]),
  )
}

function lockSnapshot(
  snapshots: JsonRecord,
  name: string,
  reference: unknown,
  label: string,
): { readonly key: string; readonly value: JsonRecord; readonly version: string } {
  const resolved = requireString(reference, `${label} reference`)
  if (resolved.startsWith("link:") || resolved.startsWith("workspace:")) {
    throw new Error(`${label} must resolve to an external package snapshot`)
  }
  const key = `${name}@${resolved}`
  const value = requireRecord(snapshots[key], `${label} snapshot ${key}`)
  const peerSuffix = resolved.indexOf("(")
  const version = peerSuffix < 0 ? resolved : resolved.slice(0, peerSuffix)
  if (!/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/u.test(version)) {
    throw new Error(`${label} has an invalid resolved version`)
  }
  return { key, value, version }
}

function lockUiDependencyChain(importerName: string): JsonRecord {
  const lockfile = readLockfile()
  const importers = requireRecord(lockfile.importers, "lockfile importers")
  const packages = requireRecord(lockfile.packages, "lockfile packages")
  const snapshots = requireRecord(lockfile.snapshots, "lockfile snapshots")
  const importer = requireRecord(importers[importerName], `importers.${importerName}`)
  const dependencies = requireRecord(
    importer.dependencies,
    `importers.${importerName}.dependencies`,
  )
  const reactCoreOwner = requireRecord(
    dependencies["@copilotkit/react-core"],
    `importers.${importerName}.dependencies.@copilotkit/react-core`,
  )
  const reactCore = lockSnapshot(
    snapshots,
    "@copilotkit/react-core",
    reactCoreOwner.version,
    `${importerName} React Core`,
  )
  const streamdown = lockSnapshot(
    snapshots,
    "streamdown",
    requireRecord(reactCore.value.dependencies, "React Core snapshot dependencies").streamdown,
    `${importerName} Streamdown`,
  )
  const mermaid = lockSnapshot(
    snapshots,
    "mermaid",
    requireRecord(streamdown.value.dependencies, "Streamdown snapshot dependencies").mermaid,
    `${importerName} Mermaid`,
  )
  const dompurify = lockSnapshot(
    snapshots,
    "dompurify",
    requireRecord(mermaid.value.dependencies, "Mermaid snapshot dependencies").dompurify,
    `${importerName} DOMPurify`,
  )

  for (const [name, node] of [
    ["@copilotkit/react-core", reactCore],
    ["streamdown", streamdown],
    ["mermaid", mermaid],
    ["dompurify", dompurify],
  ] as const) {
    if (!Object.hasOwn(packages, `${name}@${node.version}`)) {
      throw new Error(`${importerName} lock package identity ${name}@${node.version} is missing`)
    }
  }

  return {
    dompurify: dompurify.version,
    mermaid: mermaid.version,
    reactCore: {
      specifier: requireString(reactCoreOwner.specifier, "React Core lock specifier"),
      version: reactCore.version,
    },
    streamdown: streamdown.version,
  }
}

async function runWorker(
  mermaidEsmUrl: string,
  securityCase?: WorkerCaseName,
): Promise<{
  readonly receipt: WorkerReceipt
  readonly stderrBytes: number
  readonly stdoutBytes: number
  readonly terminated: boolean
}> {
  const worker = new Worker(workerUrl, {
    resourceLimits: {
      maxOldGenerationSizeMb: 128,
      stackSizeMb: 4,
    },
    stderr: true,
    stdout: true,
    workerData: {
      mermaidEsmUrl,
      ...(securityCase !== undefined ? { securityCase } : {}),
    },
  })
  let stderrBytes = 0
  let stdoutBytes = 0
  worker.stderr?.on("data", (chunk: Buffer) => {
    stderrBytes += chunk.byteLength
  })
  worker.stdout?.on("data", (chunk: Buffer) => {
    stdoutBytes += chunk.byteLength
  })

  let timeout: NodeJS.Timeout | undefined
  let receipt: WorkerReceipt | undefined
  try {
    receipt = await new Promise<WorkerReceipt>((resolveMessage, reject) => {
      timeout = setTimeout(() => {
        reject(new Error("Mermaid worker exceeded its deadline"))
      }, 12_000)
      worker.once("error", reject)
      worker.once("message", (value: unknown) => {
        const bytes = Buffer.byteLength(JSON.stringify(value), "utf8")
        if (bytes > maxWorkerMessageBytes) {
          reject(new Error("Mermaid worker returned oversized JSON"))
          return
        }
        const record = requireRecord(value, "worker receipt")
        if (record.ok !== true) {
          const failure = requireRecord(record.error, "worker error")
          reject(
            new Error(
              `Mermaid worker reported ${String(failure.name)}: ${String(failure.message)}`,
            ),
          )
          return
        }
        resolveMessage(value as unknown as WorkerReceipt)
      })
    })
  } finally {
    if (timeout !== undefined) clearTimeout(timeout)
    await worker.terminate()
  }
  if (receipt === undefined) {
    throw new Error("Mermaid worker returned no receipt")
  }
  return {
    receipt,
    stderrBytes,
    stdoutBytes,
    terminated: worker.threadId === -1,
  }
}

describe("local Mermaid UI compatibility harness", () => {
  it("pins the exact private harness tools and root typecheck hook", () => {
    expect(rootToolVersions()).toEqual({
      "@playwright/test": "1.62.1/1.62.1",
      esbuild: "0.28.1/0.28.1",
      jsdom: "30.0.1/30.0.1",
    })
    expect(rootLockToolVersions()).toEqual({
      "@playwright/test": { specifier: "1.62.1", version: "1.62.1" },
      esbuild: { specifier: "0.28.1", version: "0.28.1" },
      jsdom: { specifier: "30.0.1", version: "30.0.1" },
    })
    const scripts = requireRecord(
      readManifest(resolve(repositoryRoot, "package.json")).scripts,
      "root scripts",
    )
    // The security-dependencies hook must stay on the end of the root
    // typecheck; `test/tsconfig.json` in front of it covers the rest of the
    // root test tree, which no gate reached before.
    expect(scripts.typecheck).toBe(
      "turbo run typecheck && tsc -p test/tsconfig.json --noEmit " +
        "&& tsc -p test/security-dependencies/tsconfig.json --noEmit",
    )
  })

  it("resolves the complete example-local UI chain and patched versions", () => {
    const receipts = [
      resolveUiDependencyReceipt("examples/chat/web"),
      resolveUiDependencyReceipt("examples/research/web"),
    ]
    expect(receipts).toMatchObject([
      { app: "@dawn-example/chat-web" },
      { app: "@dawn-example/research-web" },
    ])
    for (const importerName of ["examples/chat/web", "examples/research/web"] as const) {
      expect(lockUiDependencyChain(importerName)).toEqual({
        dompurify: "3.4.13",
        mermaid: "11.16.1",
        reactCore: { specifier: "^1.68.3", version: "1.68.3" },
        streamdown: "1.6.11",
      })
    }
    for (const receipt of receipts) {
      expect(receipt).toMatchObject({
        appReactCoreRange: "^1.68.3",
        dompurify: "3.4.13",
        mermaid: "11.16.1",
        mermaidDompurifyRange: "^3.3.3",
        reactCore: "1.68.3",
        reactCoreStreamdownRange: "^1.3.0",
        streamdown: "1.6.11",
        streamdownMermaidRange: "^11.11.0",
      })
      expect(receipt.mermaidEsmUrl).toMatch(/\/mermaid\/dist\/mermaid\.core\.mjs$/u)
    }
  })

  it("loads the resolved Mermaid ESM only inside a disposable jsdom worker", async () => {
    const beforeNavigator = Object.getOwnPropertyDescriptor(globalThis, "navigator")
    const chain = resolveUiDependencyReceipt("examples/chat/web")
    const result = await runWorker(chain.mermaidEsmUrl)
    expect(result.receipt).toEqual({
      cleanup: {
        globalsRestored: true,
        realmClosed: true,
      },
      diagram: {
        hasSvg: true,
        textLabels: 2,
        utf8Bytes: expect.any(Number),
      },
      ok: true,
    })
    expect(result.receipt.diagram.utf8Bytes).toBeGreaterThan(100)
    expect(result.receipt.diagram.utf8Bytes).toBeLessThanOrEqual(256_000)
    expect(result.stderrBytes).toBe(0)
    expect(result.stdoutBytes).toBe(0)
    expect(result.terminated).toBe(true)
    expect(Object.getOwnPropertyDescriptor(globalThis, "navigator")).toEqual(beforeNavigator)
  })

  it.each(workerCaseNames)(
    "isolates the %s security regression in a disposable worker",
    async (securityCase) => {
      const chain = resolveUiDependencyReceipt("examples/chat/web")
      const result = await runWorker(chain.mermaidEsmUrl, securityCase)
      if (securityCase === "config-prototype") {
        expect(result.receipt.securityCase).toMatchObject({
          activeConfigAfter: { markerAbsent: true, prototypeClean: true },
          activeConfigBefore: { markerAbsent: true, prototypeClean: true },
        })
      }
      expect(result.receipt.securityCase).toMatchObject({
        name: securityCase,
        prototypeCleanAfter: true,
        prototypeCleanBefore: true,
        settled: expect.stringMatching(/^(?:fulfilled|rejected)$/u),
      })
      if (securityCase === "xy-axis") {
        expect(result.receipt.securityCase?.settled).toBe("fulfilled")
      }
      if (securityCase === "css-sibling") {
        expect(result.receipt.securityCase?.safeCss).toBe(true)
      }
      if (securityCase === "strict-integration") {
        expect(result.receipt.securityCase?.sanitized).toBe(true)
      }
      expect(result.receipt.cleanup).toEqual({
        globalsRestored: true,
        realmClosed: true,
      })
      expect(result.stderrBytes).toBe(0)
      expect(result.stdoutBytes).toBe(0)
      expect(result.terminated).toBe(true)
    },
  )

  it("keeps Playwright discovery constrained to the adjacent browser spec", async () => {
    const config = (await import("./playwright.config.ts")).default
    expect(config.testDir).toBe(testDirectory)
    expect(config.testMatch).toBe("mermaid-browser.spec.ts")
  })
})
