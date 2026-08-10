import { parse } from "yaml"

import { createGitReader } from "./adapters/git.mjs"

export async function readReleaseInventory({
  root,
  ref = "HEAD",
  git = createGitReader({ root }),
}) {
  const [configSource, workspaceSource, treeSource] = await Promise.all([
    git.showFile({ ref, path: ".changeset/config.json" }),
    git.showFile({ ref, path: "pnpm-workspace.yaml" }),
    git.listTree({ ref }),
  ])
  const changesetConfig = parseJsonAtRef(configSource, ".changeset/config.json", ref)
  readFixedGroup(changesetConfig)
  let workspaceConfig
  try {
    workspaceConfig = parse(workspaceSource)
  } catch (error) {
    throw new ReleaseInventoryConfigError(
      `Invalid pnpm-workspace.yaml at ${ref}: ${formatCause(error)}`,
      { cause: error },
    )
  }
  const manifestPaths = findWorkspaceManifestPaths(workspaceConfig?.packages, treeSource)
  const workspacePackages = await Promise.all(
    manifestPaths.map(async (path) => ({
      ...parseJsonAtRef(await git.showFile({ ref, path }), path, ref),
      path,
    })),
  )

  return {
    fixedGroups: changesetConfig.fixed,
    workspacePackages,
  }
}

export function readFixedGroup(changesetConfig) {
  if (!Array.isArray(changesetConfig.fixed) || changesetConfig.fixed.length !== 1) {
    throw new ReleaseInventoryError("Changesets config must define exactly one fixed group")
  }
  if (!Array.isArray(changesetConfig.fixed[0])) {
    throw new ReleaseInventoryError("Changesets fixed group must be an array")
  }
  return changesetConfig.fixed[0]
}

export function validateReleaseInventory({ fixedGroups, workspacePackages }) {
  const structuralErrors = []
  let fixed = []
  if (!Array.isArray(fixedGroups) || fixedGroups.length !== 1 || !Array.isArray(fixedGroups[0])) {
    structuralErrors.push("release inventory must define exactly one fixed group array")
  } else {
    fixed = fixedGroups[0]
  }
  if (fixed.length === 0) {
    structuralErrors.push("fixed group must contain at least one package")
  }
  fixed.forEach((name, index) => {
    if (!isNonEmptyString(name)) {
      structuralErrors.push(`fixed member at index ${index} must be a non-empty string`)
    }
  })

  const packages = Array.isArray(workspacePackages) ? workspacePackages : []
  if (!Array.isArray(workspacePackages)) {
    structuralErrors.push("workspace packages must be an array")
  }
  const publicPackages = packages.filter((pkg) => pkg?.private !== true)
  if (publicPackages.length === 0) {
    structuralErrors.push("public workspace inventory must contain at least one package")
  }
  let hasInvalidPublicManifest = false
  packages.forEach((pkg, index) => {
    if (pkg?.private === true) {
      return
    }
    const label = isNonEmptyString(pkg?.path) ? pkg.path : `workspacePackages[${index}]`
    if (!isNonEmptyString(pkg?.name)) {
      structuralErrors.push(`${label}: package name must be a non-empty string`)
      hasInvalidPublicManifest = true
    }
    if (!isNonEmptyString(pkg?.version)) {
      structuralErrors.push(`${label}: package version must be a non-empty string`)
      hasInvalidPublicManifest = true
    }
  })

  const validFixed = fixed.filter(isNonEmptyString)
  const counts = new Map()
  for (const name of validFixed) {
    counts.set(name, (counts.get(name) ?? 0) + 1)
  }

  const workspaceByName = new Map()
  packages.forEach((pkg, index) => {
    if (!isNonEmptyString(pkg?.name)) {
      return
    }
    const entries = workspaceByName.get(pkg.name) ?? []
    entries.push({ pkg, index })
    workspaceByName.set(pkg.name, entries)
  })
  const workspaceDuplicates = [...workspaceByName]
    .filter(([, entries]) => entries.length > 1)
    .map(([name, entries]) => ({
      name,
      manifests: entries
        .map(({ pkg, index }) =>
          isNonEmptyString(pkg.path) ? pkg.path : `workspacePackages[${index}]`,
        )
        .sort(),
    }))
    .sort((left, right) => left.name.localeCompare(right.name))
  const publicNames = new Set(
    publicPackages.filter((pkg) => isNonEmptyString(pkg?.name)).map((pkg) => pkg.name),
  )
  const fixedNames = new Set(validFixed)
  const extras = [...fixedNames].filter((name) => !publicNames.has(name))
  const versions = publicPackages
    .filter((pkg) => isNonEmptyString(pkg?.version))
    .map((pkg) => pkg.version)
  const canonicalVersion = mostCommon(versions)
  const versionMismatches = publicPackages
    .filter(
      (pkg) =>
        isNonEmptyString(pkg?.name) &&
        isNonEmptyString(pkg?.version) &&
        pkg.version !== canonicalVersion,
    )
    .map((pkg) => pkg.name)
    .sort()

  return {
    packages: [...publicNames].sort(),
    ...(!hasInvalidPublicManifest &&
    versionMismatches.length === 0 &&
    canonicalVersion !== undefined
      ? { version: canonicalVersion }
      : {}),
    structuralErrors: structuralErrors.sort(),
    workspaceDuplicates,
    duplicates: [...counts]
      .filter(([, count]) => count > 1)
      .map(([name]) => name)
      .sort(),
    extra: extras.sort(),
    missing: [...publicNames].filter((name) => !fixedNames.has(name)).sort(),
    privateMembers: extras
      .filter((name) => workspaceByName.get(name)?.some(({ pkg }) => pkg.private === true))
      .sort(),
    unknownMembers: extras.filter((name) => !workspaceByName.has(name)).sort(),
    versionMismatches,
  }
}

