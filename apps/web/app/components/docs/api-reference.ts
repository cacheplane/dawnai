import type { ApiReferencePage } from "./api-reference-pages"

export type { ApiReferencePage } from "./api-reference-pages"
export { API_REFERENCE_PAGES, API_REFERENCE_PARENT } from "./api-reference-pages"

export type ApiReferenceCoverage = "detailed" | "catalog-only" | "internal" | "deferred-to-pr2"
export type ImportSurfaceKind = "typescript-runtime" | "config-artifact" | "metadata"
export type OperatedArtifactKind = "executable" | "operated-application"
export type RuntimeCompatibility = "node-only" | "edge-safe"
export type ApiReferenceAudience =
  | "application"
  | "integration"
  | "testing"
  | "tooling"
  | "internal"
export type RuntimePurity = "dependency-free" | "not-claimed"
export type ApiReferenceStability = "supported" | "low-level" | "internal"

export const API_REFERENCE_GUARD_IDS = [
  "edge-import-bundle",
  "dependency-free-import-graph",
  "node-import-bundle",
  "browser-import-negative-control",
  "node-operated-bundle",
  "browser-operated-negative-control",
] as const
export type ApiReferenceGuardId = (typeof API_REFERENCE_GUARD_IDS)[number]

export interface SourceAstBehaviorAuthority {
  readonly kind: "source-ast"
  readonly file: string
  readonly selector: string
  readonly expected: string
}

export interface TestAssertionBehaviorAuthority {
  readonly kind: "test-assertion"
  readonly file: string
  readonly testNames: readonly [string, ...string[]]
  readonly assertionFingerprint: string
}

export type ApiBehaviorAuthority = SourceAstBehaviorAuthority | TestAssertionBehaviorAuthority

export interface ApiBehaviorContract {
  readonly id: string
  readonly ownerHref: string
  readonly claim: string
  readonly authorities: readonly [ApiBehaviorAuthority, ...ApiBehaviorAuthority[]]
}

// Behavior entries land with the authored API pages. Keeping the typed registry here lets
// the isolated analyzer and those pages share one contract without enabling global coverage.
export const API_BEHAVIOR_CONTRACTS = [] as const satisfies readonly ApiBehaviorContract[]

interface ArtifactPolicy {
  readonly coverage: ApiReferenceCoverage
  readonly audience: ApiReferenceAudience
  readonly stability: ApiReferenceStability
}

export interface RuntimeImportArtifact extends ArtifactPolicy {
  readonly kind: "import"
  readonly packageName: string
  readonly subpath: string
  readonly surfaceKind: "typescript-runtime"
  readonly runtime: RuntimeCompatibility
  readonly purity: RuntimePurity
  readonly guardIds: readonly ApiReferenceGuardId[]
}

export interface StaticImportArtifact extends ArtifactPolicy {
  readonly kind: "import"
  readonly packageName: string
  readonly subpath: string
  readonly surfaceKind: "config-artifact" | "metadata"
}

export interface GeneratedTypesArtifact extends ArtifactPolicy {
  readonly kind: "generated"
  readonly moduleName: "dawn:routes"
  readonly ownerHref: "/docs/api/generated-routes"
  readonly surfaceKind: "generated-types"
  readonly coverage: "detailed"
  readonly audience: "application"
  readonly stability: "supported"
}

export interface OperatedArtifact extends ArtifactPolicy {
  readonly kind: "operated"
  readonly packageName: string
  readonly selector: string
  readonly operatedKind: OperatedArtifactKind
  readonly manifestTarget: string
  readonly runtime: RuntimeCompatibility
  readonly guardIds: readonly ApiReferenceGuardId[]
}

export type ApiReferenceArtifact =
  | RuntimeImportArtifact
  | StaticImportArtifact
  | GeneratedTypesArtifact
  | OperatedArtifact

export interface PackageCatalogEntry {
  readonly packageName: string
  readonly purpose: string
  readonly readmePath: string
  readonly canonicalReferenceDestination: string
  readonly conceptualGuideDestination: string
  readonly artifactAddresses: readonly string[]
  readonly audience: ApiReferenceAudience
  readonly stability: ApiReferenceStability
}

