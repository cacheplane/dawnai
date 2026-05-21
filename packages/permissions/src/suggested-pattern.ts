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
