import {
  existsSync as nodeExistsSync,
  readdirSync as nodeReaddirSync,
  readFileSync as nodeReadFileSync,
  statSync as nodeStatSync,
} from "node:fs"
import type { MarkerFs } from "../../src/capabilities/types.js"

/**
 * Real-fs MarkerFs mirroring the cli's nodeMarkerFs (packages/cli/src/lib/
 * runtime/node-marker-fs.ts), so core marker tests exercise the same facade
 * the node execute path injects. Absent-markerFs contexts model edge runtimes.
 */
export const realMarkerFs: MarkerFs = {
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