function runtimeImport(
  packageName: string,
  subpath: string,
  coverage: ApiReferenceCoverage,
  runtime: RuntimeCompatibility,
  audience: ApiReferenceAudience,
  stability: ApiReferenceStability = "supported",
  purity: RuntimePurity = "not-claimed",
): RuntimeImportArtifact {
  const guardIds: readonly ApiReferenceGuardId[] =
    runtime === "edge-safe"
      ? [
          "edge-import-bundle",
          ...(purity === "dependency-free" ? (["dependency-free-import-graph"] as const) : []),
        ]
      : [
          "node-import-bundle",
          "browser-import-negative-control",
          ...(purity === "dependency-free" ? (["dependency-free-import-graph"] as const) : []),
        ]
  return {
    kind: "import",
    packageName,
    subpath,
    coverage,
    surfaceKind: "typescript-runtime",
    runtime,
    audience,
    purity,
    stability,
    guardIds,
  }
}

function staticImport(
  packageName: string,
  subpath: string,
  coverage: ApiReferenceCoverage,
  surfaceKind: StaticImportArtifact["surfaceKind"],
  audience: ApiReferenceAudience,
  stability: ApiReferenceStability,
): StaticImportArtifact {
  return { kind: "import", packageName, subpath, coverage, surfaceKind, audience, stability }
}

function operatedArtifact(
  packageName: string,
  selector: string,
  operatedKind: OperatedArtifactKind,
  manifestTarget: string,
  coverage: ApiReferenceCoverage,
  audience: ApiReferenceAudience,
  stability: ApiReferenceStability = "supported",
): OperatedArtifact {
  return {
    kind: "operated",
    packageName,
    selector,
    operatedKind,
    manifestTarget,
    coverage,
    runtime: "node-only",
    guardIds: ["node-operated-bundle", "browser-operated-negative-control"],
    audience,
    stability,
  }
}

export const GENERATED_ROUTES_ARTIFACT = {
  kind: "generated",
  moduleName: "dawn:routes",
  ownerHref: "/docs/api/generated-routes",
  surfaceKind: "generated-types",
  coverage: "detailed",
  audience: "application",
  stability: "supported",
} as const satisfies GeneratedTypesArtifact

