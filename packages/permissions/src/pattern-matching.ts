type PatternMap = Readonly<Record<string, readonly string[]>>

/**
 * Match a tool+candidate against allow + deny pattern maps.
 *
 * Semantics:
 *   - deny wins over allow
 *   - prefix matching: `candidate.startsWith(pattern)`
 *   - no entries for tool → "unknown"
 */
export function matchPermission(
  tool: string,
  candidate: string,
  allow: PatternMap,
  deny: PatternMap,
): "allow" | "deny" | "unknown" {
  const denyList = deny[tool] ?? []
  for (const pattern of denyList) {
    if (candidate.startsWith(pattern)) return "deny"
  }
  const allowList = allow[tool] ?? []
  for (const pattern of allowList) {
    if (candidate.startsWith(pattern)) return "allow"
  }
  return "unknown"
}
