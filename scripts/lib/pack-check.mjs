import { readdirSync, readFileSync } from "node:fs"
import { join } from "node:path"

const standardRequiredFields = [
  "publishConfig.access",
  "repository",
  "homepage",
  "bugs",
  "license",
  "engines.node",
]

const libraryRequiredFields = [...standardRequiredFields, "exports", "types"]

export const packages = [
  {
    dir: "packages/core",
    expectedFiles: [
      "dist/index.js",
      "dist/index.d.ts",
      "dist/typegen/extract-tool-schema.js",
      "dist/typegen/extract-tool-schema.d.ts",
      "dist/typegen/render-state-types.js",
      "dist/typegen/render-state-types.d.ts",
      "dist/state/resolve-state-fields.js",
      "dist/state/resolve-state-fields.d.ts",
      "README.md",
      "package.json",
    ],
    requiredFields: libraryRequiredFields,
  },
  {
    dir: "packages/langgraph",
    expectedFiles: [
      "dist/index.js",
      "dist/index.d.ts",
      "dist/define-entry.js",
      "dist/route-module.js",
      "README.md",
      "package.json",
    ],
    requiredFields: libraryRequiredFields,
  },
  {
    dir: "packages/langchain",
    expectedFiles: [
      "dist/agent-adapter.js",
      "dist/agent-adapter.d.ts",
      "dist/chain-adapter.js",
      "dist/chain-adapter.d.ts",
      "dist/index.js",
      "dist/index.d.ts",
      "dist/retry.js",
      "dist/retry.d.ts",
      "dist/tool-converter.js",
      "dist/tool-converter.d.ts",
      "README.md",
      "package.json",
    ],
    requiredFields: libraryRequiredFields,
  },
  {
    dir: "packages/vite-plugin",
    expectedFiles: [
      "dist/index.js",
      "dist/index.d.ts",
      "dist/type-extractor.js",
      "dist/type-extractor.d.ts",
      "dist/zod-generator.js",
      "dist/zod-generator.d.ts",
      "README.md",
      "package.json",
    ],
    requiredFields: libraryRequiredFields,
  },
  {
    dir: "packages/sdk",
    expectedFiles: [
      "dist/agent.js",
      "dist/agent.d.ts",
      "dist/index.js",
      "dist/index.d.ts",
      "dist/known-model-ids.js",
      "dist/known-model-ids.d.ts",
      "dist/types.js",
      "dist/types.d.ts",
      "dist/route-types.js",
      "dist/route-types.d.ts",
      "dist/testing/index.js",
      "dist/testing/index.d.ts",
      "README.md",
      "package.json",
    ],
    requiredFields: libraryRequiredFields,
  },
  {
    dir: "packages/cli",
    expectedFiles: [
      "dist/index.js",
      "dist/commands/docs.js",
      "README.md",
      "package.json",
      "SKILL.md",
      "docs/README.md",
      "docs/getting-started.md",
      "docs/tools.md",
    ],
    requiredFields: [...standardRequiredFields, "bin"],
  },
  {
    dir: "packages/devkit",
    expectedFiles: [
      "dist/index.js",
      "dist/index.d.ts",
      "templates/app-basic/npmrc.template",
      "templates/app-basic/package.json.template",
      "README.md",
      "package.json",
    ],
    requiredFields: libraryRequiredFields,
  },
  {
    dir: "packages/create-dawn-app",
    expectedFiles: ["dist/index.js", "README.md", "package.json"],
    requiredFields: [...standardRequiredFields, "bin"],
  },
  {
    dir: "packages/config-biome",
    expectedFiles: ["biome.json", "README.md", "package.json"],
    requiredFields: [...standardRequiredFields, "exports"],
  },
  {
    dir: "packages/config-typescript",
    expectedFiles: [
      "base.json",
      "library.json",
      "node.json",
      "nextjs.json",
      "README.md",
      "package.json",
    ],
    requiredFields: [...standardRequiredFields, "exports"],
  },
  {
    dir: "packages/ag-ui",
    expectedFiles: ["dist/index.js", "dist/index.d.ts", "README.md", "package.json"],
    requiredFields: libraryRequiredFields,
  },
  {
    dir: "packages/evals",
    expectedFiles: ["dist/index.js", "dist/index.d.ts", "README.md", "package.json"],
    requiredFields: libraryRequiredFields,
  },
  {
    dir: "packages/memory-pgvector",
    expectedFiles: ["dist/index.js", "dist/index.d.ts", "README.md", "package.json"],
    requiredFields: libraryRequiredFields,
  },
  {
    dir: "packages/memory",
    expectedFiles: ["dist/index.js", "dist/index.d.ts", "README.md", "package.json"],
    requiredFields: libraryRequiredFields,
  },
  {
    dir: "packages/permissions",
    expectedFiles: ["dist/index.js", "dist/index.d.ts", "README.md", "package.json"],
    requiredFields: libraryRequiredFields,
  },
  {
    dir: "packages/sandbox",
    expectedFiles: [
      "dist/index.js",
      "dist/index.d.ts",
      "dist/testing/index.js",
      "dist/testing/index.d.ts",
      "README.md",
      "package.json",
    ],
    requiredFields: libraryRequiredFields,
  },
  {
    dir: "packages/sqlite-storage",
    expectedFiles: ["dist/index.js", "dist/index.d.ts", "README.md", "package.json"],
    requiredFields: libraryRequiredFields,
  },
  {
    dir: "packages/testing",
    expectedFiles: ["dist/index.js", "dist/index.d.ts", "README.md", "package.json"],
    requiredFields: libraryRequiredFields,
  },
  {
    dir: "packages/workspace",
    expectedFiles: ["dist/index.js", "dist/index.d.ts", "README.md", "package.json"],
    requiredFields: libraryRequiredFields,
  },
]

export function validatePackManifest(repoRoot, manifest) {
  const publicPackageDirs = discoverPublicPackageDirs(repoRoot)
  const manifestDirs = new Set()

  for (const entry of manifest) {
    if (manifestDirs.has(entry.dir)) {
      throw new Error(`Pack manifest contains duplicate directory: ${entry.dir}`)
    }
    manifestDirs.add(entry.dir)

    for (const requiredFile of ["README.md", "package.json"]) {
      if (!entry.expectedFiles.includes(requiredFile)) {
        throw new Error(`${entry.dir} must expect ${requiredFile}`)
      }
    }
  }

  for (const packageDir of publicPackageDirs) {
    if (!manifestDirs.has(packageDir)) {
      throw new Error(`Pack manifest is missing public package: ${packageDir}`)
    }
  }
}

function discoverPublicPackageDirs(repoRoot) {
  const packagesDir = join(repoRoot, "packages")

  return readdirSync(packagesDir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => ({
      dir: `packages/${entry.name}`,
      packageJson: readJson(join(packagesDir, entry.name, "package.json")),
    }))
    .filter(({ packageJson }) => packageJson.private !== true)
    .map(({ dir }) => dir)
    .sort()
}

function readJson(path) {
  return JSON.parse(readFileSync(path, "utf8"))
}