export const ARTIFACT_REGISTRY = [
  runtimeImport("@dawn-ai/sdk", ".", "detailed", "edge-safe", "application"),
  runtimeImport(
    "@dawn-ai/sdk",
    "./pure",
    "detailed",
    "edge-safe",
    "integration",
    "supported",
    "dependency-free",
  ),
  runtimeImport("@dawn-ai/sdk", "./testing", "detailed", "node-only", "testing"),
  runtimeImport("@dawn-ai/cli", ".", "detailed", "node-only", "application"),
  runtimeImport("@dawn-ai/cli", "./fetch", "detailed", "edge-safe", "integration"),
  runtimeImport("@dawn-ai/cli", "./runtime", "detailed", "node-only", "tooling", "low-level"),
  runtimeImport("@dawn-ai/cli", "./testing", "detailed", "node-only", "testing"),
  runtimeImport("@dawn-ai/core", ".", "detailed", "edge-safe", "integration", "low-level"),
  runtimeImport("@dawn-ai/core", "./node", "detailed", "node-only", "integration", "low-level"),
  runtimeImport(
    "@dawn-ai/core",
    "./internal/compiler",
    "internal",
    "node-only",
    "internal",
    "internal",
  ),
  runtimeImport("@dawn-ai/ag-ui", ".", "detailed", "edge-safe", "integration"),
  runtimeImport("@dawn-ai/ag-ui", "./sse", "detailed", "edge-safe", "integration"),
  runtimeImport("@dawn-ai/memory", ".", "detailed", "node-only", "application"),
  runtimeImport(
    "@dawn-ai/memory",
    "./browse",
    "detailed",
    "edge-safe",
    "integration",
    "supported",
    "dependency-free",
  ),
  runtimeImport("@dawn-ai/memory", "./namespace", "detailed", "edge-safe", "integration"),
  runtimeImport("@dawn-ai/memory", "./reconcile", "detailed", "edge-safe", "integration"),
  runtimeImport("@dawn-ai/memory-pgvector", ".", "detailed", "node-only", "application"),
  runtimeImport("@dawn-ai/postgres-storage", ".", "detailed", "edge-safe", "application"),
  runtimeImport("@dawn-ai/postgres-storage", "./node", "detailed", "node-only", "application"),
  runtimeImport("@dawn-ai/testing", ".", "detailed", "node-only", "testing"),
  runtimeImport("@dawn-ai/evals", ".", "detailed", "node-only", "testing"),

  runtimeImport("@dawn-ai/permissions", ".", "deferred-to-pr2", "edge-safe", "integration"),
  runtimeImport("@dawn-ai/permissions", "./node", "deferred-to-pr2", "node-only", "integration"),
  runtimeImport("@dawn-ai/workspace", ".", "deferred-to-pr2", "edge-safe", "application"),
  runtimeImport("@dawn-ai/workspace", "./node", "deferred-to-pr2", "node-only", "application"),
  runtimeImport("@dawn-ai/sandbox", ".", "deferred-to-pr2", "node-only", "application"),
  runtimeImport("@dawn-ai/sandbox", "./testing", "deferred-to-pr2", "node-only", "testing"),
  runtimeImport("@dawn-ai/langgraph", ".", "deferred-to-pr2", "edge-safe", "integration"),
  runtimeImport(
    "@dawn-ai/langgraph",
    "./define-entry",
    "deferred-to-pr2",
    "edge-safe",
    "integration",
  ),
  runtimeImport(
    "@dawn-ai/langgraph",
    "./route-module",
    "deferred-to-pr2",
    "edge-safe",
    "integration",
  ),
  runtimeImport("@dawn-ai/langchain", ".", "deferred-to-pr2", "edge-safe", "integration"),
  staticImport(
    "@dawn-ai/langchain",
    "./package.json",
    "deferred-to-pr2",
    "metadata",
    "tooling",
    "supported",
  ),
  runtimeImport("@dawn-ai/sqlite-storage", ".", "deferred-to-pr2", "node-only", "application"),

  staticImport(
    "@dawn-ai/config-biome",
    ".",
    "catalog-only",
    "config-artifact",
    "tooling",
    "supported",
  ),
  staticImport(
    "@dawn-ai/config-biome",
    "./biome",
    "catalog-only",
    "config-artifact",
    "tooling",
    "supported",
  ),
  staticImport(
    "@dawn-ai/config-typescript",
    ".",
    "catalog-only",
    "config-artifact",
    "tooling",
    "supported",
  ),
  staticImport(
    "@dawn-ai/config-typescript",
    "./base",
    "catalog-only",
    "config-artifact",
    "tooling",
    "supported",
  ),
  staticImport(
    "@dawn-ai/config-typescript",
    "./library",
    "catalog-only",
    "config-artifact",
    "tooling",
    "supported",
  ),
  staticImport(
    "@dawn-ai/config-typescript",
    "./node",
    "catalog-only",
    "config-artifact",
    "tooling",
    "supported",
  ),
  staticImport(
    "@dawn-ai/config-typescript",
    "./nextjs",
    "catalog-only",
    "config-artifact",
    "tooling",
    "supported",
  ),
  runtimeImport("@dawn-ai/devkit", ".", "internal", "node-only", "internal", "internal"),
  runtimeImport("@dawn-ai/vite-plugin", ".", "internal", "node-only", "internal", "internal"),

  operatedArtifact(
    "@dawn-ai/cli",
    "bin.dawn",
    "executable",
    "./dist/index.js",
    "detailed",
    "tooling",
  ),
  operatedArtifact(
    "create-dawn-ai-app",
    "bin.create-dawn-ai-app",
    "executable",
    "./dist/bin.js",
    "catalog-only",
    "tooling",
  ),
  operatedArtifact(
    "@dawn-ai/inspector",
    "dawnInspector.server",
    "operated-application",
    ".next/standalone/packages/inspector/server.js",
    "catalog-only",
    "tooling",
  ),
  GENERATED_ROUTES_ARTIFACT,
] as const satisfies readonly ApiReferenceArtifact[]

