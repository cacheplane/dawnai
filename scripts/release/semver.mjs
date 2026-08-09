const SEMVER_PATTERN =
  /^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?(?:\+([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?$/u

export function parseSemver(value) {
  const match = typeof value === "string" ? SEMVER_PATTERN.exec(value) : null
  if (match === null) {
    throw new TypeError(`Invalid exact SemVer: ${String(value)}`)
  }

  const prerelease = match[4]?.split(".") ?? []
  if (
    prerelease.some((identifier) => /^[0-9]+$/u.test(identifier) && /^0[0-9]+$/u.test(identifier))
  ) {
    throw new TypeError(`Invalid exact SemVer: ${value}`)
  }

  const major = parseNumericIdentifier(match[1])
  const minor = parseNumericIdentifier(match[2])
  const patch = parseNumericIdentifier(match[3])

  return {
    major,
    minor,
    patch,
    prerelease: prerelease.map((identifier) =>
      /^[0-9]+$/u.test(identifier) ? parseNumericIdentifier(identifier) : identifier,
    ),
    build: match[5]?.split(".") ?? [],
  }
}

export function compareSemver(left, right) {
  const parsedLeft = parseSemver(left)
  const parsedRight = parseSemver(right)

  for (const field of ["major", "minor", "patch"]) {
    const comparison = compareNumbers(parsedLeft[field], parsedRight[field])
    if (comparison !== 0) {
      return comparison
    }
  }

  if (parsedLeft.prerelease.length === 0 || parsedRight.prerelease.length === 0) {
    return compareNumbers(parsedRight.prerelease.length, parsedLeft.prerelease.length)
  }

  const length = Math.max(parsedLeft.prerelease.length, parsedRight.prerelease.length)
  for (let index = 0; index < length; index += 1) {
    const leftIdentifier = parsedLeft.prerelease[index]
    const rightIdentifier = parsedRight.prerelease[index]
    if (leftIdentifier === undefined || rightIdentifier === undefined) {
      return compareNumbers(parsedLeft.prerelease.length, parsedRight.prerelease.length)
    }
    if (leftIdentifier === rightIdentifier) {
      continue
    }
    if (typeof leftIdentifier !== "string" && typeof rightIdentifier === "string") {
      return -1
    }
    if (typeof leftIdentifier === "string" && typeof rightIdentifier !== "string") {
      return 1
    }
    return leftIdentifier < rightIdentifier ? -1 : 1
  }
  return 0
}

export function isExactSemver(value) {
  try {
    parseSemver(value)
    return true
  } catch {
    return false
  }
}

function parseNumericIdentifier(identifier) {
  const parsed = Number(identifier)
  return Number.isSafeInteger(parsed) ? parsed : BigInt(identifier)
}

function compareNumbers(left, right) {
  return left === right ? 0 : left < right ? -1 : 1
}
