/**
 * The Dawn error-code registry.
 *
 * A single, frozen source of truth mapping a stable numeric code
 * (`DAWN_Exxxx`) to a short human-readable `title` and an optional `docsPath`.
 * Producers across every package import codes from here so a failure becomes
 * linkable, searchable, and self-documenting on all three surfaces (CLI
 * stderr, HTTP/SSE bodies, and tool-result strings).
 *
 * Numeric ranges by category:
 *   E1xxx  config / `dawn check`
 *   E2xxx  sandbox
 *   E3xxx  permissions
 *   E4xxx  model / provider
 *   E5xxx  runtime / import
 */

export interface DawnErrorDescriptor {
  /** Stable machine-readable identifier, e.g. `DAWN_E2001`. */
  readonly code: `DAWN_E${number}`
  /** Stable, short, human-readable English title. */
  readonly title: string
  /** `/docs/<slug>#<anchor>` convention; optional (a code without docs is valid). */
  readonly docsPath?: string
}

/** Canonical docs base for rendered error links. */
const DOCS_BASE = "https://dawnai.org"

export const DAWN_ERRORS = {
  DAWN_E1001: {
    code: "DAWN_E1001",
    title: "Invalid tool scope",
    docsPath: "/docs/tools#scoping-a-routes-tools",
  },
  DAWN_E1002: {
    code: "DAWN_E1002",
    title: "Invalid sandbox config",
    docsPath: "/docs/configuration#sandbox",
  },
  DAWN_E1003: {
    code: "DAWN_E1003",
    title: "Unknown build target",
    docsPath: "/docs/deployment",
  },
  DAWN_E2001: {
    code: "DAWN_E2001",
    title: "Sandbox unavailable",
    docsPath: "/docs/sandbox#what-it-is--and-isnt",
  },
  DAWN_E2002: {
    code: "DAWN_E2002",
    title: "Sandbox preflight failed",
    docsPath: "/docs/sandbox#quickstart",
  },
  DAWN_E3001: {
    code: "DAWN_E3001",
    title: "Permission denied",
    docsPath: "/docs/permissions",
  },
  DAWN_E4001: {
    code: "DAWN_E4001",
    title: "Model provider package missing",
    docsPath: "/docs/configuration",
  },
  DAWN_E4002: {
    code: "DAWN_E4002",
    title: "Unknown model id",
    docsPath: "/docs/configuration",
  },
  DAWN_E5001: {
    code: "DAWN_E5001",
    title: "Import or export mismatch",
  },
  DAWN_E5002: {
    code: "DAWN_E5002",
    title: "Tool file has the wrong shape",
    docsPath: "/docs/tools",
  },
  DAWN_E5101: {
    code: "DAWN_E5101",
    title: "Node version below the supported floor",
  },
} as const satisfies Record<string, DawnErrorDescriptor>

/** The union of all registered error codes. Producers cannot invent codes. */
export type DawnErrorCode = keyof typeof DAWN_ERRORS

/** Look up the descriptor for a registered code. */
export function describeError(code: DawnErrorCode): DawnErrorDescriptor {
  return DAWN_ERRORS[code]
}

/**
 * The canonical docs URL for a code, or `undefined` when the code has no
 * `docsPath` (still a valid, searchable code).
 */
export function errorDocsUrl(code: DawnErrorCode, base = DOCS_BASE): string | undefined {
  const path = describeError(code).docsPath
  return path ? `${base}${path}` : undefined
}
