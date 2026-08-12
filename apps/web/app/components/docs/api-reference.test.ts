import { spawnSync } from "node:child_process"
import { existsSync, readdirSync, readFileSync } from "node:fs"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import { describe, expect, it } from "vitest"
import * as apiReferenceExports from "./api-reference"
import {
  type ApiReferenceArtifact,
  ARTIFACT_REGISTRY,
  artifactAddressFor,
  GENERATED_ROUTES_ARTIFACT,
  PACKAGE_CATALOG,
  validateApiReferenceRegistries,
} from "./api-reference"
import { API_REFERENCE_PAGES, API_REFERENCE_PARENT } from "./api-reference-pages"

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "../../../../..")
const CHECK_DOCS_PATH = join(REPO_ROOT, "scripts/check-docs.mjs")

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
] as const

const EXPECTED_DEFERRED_IMPORTS = [
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
  ["@dawn-ai/memory", "."],
  ["@dawn-ai/memory", "./browse"],
  ["@dawn-ai/memory", "./namespace"],
  ["@dawn-ai/memory", "./reconcile"],
  ["@dawn-ai/memory-pgvector", "."],
  ["@dawn-ai/postgres-storage", "."],
  ["@dawn-ai/postgres-storage", "./node"],
  ["@dawn-ai/testing", "."],
  ["@dawn-ai/evals", "."],
] as const

const EXPECTED_CATALOG_AND_INTERNAL_IMPORTS = [
  ["@dawn-ai/core", "./internal/compiler", "internal"],
  ["@dawn-ai/config-biome", ".", "catalog-only"],
  ["@dawn-ai/config-biome", "./biome", "catalog-only"],
  ["@dawn-ai/config-typescript", ".", "catalog-only"],
  ["@dawn-ai/config-typescript", "./base", "catalog-only"],
  ["@dawn-ai/config-typescript", "./library", "catalog-only"],
  ["@dawn-ai/config-typescript", "./node", "catalog-only"],
  ["@dawn-ai/config-typescript", "./nextjs", "catalog-only"],
  ["@dawn-ai/devkit", ".", "internal"],
  ["@dawn-ai/vite-plugin", ".", "internal"],
] as const

const EXPECTED_OPERATED_ARTIFACTS = [
  ["@dawn-ai/cli", "bin.dawn", "executable", "./dist/index.js"],
  ["create-dawn-ai-app", "bin.create-dawn-ai-app", "executable", "./dist/bin.js"],
  [
    "@dawn-ai/inspector",
    "dawnInspector.server",
    "operated-application",
    ".next/standalone/packages/inspector/server.js",
  ],
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
    expect(API_REFERENCE_PAGES).toHaveLength(10)
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
  it("uses unique keys in separate import and operated address spaces", () => {
    const addresses = ARTIFACT_REGISTRY.map(artifactAddressFor)
    expect(new Set(addresses).size).toBe(addresses.length)
    expect(ARTIFACT_REGISTRY.filter(({ kind }) => kind === "import")).toHaveLength(42)
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

  it("pins the exact deferred-to-PR2 import allowlist", () => {
    expect(
      ARTIFACT_REGISTRY.flatMap((artifact) =>
        artifact.kind === "import" && artifact.coverage === "deferred-to-pr2"
          ? [[artifact.packageName, artifact.subpath]]
          : [],
      ),
    ).toEqual(EXPECTED_DEFERRED_IMPORTS)
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
        ({ packageName, selector, operatedKind, manifestTarget }) => [
          packageName,
          selector,
          operatedKind,
          manifestTarget,
        ],
      ),
    ).toEqual(EXPECTED_OPERATED_ARTIFACTS)
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

    expect(analyzeApiReferenceRegistry(API_REFERENCE_PAGES, coverageMutation).failures).toEqual([
      expect.stringMatching(/artifact policy tuple.*internal\/compiler.*coverage/),
    ])
    expect(analyzeApiReferenceRegistry(API_REFERENCE_PAGES, kindMutation).failures).toEqual([
      expect.stringMatching(/artifact policy tuple.*internal\/compiler.*surfaceKind/),
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
          `/docs/api#${entry.packageName.replace(/^@/, "").replaceAll("/", "-")}`,
        )
      }
    }
  })
})