export function artifactAddressFor(artifact: ApiReferenceArtifact): string {
  if (artifact.kind === "import") return `import:${artifact.packageName}:${artifact.subpath}`
  if (artifact.kind === "operated") return `operated:${artifact.packageName}:${artifact.selector}`
  return `generated:${artifact.moduleName}`
}

const importAddress = (packageName: string, subpath: string) =>
  `import:${packageName}:${subpath}` as const
const operatedAddress = (packageName: string, selector: string) =>
  `operated:${packageName}:${selector}` as const

export const PACKAGE_CATALOG = [
  packageEntry(
    "@dawn-ai/ag-ui",
    "AG-UI protocol translation for Dawn runtimes and web clients.",
    "packages/ag-ui/README.md",
    "/docs/api/ag-ui",
    "/docs/ag-ui",
    [importAddress("@dawn-ai/ag-ui", "."), importAddress("@dawn-ai/ag-ui", "./sse")],
    "integration",
    "supported",
  ),
  packageEntry(
    "@dawn-ai/cli",
    "Dawn development, build, type generation, and runtime commands.",
    "packages/cli/README.md",
    "/docs/api/cli",
    "/docs/cli",
    [
      importAddress("@dawn-ai/cli", "."),
      importAddress("@dawn-ai/cli", "./fetch"),
      importAddress("@dawn-ai/cli", "./runtime"),
      importAddress("@dawn-ai/cli", "./testing"),
      operatedAddress("@dawn-ai/cli", "bin.dawn"),
    ],
    "tooling",
    "supported",
  ),
  packageEntry(
    "@dawn-ai/config-biome",
    "Shared Biome configuration for Dawn projects.",
    "packages/config-biome/README.md",
    "/docs/api#dawn-ai-config-biome",
    "/docs/getting-started",
    [
      importAddress("@dawn-ai/config-biome", "."),
      importAddress("@dawn-ai/config-biome", "./biome"),
    ],
    "tooling",
    "supported",
  ),
  packageEntry(
    "@dawn-ai/config-typescript",
    "Shared TypeScript configurations for Dawn projects.",
    "packages/config-typescript/README.md",
    "/docs/api#dawn-ai-config-typescript",
    "/docs/getting-started",
    [
      importAddress("@dawn-ai/config-typescript", "."),
      importAddress("@dawn-ai/config-typescript", "./base"),
      importAddress("@dawn-ai/config-typescript", "./library"),
      importAddress("@dawn-ai/config-typescript", "./node"),
      importAddress("@dawn-ai/config-typescript", "./nextjs"),
    ],
    "tooling",
    "supported",
  ),
  packageEntry(
    "@dawn-ai/core",
    "Route discovery, app configuration, capabilities, and type generation.",
    "packages/core/README.md",
    "/docs/api/core",
    "/docs/routes",
    [
      importAddress("@dawn-ai/core", "."),
      importAddress("@dawn-ai/core", "./node"),
      importAddress("@dawn-ai/core", "./internal/compiler"),
    ],
    "integration",
    "low-level",
  ),
  packageEntry(
    "@dawn-ai/devkit",
    "Internal scaffold templates and generated-app test utilities.",
    "packages/devkit/README.md",
    "/docs/api#dawn-ai-devkit",
    "/docs/getting-started",
    [importAddress("@dawn-ai/devkit", ".")],
    "internal",
    "internal",
  ),
  packageEntry(
    "@dawn-ai/evals",
    "Evaluation definitions, scorers, datasets, and runners.",
    "packages/evals/README.md",
    "/docs/api/evals",
    "/docs/evals",
    [importAddress("@dawn-ai/evals", ".")],
    "testing",
    "supported",
  ),
  packageEntry(
    "@dawn-ai/inspector",
    "Browser application for inspecting a running Dawn app.",
    "packages/inspector/README.md",
    "/docs/api#dawn-ai-inspector",
    "/docs/inspector",
    [operatedAddress("@dawn-ai/inspector", "dawnInspector.server")],
    "tooling",
    "supported",
  ),
  packageEntry(
    "@dawn-ai/langchain",
    "LangChain backend adapters for Dawn agents and chains.",
    "packages/langchain/README.md",
    "/docs/api#dawn-ai-langchain",
    "/docs/agents",
    [
      importAddress("@dawn-ai/langchain", "."),
      importAddress("@dawn-ai/langchain", "./package.json"),
    ],
    "integration",
    "supported",
  ),
  packageEntry(
    "@dawn-ai/langgraph",
    "LangGraph runtime adapters and route contracts.",
    "packages/langgraph/README.md",
    "/docs/api#dawn-ai-langgraph",
    "/docs/routes",
    [
      importAddress("@dawn-ai/langgraph", "."),
      importAddress("@dawn-ai/langgraph", "./define-entry"),
      importAddress("@dawn-ai/langgraph", "./route-module"),
    ],
    "integration",
    "supported",
  ),
  packageEntry(
    "@dawn-ai/memory",
    "Long-term memory storage, ranking, browsing, and reconciliation.",
    "packages/memory/README.md",
    "/docs/api/memory",
    "/docs/memory/long-term",
    [
      importAddress("@dawn-ai/memory", "."),
      importAddress("@dawn-ai/memory", "./browse"),
      importAddress("@dawn-ai/memory", "./namespace"),
      importAddress("@dawn-ai/memory", "./reconcile"),
    ],
    "application",
    "supported",
  ),
  packageEntry(
    "@dawn-ai/memory-pgvector",
    "Postgres and pgvector storage for shared long-term memory.",
    "packages/memory-pgvector/README.md",
    "/docs/api/memory-pgvector",
    "/docs/memory/long-term",
    [importAddress("@dawn-ai/memory-pgvector", ".")],
    "application",
    "supported",
  ),
  packageEntry(
    "@dawn-ai/permissions",
    "Permission matching and Node-backed approval stores.",
    "packages/permissions/README.md",
    "/docs/api#dawn-ai-permissions",
    "/docs/permissions",
    [importAddress("@dawn-ai/permissions", "."), importAddress("@dawn-ai/permissions", "./node")],
    "integration",
    "supported",
  ),
  packageEntry(
    "@dawn-ai/postgres-storage",
    "Postgres persistence for checkpoints, threads, and permissions.",
    "packages/postgres-storage/README.md",
    "/docs/api/postgres-storage",
    "/docs/persistence",
    [
      importAddress("@dawn-ai/postgres-storage", "."),
      importAddress("@dawn-ai/postgres-storage", "./node"),
    ],
    "application",
    "supported",
  ),
  packageEntry(
    "@dawn-ai/sandbox",
    "Docker-backed isolated workspace execution for Dawn agents.",
    "packages/sandbox/README.md",
    "/docs/api#dawn-ai-sandbox",
    "/docs/sandbox",
    [importAddress("@dawn-ai/sandbox", "."), importAddress("@dawn-ai/sandbox", "./testing")],
    "application",
    "supported",
  ),
  packageEntry(
    "@dawn-ai/sdk",
    "Author-facing declarations for agents, tools, middleware, and routes.",
    "packages/sdk/README.md",
    "/docs/api/sdk",
    "/docs/agents",
    [
      importAddress("@dawn-ai/sdk", "."),
      importAddress("@dawn-ai/sdk", "./pure"),
      importAddress("@dawn-ai/sdk", "./testing"),
    ],
    "application",
    "supported",
  ),
  packageEntry(
    "@dawn-ai/sqlite-storage",
    "Local SQLite persistence for Dawn runtime state.",
    "packages/sqlite-storage/README.md",
    "/docs/api#dawn-ai-sqlite-storage",
    "/docs/persistence",
    [importAddress("@dawn-ai/sqlite-storage", ".")],
    "application",
    "supported",
  ),
  packageEntry(
    "@dawn-ai/testing",
    "Harnesses, fixtures, matchers, and runtime test utilities.",
    "packages/testing/README.md",
    "/docs/api/testing",
    "/docs/testing-agents",
    [importAddress("@dawn-ai/testing", ".")],
    "testing",
    "supported",
  ),
  packageEntry(
    "@dawn-ai/vite-plugin",
    "Internal Vite integration for Dawn type generation.",
    "packages/vite-plugin/README.md",
    "/docs/api#dawn-ai-vite-plugin",
    "/docs/routes",
    [importAddress("@dawn-ai/vite-plugin", ".")],
    "internal",
    "internal",
  ),
  packageEntry(
    "@dawn-ai/workspace",
    "Filesystem and shell tools for agent workspaces.",
    "packages/workspace/README.md",
    "/docs/api#dawn-ai-workspace",
    "/docs/workspace",
    [importAddress("@dawn-ai/workspace", "."), importAddress("@dawn-ai/workspace", "./node")],
    "application",
    "supported",
  ),
  packageEntry(
    "create-dawn-ai-app",
    "Scaffolder for new Dawn applications.",
    "packages/create-dawn-app/README.md",
    "/docs/api#create-dawn-ai-app",
    "/docs/getting-started",
    [operatedAddress("create-dawn-ai-app", "bin.create-dawn-ai-app")],
    "tooling",
    "supported",
  ),
] as const satisfies readonly PackageCatalogEntry[]

