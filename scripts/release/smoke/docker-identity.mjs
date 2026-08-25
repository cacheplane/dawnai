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
