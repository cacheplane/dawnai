const DEPENDENCY_FIELDS = ["dependencies", "optionalDependencies", "peerDependencies"]

export function internalDependencies(packageJson, inventoryNames) {
  const inventory = canonicalInventoryNames(inventoryNames)
  const dependencies = new Set()

  for (const field of DEPENDENCY_FIELDS) {
    const entries = packageJson?.[field]
    if (entries === undefined) {
      continue
    }
    if (entries === null || Array.isArray(entries) || typeof entries !== "object") {
      throw new TypeError(`${field} must be an object`)
    }
    for (const [name, specifier] of Object.entries(entries)) {
      if (typeof specifier !== "string") {
        throw new TypeError(`${field}.${name} must be a string`)
      }
      if (specifier.startsWith("workspace:") && !inventory.has(name)) {
        throw new Error(
          `Internal dependency ${name} is missing from the canonical release inventory`,
        )
      }
      if (inventory.has(name)) {
        dependencies.add(name)
      }
    }
  }

  return [...dependencies].sort(compareNames)
}

export function orderReleasePackages(packages, { gateOrder = ["create-dawn-ai-app"] } = {}) {
  if (!Array.isArray(packages) || packages.length === 0) {
    throw new TypeError("Release packages must be a non-empty array")
  }
  const packagesByName = new Map()
  for (const packageJson of packages) {
    const name = packageJson?.name
    if (typeof name !== "string" || name.trim().length === 0) {
      throw new TypeError("Every release package must have a non-empty name")
    }
    if (packagesByName.has(name)) {
      throw new Error(`Release package inventory contains duplicate package ${name}`)
    }
    packagesByName.set(name, packageJson)
  }

  if (!Array.isArray(gateOrder) || !gateOrder.every((name) => typeof name === "string")) {
    throw new TypeError("gateOrder must be an array of package names")
  }
  if (new Set(gateOrder).size !== gateOrder.length) {
    throw new Error("gateOrder must not contain duplicate package names")
  }

  const inventoryNames = [...packagesByName.keys()]
  const dependenciesByName = new Map(
    packages.map((packageJson) => [
      packageJson.name,
      new Set(internalDependencies(packageJson, inventoryNames)),
    ]),
  )
  const remaining = new Set(inventoryNames)
  const ordered = []
  const gateRanks = new Map(gateOrder.map((name, index) => [name, index]))

  while (remaining.size > 0) {
    const ready = [...remaining].filter((name) =>
      [...dependenciesByName.get(name)].every((dependency) => !remaining.has(dependency)),
    )
    if (ready.length === 0) {
      throw new Error(
        `Release package dependency cycle detected among: ${[...remaining].sort(compareNames).join(", ")}`,
      )
    }
    ready.sort((left, right) => compareReadyPackages(left, right, gateRanks))
    const next = ready[0]
    remaining.delete(next)
    ordered.push(next)
  }

  return ordered.map((name) => packagesByName.get(name))
}

function canonicalInventoryNames(inventoryNames) {
  const names = Array.isArray(inventoryNames)
    ? inventoryNames
    : inventoryNames instanceof Set
      ? [...inventoryNames]
      : null
  if (names === null || !names.every((name) => typeof name === "string" && name.length > 0)) {
    throw new TypeError("Canonical inventory names must be an array or set of package names")
  }
  if (new Set(names).size !== names.length) {
    throw new Error("Canonical release inventory contains duplicate package names")
  }
  return new Set(names)
}

function compareReadyPackages(left, right, gateRanks) {
  const leftGateRank = gateRanks.get(left)
  const rightGateRank = gateRanks.get(right)
  if (leftGateRank === undefined && rightGateRank !== undefined) {
    return -1
  }
  if (leftGateRank !== undefined && rightGateRank === undefined) {
    return 1
  }
  if (leftGateRank !== undefined && rightGateRank !== undefined) {
    return leftGateRank - rightGateRank
  }
  return compareNames(left, right)
}

function compareNames(left, right) {
  return left < right ? -1 : left > right ? 1 : 0
}
