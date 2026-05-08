import { PALETTE_STOPS, type PaletteStop, type Rgb, type Rgba } from "./stops"

export interface Palette {
  readonly bg: string
  readonly fg: string
  readonly muted: string
  readonly surface: string
  readonly accent: string
  readonly hue: string
  readonly border: string
}

function clamp01(n: number): number {
  return n < 0 ? 0 : n > 1 ? 1 : n
}

function easeInOutCubic(t: number): number {
  return t < 0.5 ? 4 * t * t * t : 1 - (-2 * t + 2) ** 3 / 2
}

function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t
}

function lerpRgb(a: Rgb, b: Rgb, t: number): Rgb {
  return [
    Math.round(lerp(a[0], b[0], t)),
    Math.round(lerp(a[1], b[1], t)),
    Math.round(lerp(a[2], b[2], t)),
  ]
}

function lerpRgba(a: Rgba, b: Rgba, t: number): Rgba {
  return [
    Math.round(lerp(a[0], b[0], t)),
    Math.round(lerp(a[1], b[1], t)),
    Math.round(lerp(a[2], b[2], t)),
    lerp(a[3], b[3], t),
  ]
}

function fmtRgb(c: Rgb): string {
  return `rgb(${c[0]},${c[1]},${c[2]})`
}

function fmtRgba(c: Rgba): string {
  return `rgba(${c[0]},${c[1]},${c[2]},${c[3]})`
}

function findBracket(p: number): { lo: PaletteStop; hi: PaletteStop } {
  const last = PALETTE_STOPS.length - 1
  if (p <= PALETTE_STOPS[0]!.at) return { lo: PALETTE_STOPS[0]!, hi: PALETTE_STOPS[0]! }
  if (p >= PALETTE_STOPS[last]!.at) return { lo: PALETTE_STOPS[last]!, hi: PALETTE_STOPS[last]! }
  for (let i = 0; i < last; i++) {
    const lo = PALETTE_STOPS[i]!
    const hi = PALETTE_STOPS[i + 1]!
    if (p >= lo.at && p <= hi.at) return { lo, hi }
  }
  // Unreachable given the guards above; satisfy the type checker.
  return { lo: PALETTE_STOPS[0]!, hi: PALETTE_STOPS[last]! }
}

/**
 * Compute the interpolated palette at the given scroll progress.
 *
 * `progress` is clamped to [0, 1]. Within a bracketing pair of stops, the
 * normalized t is eased with cubic ease-in-out before the per-channel lerp.
 */
export function paletteAt(progress: number): Palette {
  const p = clamp01(progress)
  const { lo, hi } = findBracket(p)
  const span = hi.at - lo.at
  const tLinear = span === 0 ? 0 : (p - lo.at) / span
  const t = easeInOutCubic(tLinear)
  return {
    bg: fmtRgb(lerpRgb(lo.bg, hi.bg, t)),
    fg: fmtRgb(lerpRgb(lo.fg, hi.fg, t)),
    muted: fmtRgb(lerpRgb(lo.muted, hi.muted, t)),
    surface: fmtRgb(lerpRgb(lo.surface, hi.surface, t)),
    accent: fmtRgb(lerpRgb(lo.accent, hi.accent, t)),
    hue: fmtRgb(lerpRgb(lo.hue, hi.hue, t)),
    border: fmtRgba(lerpRgba(lo.border, hi.border, t)),
  }
}
