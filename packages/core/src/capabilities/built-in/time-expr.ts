const RELATIVE = /^-(\d+)([mhd])$/
const UNIT_MS = { m: 60_000, h: 3_600_000, d: 86_400_000 } as const

/** "-24h" | "-7d" | "-30m" | ISO → ISO, resolved against `now`. Pure. */
export function resolveTimeExpr(expr: string, now: string): string {
  const rel = RELATIVE.exec(expr)
  if (rel) {
    const [, n, unit] = rel
    return new Date(
      Date.parse(now) - Number(n) * UNIT_MS[unit as keyof typeof UNIT_MS],
    ).toISOString()
  }
  const parsed = Date.parse(expr)
  if (Number.isNaN(parsed)) {
    throw new Error(
      `invalid time '${expr}' — use an ISO timestamp or relative offset like "-24h", "-7d", "-30m"`,
    )
  }
  return new Date(parsed).toISOString()
}
