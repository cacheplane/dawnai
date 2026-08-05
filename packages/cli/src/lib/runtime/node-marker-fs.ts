import { existsSync, readdirSync, readFileSync, statSync } from "node:fs"

import type { MarkerFs } from "@dawn-ai/core"

/**
 * The Node implementation of the capability-marker fs facade. Injected by
 * prepareRouteExecution so @dawn-ai/core's markers carry no `node:fs` import
 * of their own (edge bundles built from the `./fetch` entry never pull this
 * module in — it is only imported by the node execute path).
 */
export const nodeMarkerFs: MarkerFs = {
  existsSync: (path) => {
    try {
      return existsSync(path)
    } catch {
      return false
    }
  },
  statSizeSync: (path) => {
    try {
      return statSync(path).size
    } catch {
      return undefined
    }
  },
  readFileSync: (path) => readFileSync(path, "utf8"),
  readDirSync: (path) => {
    try {
      return readdirSync(path)
    } catch {
      return []
    }
  },
}
