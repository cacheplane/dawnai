export interface MemoryScopeTuple {
  readonly workspace?: string
  readonly route?: string
  readonly tenant?: string
  readonly user?: string
  readonly agent?: string
}
const ORDER = ["workspace", "route", "tenant", "user", "agent"] as const

// "|" separates dimensions and "=" separates key from value, so a dimension
// VALUE containing either would corrupt the namespace (prefix-match collisions,
// mis-split in suggestedMemoryPattern). Percent-encode both — and "%" itself,
// first, so the encoding is reversible. Keys are fixed names from ORDER and
// never need encoding. Values with none of these chars (the common case) are
// returned unchanged, so existing stored namespaces and persisted permission
// patterns keep matching byte-for-byte.
function encodeValue(value: string): string {
  return value.replaceAll("%", "%25").replaceAll("|", "%7C").replaceAll("=", "%3D")
}

/** Serialize a scope tuple to a stable namespace string. Fail-closed on empty. */
export function serializeNamespace(tuple: MemoryScopeTuple): string {
  const parts: string[] = []
  for (const key of ORDER) {
    const value = tuple[key]
    if (value !== undefined && value !== "") parts.push(`${key}=${encodeValue(value)}`)
  }
  if (parts.length === 0)
    throw new Error("serializeNamespace: scope tuple must have at least one dimension")
  return parts.join("|")
}