function packageEntry(
  packageName: string,
  purpose: string,
  readmePath: string,
  canonicalReferenceDestination: string,
  conceptualGuideDestination: string,
  artifactAddresses: readonly string[],
  audience: ApiReferenceAudience,
  stability: ApiReferenceStability,
): PackageCatalogEntry {
  return {
    packageName,
    purpose,
    readmePath,
    canonicalReferenceDestination,
    conceptualGuideDestination,
    artifactAddresses,
    audience,
    stability,
  }
}

interface ApiReferenceRegistries {
  readonly pages: readonly ApiReferencePage[]
  readonly artifacts: readonly ApiReferenceArtifact[]
  readonly packages: readonly PackageCatalogEntry[]
}

const COVERAGES = new Set<ApiReferenceCoverage>([
  "detailed",
  "catalog-only",
  "internal",
  "deferred-to-pr2",
])
const AUDIENCES = new Set<ApiReferenceAudience>([
  "application",
  "integration",
  "testing",
  "tooling",
  "internal",
])
const STABILITIES = new Set<ApiReferenceStability>(["supported", "low-level", "internal"])
const RUNTIMES = new Set<RuntimeCompatibility>(["node-only", "edge-safe"])
const PURITIES = new Set<RuntimePurity>(["dependency-free", "not-claimed"])
const GUARD_IDS = new Set<ApiReferenceGuardId>(API_REFERENCE_GUARD_IDS)
const STATIC_SURFACES = new Set<StaticImportArtifact["surfaceKind"]>([
  "config-artifact",
  "metadata",
])
const OPERATED_ONLY_PACKAGES = new Set(["create-dawn-ai-app", "@dawn-ai/inspector"])

