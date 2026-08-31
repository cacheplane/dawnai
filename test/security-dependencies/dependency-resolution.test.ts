import { readFileSync } from "node:fs"
import { dirname, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { describe, expect, it } from "vitest"
import { parseDocument } from "yaml"

const testDirectory = dirname(fileURLToPath(import.meta.url))
const repositoryRoot = resolve(testDirectory, "../..")
const exampleImporters = ["examples/chat/web", "examples/research/web"] as const
const forbiddenOverrideSelector =
  /(^|>)(?:@copilotkit\/|@ag-ui\/|@ai-sdk\/provider-utils(?:@|$)|@hono\/node-server(?:@|$)|hono(?:@|$)|uuid(?:@|$))/

type JsonRecord = Record<string, unknown>
type DependencySection = "dependencies" | "devDependencies" | "optionalDependencies"

interface ParsedWorkspace {
  readonly importers: JsonRecord
  readonly manifestOverrides: Record<string, string>
  readonly packages: JsonRecord
  readonly snapshots: JsonRecord
}

interface Locator {
  readonly key: string
  readonly name: string
  readonly value: JsonRecord
  readonly version: string
}

interface ReverseParent {
  readonly identity: string
  readonly kind: "importer" | "snapshot"
  readonly section: DependencySection
  readonly targetIdentity: string
}

interface RootImporterPaths {
  readonly paths: string[][]
  readonly targetIdentity: string
}

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

function requireStringMap(value: unknown, label: string): Record<string, string> {
  const record = requireRecord(value, label)
  return Object.fromEntries(
    Object.entries(record).map(([key, entry]) => [key, requireString(entry, `${label}.${key}`)]),
  )
}

function parseJsonRecord(source: string, label: string): JsonRecord {
  let value: unknown
  try {
    value = JSON.parse(source)
  } catch {
    throw new Error(`${label} must contain valid JSON`)
  }
  return requireRecord(value, label)
}

function parseManifest(source: string): Record<string, string> {
  const manifest = parseJsonRecord(source, "package.json")
  const pnpm = requireRecord(manifest.pnpm, "package.json.pnpm")
  return requireStringMap(pnpm.overrides, "package.json.pnpm.overrides")
}

function parseLockfile(source: string): {
  readonly importers: JsonRecord
  readonly overrides: Record<string, string>
  readonly packages: JsonRecord
  readonly snapshots: JsonRecord
} {
  const document = parseDocument(source, {
    strict: true,
    uniqueKeys: true,
  })
  if (document.errors.length > 0 || document.warnings.length > 0) {
    throw new Error("pnpm-lock.yaml must parse without errors or warnings")
  }
  const lockfile = requireRecord(document.toJS({ maxAliasCount: 0 }), "pnpm-lock.yaml")
  const expectedKeys = [
    "importers",
    "lockfileVersion",
    "overrides",
    "packages",
    "settings",
    "snapshots",
  ]
  if (JSON.stringify(Object.keys(lockfile).sort()) !== JSON.stringify(expectedKeys)) {
    throw new Error("pnpm-lock.yaml has unexpected or missing top-level records")
  }
  if (lockfile.lockfileVersion !== "9.0") {
    throw new Error("pnpm-lock.yaml.lockfileVersion must be the string 9.0")
  }
  const settings = requireRecord(lockfile.settings, "pnpm-lock.yaml.settings")
  if (
    settings.autoInstallPeers !== true ||
    settings.excludeLinksFromLockfile !== false ||
    Object.keys(settings).length !== 2
  ) {
    throw new Error("pnpm-lock.yaml.settings has an unexpected shape")
  }
  return {
    importers: requireRecord(lockfile.importers, "pnpm-lock.yaml.importers"),
    overrides: requireStringMap(lockfile.overrides, "pnpm-lock.yaml.overrides"),
    packages: requireRecord(lockfile.packages, "pnpm-lock.yaml.packages"),
    snapshots: requireRecord(lockfile.snapshots, "pnpm-lock.yaml.snapshots"),
  }
}

function sortedStringMapEntries(value: Record<string, string>): string {
  return JSON.stringify(Object.entries(value).sort(([left], [right]) => left.localeCompare(right)))
}

function readWorkspace(): ParsedWorkspace {
  const manifestOverrides = parseManifest(
    readFileSync(resolve(repositoryRoot, "package.json"), "utf8"),
  )
  const lockfile = parseLockfile(readFileSync(resolve(repositoryRoot, "pnpm-lock.yaml"), "utf8"))
  if (sortedStringMapEntries(manifestOverrides) !== sortedStringMapEntries(lockfile.overrides)) {
    throw new Error("manifest and lockfile override maps must match")
  }
  return {
    importers: lockfile.importers,
    manifestOverrides,
    packages: lockfile.packages,
    snapshots: lockfile.snapshots,
  }
}

function parseLocatorIdentity(
  key: string,
  label: string,
): { readonly name: string; readonly version: string } {
  const peerSuffix = key.indexOf("(")
  const bareKey = peerSuffix < 0 ? key : key.slice(0, peerSuffix)
  const suffix = peerSuffix < 0 ? "" : key.slice(peerSuffix)
  const peerGroups: string[] = []
  let groupStart = -1
  let depth = 0
  let validSuffix = !bareKey.includes(")")
  for (let index = 0; validSuffix && index < suffix.length; index += 1) {
    const character = suffix[index]
    if (character === "(") {
      if (depth === 0) groupStart = index + 1
      depth += 1
    } else if (character === ")") {
      if (depth === 0) {
        validSuffix = false
        continue
      }
      depth -= 1
      if (depth === 0) {
        const peerGroup = suffix.slice(groupStart, index)
        if (peerGroup.length === 0) {
          validSuffix = false
        } else {
          peerGroups.push(peerGroup)
        }
      }
    } else if (depth === 0) {
      validSuffix = false
    }
  }
  if (!validSuffix || depth !== 0) {
    throw new Error(`${label} contains malformed package locator ${key}`)
  }
  const separator = bareKey.indexOf("@", 1)
  if (separator <= 0 || separator === bareKey.length - 1) {
    throw new Error(`${label} contains malformed package locator ${key}`)
  }
  const name = bareKey.slice(0, separator)
  const version = bareKey.slice(separator + 1)
  const packageSegment = /^[A-Za-z0-9][A-Za-z0-9._~-]*$/
  const validName = name.startsWith("@")
    ? (() => {
        const slash = name.indexOf("/")
        return (
          slash > 1 &&
          slash < name.length - 1 &&
          name.indexOf("/", slash + 1) < 0 &&
          packageSegment.test(name.slice(1, slash)) &&
          packageSegment.test(name.slice(slash + 1))
        )
      })()
    : packageSegment.test(name)
  if (!validName || /[()\s]/.test(version)) {
    throw new Error(`${label} contains malformed package locator ${key}`)
  }
  let peerGroupStart = 0
  if (peerGroups[0]?.startsWith("patch_hash=")) {
    if (!/^patch_hash=[a-z0-9]+$/.test(peerGroups[0])) {
      throw new Error(`${label} contains malformed package locator ${key}`)
    }
    peerGroupStart = 1
  }
  const dependencyPeerGroups = peerGroups.slice(peerGroupStart)
  if (dependencyPeerGroups.some((peerGroup) => peerGroup.startsWith("patch_hash="))) {
    throw new Error(`${label} contains malformed package locator ${key}`)
  }
  const compressedPeerGraph = /^[0-9a-f]{32}$/
  if (dependencyPeerGroups.some((peerGroup) => compressedPeerGraph.test(peerGroup))) {
    if (
      dependencyPeerGroups.length !== 1 ||
      !compressedPeerGraph.test(dependencyPeerGroups[0] ?? "")
    ) {
      throw new Error(`${label} contains malformed package locator ${key}`)
    }
  } else {
    for (const peerGroup of dependencyPeerGroups) {
      parseLocatorIdentity(peerGroup, `${label} peer suffix`)
    }
  }
  return { name, version }
}

function parseLocator(key: string, value: unknown, label: string): Locator {
  const identity = parseLocatorIdentity(key, label)
  return {
    key,
    name: identity.name,
    value: requireRecord(value, `${label}.${key}`),
    version: identity.version,
  }
}

function locatorsFor(record: JsonRecord, name: string, label: string): Locator[] {
  return Object.entries(record)
    .map(([key, value]) => parseLocator(key, value, label))
    .filter((locator) => locator.name === name)
    .sort((left, right) => left.key.localeCompare(right.key))
}

function versionTuple(version: string): readonly [number, number, number] {
  const match = /^(\d+)\.(\d+)\.(\d+)$/.exec(version)
  if (!match) throw new Error(`invalid release version ${version}`)
  return [Number(match[1]), Number(match[2]), Number(match[3])]
}

function compareVersions(left: string, right: string): number {
  const leftTuple = versionTuple(left)
  const rightTuple = versionTuple(right)
  for (const index of [0, 1, 2] as const) {
    const difference = leftTuple[index] - rightTuple[index]
    if (difference !== 0) return difference
  }
  return 0
}

function packageVersions(workspace: ParsedWorkspace, name: string): string[] {
  const versions = new Set<string>()
  for (const [recordName, record] of [
    ["packages", workspace.packages],
    ["snapshots", workspace.snapshots],
  ] as const) {
    for (const locator of locatorsFor(record, name, recordName)) {
      versions.add(locator.version)
    }
  }
  return [...versions].sort(compareVersions)
}

function importerDependency(
  workspace: ParsedWorkspace,
  importerName: string,
  sectionName: "dependencies" | "devDependencies",
  dependencyName: string,
): { readonly specifier: string; readonly version: string } {
  const importer = requireRecord(workspace.importers[importerName], `importers.${importerName}`)
  const section = requireRecord(importer[sectionName], `importers.${importerName}.${sectionName}`)
  const entry = requireRecord(
    section[dependencyName],
    `importers.${importerName}.${sectionName}.${dependencyName}`,
  )
  if (Object.keys(entry).sort().join(",") !== "specifier,version") {
    throw new Error(
      `importers.${importerName}.${sectionName}.${dependencyName} has an unexpected shape`,
    )
  }
  return {
    specifier: requireString(entry.specifier, "dependency specifier"),
    version: requireString(entry.version, "dependency version"),
  }
}

function importerDependencyLocator(
  workspace: ParsedWorkspace,
  importerName: string,
  sectionName: "dependencies" | "devDependencies",
  dependencyName: string,
): Locator {
  const dependency = importerDependency(workspace, importerName, sectionName, dependencyName)
  const label = `importers.${importerName}.${sectionName}.${dependencyName}`
  const target = snapshotTarget(workspace, dependencyName, dependency.version, `${label}.version`)
  if (!target) throw new Error(`${label} must resolve to an external snapshot`)
  return parseLocator(target, workspace.snapshots[target], "snapshots")
}

function snapshotTarget(
  workspace: ParsedWorkspace,
  dependencyName: string,
  reference: string,
  label: string,
): string | undefined {
  if (reference.startsWith("link:") || reference.startsWith("workspace:")) {
    return undefined
  }
  const target = `${dependencyName}@${reference}`
  const candidates = [...new Set([target, reference])].filter((candidate) =>
    Object.hasOwn(workspace.snapshots, candidate),
  )
  if (candidates.length === 1) return candidates[0]
  if (candidates.length > 1) {
    throw new Error(`${label} has ambiguous snapshot references ${candidates.join(", ")}`)
  }
  throw new Error(`${label} has dangling snapshot reference ${target}`)
}

function addReverseParent(
  index: Map<string, ReverseParent[]>,
  targetIdentity: string,
  parent: Omit<ReverseParent, "targetIdentity">,
): void {
  const parents = index.get(targetIdentity) ?? []
  parents.push({ ...parent, targetIdentity })
  index.set(targetIdentity, parents)
}

function reverseParentIndex(workspace: ParsedWorkspace): Map<string, ReverseParent[]> {
  const index = new Map<string, ReverseParent[]>()
  for (const [key, value] of Object.entries(workspace.snapshots)) {
    const parent = parseLocator(key, value, "snapshots")
    for (const section of ["dependencies", "optionalDependencies"] as const) {
      if (parent.value[section] === undefined) continue
      const dependencies = requireRecord(parent.value[section], `${parent.key}.${section}`)
      for (const [dependencyName, value] of Object.entries(dependencies)) {
        const reference = requireString(value, `${parent.key}.${section}.${dependencyName}`)
        const target = snapshotTarget(
          workspace,
          dependencyName,
          reference,
          `${parent.key}.${section}.${dependencyName}`,
        )
        if (target) {
          addReverseParent(index, target, {
            identity: parent.key,
            kind: "snapshot",
            section,
          })
        }
      }
    }
  }

  for (const [importerName, value] of Object.entries(workspace.importers)) {
    const importer = requireRecord(value, `importers.${importerName}`)
    for (const section of ["dependencies", "devDependencies", "optionalDependencies"] as const) {
      if (importer[section] === undefined) continue
      const dependencies = requireRecord(importer[section], `importers.${importerName}.${section}`)
      for (const [dependencyName, value] of Object.entries(dependencies)) {
        const entry = requireRecord(value, `importers.${importerName}.${section}.${dependencyName}`)
        const reference = requireString(
          entry.version,
          `importers.${importerName}.${section}.${dependencyName}.version`,
        )
        const target = snapshotTarget(
          workspace,
          dependencyName,
          reference,
          `importers.${importerName}.${section}.${dependencyName}`,
        )
        if (target) {
          addReverseParent(index, target, {
            identity: importerName,
            kind: "importer",
            section,
          })
        }
      }
    }
  }

  for (const parents of index.values()) {
    parents.sort((left, right) =>
      `${left.kind}:${left.identity}:${left.section}`.localeCompare(
        `${right.kind}:${right.identity}:${right.section}`,
      ),
    )
  }
  return index
}

function reverseParents(
  workspace: ParsedWorkspace,
  name: string,
  version: string,
): ReverseParent[] {
  const index = reverseParentIndex(workspace)
  return locatorsFor(workspace.snapshots, name, "snapshots")
    .filter((locator) => locator.version === version)
    .flatMap((locator) => index.get(locator.key) ?? [])
}

function rootImporterPathsToVersion(
  workspace: ParsedWorkspace,
  name: string,
  version: string,
): RootImporterPaths[] {
  const index = reverseParentIndex(workspace)
  return locatorsFor(workspace.snapshots, name, "snapshots")
    .filter((target) => target.version === version)
    .map((target) => {
      const paths: string[][] = []
      const visit = (
        identity: string,
        path: readonly string[],
        activePath: ReadonlySet<string>,
      ): void => {
        for (const parent of index.get(identity) ?? []) {
          if (parent.kind === "importer") {
            paths.push([parent.identity, ...path])
            continue
          }
          if (activePath.has(parent.identity)) continue
          visit(
            parent.identity,
            [parent.identity, ...path],
            new Set([...activePath, parent.identity]),
          )
        }
      }
      visit(target.key, [target.key], new Set([target.key]))
      paths.sort((left, right) => left.join(" -> ").localeCompare(right.join(" -> ")))
      return { paths, targetIdentity: target.key }
    })
}

function patchedFloorFailures(workspace: ParsedWorkspace): string[] {
  const failures: string[] = []
  for (const [name, floors] of [
    ["hono", { 4: "4.12.34" }],
    ["@hono/node-server", { 1: "1.19.15", 2: "2.0.10" }],
  ] as const) {
    for (const version of packageVersions(workspace, name)) {
      const floor = floors[versionTuple(version)[0] as keyof typeof floors]
      if (floor && compareVersions(version, floor) < 0) {
        failures.push(`${name}@${version} is below ${floor}`)
      }
    }
  }
  for (const version of packageVersions(workspace, "uuid")) {
    if (compareVersions(version, "11.1.1") < 0) {
      failures.push(`uuid@${version} is below 11.1.1`)
    }
  }
  return failures.sort()
}

function isPackageIdentity(
  identity: string,
  name: string,
  versionMatches: (version: string) => boolean,
): boolean {
  if (!identity.startsWith(`${name}@`)) return false
  const parsed = parseLocatorIdentity(identity, "dependency path")
  return parsed.name === name && versionMatches(parsed.version)
}

function legacyAgUiParentFailures(workspace: ParsedWorkspace): string[] {
  if (!packageVersions(workspace, "@ag-ui/client").includes("0.0.54")) return []
  const parents = reverseParents(workspace, "@ag-ui/client", "0.0.54")
  const targets = locatorsFor(workspace.snapshots, "@ag-ui/client", "snapshots").filter(
    (locator) => locator.version === "0.0.54",
  )
  if (targets.length === 0) return ["@ag-ui/client@0.0.54 has no snapshot identities"]
  return targets
    .flatMap((target) => {
      const targetParents = parents.filter((parent) => parent.targetIdentity === target.key)
      if (targetParents.length === 0) return [`${target.key} has no reverse parents`]
      return targetParents.flatMap((parent) =>
        parent.kind === "snapshot" &&
        /^@ag-ui\/mcp-middleware@0\.0\.1(?:\(|$)/.test(parent.identity)
          ? []
          : [`${target.key} has unexpected reverse parent ${parent.identity}`],
      )
    })
    .sort()
}

function providerUtilsRootPathFailure(
  targetIdentity: string,
  path: readonly string[],
): string | undefined {
  if (!exampleImporters.includes(path[0] as (typeof exampleImporters)[number])) {
    return `${targetIdentity} starts at unexpected importer ${path[0] ?? "<missing>"}`
  }
  const runtimeIndex = path.findIndex((identity) =>
    isPackageIdentity(identity, "@copilotkit/runtime", (candidate) => candidate === "1.70.0"),
  )
  const vertexIndex = path.findIndex((identity) =>
    isPackageIdentity(
      identity,
      "@ai-sdk/google-vertex",
      (candidate) => versionTuple(candidate)[0] === 3,
    ),
  )
  const providerUtilsIndex = path.indexOf(targetIdentity)
  if (
    runtimeIndex <= 0 ||
    vertexIndex <= runtimeIndex ||
    providerUtilsIndex <= vertexIndex ||
    providerUtilsIndex !== path.length - 1
  ) {
    return `${targetIdentity} has an unexpected root importer path ${path.join(" -> ")}`
  }
  return undefined
}

function providerUtilsPathFailures(workspace: ParsedWorkspace): string[] {
  const failures: string[] = []
  const affectedVersions = packageVersions(workspace, "@ai-sdk/provider-utils").filter(
    (version) => compareVersions(version, "3.0.0") >= 0 && compareVersions(version, "3.0.97") <= 0,
  )
  for (const version of affectedVersions) {
    const targets = rootImporterPathsToVersion(workspace, "@ai-sdk/provider-utils", version)
    if (targets.length === 0) {
      failures.push(`@ai-sdk/provider-utils@${version} has no snapshot identities`)
    }
    for (const target of targets) {
      if (target.paths.length === 0) {
        failures.push(`${target.targetIdentity} has no root importer paths`)
      }
      for (const path of target.paths) {
        const failure = providerUtilsRootPathFailure(target.targetIdentity, path)
        if (failure) failures.push(failure)
      }
    }
  }
  return failures.sort()
}

describe("dependency security graph invariants", () => {
  it("pins the dedicated config boundary, TSX include, and app-local browser mappings", async () => {
    const vitestConfig = (await import("./vitest.config.ts")).default
    const config = vitestConfig
    const testConfig = requireRecord(config.test, "vitest config test block")
    expect(config.root).toBe(repositoryRoot)
    expect(testConfig.environment).toBe("node")
    expect(testConfig.testTimeout).toBe(30_000)
    expect(testConfig.hookTimeout).toBe(30_000)
    expect(testConfig.include).toEqual([
      "test/security-dependencies/**/*.test.ts",
      "test/security-dependencies/**/*.test.tsx",
    ])
    expect(testConfig.env).toEqual({
      COPILOTKIT_TELEMETRY_DISABLED: "true",
      DO_NOT_TRACK: "1",
      GH_TOKEN: "",
      GITHUB_TOKEN: "",
      NODE_AUTH_TOKEN: "",
      NPM_TOKEN: "",
    })

    const tsconfig = requireRecord(
      JSON.parse(readFileSync(resolve(testDirectory, "tsconfig.json"), "utf8")),
      "security tsconfig",
    )
    const compilerOptions = requireRecord(
      tsconfig.compilerOptions,
      "security tsconfig compilerOptions",
    )
    expect(compilerOptions.jsx).toBe("react-jsx")
    expect(compilerOptions.allowImportingTsExtensions).toBe(true)
    expect(compilerOptions.lib).toEqual(["ES2022", "DOM", "DOM.Iterable"])
    expect(compilerOptions.noEmit).toBe(true)
    expect(compilerOptions.paths).toEqual({
      "@copilotkit/react-core/v2": [
        "../../examples/chat/web/node_modules/@copilotkit/react-core/dist/v2/index.d.mts",
      ],
      react: ["../../examples/chat/web/node_modules/@types/react/index.d.ts"],
      "react/jsx-runtime": ["../../examples/chat/web/node_modules/@types/react/jsx-runtime.d.ts"],
      "react-dom": ["../../examples/chat/web/node_modules/@types/react-dom/index.d.ts"],
      "react-dom/client": ["../../examples/chat/web/node_modules/@types/react-dom/client.d.ts"],
    })
  })

  it("makes the examples and AG-UI package stable CopilotKit owners", () => {
    const workspace = readWorkspace()
    for (const importerName of exampleImporters) {
      const manifestPath = `${importerName}/package.json`
      const manifest = parseJsonRecord(
        readFileSync(resolve(repositoryRoot, manifestPath), "utf8"),
        manifestPath,
      )
      expect(manifest.private).toBe(true)
      const manifestDependencies = requireStringMap(
        manifest.dependencies,
        `${manifestPath}.dependencies`,
      )
      expect(manifestDependencies["@copilotkit/react-core"]).toBe("^1.70.0")
      expect(manifestDependencies["@copilotkit/runtime"]).toBe("^1.70.0")
      expect(manifestDependencies["@ag-ui/client"]).toBe("0.0.59")

      for (const dependency of ["@copilotkit/react-core", "@copilotkit/runtime"] as const) {
        const owned = importerDependency(workspace, importerName, "dependencies", dependency)
        expect(owned.specifier).toBe("^1.70.0")
        const target = importerDependencyLocator(
          workspace,
          importerName,
          "dependencies",
          dependency,
        )
        expect({ name: target.name, version: target.version }).toEqual({
          name: dependency,
          version: "1.70.0",
        })
      }
      expect(importerDependency(workspace, importerName, "dependencies", "@ag-ui/client")).toEqual({
        specifier: "0.0.59",
        version: "0.0.59",
      })
      const agUiTarget = importerDependencyLocator(
        workspace,
        importerName,
        "dependencies",
        "@ag-ui/client",
      )
      expect({ name: agUiTarget.name, version: agUiTarget.version }).toEqual({
        name: "@ag-ui/client",
        version: "0.0.59",
      })
    }

    const agUiManifestPath = "packages/ag-ui/package.json"
    const agUiManifest = parseJsonRecord(
      readFileSync(resolve(repositoryRoot, agUiManifestPath), "utf8"),
      agUiManifestPath,
    )
    const agUiDependencies = requireStringMap(
      agUiManifest.dependencies,
      `${agUiManifestPath}.dependencies`,
    )
    const agUiDevDependencies = requireStringMap(
      agUiManifest.devDependencies,
      `${agUiManifestPath}.devDependencies`,
    )
    expect(agUiDependencies["@ag-ui/core"]).toBe("0.0.59")
    expect(agUiDependencies["@ag-ui/encoder"]).toBe("0.0.59")
    expect(agUiDevDependencies["@ag-ui/client"]).toBe("0.0.59")
    expect(agUiDevDependencies["@copilotkit/react-core"]).toBe("^1.70.0")
    expect(
      requireStringMap(agUiManifest.peerDependencies, `${agUiManifestPath}.peerDependencies`)[
        "@copilotkit/react-core"
      ],
    ).toBe(">=1.66.0")
    expect(
      importerDependency(workspace, "packages/ag-ui", "devDependencies", "@ag-ui/client"),
    ).toEqual({ specifier: "0.0.59", version: "0.0.59" })
    const agUiClientOwner = importerDependencyLocator(
      workspace,
      "packages/ag-ui",
      "devDependencies",
      "@ag-ui/client",
    )
    expect({ name: agUiClientOwner.name, version: agUiClientOwner.version }).toEqual({
      name: "@ag-ui/client",
      version: "0.0.59",
    })
    const agUiOwner = importerDependency(
      workspace,
      "packages/ag-ui",
      "devDependencies",
      "@copilotkit/react-core",
    )
    expect(agUiOwner.specifier).toBe("^1.70.0")
    const agUiReactCoreOwner = importerDependencyLocator(
      workspace,
      "packages/ag-ui",
      "devDependencies",
      "@copilotkit/react-core",
    )
    expect({ name: agUiReactCoreOwner.name, version: agUiReactCoreOwner.version }).toEqual({
      name: "@copilotkit/react-core",
      version: "1.70.0",
    })

    const cliManifestPath = "packages/cli/package.json"
    const cliManifest = parseJsonRecord(
      readFileSync(resolve(repositoryRoot, cliManifestPath), "utf8"),
      cliManifestPath,
    )
    expect(
      requireStringMap(cliManifest.dependencies, `${cliManifestPath}.dependencies`)["@ag-ui/core"],
    ).toBe("0.0.59")
  })

  it("contains only CopilotKit 1.70.0 package identities", () => {
    const workspace = readWorkspace()
    for (const name of ["@copilotkit/react-core", "@copilotkit/runtime"] as const) {
      expect(packageVersions(workspace, name)).toEqual(["1.70.0"])
    }
  })

  it("keeps direct AG-UI on 0.0.59 and isolates any legacy 0.0.54", () => {
    const workspace = readWorkspace()
    const versions = packageVersions(workspace, "@ag-ui/client")
    expect(versions).not.toContain("0.0.58")
    expect(legacyAgUiParentFailures(workspace)).toEqual([])
  })

  it("contains no override selectors for the public dependency owners", () => {
    const workspace = readWorkspace()
    expect(
      Object.keys(workspace.manifestOverrides).filter((selector) =>
        forbiddenOverrideSelector.test(selector),
      ),
    ).toEqual([])
    expect(
      [
        "@copilotkit/runtime@<2",
        "parent>@ag-ui/client@0.0.58",
        "@scope/parent>@ai-sdk/provider-utils@<=3.0.97",
        "parent>@hono/node-server@<2.0.10",
        "hono@<4.12.34",
        "parent>uuid@<11.1.1",
      ].every((selector) => forbiddenOverrideSelector.test(selector)),
    ).toBe(true)
  })

  it("keeps only the unavoidable js-yaml policy for the remediated packages", () => {
    const workspace = readWorkspace()
    const remediatedPackages = [
      "body-parser",
      "brace-expansion",
      "dompurify",
      "fast-uri",
      "ip-address",
      "js-yaml",
      "mermaid",
      "nanoid",
      "postcss",
    ] as const
    const remediatedSelectors = Object.keys(workspace.manifestOverrides)
      .filter((selector) =>
        remediatedPackages.some(
          (packageName) =>
            selector === packageName ||
            selector.startsWith(`${packageName}@`) ||
            selector.includes(`>${packageName}@`) ||
            selector.endsWith(`>${packageName}`),
        ),
      )
      .sort()

    expect(remediatedSelectors).toEqual(["js-yaml@>=4 <4.3.1"])
    expect(workspace.manifestOverrides["js-yaml@>=4 <4.3.1"]).toBe("4.3.1")
  })

  it("contains no Hono, node-server, or UUID package below its patched floor", () => {
    expect(patchedFloorFailures(readWorkspace())).toEqual([])
  })

  it("scopes affected provider-utils 3.x paths to private CopilotKit Vertex", () => {
    expect(providerUtilsPathFailures(readWorkspace())).toEqual([])
  })

  it("rejects malformed peer suffixes", () => {
    expect(
      parseLocatorIdentity(
        "@scope/package@1.2.3(peer@1.0.0)(nested@2.0.0(child@3.0.0))",
        "valid nested peers",
      ),
    ).toEqual({ name: "@scope/package", version: "1.2.3" })
    for (const malformed of [
      "package@1.0.0)",
      "package@1.0.0(peer@1.0.0",
      "package@1.0.0(peer@1.0.0)stray",
      "package@1.0.0(peer@1.0.0))",
    ]) {
      expect(() => parseLocatorIdentity(malformed, "synthetic locator")).toThrow(
        "malformed package locator",
      )
    }
  })

  it("rejects balanced peer groups whose contents are not locators", () => {
    expect(
      parseLocatorIdentity(
        "@copilotkit/runtime@1.68.3(@langchain/core@1.2.5(openai@6.45.0(zod@4.4.3)))(vitest@4.1.10)",
        "valid real-shape peers",
      ),
    ).toEqual({ name: "@copilotkit/runtime", version: "1.68.3" })
    for (const [label, malformed] of [
      ["missing peer version", "package@1.0.0(peer)"],
      ["invalid peer name", "package@1.0.0(peer!@1.0.0)"],
      ["malformed scoped peer", "package@1.0.0(@scope@1.0.0)"],
      ["nested junk", "package@1.0.0(peer@1.0.0(junk))"],
      ["empty peer version", "package@1.0.0(peer@)"],
      ["nested empty version", "package@1.0.0(peer@1.0.0(child@))"],
    ] as const) {
      expect
        .soft(() => parseLocatorIdentity(malformed, label), label)
        .toThrow("malformed package locator")
    }
  })

  it("accepts pnpm patch hashes, compressed peer graphs, and referenced versions", () => {
    for (const [label, locator, expected] of [
      [
        "patch-only hex hash",
        "package@1.0.0(patch_hash=abcdef0123456789)",
        { name: "package", version: "1.0.0" },
      ],
      [
        "patch-only alphanumeric hash",
        "package@1.0.0(patch_hash=abc123z9)",
        { name: "package", version: "1.0.0" },
      ],
      [
        "compressed peer graph",
        "package@1.0.0(0123456789abcdef0123456789abcdef)",
        { name: "package", version: "1.0.0" },
      ],
      [
        "patch and expanded peers",
        "package@1.0.0(patch_hash=abc123)(peer@2.0.0)(@scope/nested@3.0.0)",
        { name: "package", version: "1.0.0" },
      ],
      [
        "patch and compressed peer graph",
        "package@1.0.0(patch_hash=abc123)(0123456789abcdef0123456789abcdef)",
        { name: "package", version: "1.0.0" },
      ],
      [
        "referenced version containing at-sign",
        "alias@npm:target@1.0.0",
        { name: "alias", version: "npm:target@1.0.0" },
      ],
    ] as const) {
      expect(parseLocatorIdentity(locator, label), label).toEqual(expected)
    }
  })

  it("rejects malformed patch hashes and compressed peer graphs", () => {
    for (const [label, locator] of [
      ["empty patch hash", "package@1.0.0(patch_hash=)"],
      ["uppercase patch hash", "package@1.0.0(patch_hash=ABC123)"],
      ["punctuated patch hash", "package@1.0.0(patch_hash=abc-123)"],
      ["wrong patch prefix", "package@1.0.0(patch-hash=abc123)"],
      ["duplicate patch hash", "package@1.0.0(patch_hash=abc123)(patch_hash=def456)"],
      ["patch hash after peer", "package@1.0.0(peer@2.0.0)(patch_hash=abc123)"],
      ["short compressed peer graph", "package@1.0.0(0123456789abcdef)"],
      ["nonhex compressed peer graph", "package@1.0.0(gggggggggggggggggggggggggggggggg)"],
    ] as const) {
      expect
        .soft(() => parseLocatorIdentity(locator, label), label)
        .toThrow("malformed package locator")
    }
  })

  it("rejects ambiguous alias targets", () => {
    const ambiguousWorkspace: ParsedWorkspace = {
      importers: {},
      manifestOverrides: {},
      packages: {},
      snapshots: {
        "alias@target@1.0.0": {},
        "target@1.0.0": {},
      },
    }
    expect(() =>
      snapshotTarget(ambiguousWorkspace, "alias", "target@1.0.0", "synthetic alias"),
    ).toThrow("ambiguous")
    expect(
      snapshotTarget(ambiguousWorkspace, "workspace-package", "link:../workspace", "workspace"),
    ).toBeUndefined()
  })

  it("rejects dangling direct-owner references", () => {
    const danglingWorkspace: ParsedWorkspace = {
      importers: {
        "examples/chat/web": {
          dependencies: {
            "@copilotkit/runtime": {
              specifier: "^1.68.3",
              version: "1.68.3(zod@4.4.3)",
            },
          },
        },
      },
      manifestOverrides: {},
      packages: { "@copilotkit/runtime@1.68.3": {} },
      snapshots: {},
    }
    expect(() =>
      importerDependencyLocator(
        danglingWorkspace,
        "examples/chat/web",
        "dependencies",
        "@copilotkit/runtime",
      ),
    ).toThrow("dangling snapshot reference")
  })

  it("resolves alias-style direct-owner references", () => {
    const aliasWorkspace: ParsedWorkspace = {
      importers: {
        "examples/chat/web": {
          dependencies: {
            alias: { specifier: "npm:target@1.0.0", version: "target@1.0.0" },
          },
        },
      },
      manifestOverrides: {},
      packages: { "target@1.0.0": {} },
      snapshots: { "target@1.0.0": {} },
    }
    const target = importerDependencyLocator(
      aliasWorkspace,
      "examples/chat/web",
      "dependencies",
      "alias",
    )
    expect({ key: target.key, name: target.name, version: target.version }).toEqual({
      key: "target@1.0.0",
      name: "target",
      version: "1.0.0",
    })
  })

  it("rejects malformed provider-utils root paths", () => {
    const target = "@ai-sdk/provider-utils@3.0.50(zod@3.25.76)"
    const runtime = "@copilotkit/runtime@1.70.0(zod@3.25.76)"
    const vertex = "@ai-sdk/google-vertex@3.0.1(zod@3.25.76)"
    expect(
      providerUtilsRootPathFailure(target, ["examples/chat/web", runtime, vertex, target]),
    ).toBeUndefined()
    for (const [label, path] of [
      ["unexpected importer", ["packages/cli", runtime, vertex, target]],
      ["missing runtime", ["examples/chat/web", vertex, target]],
      ["wrong runtime", ["examples/chat/web", "@copilotkit/runtime@1.69.9", vertex, target]],
      ["missing Vertex", ["examples/chat/web", runtime, target]],
      ["wrong Vertex", ["examples/chat/web", runtime, "@ai-sdk/google-vertex@2.9.0", target]],
      ["incorrect ordering", ["examples/chat/web", vertex, runtime, target]],
    ] as const) {
      expect(providerUtilsRootPathFailure(target, path), label).toBeDefined()
    }
  })

  it("reports a synthetic version below its patched floor", () => {
    const belowFloorWorkspace: ParsedWorkspace = {
      importers: {},
      manifestOverrides: {},
      packages: { "hono@4.12.33": {} },
      snapshots: { "hono@4.12.33": {} },
    }
    expect(patchedFloorFailures(belowFloorWorkspace)).toEqual(["hono@4.12.33 is below 4.12.34"])
  })

  it("reports an orphan provider-utils peer identity independently", () => {
    const approvedProvider = "@ai-sdk/provider-utils@3.0.50(zod@3.25.76)"
    const orphanProvider = "@ai-sdk/provider-utils@3.0.50(zod@4.4.3)"
    const providerWorkspace: ParsedWorkspace = {
      importers: {
        "examples/chat/web": {
          dependencies: {
            "@copilotkit/runtime": {
              specifier: "^1.70.0",
              version: "1.70.0(zod@3.25.76)",
            },
          },
        },
      },
      manifestOverrides: {},
      packages: {
        "@ai-sdk/google-vertex@3.0.1": {},
        "@ai-sdk/provider-utils@3.0.50": {},
        "@copilotkit/runtime@1.70.0": {},
      },
      snapshots: {
        "@ai-sdk/google-vertex@3.0.1(zod@3.25.76)": {
          dependencies: {
            "@ai-sdk/provider-utils": "3.0.50(zod@3.25.76)",
          },
        },
        [approvedProvider]: {},
        [orphanProvider]: {},
        "@copilotkit/runtime@1.70.0(zod@3.25.76)": {
          dependencies: {
            "@ai-sdk/google-vertex": "3.0.1(zod@3.25.76)",
          },
        },
      },
    }
    expect(providerUtilsPathFailures(providerWorkspace)).toEqual([
      `${orphanProvider} has no root importer paths`,
    ])
  })

  it("reports an orphan AG-UI peer identity independently", () => {
    const approvedClient = "@ag-ui/client@0.0.54(rxjs@7.8.1)"
    const orphanClient = "@ag-ui/client@0.0.54(rxjs@8.0.0)"
    const agUiWorkspace: ParsedWorkspace = {
      importers: {},
      manifestOverrides: {},
      packages: {
        "@ag-ui/client@0.0.54": {},
        "@ag-ui/mcp-middleware@0.0.1": {},
      },
      snapshots: {
        [approvedClient]: {},
        "@ag-ui/mcp-middleware@0.0.1(rxjs@7.8.1)": {
          dependencies: { "@ag-ui/client": "0.0.54(rxjs@7.8.1)" },
        },
        [orphanClient]: {},
      },
    }
    expect(legacyAgUiParentFailures(agUiWorkspace)).toEqual([
      `${orphanClient} has no reverse parents`,
    ])
  })

  it("keeps graph traversal cycle-safe and parsing fail-closed", () => {
    expect(() => parseManifest("{")).toThrow("valid JSON")
    expect(() => parseLockfile("lockfileVersion: 9\nsettings: false\n")).toThrow("pnpm-lock.yaml")
    expect(() => parseLockfile("lockfileVersion: '9.0'\nlockfileVersion: '9.0'\n")).toThrow(
      "parse without errors",
    )

    const cyclicWorkspace: ParsedWorkspace = {
      importers: {
        "examples/chat/web": {
          dependencies: {
            "cycle-a": { specifier: "1.0.0", version: "1.0.0" },
          },
        },
      },
      manifestOverrides: {},
      packages: {
        "@ai-sdk/provider-utils@3.0.50": {},
        "cycle-a@1.0.0": {},
        "cycle-b@1.0.0": {},
      },
      snapshots: {
        "@ai-sdk/provider-utils@3.0.50": {},
        "cycle-a@1.0.0": { dependencies: { "cycle-b": "1.0.0" } },
        "cycle-b@1.0.0": {
          dependencies: {
            "@ai-sdk/provider-utils": "3.0.50",
            "cycle-a": "1.0.0",
          },
        },
      },
    }
    expect(rootImporterPathsToVersion(cyclicWorkspace, "@ai-sdk/provider-utils", "3.0.50")).toEqual(
      [
        {
          paths: [
            [
              "examples/chat/web",
              "cycle-a@1.0.0",
              "cycle-b@1.0.0",
              "@ai-sdk/provider-utils@3.0.50",
            ],
          ],
          targetIdentity: "@ai-sdk/provider-utils@3.0.50",
        },
      ],
    )
  })
})
