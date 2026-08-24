/**
 * Which Dawn server paths the browser may reach, and nothing else.
 *
 * The dev server sets no CORS headers, so direct reads from the page are
 * impossible and a same-origin proxy is required. An OPEN proxy in a template
 * every Dawn developer copies is a liability — this app would happily forward
 * `POST /threads/:id/resume` or the whole agent surface — so the allowlist is
 * the point of the route, not an optimization over it.
 *
 * The decision lives here, as a pure function, rather than inside the route
 * handler: no test in this repo imports a Next route module, and the one
 * precedent that exists boots a standalone server behind an env gate. A pure
 * module is testable the way `transcript.ts` and `thread-source.ts` are.
 */

/** A single allowed route: an exact method plus a fixed-arity path shape. */
interface AllowedRoute {
  readonly method: "GET" | "POST"
  /** `null` marks a single free segment (an id); strings must match exactly. */
  readonly shape: readonly (string | null)[]
}

const ALLOWED: readonly AllowedRoute[] = [
  // The dev server's entire memory surface — these three and no more.
  { method: "GET", shape: ["memory", "candidates"] },
  { method: "POST", shape: ["memory", "candidates", null, "approve"] },
  { method: "POST", shape: ["memory", "candidates", null, "reject"] },
  // Thread reads the workbench hydrates from. Deliberately read-only: running,
  // resuming and cancelling a thread all go through CopilotKit's own runtime
  // route, which is separately wired.
  { method: "GET", shape: ["threads", null, "state"] },
  { method: "GET", shape: ["threads", null, "pending_interrupts"] },
]

/**
 * A free segment must be one path segment and nothing clever. Rejecting these
 * outright is cheaper to reason about than normalizing them, and every real id
 * (a UUID, or `cand1`) passes.
 */
function isSafeSegment(segment: string): boolean {
  return segment.length > 0 && segment !== "." && segment !== ".." && !segment.includes("/")
}

function matches(route: AllowedRoute, method: string, path: readonly string[]): boolean {
  if (route.method !== method) return false
  if (route.shape.length !== path.length) return false
  return route.shape.every((expected, index) => {
    const actual = path[index] ?? ""
    return expected === null ? isSafeSegment(actual) : actual === expected
  })
}

/**
 * The absolute URL to forward to, or `null` to reject.
 *
 * Segments are re-encoded on the way out so a decoded id can never forge extra
 * path structure — Next has already `decodeURIComponent`-ed them by the time a
 * catch-all handler sees them.
 */
export function resolveProxyTarget(
  method: string,
  path: readonly string[],
  serverUrl: string,
): string | null {
  if (!ALLOWED.some((route) => matches(route, method, path))) return null
  const base = serverUrl.replace(/\/+$/, "")
  return `${base}/${path.map(encodeURIComponent).join("/")}`
}
