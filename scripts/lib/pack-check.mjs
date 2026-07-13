import { randomUUID } from "node:crypto"
import { existsSync, lstatSync, readdirSync, readFileSync } from "node:fs"
import { isAbsolute, join, relative, resolve, sep } from "node:path"
import { fileURLToPath, pathToFileURL } from "node:url"

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
      "dist/runtime-exports.js",
      "dist/runtime-exports.d.ts",
      "dist/testing/index.js",
      "dist/testing/index.d.ts",
      "README.md",
      "package.json",
      "SKILL.md",
      "docs/README.md",
      "docs/getting-started.md",
      "docs/tools.md",
    ],
    requiredFields: [...libraryRequiredFields, "bin"],
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
    expectedFiles: ["dist/bin.js", "dist/index.js", "README.md", "package.json"],
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
    expectedFiles: [
      "dist/index.js",
      "dist/index.d.ts",
      "dist/sse.js",
      "dist/sse.d.ts",
      "README.md",
      "package.json",
    ],
    expectedExports: {
      ".": {
        types: "./dist/index.d.ts",
        default: "./dist/index.js",
      },
      "./sse": {
        types: "./dist/sse.d.ts",
        default: "./dist/sse.js",
      },
    },
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
  const publicPackageDirSet = new Set(publicPackageDirs)
  const manifestDirs = new Set()

  for (const entry of manifest) {
    if (manifestDirs.has(entry.dir)) {
      throw new Error(`Pack manifest contains duplicate directory: ${entry.dir}`)
    }
    manifestDirs.add(entry.dir)

    if (!publicPackageDirSet.has(entry.dir)) {
      throw new Error(`Pack manifest includes non-public package: ${entry.dir}`)
    }

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

export function missingExportTargets(packedRoot, exportsField) {
  const missingTargets = relativeExportTargets(exportsField)
    .filter(({ exportKey, target }) => !exportTargetHasPackedFile(packedRoot, exportKey, target))
    .map(({ target }) => target)

  return [...new Set(missingTargets)]
}

export function expectedExportFailures(exportsField, expectedExports = {}) {
  const failures = []

  for (const [exportKey, expectedMapping] of Object.entries(expectedExports)) {
    if (
      !exportsField ||
      typeof exportsField !== "object" ||
      !Object.hasOwn(exportsField, exportKey)
    ) {
      failures.push(`missing required export "${exportKey}"`)
      continue
    }

    if (JSON.stringify(exportsField[exportKey]) !== JSON.stringify(expectedMapping)) {
      failures.push(`export "${exportKey}" does not match required mapping`)
    }
  }

  return failures
}

function relativeExportTargets(value) {
  if (
    value &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    Object.keys(value).some((key) => key.startsWith("."))
  ) {
    return Object.entries(value).flatMap(([exportKey, mapping]) =>
      relativeExportTargetsForKey(exportKey, mapping),
    )
  }

  return relativeExportTargetsForKey(".", value)
}

function relativeExportTargetsForKey(exportKey, value) {
  if (typeof value === "string") {
    return value.startsWith("./") ? [{ exportKey, target: value }] : []
  }

  if (Array.isArray(value)) {
    return value.flatMap((entry) => relativeExportTargetsForKey(exportKey, entry))
  }

  if (value && typeof value === "object") {
    return Object.values(value).flatMap((entry) => relativeExportTargetsForKey(exportKey, entry))
  }

  return []
}

function exportTargetHasPackedFile(packedRoot, exportKey, target) {
  const targetPath = exportTargetPath(target)
  if (!validExportKey(exportKey) || !validPackagePath(targetPath)) {
    return false
  }

  const resolvedTarget = resolveExportTarget(packedRoot, target, targetPath)
  if (!resolvedTarget) {
    return false
  }

  if (targetPath.includes("*")) {
    return exportPatternHasPackedFile(packedRoot, exportKey, resolvedTarget.patternParts)
  }

  try {
    return lstatSync(resolvedTarget.filePath).isFile()
  } catch (error) {
    if (error?.code === "ENOENT" || error?.code === "ENOTDIR") {
      return false
    }
    throw error
  }
}

function exportTargetPath(target) {
  const suffixIndex = target.search(/[?#]/)
  return suffixIndex === -1 ? target : target.slice(0, suffixIndex)
}

function exportPatternHasPackedFile(packedRoot, exportKey, patternParts) {
  if (wildcardCount(exportKey) !== 1 || !exportKey.startsWith("./")) {
    return false
  }

  const pattern = exportPatternRegExp(patternParts)
  return packedRegularFiles(packedRoot).some((relativePath) => {
    const match = pattern.exec(relativePath)
    const subpath = match?.groups?.subpath
    return (
      subpath && validPackageSubpath(subpath) && validPackagePath(exportKey.replace("*", subpath))
    )
  })
}

function resolveExportTarget(packedRoot, target, targetPath) {
  const wildcardSentinel = `__dawn_export_wildcard_${randomUUID()}__`
  const sentinelTarget = `${targetPath.replaceAll("*", wildcardSentinel)}${target.slice(targetPath.length)}`

  try {
    const rootPath = resolve(packedRoot)
    const rootUrl = pathToFileURL(rootPath)
    if (!rootUrl.pathname.endsWith("/")) {
      rootUrl.pathname += "/"
    }

    const filePath = fileURLToPath(new URL(sentinelTarget, rootUrl))
    const relativePath = relative(rootPath, filePath)
    if (relativePath === ".." || relativePath.startsWith(`..${sep}`) || isAbsolute(relativePath)) {
      return null
    }

    const patternParts = relativePath.split(sep).join("/").split(wildcardSentinel)
    if (patternParts.length !== wildcardCount(targetPath) + 1) {
      return null
    }

    return { filePath, patternParts }
  } catch {
    return null
  }
}

function wildcardCount(value) {
  return [...value].filter((character) => character === "*").length
}

function validExportKey(exportKey) {
  if (exportKey === ".") {
    return true
  }

  const wildcards = wildcardCount(exportKey)
  return (
    wildcards <= 1 && (wildcards === 1 || !exportKey.endsWith("/")) && validPackagePath(exportKey)
  )
}

function validPackagePath(packagePath) {
  if (!packagePath.startsWith("./")) {
    return false
  }

  return validPackageSubpath(packagePath.slice(2))
}

function validPackageSubpath(subpath) {
  return subpath.split(/[\\/]/).every(validPackagePathSegment)
}

function validPackagePathSegment(rawSegment) {
  let segment
  try {
    segment = decodeURIComponent(rawSegment)
  } catch {
    return false
  }

  if (segment.includes("/") || segment.includes("\\")) {
    return false
  }

  return segment !== "." && segment !== ".." && segment.toLowerCase() !== "node_modules"
}

function exportPatternRegExp(parts) {
  let source = escapeRegExp(parts[0])

  if (parts.length > 1) {
    source += `(?<subpath>.+)${escapeRegExp(parts[1])}`
    for (const part of parts.slice(2)) {
      source += `\\k<subpath>${escapeRegExp(part)}`
    }
  }

  return new RegExp(`^${source}$`)
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
}

function packedRegularFiles(root, current = root, prefix = "") {
  const files = []

  for (const entry of readdirSync(current, { withFileTypes: true })) {
    const relativePath = prefix ? `${prefix}/${entry.name}` : entry.name
    if (entry.isDirectory()) {
      files.push(...packedRegularFiles(root, join(current, entry.name), relativePath))
    } else if (entry.isFile()) {
      files.push(relativePath)
    }
  }

  return files
}

function discoverPublicPackageDirs(repoRoot) {
  const packagesDir = join(repoRoot, "packages")

  return readdirSync(packagesDir, { withFileTypes: true })
    .filter(
      (entry) => entry.isDirectory() && existsSync(join(packagesDir, entry.name, "package.json")),
    )
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
