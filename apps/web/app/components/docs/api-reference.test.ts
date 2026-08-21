import { spawnSync } from "node:child_process"
import { existsSync, readdirSync, readFileSync } from "node:fs"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import { describe, expect, it } from "vitest"
import * as apiReferenceExports from "./api-reference"
import {
  API_REFERENCE_GUARD_IDS,
  API_REQUIRED_CONTRACT_KEYS,
  type ApiReferenceArtifact,
  ARTIFACT_REGISTRY,
  artifactAddressFor,
  artifactBoundaryFor,
  GENERATED_ROUTES_ARTIFACT,
  PACKAGE_CATALOG,
  validateApiReferenceRegistries,
} from "./api-reference"
import { API_REFERENCE_PAGES, API_REFERENCE_PARENT } from "./api-reference-pages"

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "../../../../..")
const CHECK_DOCS_PATH = join(REPO_ROOT, "scripts/check-docs.mjs")
const CHANGESET_PATH = join(REPO_ROOT, ".changeset/api-reference-coverage.md")

const EXPECTED_REFERENCE_PAGES = [
  ["@dawn-ai/sdk", "/docs/api/sdk", "@dawn-ai/sdk", ["@dawn-ai/sdk"]],
  ["@dawn-ai/cli", "/docs/api/cli", "@dawn-ai/cli", ["@dawn-ai/cli"]],
  ["@dawn-ai/core", "/docs/api/core", "@dawn-ai/core", ["@dawn-ai/core"]],
  ["@dawn-ai/ag-ui", "/docs/api/ag-ui", "@dawn-ai/ag-ui", ["@dawn-ai/ag-ui"]],
  ["@dawn-ai/memory", "/docs/api/memory", "@dawn-ai/memory", ["@dawn-ai/memory"]],
  [
    "@dawn-ai/memory-pgvector",
    "/docs/api/memory-pgvector",
    "@dawn-ai/memory-pgvector",
    ["@dawn-ai/memory-pgvector"],
  ],
  [
    "@dawn-ai/postgres-storage",
    "/docs/api/postgres-storage",
    "@dawn-ai/postgres-storage",
    ["@dawn-ai/postgres-storage"],
  ],
  ["@dawn-ai/testing", "/docs/api/testing", "@dawn-ai/testing", ["@dawn-ai/testing"]],
  ["@dawn-ai/evals", "/docs/api/evals", "@dawn-ai/evals", ["@dawn-ai/evals"]],
  ["dawn:routes", "/docs/api/generated-routes", "dawn:routes", ["@dawn-ai/cli", "@dawn-ai/core"]],
  [
    "@dawn-ai/permissions",
    "/docs/api/permissions",
    "@dawn-ai/permissions",
    ["@dawn-ai/permissions"],
  ],
  ["@dawn-ai/workspace", "/docs/api/workspace", "@dawn-ai/workspace", ["@dawn-ai/workspace"]],
  ["@dawn-ai/sandbox", "/docs/api/sandbox", "@dawn-ai/sandbox", ["@dawn-ai/sandbox"]],
  ["@dawn-ai/langgraph", "/docs/api/langgraph", "@dawn-ai/langgraph", ["@dawn-ai/langgraph"]],
  ["@dawn-ai/langchain", "/docs/api/langchain", "@dawn-ai/langchain", ["@dawn-ai/langchain"]],
  [
    "@dawn-ai/sqlite-storage",
    "/docs/api/sqlite-storage",
    "@dawn-ai/sqlite-storage",
    ["@dawn-ai/sqlite-storage"],
  ],
] as const

const EXPECTED_DETAILED_IMPORTS = [
  ["@dawn-ai/sdk", "."],
  ["@dawn-ai/sdk", "./pure"],
  ["@dawn-ai/sdk", "./testing"],
  ["@dawn-ai/cli", "."],
  ["@dawn-ai/cli", "./fetch"],
  ["@dawn-ai/cli", "./runtime"],
  ["@dawn-ai/cli", "./testing"],
  ["@dawn-ai/core", "."],
  ["@dawn-ai/core", "./node"],
  ["@dawn-ai/ag-ui", "."],
  ["@dawn-ai/ag-ui", "./sse"],
  ["@dawn-ai/ag-ui", "./react"],
  ["@dawn-ai/memory", "."],
  ["@dawn-ai/memory", "./browse"],
  ["@dawn-ai/memory", "./namespace"],
  ["@dawn-ai/memory", "./reconcile"],
  ["@dawn-ai/memory-pgvector", "."],
  ["@dawn-ai/postgres-storage", "."],
  ["@dawn-ai/postgres-storage", "./node"],
  ["@dawn-ai/testing", "."],
  ["@dawn-ai/evals", "."],
  ["@dawn-ai/permissions", "."],
  ["@dawn-ai/permissions", "./node"],
  ["@dawn-ai/workspace", "."],
  ["@dawn-ai/workspace", "./node"],
  ["@dawn-ai/sandbox", "."],
  ["@dawn-ai/sandbox", "./testing"],
  ["@dawn-ai/langgraph", "."],
  ["@dawn-ai/langgraph", "./define-entry"],
  ["@dawn-ai/langgraph", "./route-module"],
  ["@dawn-ai/langchain", "."],
  ["@dawn-ai/langchain", "./package.json"],
  ["@dawn-ai/sqlite-storage", "."],
] as const

const EXPECTED_CATALOG_AND_INTERNAL_IMPORTS = [
  ["@dawn-ai/core", "./internal/compiler", "internal"],
  ["@dawn-ai/ag-ui", "./react/styles.css", "catalog-only"],
  ["@dawn-ai/config-biome", ".", "internal"],
  ["@dawn-ai/config-biome", "./biome", "internal"],
  ["@dawn-ai/config-typescript", ".", "internal"],
  ["@dawn-ai/config-typescript", "./base", "internal"],
  ["@dawn-ai/config-typescript", "./library", "internal"],
  ["@dawn-ai/config-typescript", "./node", "internal"],
  ["@dawn-ai/config-typescript", "./nextjs", "internal"],
  ["@dawn-ai/devkit", ".", "internal"],
  ["@dawn-ai/vite-plugin", ".", "internal"],
] as const

