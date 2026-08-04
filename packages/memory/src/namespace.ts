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

function decodeValue(value: string): string {
  return value.replaceAll("%3D", "=").replaceAll("%7C", "|").replaceAll("%25", "%")
}

/** Inverse of serializeNamespace. Unknown keys are ignored. */
export function parseNamespace(namespace: string): MemoryScopeTuple {
  const out: Record<string, string> = {}
  for (const part of namespace.split("|")) {
    const eq = part.indexOf("=")
    if (eq <= 0) continue
    const key = part.slice(0, eq)
    if ((ORDER as readonly string[]).includes(key)) out[key] = decodeValue(part.slice(eq + 1))
  }
  return out as MemoryScopeTuple
}

/**
 * Normalize a route path to a clean namespace key. Converts a route FILE path
 * like "src/app/memory-chat/index.ts" → "/memory-chat" (and ".../support/[tenant]/index.ts"
 * → "/support/[tenant]"); leaves an already-clean URL path like "/chat" unchanged.
 */
export function routeNamespaceKey(routePath: string): string {
  // Regex-free on purpose: each step is a linear string op, so there is no
  // ReDoS surface even though routePath ultimately derives from caller input.
  let p = routePath.split("\\").join("/")
  const appMarker = "/app/"
  const idx = p.lastIndexOf(appMarker)
  if (idx >= 0) p = p.slice(idx + appMarker.length - 1) // keep leading "/": "/memory-chat/index.ts"
  // Strip a trailing /index.<ext>.
  const lower = p.toLowerCase()
  for (const ext of ["/index.ts", "/index.tsx", "/index.js", "/index.mjs"]) {
    if (lower.endsWith(ext)) {
      p = p.slice(0, p.length - ext.length)
      break
    }
  }
  // Strip a #agent (or any #suffix).
  const hash = p.indexOf("#")
  if (hash >= 0) p = p.slice(0, hash)
  if (!p.startsWith("/")) p = `/${p}`
  return p === "" ? "/" : p
}
