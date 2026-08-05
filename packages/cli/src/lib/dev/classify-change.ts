export type ChangeClassification = "ignore" | "restart"

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

  if (
    relativePath === "node_modules" ||
    relativePath.startsWith("node_modules/") ||
    relativePath === "pnpm-workspace.yaml" ||
    relativePath === "pnpm-lock.yaml" ||
    relativePath === "package-lock.json" ||
    relativePath === "yarn.lock" ||
    relativePath === ".pnpm-store" ||
    relativePath.startsWith(".pnpm-store/")
  ) {
    return "ignore"
  }

  // Tool files: any path containing /tools/<name>.ts (not .d.ts)
  //
  // Tool/state/reducer edits used to classify as "typegen" (regenerate types,
  // no restart) on the theory that the dev child's tsx `?t=` cache-buster
  // would re-import the changed module on the next request. It doesn't: tsx
  // 4.23.0 never re-evaluates a module on a query-string change, so the
  // running child kept serving the stale tool/state/reducer implementation
  // until an unrelated edit happened to restart it. Classifying these as
  // "restart" is a bug fix, not a trade — it's the only way a tool/state/
  // reducer edit reliably hot-applies.
  if (/\/tools\/[^/]+\.ts$/.test(relativePath) && !relativePath.endsWith(".d.ts")) {
    return "restart"
  }

  // State definition: any path ending in /state.ts
  if (/\/state\.ts$/.test(relativePath)) {
    return "restart"
  }

  // Reducer overrides: any path containing /reducers/<name>.ts
  if (/\/reducers\/[^/]+\.ts$/.test(relativePath) && !relativePath.endsWith(".d.ts")) {
    return "restart"
  }

  return "restart"
}

/**
 * Human-readable description of what changed, for the dev session's restart
 * log line. Colocated with `classifyChange` so the tool/state/reducer path
 * patterns stay defined in one place.
 */
export function describeChangeReason(relativePath: string): string {
  if (/\/tools\/[^/]+\.ts$/.test(relativePath) && !relativePath.endsWith(".d.ts")) {
    return `tool change: ${relativePath}`
  }

  if (/\/state\.ts$/.test(relativePath)) {
    return `state change: ${relativePath}`
  }

  if (/\/reducers\/[^/]+\.ts$/.test(relativePath) && !relativePath.endsWith(".d.ts")) {
    return `reducer change: ${relativePath}`
  }

  return relativePath
}