function assertExactFields(
  artifact: ApiReferenceArtifact,
  record: Record<string, unknown>,
  fields: readonly string[],
): void {
  const expected = new Set(fields)
  const unexpected = Object.keys(record).filter((field) => !expected.has(field))
  const missing = fields.filter((field) => !Object.hasOwn(record, field))
  if (unexpected.length > 0 || missing.length > 0) {
    throw new Error(
      `invalid artifact fields for ${artifactAddressFor(artifact)} (unexpected: ${unexpected.join(", ") || "none"}; missing: ${missing.join(", ") || "none"})`,
    )
  }
}

function validateArtifact(artifact: ApiReferenceArtifact): void {
  const record = artifact as unknown as Record<string, unknown>
  if (!COVERAGES.has(artifact.coverage)) throw new Error(`invalid coverage: ${artifact.coverage}`)
  if (!AUDIENCES.has(artifact.audience)) throw new Error(`invalid audience: ${artifact.audience}`)
  if (!STABILITIES.has(artifact.stability))
    throw new Error(`invalid stability: ${artifact.stability}`)
  if (
    (artifact.coverage === "catalog-only" || artifact.coverage === "internal") &&
    artifact.audience === "application"
  ) {
    throw new Error(`${artifact.coverage} artifacts cannot use the application audience`)
  }

  if (artifact.kind === "generated") {
    assertExactFields(artifact, record, [
      "kind",
      "moduleName",
      "ownerHref",
      "surfaceKind",
      "coverage",
      "audience",
      "stability",
    ])
    if (
      artifact.moduleName !== "dawn:routes" ||
      artifact.ownerHref !== "/docs/api/generated-routes" ||
      artifact.surfaceKind !== "generated-types" ||
      artifact.coverage !== "detailed" ||
      artifact.audience !== "application" ||
      artifact.stability !== "supported"
    ) {
      throw new Error(
        "dawn:routes generated artifact must use the canonical owner, generated-types category, application audience, and supported stability",
      )
    }
    return
  }

  if (artifact.kind === "import") {
    if (OPERATED_ONLY_PACKAGES.has(artifact.packageName)) {
      throw new Error(`${artifact.packageName} is an operated artifact, not an import surface`)
    }
    if (artifact.subpath !== "." && !artifact.subpath.startsWith("./")) {
      throw new Error(`invalid import subpath or operated selector: ${artifact.subpath}`)
    }
    if (artifact.surfaceKind === "typescript-runtime") {
      assertExactFields(artifact, record, [
        "kind",
        "packageName",
        "subpath",
        "coverage",
        "surfaceKind",
        "runtime",
        "audience",
        "purity",
        "stability",
        "guardIds",
      ])
      if (!RUNTIMES.has(artifact.runtime)) throw new Error(`invalid runtime: ${artifact.runtime}`)
      if (!PURITIES.has(artifact.purity)) throw new Error(`invalid purity: ${artifact.purity}`)
      validateGuardIds(artifact)
      return
    }
    if (!STATIC_SURFACES.has(artifact.surfaceKind)) {
      throw new Error(`invalid import surface kind: ${String(artifact.surfaceKind)}`)
    }
    assertExactFields(artifact, record, [
      "kind",
      "packageName",
      "subpath",
      "coverage",
      "surfaceKind",
      "audience",
      "stability",
    ])
    return
  }

  if (artifact.kind !== "operated") throw new Error(`invalid artifact kind: ${String(record.kind)}`)
  assertExactFields(artifact, record, [
    "kind",
    "packageName",
    "selector",
    "operatedKind",
    "manifestTarget",
    "coverage",
    "runtime",
    "audience",
    "stability",
    "guardIds",
  ])
  if (artifact.runtime !== "node-only") {
    throw new Error(`operated artifacts must use the node-only runtime`)
  }
  validateGuardIds(artifact)
  if (artifact.manifestTarget.length === 0) {
    throw new Error(`empty manifest target for ${artifactAddressFor(artifact)}`)
  }
  if (!/^(?:bin\.[^.]+|dawnInspector\.server)$/.test(artifact.selector)) {
    throw new Error(`invalid operated selector: ${artifact.selector}`)
  }
  if (
    (artifact.selector.startsWith("bin.") && artifact.operatedKind !== "executable") ||
    (artifact.selector === "dawnInspector.server" &&
      artifact.operatedKind !== "operated-application")
  ) {
    throw new Error(`invalid operated kind for ${artifact.selector}`)
  }
}

