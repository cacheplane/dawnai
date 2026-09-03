import type { MarkerFs } from "./capabilities/types.js"

/**
 * Absolute namespace paths to UTF-8 contents. Keys are the same strings the
 * capability markers compute with `pureJoin(routeDir, …)`, where `routeDir`
 * is `pureDirname(routeFile)` — on an edge manifest an opaque `/<app-name>/…`
 * namespace, never a build-machine path.
 */
export type StaticMarkerFiles = Readonly<Record<string, string>>

const encoder = new TextEncoder()

function normalize(path: string): string {
  // The markers join with pure helpers, so the only variation a caller can
  // introduce is a trailing separator. Strip it; keep "/" as the root.
  let end = path.length
  while (end > 1 && path[end - 1] === "/") end -= 1
  return path.slice(0, end)
}

/**
 * A `MarkerFs` over an in-memory map, for runtimes with no filesystem.
 *
 * Directories are implied by keys: `/a/b/c.md` makes `/a` and `/a/b`
 * directories. Every method is total — a miss reads exactly as it does on
 * disk, so the markers' own size and parse rules run unchanged.
 */
export function staticMarkerFs(files: StaticMarkerFiles): MarkerFs {
  const entries = new Map<string, string>()
  for (const [key, content] of Object.entries(files)) {
    if (typeof content === "string") entries.set(normalize(key), content)
  }
  const keys = [...entries.keys()]

  const isDirectory = (path: string): boolean => {
    if (path === "/") return keys.length > 0
    const prefix = `${path}/`
    return keys.some((key) => key.startsWith(prefix))
  }

  return {
    existsSync: (path) => {
      const p = normalize(path)
      return entries.has(p) || isDirectory(p)
    },
    isDirectorySync: (path) => {
      const p = normalize(path)
      return !entries.has(p) && isDirectory(p)
    },
    statSizeSync: (path) => {
      const content = entries.get(normalize(path))
      return content === undefined ? undefined : encoder.encode(content).byteLength
    },
    readFileSync: (path) => entries.get(normalize(path)),
    readdirSync: (path) => {
      const p = normalize(path)
      if (entries.has(p)) return []
      const prefix = p === "/" ? "/" : `${p}/`
      const names = new Set<string>()
      for (const key of keys) {
        if (!key.startsWith(prefix)) continue
        const rest = key.slice(prefix.length)
        const slash = rest.indexOf("/")
        const name = slash === -1 ? rest : rest.slice(0, slash)
        if (name.length > 0) names.add(name)
      }
      return [...names].sort()
    },
  }
}
