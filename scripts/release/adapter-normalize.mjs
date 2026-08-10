const STATUSES = new Set(["PRESENT", "ABSENT", "AMBIGUOUS", "ERROR"])
const CODE_PATTERN = /^[A-Z][A-Z0-9_-]{0,63}$/u

export function normalizeAdapterEnvelope(value, { source, operation, payloadKey }) {
  let snapshot
  try {
    snapshot = snapshotJson(value, new Set())
  } catch {
    return malformed()
  }
  if (!isRecord(snapshot) || !STATUSES.has(snapshot.status)) return malformed()
  const expected =
    snapshot.status === "PRESENT"
      ? ["status", "operation", "httpStatus", "code", payloadKey]
      : ["status", "operation", "httpStatus", "code"]
  if (!exactKeys(snapshot, expected) || snapshot.operation !== operation) return malformed()
  if (
    (snapshot.httpStatus !== null &&
      (!Number.isInteger(snapshot.httpStatus) ||
        snapshot.httpStatus < 100 ||
        snapshot.httpStatus > 599)) ||
    (snapshot.code !== null &&
      (typeof snapshot.code !== "string" || !CODE_PATTERN.test(snapshot.code)))
  )
    return malformed()
  if (snapshot.status === "PRESENT") {
    if (
      !Number.isInteger(snapshot.httpStatus) ||
      snapshot.httpStatus < 200 ||
      snapshot.httpStatus >= 300 ||
      snapshot.code !== null
    ) {
      return malformed()
    }
    return snapshot
  }
  if (snapshot.status === "ABSENT") {
    if (
      source === "npm" &&
      operation === "package-version" &&
      snapshot.httpStatus === 404 &&
      snapshot.code === "E404"
    )
      return snapshot
    if (source === "github" && snapshot.httpStatus === 404) {
      return { ...snapshot, status: "AMBIGUOUS" }
    }
    return malformed()
  }
  if (snapshot.code === null) return malformed()
  return snapshot
}

export function snapshotJson(value, ancestors = new Set()) {
  if (value === null || typeof value === "string" || typeof value === "boolean") return value
  if (typeof value === "number" && Number.isFinite(value)) return value
  if (typeof value !== "object" || ancestors.has(value)) throw new TypeError("Invalid JSON value")
  ancestors.add(value)
  try {
    if (Array.isArray(value)) {
      if (Object.getPrototypeOf(value) !== Array.prototype) throw new TypeError("Invalid array")
      const keys = Reflect.ownKeys(value)
      if (keys.length !== value.length + 1 || keys.at(-1) !== "length") {
        throw new TypeError("Invalid array")
      }
      const output = []
      for (let index = 0; index < value.length; index += 1) {
        const descriptor = Object.getOwnPropertyDescriptor(value, String(index))
        if (!isEnumerableData(descriptor)) throw new TypeError("Invalid array entry")
        output.push(snapshotJson(descriptor.value, ancestors))
      }
      return output
    }
    const prototype = Object.getPrototypeOf(value)
    if (prototype !== Object.prototype && prototype !== null) throw new TypeError("Invalid object")
    const output = Object.create(null)
    for (const key of Reflect.ownKeys(value)) {
      if (typeof key !== "string") throw new TypeError("Invalid key")
      const descriptor = Object.getOwnPropertyDescriptor(value, key)
      if (!isEnumerableData(descriptor)) throw new TypeError("Invalid field")
      output[key] = snapshotJson(descriptor.value, ancestors)
    }
    return { ...output }
  } finally {
    ancestors.delete(value)
  }
}

function isEnumerableData(descriptor) {
  return (
    descriptor?.enumerable === true &&
    "value" in descriptor &&
    descriptor.get === undefined &&
    descriptor.set === undefined
  )
}

function exactKeys(value, expected) {
  const actual = Object.keys(value).sort()
  return actual.length === expected.length && expected.every((key) => actual.includes(key))
}

function malformed() {
  return {
    status: "ERROR",
    operation: "malformed-envelope",
    httpStatus: null,
    code: "MALFORMED_ENVELOPE",
  }
}

function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value)
}
