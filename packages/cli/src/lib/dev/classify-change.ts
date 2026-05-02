export type ChangeClassification = "typegen" | "restart"

export function classifyChange(relativePath: string): ChangeClassification {
  // Tool files: any path containing /tools/<name>.ts (not .d.ts)
  if (/\/tools\/[^/]+\.ts$/.test(relativePath) && !relativePath.endsWith(".d.ts")) {
    return "typegen"
  }

  // State definition: any path ending in /state.ts
  if (/\/state\.ts$/.test(relativePath)) {
    return "typegen"
  }

  // Reducer overrides: any path containing /reducers/<name>.ts
  if (/\/reducers\/[^/]+\.ts$/.test(relativePath) && !relativePath.endsWith(".d.ts")) {
    return "typegen"
  }

  return "restart"
}
