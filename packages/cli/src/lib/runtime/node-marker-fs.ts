import {
  existsSync as nodeExistsSync,
  readdirSync as nodeReaddirSync,
  readFileSync as nodeReadFileSync,
  statSync as nodeStatSync,
} from "node:fs"

import type { MarkerFs } from "@dawn-ai/core"

/**
 * The Node implementation of the capability-marker fs facade. Injected by
 * prepareRouteExecution so that markers can drop their own `node:fs` imports
 * (edge bundles built from the `./fetch` entry never pull this module in — it
 * is only imported by the node execute path).
 */
export const nodeMarkerFs: MarkerFs = {
  existsSync: (path) => {
    try {
      return nodeExistsSync(path)
    } catch {
      return false
    }
  },
  isDirectorySync: (path) => {
    try {
      return nodeStatSync(path).isDirectory()
    } catch {
      return false
    }
  },
  statSizeSync: (path) => {
    try {
      return nodeStatSync(path).size
    } catch {
      return undefined
    }
  },
  readFileSync: (path) => {
    try {
      return nodeReadFileSync(path, "utf8")
    } catch {
      return undefined
    }
  },
  readdirSync: (path) => {
    try {
      return nodeReaddirSync(path)
    } catch {
      return []
    }
  },
}
