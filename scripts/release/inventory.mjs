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
  const changesetConfig = JSON.parse(configSource)
  readFixedGroup(changesetConfig)
  const workspaceConfig = parse(workspaceSource)
  const manifestPaths = findWorkspaceManifestPaths(workspaceConfig.packages, treeSource)
  const workspacePackages = await Promise.all(
    manifestPaths.map(async (path) => ({
      ...JSON.parse(await git.showFile({ ref, path })),
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
  const fixed = readFixedGroup({ fixed: fixedGroups })
  const counts = new Map()
  for (const name of fixed) {
    counts.set(name, (counts.get(name) ?? 0) + 1)
  }

  const workspaceByName = new Map(workspacePackages.map((pkg) => [pkg.name, pkg]))
  const publicPackages = workspacePackages.filter((pkg) => pkg.private !== true)
  const publicNames = new Set(publicPackages.map((pkg) => pkg.name))
  const fixedNames = new Set(fixed)
  const extras = [...fixedNames].filter((name) => !publicNames.has(name))
  const versions = publicPackages.map((pkg) => pkg.version)
  const canonicalVersion = mostCommon(versions)
  const versionMismatches = publicPackages
    .filter((pkg) => pkg.version !== canonicalVersion)
    .map((pkg) => pkg.name)
    .sort()

  return {
    packages: [...publicNames].sort(),
    ...(versionMismatches.length === 0 && canonicalVersion !== undefined
      ? { version: canonicalVersion }
      : {}),
    duplicates: [...counts]
      .filter(([, count]) => count > 1)
      .map(([name]) => name)
      .sort(),
    extra: extras.sort(),
    missing: [...publicNames].filter((name) => !fixedNames.has(name)).sort(),
    privateMembers: extras.filter((name) => workspaceByName.get(name)?.private === true).sort(),
    unknownMembers: extras.filter((name) => !workspaceByName.has(name)).sort(),
    versionMismatches,
  }
}

export function assertValidReleaseInventory(inventory) {
  const result = validateReleaseInventory(inventory)
  const categories = [
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

export class ReleaseInventoryError extends Error {
  constructor(message, details) {
    super(message)
    this.name = "ReleaseInventoryError"
    if (details !== undefined) {
      this.details = details
    }
  }
}

function findWorkspaceManifestPaths(patterns, treeSource) {
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
  const source = pattern
    .split("**")
    .map((part) => part.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&").replaceAll("\\*", "[^/]*"))
    .join(".*")
  return new RegExp(`^${source}$`, "u")
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
