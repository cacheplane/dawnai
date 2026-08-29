const CANONICAL_UUID_V4_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u

export function dockerUuidToken(randomUUID, label) {
  if (typeof randomUUID !== "function") {
    throw new TypeError(`${label} randomUUID dependency is invalid`)
  }
  const uuid = randomUUID()
  if (typeof uuid !== "string" || !CANONICAL_UUID_V4_PATTERN.test(uuid)) {
    throw new TypeError(`${label} UUID must be one canonical lowercase v4 UUID`)
  }
  return uuid.replaceAll("-", "")
}

export async function removeAndVerifyDockerResource({ kind, name, runCommand }) {
  if (
    !["container", "volume"].includes(kind) ||
    typeof name !== "string" ||
    !/^[a-z0-9][a-z0-9_.-]{0,127}$/u.test(name) ||
    typeof runCommand !== "function"
  ) {
    throw new TypeError("Docker cleanup identity or runner is invalid")
  }
  const removeArgs = kind === "container" ? ["rm", "-f", name] : ["volume", "rm", "--force", name]
  try {
    await runCommand("docker", removeArgs)
  } catch (error) {
    if (!isExactMissingDockerResource(error, { kind, name, operation: "remove" })) throw error
  }

  const inspectArgs = kind === "container" ? ["inspect", name] : ["volume", "inspect", name]
  try {
    await runCommand("docker", inspectArgs)
  } catch (error) {
    if (isExactMissingDockerResource(error, { kind, name, operation: "inspect" })) return
    throw error
  }
  throw new Error(`Docker ${kind} ${name} remains after cleanup`)
}

function isExactMissingDockerResource(error, { kind, name, operation }) {
  if (error?.exitCode !== 1 || typeof error.stderr !== "string") return false
  const stderr = error.stderr.trim()
  if (kind === "container") {
    return (
      stderr ===
      (operation === "remove"
        ? `Error response from daemon: No such container: ${name}`
        : `Error: No such object: ${name}`)
    )
  }
  return (
    stderr ===
    (operation === "remove"
      ? `Error response from daemon: get ${name}: no such volume`
      : `Error: No such volume: ${name}`)
  )
}
