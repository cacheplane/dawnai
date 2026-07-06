import { dirname } from "node:path"

/**
 * Default suggested pattern for a shell command.
 * Returns the first two whitespace-separated tokens.
 */
export function suggestedCommandPattern(command: string): string {
  const trimmed = command.trim()
  if (trimmed.length === 0) return ""
  const tokens = trimmed.split(/\s+/)
  return tokens.slice(0, 2).join(" ")
}

/**
 * Default suggested pattern for a filesystem path.
 * Returns the parent directory with trailing slash.
 */
export function suggestedPathPattern(path: string): string {
  if (path.endsWith("/")) return path
  const parent = dirname(path)
  return parent === "/" ? "/" : `${parent}/`
}

/**
 * Default suggested pattern for a memory-write approval: the namespace's
 * workspace+route prefix, with a trailing "|" terminator so prefix matching
 * cannot collide across sibling routes (route=/a vs route=/ab). Callers match
 * candidates as `namespace + "|"` for the same reason.
 */
export function suggestedMemoryPattern(namespace: string): string {
  const parts = namespace.split("|")
  const routeIdx = parts.findIndex((p) => p.startsWith("route="))
  const prefix = routeIdx >= 0 ? parts.slice(0, routeIdx + 1) : parts
  return `${prefix.join("|")}|`
}
