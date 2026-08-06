import {
  existsSync as nodeExistsSync,
  readdirSync as nodeReaddirSync,
  readFileSync as nodeReadFileSync,
  statSync as nodeStatSync,
} from "node:fs"

import type { MarkerFs } from "./capabilities/types.js"

/**
 * The Node implementation of the capability-marker fs facade. Lives in core
 * behind the explicitly node-only "@dawn-ai/core/node" subpath (NOT the "."
 * barrel) so every node-side consumer shares one implementation while
 * `node:fs` stays out of the default import graph — edge entries never import
 * this subpath.
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
