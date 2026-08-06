/**
 * POSIX-only pure implementations of the three path operations the fetch
 * graph needs (dirname/basename/join), so the `./fetch` entry's module graph
 * carries zero `node:` imports. Build-time code (and the dynamic loaders)
 * keeps `node:path` — Windows build-machine paths only ever flow through
 * those. Behavior is pinned byte-for-byte to `node:path`'s posix
 * implementations by `test/pure-path.test.ts`.
 */

/** `path.posix.dirname` parity. */
export function pureDirname(path: string): string {
  if (path.length === 0) return "."
  const hasRoot = path[0] === "/"
  let end = -1
  let matchedSlash = true
  for (let i = path.length - 1; i >= 1; --i) {
    if (path[i] === "/") {
      if (!matchedSlash) {
        end = i
        break
      }
    } else {
      matchedSlash = false
    }
  }
  if (end === -1) return hasRoot ? "/" : "."
  if (hasRoot && end === 1) return "//"
  return path.slice(0, end)
}

/** `path.posix.basename` parity (no-suffix form). */
export function pureBasename(path: string): string {
  let start = 0
  let end = -1
  let matchedSlash = true
  for (let i = path.length - 1; i >= 0; --i) {
    if (path[i] === "/") {
      if (!matchedSlash) {
        start = i + 1
        break
      }
    } else if (end === -1) {
      matchedSlash = false
      end = i + 1
    }
  }
  if (end === -1) return ""
  return path.slice(start, end)
}

/** `path.posix.join` parity: concatenate non-empty parts, then normalize. */
export function pureJoin(...parts: readonly string[]): string {
  let joined: string | undefined
  for (const part of parts) {
    if (part.length > 0) {
      joined = joined === undefined ? part : `${joined}/${part}`
    }
  }
  if (joined === undefined) return "."
  return pureNormalize(joined)
}

/** `path.posix.normalize` parity (empty-root, trailing-slash, `..` rules). */
function pureNormalize(path: string): string {
  if (path.length === 0) return "."
  const isAbsolute = path[0] === "/"
  const trailingSeparator = path[path.length - 1] === "/"
  const body = normalizeSegments(path, !isAbsolute)
  if (body.length === 0) {
    if (isAbsolute) return "/"
    return trailingSeparator ? "./" : "."
  }
  const withTrailing = trailingSeparator ? `${body}/` : body
  return isAbsolute ? `/${withTrailing}` : withTrailing
}

/**
 * Resolve `.`/`..`/empty segments. Relative paths (`allowAboveRoot`) keep
 * leading `..` runs; absolute paths drop `..` above root — node's
 * `normalizeString` semantics, segment-wise.
 */
function normalizeSegments(path: string, allowAboveRoot: boolean): string {
  const out: string[] = []
  for (const segment of path.split("/")) {
    if (segment === "" || segment === ".") continue
    if (segment === "..") {
      if (out.length > 0 && out.at(-1) !== "..") out.pop()
      else if (allowAboveRoot) out.push("..")
      continue
    }
    out.push(segment)
  }
  return out.join("/")
}