export function assertValidReleaseInventory(inventory) {
  const result = validateReleaseInventory(inventory)
  const categories = [
    "structuralErrors",
    "workspaceDuplicates",
    "duplicates",
    "extra",
    "missing",
    "privateMembers",
    "unknownMembers",
    "versionMismatches",
  ]
  if (categories.some((category) => result[category].length > 0)) {
    throw new ReleaseInventoryError("Release inventory is invalid", result)
  }
  return result
}

function isNonEmptyString(value) {
  return typeof value === "string" && value.trim().length > 0
}

function parseJsonAtRef(source, path, ref) {
  try {
    const value = JSON.parse(source)
    if (value === null || Array.isArray(value) || typeof value !== "object") {
      throw new TypeError("expected a JSON object")
    }
    return value
  } catch (error) {
    throw new ReleaseInventoryConfigError(`Invalid ${path} at ${ref}: ${formatCause(error)}`, {
      cause: error,
    })
  }
}

function formatCause(error) {
  return error instanceof Error ? error.message : String(error)
}

export class ReleaseInventoryError extends Error {
  constructor(message, details) {
    super(message)
    this.name = "ReleaseInventoryError"
    if (details !== undefined) {
      this.details = details
    }
  }
}

export class ReleaseInventoryConfigError extends ReleaseInventoryError {
  constructor(message, options) {
    super(message)
    this.name = "ReleaseInventoryConfigError"
    if (options?.cause !== undefined) {
      this.cause = options.cause
    }
  }
}

function findWorkspaceManifestPaths(patterns, treeSource) {
  if (!Array.isArray(patterns) || !patterns.every((pattern) => typeof pattern === "string")) {
    throw new ReleaseInventoryConfigError(
      "pnpm-workspace.yaml packages must be an array of strings",
    )
  }
  const included = patterns
    .filter((pattern) => !pattern.startsWith("!"))
    .map((pattern) => globToRegExp(`${pattern}/package.json`))
  const excluded = patterns
    .filter((pattern) => pattern.startsWith("!"))
    .map((pattern) => globToRegExp(`${pattern.slice(1)}/package.json`))
  return treeSource
    .split("\n")
    .filter(
      (path) =>
        included.some((matcher) => matcher.test(path)) &&
        !excluded.some((matcher) => matcher.test(path)),
    )
    .sort()
}

function globToRegExp(pattern) {
  if (
    pattern.length === 0 ||
    pattern.trim() !== pattern ||
    pattern.startsWith("/") ||
    pattern.endsWith("/") ||
    pattern.includes("//") ||
    /[?{}[\]\\()]/u.test(pattern)
  ) {
    throw new ReleaseInventoryConfigError(`Unsupported workspace pattern: ${pattern}`)
  }

  const segments = pattern.split("/")
  if (
    segments.some(
      (segment) =>
        segment === "" ||
        segment === "." ||
        segment === ".." ||
        (segment.includes("**") && segment !== "**"),
    )
  ) {
    throw new ReleaseInventoryConfigError(`Unsupported workspace pattern: ${pattern}`)
  }

  let source = "^"
  segments.forEach((segment, index) => {
    if (segment === "**") {
      source += "(?:[^/]+/)*"
      return
    }
    source += segment.replace(/[\\.+^${}|]/gu, "\\$&").replaceAll("*", "[^/]*")
    if (index < segments.length - 1) {
      source += "/"
    }
  })
  return new RegExp(`${source}$`, "u")
}

function mostCommon(values) {
  const counts = new Map()
  for (const value of values) {
    counts.set(value, (counts.get(value) ?? 0) + 1)
  }
  return [...counts].sort(
    ([leftValue, leftCount], [rightValue, rightCount]) =>
      rightCount - leftCount || String(leftValue).localeCompare(String(rightValue)),
  )[0]?.[0]
}
