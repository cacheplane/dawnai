/**
 * POSIX-only pure implementations of the path operations the fetch graph needs
 * (dirname/basename/join/resolve/relative), so the `./fetch` entry's module
 * graph carries zero `node:` imports. Build-time code (and the dynamic
 * loaders) keeps `node:path` — Windows build-machine paths only ever flow
 * through those. Behavior is pinned byte-for-byte to `node:path`'s posix
 * implementations by `test/pure-path.test.ts`.
 *
 * Callers that compare paths (containment checks) must use POSIX_SEP rather
 * than a host-derived separator, and must hand these functions paths that a
 * node lane has already canonicalized to POSIX form.
 */

/** The POSIX separator, so containment checks never reach for `path.sep`. */
export const POSIX_SEP = "/"

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

/**
 * `path.posix.resolve` parity for absolute bases, WITH the security-critical
 * rule intact: an absolute later segment DISCARDS everything before it, so
 * `pureResolve("/app/workspace", "/etc/passwd")` is `/etc/passwd`, not
 * `/app/workspace/etc/passwd`. A containment check fed the latter would pass a
 * path that escapes the jail.
 *
 * Deliberate contract difference from node: node falls back to `process.cwd()`
 * when no segment is absolute. There is no cwd here, so a non-absolute first
 * segment THROWS rather than silently producing a relative result that a
 * caller might then treat as rooted.
 */
export function pureResolve(...segments: readonly string[]): string {
  const base = segments[0]
  if (base === undefined || base[0] !== POSIX_SEP) {
    throw new Error(
      `pureResolve requires an absolute base; got ${JSON.stringify(base ?? "")} — the node lane must canonicalize before calling`,
    )
  }
  // Walk backwards and stop at the last absolute segment: everything earlier is
  // discarded, exactly as node does. The loop always terminates at `base`.
  let resolved = ""
  for (let i = segments.length - 1; i >= 0; i--) {
    const segment = segments[i] ?? ""
    if (segment.length === 0) continue
    resolved = resolved.length === 0 ? segment : `${segment}${POSIX_SEP}${resolved}`
    if (segment[0] === POSIX_SEP) break
  }
  return `${POSIX_SEP}${normalizeSegments(resolved, false)}`
}

/**
 * `path.posix.relative` parity. Both operands must be absolute (they run
 * through `pureResolve`, which throws otherwise) — node would resolve a
 * relative operand against the cwd this module does not have.
 */
export function pureRelative(from: string, to: string): string {
  if (from === to) return ""
  const fromPath = pureResolve(from)
  const toPath = pureResolve(to)
  if (fromPath === toPath) return ""

  // Compare segment-wise (not character-wise): the shared leading segments are
  // the common ancestor, so `/app/workspace-evil` shares only `/app` with
  // `/app/workspace` — a character walk would call the whole prefix common.
  const fromSegments = fromPath.split(POSIX_SEP).slice(1).filter(Boolean)
  const toSegments = toPath.split(POSIX_SEP).slice(1).filter(Boolean)
  let common = 0
  while (
    common < fromSegments.length &&
    common < toSegments.length &&
    fromSegments[common] === toSegments[common]
  ) {
    common++
  }

  const up = fromSegments.slice(common).map(() => "..")
  return [...up, ...toSegments.slice(common)].join(POSIX_SEP)
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