const EXPECTED_OPERATED_ARTIFACTS = [
  [
    "@dawn-ai/cli",
    "bin.dawn",
    "executable",
    "./dist/index.js",
    "detailed",
    "node-only",
    "tooling",
    "supported",
  ],
  [
    "create-dawn-ai-app",
    "bin.create-dawn-ai-app",
    "executable",
    "./dist/bin.js",
    "catalog-only",
    "node-only",
    "tooling",
    "supported",
  ],
  [
    "@dawn-ai/inspector",
    "dawnInspector.server",
    "operated-application",
    ".next/standalone/packages/inspector/server.js",
    "catalog-only",
    "node-only",
    "tooling",
    "supported",
  ],
] as const

const EXPECTED_FINAL_ARTIFACT_POLICIES = [
  [
    "import:@dawn-ai/config-biome:.",
    "internal",
    "config-artifact",
    null,
    null,
    "tooling",
    "supported",
  ],
  [
    "import:@dawn-ai/config-biome:./biome",
    "internal",
    "config-artifact",
    null,
    null,
    "tooling",
    "supported",
  ],
  [
    "import:@dawn-ai/config-typescript:.",
    "internal",
    "config-artifact",
    null,
    null,
    "tooling",
    "supported",
  ],
  [
    "import:@dawn-ai/config-typescript:./base",
    "internal",
    "config-artifact",
    null,
    null,
    "tooling",
    "supported",
  ],
  [
    "import:@dawn-ai/config-typescript:./library",
    "internal",
    "config-artifact",
    null,
    null,
    "tooling",
    "supported",
  ],
  [
    "import:@dawn-ai/config-typescript:./node",
    "internal",
    "config-artifact",
    null,
    null,
    "tooling",
    "supported",
  ],
  [
    "import:@dawn-ai/config-typescript:./nextjs",
    "internal",
    "config-artifact",
    null,
    null,
    "tooling",
    "supported",
  ],
  [
    "import:@dawn-ai/devkit:.",
    "internal",
    "typescript-runtime",
    "node-only",
    "not-claimed",
    "internal",
    "internal",
  ],
  [
    "import:@dawn-ai/vite-plugin:.",
    "internal",
    "typescript-runtime",
    "node-only",
    "not-claimed",
    "tooling",
    "internal",
  ],
] as const

const EXPECTED_CATALOG_DESTINATIONS = new Map<string, string>([
  ["@dawn-ai/config-biome", "/docs/api#dawn-aiconfig-biome"],
  ["@dawn-ai/config-typescript", "/docs/api#dawn-aiconfig-typescript"],
  ["@dawn-ai/devkit", "/docs/api#dawn-aidevkit"],
  ["@dawn-ai/inspector", "/docs/api#dawn-aiinspector"],
  ["@dawn-ai/vite-plugin", "/docs/api#dawn-aivite-plugin"],
  ["create-dawn-ai-app", "/docs/api#create-dawn-ai-app"],
] as const)

