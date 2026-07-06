type PatternMap = Readonly<Record<string, readonly string[]>>

/**
 * Match a tool+candidate against allow + deny pattern maps.
 *
 * Semantics:
 *   - deny wins over allow
 *   - prefix matching: `candidate.startsWith(pattern)` — for commands/paths
 *   - EXCEPT the reserved "tool" key (per-tool approval gating), which uses
 *     exact equality: tool names must not prefix-match ("deploy" must not
 *     match "deployProd")
 *   - no entries for tool → "unknown"
 */
export function matchPermission(
  tool: string,
  candidate: string,
  allow: PatternMap,
  deny: PatternMap,
): "allow" | "deny" | "unknown" {
  const matches = (pattern: string) =>
    tool === "tool" ? candidate === pattern : candidate.startsWith(pattern)
  const denyList = deny[tool] ?? []
  for (const pattern of denyList) {
    if (matches(pattern)) return "deny"
  }
  const allowList = allow[tool] ?? []
  for (const pattern of allowList) {
    if (matches(pattern)) return "allow"
  }
  return "unknown"
}
