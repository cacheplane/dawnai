// RUNTIME-ONLY imports. These packages load the user's dawn.config.ts / route
// memory.ts (arbitrary TS through the tsx loader) and open sqlite databases —
// they must execute from real node_modules at runtime, NEVER be bundled by
// Next. pnpm workspace links resolve outside node_modules, which defeats
// serverExternalPackages, so the ignore comments leave these import()s for
// Node itself to resolve.
export function importCore(): Promise<typeof import("@dawn-ai/core")> {
  return import(/* turbopackIgnore: true */ /* webpackIgnore: true */ "@dawn-ai/core")
}

export function importMemory(): Promise<typeof import("@dawn-ai/memory")> {
  return import(/* turbopackIgnore: true */ /* webpackIgnore: true */ "@dawn-ai/memory")
}
