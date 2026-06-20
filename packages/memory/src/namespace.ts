export interface MemoryScopeTuple {
  readonly workspace?: string
  readonly route?: string
  readonly tenant?: string
  readonly user?: string
  readonly agent?: string
}
const ORDER = ["workspace", "route", "tenant", "user", "agent"] as const
/** Serialize a scope tuple to a stable namespace string. Fail-closed on empty. */
export function serializeNamespace(tuple: MemoryScopeTuple): string {
  const parts: string[] = []
  for (const key of ORDER) {
    const value = tuple[key]
    if (value !== undefined && value !== "") parts.push(`${key}=${value}`)
  }
  if (parts.length === 0)
    throw new Error("serializeNamespace: scope tuple must have at least one dimension")
  return parts.join("|")
}