function validateGuardIds(artifact: RuntimeImportArtifact | OperatedArtifact): void {
  if (!Array.isArray(artifact.guardIds) || artifact.guardIds.length === 0) {
    throw new Error(`missing compatibility guard for ${artifactAddressFor(artifact)}`)
  }
  for (const guardId of artifact.guardIds) {
    if (!GUARD_IDS.has(guardId)) {
      throw new Error(
        `unknown compatibility guard ${String(guardId)} for ${artifactAddressFor(artifact)}`,
      )
    }
  }
  if (new Set(artifact.guardIds).size !== artifact.guardIds.length) {
    throw new Error(`duplicate compatibility guard for ${artifactAddressFor(artifact)}`)
  }

  const allowedGuardIds: readonly ApiReferenceGuardId[] =
    artifact.kind === "operated"
      ? ["node-operated-bundle", "browser-operated-negative-control"]
      : artifact.runtime === "edge-safe"
        ? ["edge-import-bundle"]
        : ["node-import-bundle", "browser-import-negative-control"]
  const applicableGuardIds =
    artifact.kind === "import" && artifact.purity === "dependency-free"
      ? ([...allowedGuardIds, "dependency-free-import-graph"] as const)
      : allowedGuardIds
  for (const guardId of artifact.guardIds) {
    if (!applicableGuardIds.includes(guardId)) {
      throw new Error(
        `inapplicable compatibility guard ${guardId} for ${artifactAddressFor(artifact)}`,
      )
    }
  }
  for (const guardId of applicableGuardIds) {
    if (artifact.guardIds.includes(guardId)) continue
    throw new Error(`missing compatibility guard ${guardId} for ${artifactAddressFor(artifact)}`)
  }
}

