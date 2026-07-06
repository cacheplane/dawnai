import type { DawnConfig } from "./types.js"

/**
 * Typed identity helper for `dawn.config.ts`. Purely for IntelliSense — the
 * loader reads `export default`, so `export default config({...})` and a bare
 * `export default {...}` are equivalent at runtime.
 */
export function config(c: DawnConfig): DawnConfig {
  return c
}
