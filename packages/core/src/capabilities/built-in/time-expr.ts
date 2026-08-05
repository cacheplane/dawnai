const RELATIVE = /^-(\d+)([mhd])$/
const UNIT_MS = { m: 60_000, h: 3_600_000, d: 86_400_000 } as const

const invalid = (expr: string) =>
  new Error(
    `invalid time '${expr}' — use an ISO timestamp or relative offset like "-24h", "-7d", "-30m"`,
  )

/** "-24h" | "-7d" | "-30m" | ISO → ISO, resolved against `now`. Pure. */
export function resolveTimeExpr(expr: string, now: string): string {
  const rel = RELATIVE.exec(expr)
  if (rel) {
    const [, n, unit] = rel
    const ms = Date.parse(now) - Number(n) * UNIT_MS[unit as keyof typeof UNIT_MS]
    const d = new Date(ms)
    // A huge count (e.g. "-999999999999d") overflows the valid Date range;
    // toISOString on an Invalid Date throws V8's generic RangeError("Invalid
    // time value") — throw the same actionable message as the garbage path
    // instead, so callers without a try/catch can't crash uselessly.
    if (Number.isNaN(d.getTime())) throw invalid(expr)
    return d.toISOString()
  }
  const parsed = Date.parse(expr)
  if (Number.isNaN(parsed)) throw invalid(expr)
  return new Date(parsed).toISOString()
}