export function validateApiReferenceRegistries(registries: ApiReferenceRegistries): void {
  const packageNames = registries.packages.map(({ packageName }) => packageName)
  if (new Set(packageNames).size !== packageNames.length) {
    throw new Error("duplicate package catalog entry")
  }

  const addresses = new Set<string>()
  const generatedArtifacts = registries.artifacts.filter(
    (artifact): artifact is GeneratedTypesArtifact => artifact.kind === "generated",
  )
  if (generatedArtifacts.length !== 1) {
    throw new Error("dawn:routes must have exactly one generated artifact registry record")
  }
  const generatedArtifact = generatedArtifacts[0]
  if (!generatedArtifact) throw new Error("dawn:routes generated artifact is missing")
  for (const artifact of registries.artifacts) {
    validateArtifact(artifact)
    const address = artifactAddressFor(artifact)
    if (addresses.has(address)) throw new Error(`duplicate artifact address: ${address}`)
    addresses.add(address)
    if (artifact.kind !== "generated" && !packageNames.includes(artifact.packageName)) {
      throw new Error(`artifact owner missing from package catalog: ${artifact.packageName}`)
    }
  }

  const pageHrefs = registries.pages.map(({ href }) => href)
  if (new Set(pageHrefs).size !== pageHrefs.length)
    throw new Error("duplicate API reference page href")
  const pageLabels = registries.pages.map(({ label }) => label)
  if (new Set(pageLabels).size !== pageLabels.length)
    throw new Error("duplicate API reference page labels")
  for (const page of registries.pages) {
    if (page.parent.label !== "API Reference" || page.parent.href !== "/docs/api") {
      throw new Error(`invalid API reference parent for ${page.href}`)
    }
    for (const owner of page.ownerPackageNames) {
      if (!packageNames.includes(owner))
        throw new Error(`page owner missing from package catalog: ${owner}`)
    }
  }
  const generatedPageMatches = registries.pages.filter(
    ({ surfaceName, href }) =>
      surfaceName === generatedArtifact.moduleName && href === generatedArtifact.ownerHref,
  )
  if (generatedPageMatches.length !== 1) {
    throw new Error("dawn:routes generated artifact must map to its one canonical page")
  }

  const catalogAddresses = new Set<string>()
  for (const entry of registries.packages) {
    for (const address of entry.artifactAddresses) {
      if (catalogAddresses.has(address))
        throw new Error(`duplicate package artifact address: ${address}`)
      catalogAddresses.add(address)
      const artifact = registries.artifacts.find(
        (candidate) => artifactAddressFor(candidate) === address,
      )
      if (!artifact) throw new Error(`package catalog references unknown artifact: ${address}`)
      if (artifact.kind === "generated" || artifact.packageName !== entry.packageName) {
        throw new Error(`package catalog associates ${address} with the wrong package`)
      }
    }
  }
  for (const artifact of registries.artifacts) {
    const address = artifactAddressFor(artifact)
    if (artifact.kind !== "generated" && !catalogAddresses.has(address))
      throw new Error(`artifact missing from package catalog: ${address}`)
  }
}
