export type ChangeClassification = "ignore" | "typegen" | "restart"

export function classifyChange(relativePath: string): ChangeClassification {
  // An empty path means the watcher could not identify which file changed
  // (e.g. a null fileName from recursive fs.watch). Never restart on an
  // unattributable change — default to ignore.
  if (relativePath === "") {
    return "ignore"
  }

  // Runtime state lives under .dawn/ and must never trigger a rebuild/restart.
  if (relativePath === ".dawn" || relativePath.startsWith(".dawn/")) {
    return "ignore"
  }

  if (relativePath === "workspace" || relativePath.startsWith("workspace/")) {
    return "ignore"
  }

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