const EXPECTED_REQUIRED_CONTRACT_KEYS = [
  "@dawn-ai/langchain#.:AgentStreamChunk",
  "@dawn-ai/langchain#.:OffloadToolOutputCtx",
  "@dawn-ai/langchain#.:RetryOptions",
  "@dawn-ai/langchain#.:UnwrappedToolResult",
  "@dawn-ai/langchain#.:resolveProvider",
  "@dawn-ai/langchain#.:withRetry",
  "@dawn-ai/langgraph#./define-entry:defineEntry",
  "@dawn-ai/langgraph#./route-module:GraphRouteModule",
  "@dawn-ai/langgraph#./route-module:NormalizedRouteModule",
  "@dawn-ai/langgraph#./route-module:RouteModule",
  "@dawn-ai/langgraph#./route-module:WorkflowRouteModule",
  "@dawn-ai/langgraph#./route-module:assertExactlyOneEntry",
  "@dawn-ai/langgraph#./route-module:normalizeRouteModule",
  "@dawn-ai/ag-ui#./sse:encodeAgUiSse",
  "@dawn-ai/ag-ui#.:DAWN_PLAN_ACTIVITY_TYPE",
  "@dawn-ai/ag-ui#.:DAWN_SUBAGENT_ACTIVITY_TYPE",
  "@dawn-ai/ag-ui#.:DawnRunInput",
  "@dawn-ai/ag-ui#.:DawnPlanActivityContent",
  "@dawn-ai/ag-ui#.:DawnSubagentActivityContent",
  "@dawn-ai/ag-ui#.:RunContext",
  "@dawn-ai/ag-ui#.:ToAguiOptions",
  "@dawn-ai/ag-ui#.:fromRunAgentInput",
  "@dawn-ai/ag-ui#.:toAguiEvents",
  "@dawn-ai/cli#.:ServeRuntimeOptions",
  "@dawn-ai/cli#.:serveRuntime",
  "@dawn-ai/core#.:loadDawnConfig",
  "@dawn-ai/core#.:resolveStateFields",
  "@dawn-ai/evals#.:EvalCase",
  "@dawn-ai/evals#.:EvalDefinition",
  "@dawn-ai/evals#.:EvalReport",
  "@dawn-ai/evals#.:RunEvalOptions",
  "@dawn-ai/evals#.:Scorer",
  "@dawn-ai/evals#.:defineEval",
  "@dawn-ai/evals#.:runEval",
  "@dawn-ai/memory#./namespace:MemoryScopeTuple",
  "@dawn-ai/memory#./namespace:serializeNamespace",
  "@dawn-ai/memory#./reconcile:approveWithReconcile",
  "@dawn-ai/memory#.:BrowsePage",
  "@dawn-ai/memory#.:BrowseQuery",
  "@dawn-ai/memory#.:MemoryQuery",
  "@dawn-ai/memory#.:MemoryRecord",
  "@dawn-ai/memory#.:MemoryStore",
  "@dawn-ai/memory-pgvector#.:PgvectorMemoryStore",
  "@dawn-ai/memory-pgvector#.:pgvectorMemoryStore",
  "@dawn-ai/postgres-storage#./node:NodePostgresPermissionsStoreOptions",
  "@dawn-ai/postgres-storage#./node:NodePostgresStoreOptions",
  "@dawn-ai/postgres-storage#./node:createPostgresPermissionsStore",
  "@dawn-ai/postgres-storage#./node:createPostgresThreadsStore",
  "@dawn-ai/postgres-storage#./node:postgresCheckpointer",
  "@dawn-ai/postgres-storage#.:PostgresPermissionsStoreOptions",
  "@dawn-ai/postgres-storage#.:PostgresStoreOptions",
  "@dawn-ai/postgres-storage#.:createPostgresPermissionsStore",
  "@dawn-ai/postgres-storage#.:createPostgresThreadsStore",
  "@dawn-ai/postgres-storage#.:postgresCheckpointer",
  "@dawn-ai/sandbox#./testing:runProviderConformance",
  "@dawn-ai/sandbox#.:KubernetesSandboxOptions",
  "@dawn-ai/sandbox#.:dockerSandbox",
  "@dawn-ai/sandbox#.:kubernetesSandbox",
  "@dawn-ai/permissions#.:PermissionDecision",
  "@dawn-ai/permissions#.:PermissionMode",
  "@dawn-ai/permissions#.:PermissionsFile",
  "@dawn-ai/permissions#.:PermissionsStore",
  "@dawn-ai/sdk#.:AgentConfig",
  "@dawn-ai/sdk#.:ReasoningConfig",
  "@dawn-ai/sdk#.:RetryConfig",
  "@dawn-ai/sdk#.:RouteConfig",
  "@dawn-ai/sdk#.:agent",
  "@dawn-ai/sdk#.:allow",
  "@dawn-ai/sdk#.:defineMemory",
  "@dawn-ai/sdk#.:defineMiddleware",
  "@dawn-ai/sdk#.:isDawnAgent",
  "@dawn-ai/sdk#.:reject",
  "@dawn-ai/sdk#.:validateModelId",
  "@dawn-ai/sqlite-storage#.:CreateThreadInput",
  "@dawn-ai/sqlite-storage#.:SqliteCheckpointerOptions",
  "@dawn-ai/sqlite-storage#.:Thread",
  "@dawn-ai/sqlite-storage#.:ThreadStatus",
  "@dawn-ai/sqlite-storage#.:ThreadsStore",
  "@dawn-ai/sqlite-storage#.:ThreadsStoreOptions",
  "@dawn-ai/sqlite-storage#.:createThreadsStore",
  "@dawn-ai/sqlite-storage#.:sqliteCheckpointer",
  "@dawn-ai/testing#.:AgentHarness",
  "@dawn-ai/testing#.:AgentHarnessOptions",
  "@dawn-ai/testing#.:ScriptBuilder",
  "@dawn-ai/testing#.:createAgentHarness",
  "@dawn-ai/testing#.:fakeEmbedder",
  "@dawn-ai/testing#.:loadFixtures",
  "@dawn-ai/testing#.:runCheckpointerConformance",
  "@dawn-ai/testing#.:runMemoryStoreConformance",
  "@dawn-ai/testing#.:runPermissionsStoreConformance",
  "@dawn-ai/testing#.:runThreadsStoreConformance",
  "@dawn-ai/testing#.:writeFixtures",
  "@dawn-ai/workspace#./node:LocalExecOptions",
  "@dawn-ai/workspace#./node:LocalFilesystemOptions",
  "@dawn-ai/workspace#./node:localExec",
  "@dawn-ai/workspace#./node:localFilesystem",
  "@dawn-ai/workspace#.:BackendContext",
  "@dawn-ai/workspace#.:ExecBackend",
  "@dawn-ai/workspace#.:FilesystemBackend",
  "@dawn-ai/workspace#.:SandboxConfig",
  "@dawn-ai/workspace#.:SandboxHandle",
  "@dawn-ai/workspace#.:SandboxPolicy",
  "@dawn-ai/workspace#.:SandboxProvider",
  "@dawn-ai/workspace#.:SandboxSecurityPolicy",
  "@dawn-ai/workspace#.:compose",
] as const

interface ManifestFixture {
  readonly name: string
  exports?: Record<string, unknown>
  bin?: Record<string, string>
  dawnInspector?: { server?: string }
  imports?: Record<string, unknown>
}

function publicPackageNames(): readonly string[] {
  const script = `
    import { readPublicPackages } from ${JSON.stringify(
      new URL("../../../../../scripts/lib/published-artifacts.mjs", import.meta.url).href,
    )};
    console.log(JSON.stringify((await readPublicPackages(${JSON.stringify(REPO_ROOT)})).map(({ packageJson }) => packageJson.name)));
  `
  const result = spawnSync(process.execPath, ["--input-type=module", "--eval", script], {
    encoding: "utf8",
  })

  expect(result.status, result.stderr).toBe(0)
  return JSON.parse(result.stdout) as readonly string[]
}

