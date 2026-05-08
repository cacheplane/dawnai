/**
 * Five-anchor palette table for the landing scroll arc.
 *
 * Each stop maps a normalized scroll progress (0..1) to a complete palette.
 * `paletteAt()` interpolates between adjacent stops using cubic ease-in-out.
 *
 * RGB tuples are [r, g, b]; alpha tuples are [r, g, b, a].
 * Tune values here without touching the engine.
 */

export type Rgb = readonly [number, number, number]
export type Rgba = readonly [number, number, number, number]

export interface PaletteStop {
  readonly at: number // 0..1 scroll progress
  readonly bg: Rgb
  readonly fg: Rgb
  readonly muted: Rgb
  readonly surface: Rgb
  readonly accent: Rgb
  readonly hue: Rgb
  readonly border: Rgba
}

export const PALETTE_STOPS: readonly PaletteStop[] = [
  // 0 — pre-dawn cosmic (matches hero's hardcoded dark)
  {
    at: 0.0,
    bg: [2, 6, 23],
    fg: [200, 200, 204],
    muted: [139, 143, 163],
    surface: [10, 15, 31],
    accent: [251, 191, 36],
    hue: [245, 165, 36],
    border: [255, 255, 255, 0.08],
  },
  // 0.15 — twilight violet
  {
    at: 0.15,
    bg: [26, 21, 48],
    fg: [218, 210, 224],
    muted: [173, 158, 192],
    surface: [40, 31, 70],
    accent: [251, 191, 36],
    hue: [245, 165, 36],
    border: [255, 255, 255, 0.1],
  },
  // 0.30 — dusk peach
  {
    at: 0.3,
    bg: [58, 40, 64],
    fg: [240, 220, 220],
    muted: [200, 170, 170],
    surface: [82, 56, 90],
    accent: [251, 146, 60],
    hue: [251, 146, 60],
    border: [255, 255, 255, 0.14],
  },
  // 0.50 — sunrise (resolved to daylight palette)
  {
    at: 0.5,
    bg: [254, 244, 230],
    fg: [33, 24, 12],
    muted: [109, 86, 56],
    surface: [255, 252, 244],
    accent: [217, 119, 6],
    hue: [251, 191, 36],
    border: [33, 24, 12, 0.1],
  },
  // 1.0 — daylight
  {
    at: 1.0,
    bg: [254, 254, 254],
    fg: [15, 18, 32],
    muted: [85, 95, 117],
    surface: [248, 250, 254],
    accent: [217, 119, 6],
    hue: [251, 191, 36],
    border: [15, 18, 32, 0.08],
  },
]