function publicPackageManifests(): ManifestFixture[] {
  return readdirSync(join(REPO_ROOT, "packages"), { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .flatMap((entry) => {
      const packageJson = JSON.parse(
        readFileSync(join(REPO_ROOT, "packages", entry.name, "package.json"), "utf8"),
      ) as ManifestFixture & { readonly private?: boolean }
      return packageJson.private === true ? [] : [structuredClone(packageJson)]
    })
}

interface ApiReferenceRegistryAnalysis {
  readonly failures: readonly string[]
}

function analyzeApiReferenceRegistry(
  pages: readonly unknown[],
  artifacts: readonly unknown[],
): ApiReferenceRegistryAnalysis {
  const fixture = JSON.stringify({ pages, artifacts })
  const result = spawnSync(
    process.execPath,
    [CHECK_DOCS_PATH, "--analyze-api-reference-registry", fixture],
    { encoding: "utf8" },
  )

  expect(result.status).toBe(0)
  expect(result.stderr).toBe("")
  expect(result.stdout).toMatch(/^\{/)
  return JSON.parse(result.stdout) as ApiReferenceRegistryAnalysis
}

function analyzeApiReferenceManifests(
  manifests: readonly ManifestFixture[],
  artifacts: readonly unknown[] = ARTIFACT_REGISTRY,
): ApiReferenceRegistryAnalysis {
  const fixture = JSON.stringify({ manifests, artifacts })
  const result = spawnSync(
    process.execPath,
    [CHECK_DOCS_PATH, "--analyze-api-reference-manifests", fixture],
    { encoding: "utf8" },
  )

  expect(result.status).toBe(0)
  expect(result.stderr).toBe("")
  expect(result.stdout).toMatch(/^\{/)
  return JSON.parse(result.stdout) as ApiReferenceRegistryAnalysis
}

function mutatedManifestAnalysis(
  packageName: string,
  mutate: (manifest: ManifestFixture) => void,
): ApiReferenceRegistryAnalysis {
  const manifests = publicPackageManifests()
  const manifest = manifests.find(({ name }) => name === packageName)
  expect(manifest).toBeDefined()
  mutate(manifest as ManifestFixture)
  return analyzeApiReferenceManifests(manifests)
}

function expectRegistryRejection(artifact: Record<string, unknown>, message: RegExp): void {
  expect(() =>
    validateApiReferenceRegistries({
      pages: API_REFERENCE_PAGES,
      artifacts: [...ARTIFACT_REGISTRY, artifact as unknown as ApiReferenceArtifact],
      packages: PACKAGE_CATALOG,
    }),
  ).toThrow(message)
}

describe("API reference page registry", () => {
  it("pins the approved surfaces, destinations, ownership, and parent hub", () => {
    expect(
      API_REFERENCE_PAGES.map(({ label, href, surfaceName, ownerPackageNames }) => [
        label,
        href,
        surfaceName,
        ownerPackageNames,
      ]),
    ).toEqual(EXPECTED_REFERENCE_PAGES)
    expect(API_REFERENCE_PAGES).toHaveLength(16)
    for (const page of API_REFERENCE_PAGES) {
      expect(page.parent).toEqual({ label: "API Reference", href: "/docs/api" })
    }
  })

  it("rejects an address-preserving page-label mutation", () => {
    const pages = API_REFERENCE_PAGES.map((page, index) =>
      index === 0 ? { ...page, label: "SDK Reference" } : page,
    )

    expect(analyzeApiReferenceRegistry(pages, ARTIFACT_REGISTRY).failures).toEqual([
      expect.stringMatching(/page tuple.*@dawn-ai\/sdk/),
    ])
  })

  it("rejects duplicate page labels independently of href uniqueness", () => {
    const pages = API_REFERENCE_PAGES.map((page, index) =>
      index === 1 ? { ...page, label: API_REFERENCE_PAGES[0].label } : page,
    )

    expect(() =>
      validateApiReferenceRegistries({
        pages,
        artifacts: ARTIFACT_REGISTRY,
        packages: PACKAGE_CATALOG,
      }),
    ).toThrow(/duplicate API reference page labels/)
    expect(analyzeApiReferenceRegistry(pages, ARTIFACT_REGISTRY).failures).toEqual(
      expect.arrayContaining([expect.stringMatching(/duplicate API reference page labels/)]),
    )
  })
})

describe("client navigation dependency boundary", () => {
  it("preserves the page registry exports on the server registry entrypoint", () => {
    const exports = apiReferenceExports as Record<string, unknown>
    const registrySource = readFileSync(
      join(dirname(fileURLToPath(import.meta.url)), "api-reference.ts"),
      "utf8",
    )

    expect(exports.API_REFERENCE_PAGES).toBe(API_REFERENCE_PAGES)
    expect(exports.API_REFERENCE_PARENT).toBe(API_REFERENCE_PARENT)
    expect(registrySource).toContain(
      'export type { ApiReferencePage } from "./api-reference-pages"',
    )
  })

  it("loads only the lightweight, side-effect-free API page registry", () => {
    const docsComponentsRoot = dirname(fileURLToPath(import.meta.url))
    const navSource = readFileSync(join(docsComponentsRoot, "nav.ts"), "utf8")
    const pagesPath = join(docsComponentsRoot, "api-reference-pages.ts")
    const registrySource = readFileSync(join(docsComponentsRoot, "api-reference.ts"), "utf8")

    expect(existsSync(pagesPath)).toBe(true)
    if (!existsSync(pagesPath)) return
    const pagesSource = readFileSync(pagesPath, "utf8")
    expect(navSource).toContain('from "./api-reference-pages"')
    expect(navSource).not.toContain('from "./api-reference"')
    expect(pagesSource).not.toMatch(
      /ARTIFACT_REGISTRY|PACKAGE_CATALOG|validateApiReferenceRegistries|api-reference"/,
    )
    expect(registrySource).not.toMatch(
      /\nvalidateApiReferenceRegistries\(\{\n\s*pages: API_REFERENCE_PAGES/,
    )
  })
})

describe("artifact registry", () => {
  it("renders stable public documentation labels without delivery-state coverage names", () => {
    const forbidden = /\b(?:detailed|catalog-only)\b/
    for (const artifact of ARTIFACT_REGISTRY) {
      expect(artifactBoundaryFor(artifact)).not.toMatch(forbidden)
    }
    expect(artifactBoundaryFor(ARTIFACT_REGISTRY[0])).toContain("focused reference")
    expect(
      artifactBoundaryFor(
        ARTIFACT_REGISTRY.find(({ coverage }) => coverage === "catalog-only") ??
          ARTIFACT_REGISTRY[0],
      ),
    ).toContain("catalog summary")
    expect(
      artifactBoundaryFor(
        ARTIFACT_REGISTRY.find(({ coverage }) => coverage === "internal") ?? ARTIFACT_REGISTRY[0],
      ),
    ).toContain("internal only")
  })

  it("assigns executable compatibility guards to every runtime claim", () => {
    const knownGuardIds = new Set(API_REFERENCE_GUARD_IDS)
    const usedGuardIds = new Set<string>()

    for (const artifact of ARTIFACT_REGISTRY) {
      if (
        (artifact.kind === "import" && artifact.surfaceKind === "typescript-runtime") ||
        artifact.kind === "operated"
      ) {
        expect(artifact.guardIds, artifactAddressFor(artifact)).not.toHaveLength(0)
        for (const guardId of artifact.guardIds) {
          expect(knownGuardIds, `${artifactAddressFor(artifact)} uses ${guardId}`).toContain(
            guardId,
          )
          usedGuardIds.add(guardId)
        }

        if (artifact.runtime === "edge-safe") {
          expect(artifact.guardIds).toContain("edge-import-bundle")
        } else if (artifact.kind === "import") {
          expect(artifact.guardIds).toContain("node-import-bundle")
        } else {
          expect(artifact.guardIds).toContain("node-operated-bundle")
        }
        if (artifact.kind === "import" && artifact.purity === "dependency-free") {
          expect(artifact.guardIds).toContain("dependency-free-import-graph")
        }
      } else {
        expect("runtime" in artifact).toBe(false)
        expect("purity" in artifact).toBe(false)
        expect("guardIds" in artifact).toBe(false)
      }
    }

    expect(usedGuardIds).toEqual(knownGuardIds)
    const sandboxTesting = ARTIFACT_REGISTRY.find(
      (artifact) =>
        artifact.kind === "import" &&
        artifact.surfaceKind === "typescript-runtime" &&
        artifact.packageName === "@dawn-ai/sandbox" &&
        artifact.subpath === "./testing",
    )
    expect(
      sandboxTesting && "guardIds" in sandboxTesting ? sandboxTesting.guardIds : undefined,
    ).toContain("browser-import-negative-control")
  })

  it("rejects missing and unknown compatibility guard IDs", () => {
    const runtimeArtifact = ARTIFACT_REGISTRY.find(
      (artifact) => artifact.kind === "import" && artifact.surfaceKind === "typescript-runtime",
    )
    expect(runtimeArtifact).toBeDefined()

    expectRegistryRejection(
      {
        ...runtimeArtifact,
        packageName: "@dawn-ai/cli",
        subpath: "./missing-guards",
        guardIds: [],
      },
      /compatibility guard/i,
    )
    expectRegistryRejection(
      {
        ...runtimeArtifact,
        packageName: "@dawn-ai/cli",
        subpath: "./unknown-guard",
        guardIds: ["stale-guard-id"],
      },
      /unknown compatibility guard/i,
    )
    expectRegistryRejection(
      {
        ...runtimeArtifact,
        packageName: "@dawn-ai/cli",
        subpath: "./wrong-guard-kind",
        runtime: "edge-safe",
        guardIds: ["edge-import-bundle", "node-import-bundle"],
      },
      /inapplicable compatibility guard/i,
    )
    expectRegistryRejection(
      {
        ...runtimeArtifact,
        packageName: "@dawn-ai/cli",
        subpath: "./duplicate-guard",
        guardIds: ["node-import-bundle", "node-import-bundle"],
      },
      /duplicate compatibility guard/i,
    )
    expectRegistryRejection(
      {
        kind: "import",
        packageName: "@dawn-ai/config-biome",
        subpath: "./guarded-config",
        coverage: "catalog-only",
        surfaceKind: "config-artifact",
        audience: "tooling",
        stability: "supported",
        guardIds: ["edge-import-bundle"],
      },
      /invalid artifact fields.*guardIds/i,
    )
    expect(() =>
      validateApiReferenceRegistries({
        pages: API_REFERENCE_PAGES,
        artifacts: ARTIFACT_REGISTRY.map((artifact) =>
          artifact.kind === "generated"
            ? ({ ...artifact, guardIds: ["edge-import-bundle"] } as unknown as ApiReferenceArtifact)
            : artifact,
        ),
        packages: PACKAGE_CATALOG,
      }),
    ).toThrow(/invalid artifact fields.*guardIds/i)
    expectRegistryRejection(
      {
        ...runtimeArtifact,
        packageName: "@dawn-ai/cli",
        subpath: "./audience-is-not-runtime",
        runtime: "testing",
      },
      /invalid runtime/i,
    )
    expect(() =>
      validateApiReferenceRegistries({
        pages: API_REFERENCE_PAGES,
        artifacts: ARTIFACT_REGISTRY.map((artifact) =>
          artifactAddressFor(artifact) === "import:@dawn-ai/sdk:./testing"
            ? ({
                ...artifact,
                runtime: "node-only",
                purity: "dependency-free",
                guardIds: ["node-import-bundle", "browser-import-negative-control"],
              } as ApiReferenceArtifact)
            : artifact,
        ),
        packages: PACKAGE_CATALOG,
      }),
    ).toThrow(/dependency-free-import-graph/i)
    const operatedArtifact = ARTIFACT_REGISTRY.find((artifact) => artifact.kind === "operated")
    expect(operatedArtifact).toBeDefined()
    expectRegistryRejection(
      {
        ...operatedArtifact,
        packageName: "@dawn-ai/cli",
        selector: "bin.edge-dawn",
        runtime: "edge-safe",
      },
      /operated.*node-only|node-only.*operated/i,
    )
  })

  it("uses unique keys in separate import and operated address spaces", () => {
    const addresses = ARTIFACT_REGISTRY.map(artifactAddressFor)
    expect(new Set(addresses).size).toBe(addresses.length)
    expect(ARTIFACT_REGISTRY.filter(({ kind }) => kind === "import")).toHaveLength(44)
    expect(ARTIFACT_REGISTRY.filter(({ kind }) => kind === "operated")).toHaveLength(3)
    expect(ARTIFACT_REGISTRY.filter(({ kind }) => kind === "generated")).toEqual([
      GENERATED_ROUTES_ARTIFACT,
    ])
    expect(addresses).toContain("import:@dawn-ai/cli:.")
    expect(addresses).toContain("operated:@dawn-ai/cli:bin.dawn")
    expect(addresses).not.toContain("import:@dawn-ai/cli:bin.dawn")
    expect(addresses).toContain("operated:@dawn-ai/inspector:dawnInspector.server")
    expect(addresses).toContain("generated:dawn:routes")
  })

  it("maps the manifest-less generated surface to its canonical page without package fields", () => {
    expect(GENERATED_ROUTES_ARTIFACT).toEqual({
      kind: "generated",
      moduleName: "dawn:routes",
      ownerHref: "/docs/api/generated-routes",
      surfaceKind: "generated-types",
      coverage: "detailed",
      audience: "application",
      stability: "supported",
    })
    expect("packageName" in GENERATED_ROUTES_ARTIFACT).toBe(false)
    expect("runtime" in GENERATED_ROUTES_ARTIFACT).toBe(false)
    expect("purity" in GENERATED_ROUTES_ARTIFACT).toBe(false)
    expect(
      API_REFERENCE_PAGES.filter(
        ({ surfaceName, href }) =>
          surfaceName === GENERATED_ROUTES_ARTIFACT.moduleName &&
          href === GENERATED_ROUTES_ARTIFACT.ownerHref,
      ),
    ).toHaveLength(1)
  })

  it("pins the complete detailed, catalog, internal, and operated inventories", () => {
    expect(
      ARTIFACT_REGISTRY.flatMap((artifact) =>
        artifact.kind === "import" && artifact.coverage === "detailed"
          ? [[artifact.packageName, artifact.subpath]]
          : [],
      ),
    ).toEqual(EXPECTED_DETAILED_IMPORTS)
    expect(
      ARTIFACT_REGISTRY.flatMap((artifact) =>
        artifact.kind === "import" &&
        (artifact.coverage === "catalog-only" || artifact.coverage === "internal")
          ? [[artifact.packageName, artifact.subpath, artifact.coverage]]
          : [],
      ),
    ).toEqual(EXPECTED_CATALOG_AND_INTERNAL_IMPORTS)
    expect(
      ARTIFACT_REGISTRY.filter((artifact) => artifact.kind === "operated").map(
        ({
          packageName,
          selector,
          operatedKind,
          manifestTarget,
          coverage,
          runtime,
          audience,
          stability,
        }) => [
          packageName,
          selector,
          operatedKind,
          manifestTarget,
          coverage,
          runtime,
          audience,
          stability,
        ],
      ),
    ).toEqual(EXPECTED_OPERATED_ARTIFACTS)
    expect(
      ARTIFACT_REGISTRY.flatMap((artifact) => {
        const address = artifactAddressFor(artifact)
        if (!EXPECTED_FINAL_ARTIFACT_POLICIES.some(([expected]) => expected === address)) return []
        return [
          [
            address,
            artifact.coverage,
            artifact.kind === "import" ? artifact.surfaceKind : artifact.kind,
            "runtime" in artifact ? artifact.runtime : null,
            "purity" in artifact ? artifact.purity : null,
            artifact.audience,
            artifact.stability,
          ],
        ]
      }),
    ).toEqual(EXPECTED_FINAL_ARTIFACT_POLICIES)
  })

  it("rejects address-preserving artifact policy mutations", () => {
    const coverageMutation = ARTIFACT_REGISTRY.map((artifact) =>
      artifactAddressFor(artifact) === "import:@dawn-ai/core:./internal/compiler"
        ? { ...artifact, coverage: "detailed" }
        : artifact,
    )
    const kindMutation = ARTIFACT_REGISTRY.map((artifact) =>
      artifactAddressFor(artifact) === "import:@dawn-ai/core:./internal/compiler"
        ? { ...artifact, surfaceKind: "metadata" }
        : artifact,
    )
    const guardMutation = ARTIFACT_REGISTRY.map((artifact) =>
      artifactAddressFor(artifact) === "import:@dawn-ai/sdk:./pure"
        ? { ...artifact, guardIds: ["edge-import-bundle"] }
        : artifact,
    )
    const runtimeMutation = ARTIFACT_REGISTRY.map((artifact) =>
      artifactAddressFor(artifact) === "import:@dawn-ai/sdk:./testing"
        ? { ...artifact, runtime: "testing" }
        : artifact,
    )
    const staticGuardMutation = ARTIFACT_REGISTRY.map((artifact) =>
      artifactAddressFor(artifact) === "import:@dawn-ai/config-biome:."
        ? { ...artifact, guardIds: ["edge-import-bundle"] }
        : artifact,
    )

    expect(analyzeApiReferenceRegistry(API_REFERENCE_PAGES, coverageMutation).failures).toEqual([
      expect.stringMatching(/artifact policy tuple.*internal\/compiler.*coverage/),
    ])
    expect(analyzeApiReferenceRegistry(API_REFERENCE_PAGES, kindMutation).failures).toEqual([
      expect.stringMatching(/artifact policy tuple.*internal\/compiler.*surfaceKind/),
    ])
    expect(analyzeApiReferenceRegistry(API_REFERENCE_PAGES, guardMutation).failures).toEqual([
      expect.stringMatching(/artifact policy tuple.*sdk.*pure.*guardIds/),
    ])
    expect(analyzeApiReferenceRegistry(API_REFERENCE_PAGES, runtimeMutation).failures).toEqual([
      expect.stringMatching(/artifact policy tuple.*sdk.*testing.*runtime/),
    ])
    expect(analyzeApiReferenceRegistry(API_REFERENCE_PAGES, staticGuardMutation).failures).toEqual([
      expect.stringMatching(/artifact policy tuple.*config-biome.*guardIds/),
    ])
  })

  it("keeps runtime and purity claims applicable to runtime TypeScript imports", () => {
    for (const artifact of ARTIFACT_REGISTRY) {
      if (artifact.kind === "import" && artifact.surfaceKind === "typescript-runtime") {
        expect(["node-only", "edge-safe"]).toContain(artifact.runtime)
        expect(["dependency-free", "not-claimed"]).toContain(artifact.purity)
      } else if (artifact.kind === "operated") {
        expect(["node-only", "edge-safe"]).toContain(artifact.runtime)
        expect("purity" in artifact).toBe(false)
      } else {
        expect("runtime" in artifact).toBe(false)
        expect("purity" in artifact).toBe(false)
      }
    }
  })

  it("does not recommend catalog-only or internal surfaces to applications", () => {
    for (const artifact of ARTIFACT_REGISTRY) {
      if (artifact.coverage === "catalog-only" || artifact.coverage === "internal") {
        expect(artifact.audience).not.toBe("application")
      }
    }
  })

  it("rejects duplicate addresses and invalid discriminant combinations", () => {
    const retiredCoverage = ["deferred", "to", "pr2"].join("-")
    const retiredCoverageArtifact = {
      ...ARTIFACT_REGISTRY[0],
      coverage: retiredCoverage,
    }
    expect(() =>
      validateApiReferenceRegistries({
        pages: API_REFERENCE_PAGES,
        artifacts: ARTIFACT_REGISTRY.map((artifact, index) =>
          index === 0 ? (retiredCoverageArtifact as unknown as ApiReferenceArtifact) : artifact,
        ),
        packages: PACKAGE_CATALOG,
      }),
    ).toThrow(new RegExp(`invalid coverage: ${retiredCoverage}`))
    expect(
      analyzeApiReferenceRegistry(
        API_REFERENCE_PAGES,
        ARTIFACT_REGISTRY.map((artifact, index) =>
          index === 0 ? retiredCoverageArtifact : artifact,
        ),
      ).failures,
    ).toEqual(
      expect.arrayContaining([
        expect.stringMatching(new RegExp(`invalid coverage: ${retiredCoverage}`)),
      ]),
    )

    expectRegistryRejection({ ...ARTIFACT_REGISTRY[0] }, /duplicate artifact address/)
    expectRegistryRejection(
      {
        kind: "import",
        packageName: "@dawn-ai/cli",
        subpath: "bin.dawn",
        coverage: "detailed",
        surfaceKind: "typescript-runtime",
        runtime: "node-only",
        audience: "tooling",
        purity: "not-claimed",
        stability: "supported",
      },
      /operated selector|import subpath/,
    )
    expectRegistryRejection(
      {
        kind: "import",
        packageName: "@dawn-ai/inspector",
        subpath: ".",
        coverage: "catalog-only",
        surfaceKind: "typescript-runtime",
        runtime: "node-only",
        audience: "tooling",
        purity: "not-claimed",
        stability: "supported",
      },
      /operated artifact/,
    )
    expectRegistryRejection(
      {
        kind: "import",
        packageName: "@dawn-ai/config-biome",
        subpath: ".",
        coverage: "catalog-only",
        surfaceKind: "config-artifact",
        runtime: "node-only",
        audience: "tooling",
        stability: "supported",
      },
      /import:@dawn-ai\/config-biome:\.[\s\S]*runtime/,
    )
    expectRegistryRejection(
      {
        kind: "operated",
        packageName: "create-dawn-ai-app",
        selector: "bin.create-dawn-ai-app",
        operatedKind: "executable",
        coverage: "catalog-only",
        runtime: "node-only",
        audience: "application",
        stability: "supported",
      },
      /application audience/,
    )
  })
})

describe("published manifest address inventory", () => {
  it("matches exports, bins, and the Inspector server while ignoring package imports", () => {
    const manifests = publicPackageManifests()
    expect(analyzeApiReferenceManifests(manifests).failures).toEqual([])

    const langchain = manifests.find(({ name }) => name === "@dawn-ai/langchain")
    expect(langchain).toBeDefined()
    if (!langchain) throw new Error("LangChain manifest fixture is missing")
    langchain.imports = {
      ...(langchain.imports ?? {}),
      "#another-internal-import": "./internal.js",
    }
    expect(analyzeApiReferenceManifests(manifests).failures).toEqual([])
  })

  it.each([
    [
      "added",
      (manifest: ManifestFixture) => {
        if (!manifest.exports) throw new Error("SDK exports fixture is missing")
        manifest.exports["./unexpected"] = "./dist/unexpected.js"
      },
    ],
    [
      "removed",
      (manifest: ManifestFixture) => {
        if (!manifest.exports) throw new Error("SDK exports fixture is missing")
        delete manifest.exports["./testing"]
      },
    ],
    [
      "renamed",
      (manifest: ManifestFixture) => {
        if (!manifest.exports) throw new Error("SDK exports fixture is missing")
        manifest.exports["./test-support"] = manifest.exports["./testing"]
        delete manifest.exports["./testing"]
      },
    ],
  ])("rejects an %s exports subpath", (_name, mutate) => {
    expect(mutatedManifestAnalysis("@dawn-ai/sdk", mutate).failures.join("\n")).toMatch(
      /manifest.*import:@dawn-ai\/sdk/,
    )
  })

  it.each([
    [
      "added",
      (manifest: ManifestFixture) => {
        if (!manifest.bin) throw new Error("CLI bin fixture is missing")
        manifest.bin["dawn-extra"] = "./dist/index.js"
      },
    ],
    [
      "removed",
      (manifest: ManifestFixture) => {
        if (!manifest.bin) throw new Error("CLI bin fixture is missing")
        delete manifest.bin.dawn
      },
    ],
    [
      "renamed",
      (manifest: ManifestFixture) => {
        if (!manifest.bin) throw new Error("CLI bin fixture is missing")
        manifest.bin.sunrise = manifest.bin.dawn ?? "./dist/index.js"
        delete manifest.bin.dawn
      },
    ],
  ])("rejects an %s executable bin", (_name, mutate) => {
    expect(mutatedManifestAnalysis("@dawn-ai/cli", mutate).failures.join("\n")).toMatch(
      /manifest.*operated:@dawn-ai\/cli/,
    )
  })

  it.each([
    [
      "removed",
      (manifest: ManifestFixture) => {
        if (!manifest.dawnInspector) throw new Error("Inspector fixture is missing")
        delete manifest.dawnInspector.server
      },
    ],
    [
      "changed",
      (manifest: ManifestFixture) => {
        if (!manifest.dawnInspector) throw new Error("Inspector fixture is missing")
        manifest.dawnInspector.server = "./different-server.js"
      },
    ],
  ])("rejects a %s Inspector server", (_name, mutate) => {
    expect(mutatedManifestAnalysis("@dawn-ai/inspector", mutate).failures.join("\n")).toMatch(
      /manifest.*operated:@dawn-ai\/inspector/,
    )
  })
})

describe("package catalog", () => {
  it("pins the exact twelve-package patch changeset", () => {
    const source = readFileSync(CHANGESET_PATH, "utf8")
    const entries = [...source.matchAll(/^"([^"]+)": (\w+)$/gm)].map((match) => [
      match[1],
      match[2],
    ])
    expect(entries).toEqual([
      ["@dawn-ai/permissions", "patch"],
      ["@dawn-ai/workspace", "patch"],
      ["@dawn-ai/sandbox", "patch"],
      ["@dawn-ai/langgraph", "patch"],
      ["@dawn-ai/langchain", "patch"],
      ["@dawn-ai/sqlite-storage", "patch"],
      ["create-dawn-ai-app", "patch"],
      ["@dawn-ai/config-biome", "patch"],
      ["@dawn-ai/config-typescript", "patch"],
      ["@dawn-ai/devkit", "patch"],
      ["@dawn-ai/inspector", "patch"],
      ["@dawn-ai/vite-plugin", "patch"],
    ])
  })

  it("registers every authored high-value signature contract exactly once", () => {
    expect(API_REQUIRED_CONTRACT_KEYS).toEqual(EXPECTED_REQUIRED_CONTRACT_KEYS)
    expect(API_REQUIRED_CONTRACT_KEYS).toHaveLength(105)
    expect(new Set(API_REQUIRED_CONTRACT_KEYS).size).toBe(API_REQUIRED_CONTRACT_KEYS.length)
    expect(API_REQUIRED_CONTRACT_KEYS).toContain("@dawn-ai/sdk#.:agent")
    expect(API_REQUIRED_CONTRACT_KEYS).toContain("@dawn-ai/memory#.:MemoryStore")
    expect(API_REQUIRED_CONTRACT_KEYS).toContain("@dawn-ai/evals#.:runEval")
  })

  it("matches readPublicPackages bidirectionally", () => {
    const catalogNames = PACKAGE_CATALOG.map(({ packageName }) => packageName).sort()
    expect(catalogNames).toHaveLength(21)
    expect(catalogNames).toEqual([...publicPackageNames()].sort())
  })

  it("associates every package and artifact bidirectionally", () => {
    const catalogByName = new Map(PACKAGE_CATALOG.map((entry) => [entry.packageName, entry]))
    const registryAddressesByPackage = new Map<string, string[]>()
    for (const artifact of ARTIFACT_REGISTRY) {
      if (artifact.kind === "generated") continue
      const addresses = registryAddressesByPackage.get(artifact.packageName) ?? []
      addresses.push(artifactAddressFor(artifact))
      registryAddressesByPackage.set(artifact.packageName, addresses)
    }

    for (const entry of PACKAGE_CATALOG) {
      expect(entry.readmePath).toMatch(/^packages\/[^/]+\/README\.md$/)
      expect([...entry.artifactAddresses].sort()).toEqual(
        [...(registryAddressesByPackage.get(entry.packageName) ?? [])].sort(),
      )
    }
    for (const artifact of ARTIFACT_REGISTRY) {
      if (artifact.kind === "generated") continue
      expect(catalogByName.get(artifact.packageName)?.artifactAddresses).toContain(
        artifactAddressFor(artifact),
      )
    }
  })

  it("rejects generated records that bypass their closed registry branch", () => {
    expectRegistryRejection(
      { ...GENERATED_ROUTES_ARTIFACT, packageName: "@dawn-ai/core" },
      /generated artifact|invalid artifact fields|packageName/i,
    )
  })

  it("routes detailed owners to leaves and all other packages to hub anchors", () => {
    const leafByOwner = new Map(
      API_REFERENCE_PAGES.flatMap((page) =>
        page.surfaceName === "dawn:routes"
          ? []
          : page.ownerPackageNames.map((packageName) => [packageName, page.href] as const),
      ),
    )

    for (const entry of PACKAGE_CATALOG) {
      const leaf = leafByOwner.get(entry.packageName)
      if (leaf) {
        expect(entry.canonicalReferenceDestination).toBe(leaf)
      } else {
        expect(entry.canonicalReferenceDestination).toBe(
          EXPECTED_CATALOG_DESTINATIONS.get(entry.packageName),
        )
      }
    }
    expect([...EXPECTED_CATALOG_DESTINATIONS]).toHaveLength(6)
  })
})
