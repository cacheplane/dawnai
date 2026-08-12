/**
 * The pure half of thread-access loading: everything an edge bundle may reach.
 *
 * No `node:` imports, not even types — `test/fetch-entry-purity.test.ts` and
 * `test/edge-bundle-purity.test.ts` gate this module's graph. The disk probe
 * lives in `thread-access-node.ts`.
 */

import type { ThreadAccessResult, ThreadOperation } from "@dawn-ai/sdk"

/**
 * The ONE selection rule, shared by the dynamic loader and (in a later slice)
 * the build probes — a built app can never bind differently than dev.
 * `default` first (nullish falls through), then a named `threadAccess` export.
 *
 * Returns the raw value rather than narrowing it: a non-object default must
 * reach `validateThreadAccessPolicy` so the operator is told what is wrong,
 * not silently treated as "no policy" the way `loadMiddleware` treats it.
 */
export function selectThreadAccessExport(mod: unknown): unknown {
  if (!mod || typeof mod !== "object") return undefined
  const candidate = mod as { readonly default?: unknown; readonly threadAccess?: unknown }
  return candidate.default ?? candidate.threadAccess
}

/** The four candidate paths, in probe precedence order. String concat, not `path.join`. */
export function threadAccessCandidatePaths(appRoot: string): readonly string[] {
  return [
    `${appRoot}/src/thread-access.ts`,
    `${appRoot}/src/thread-access.js`,
    `${appRoot}/thread-access.ts`,
    `${appRoot}/thread-access.js`,
  ]
}

const THREAD_ACCESS_ACTION_KEYS = ["create", "read", "update", "delete"] as const

/**
 * Shape validation of a SELECTED POLICY VALUE — not of a module. Run on both
 * the dynamic path (after `selectThreadAccessExport`) and the manifest path,
 * where export selection never happened because the manifest already holds a
 * policy object. Types are erased across a dynamic import, so `fallback` being
 * required in `ThreadAccessPolicy` is not enforcement — this is.
 *
 * Returns the reason, or undefined when the value is a well-formed policy.
 */
export function validateThreadAccessPolicy(value: unknown): string | undefined {
  if (!value || typeof value !== "object") {
    return "the bound value is not an object"
  }
  const candidate = value as Record<string, unknown>
  if (typeof candidate.fallback !== "function") {
    return "`fallback` is missing or is not a function (it is required so an unhandled action cannot silently allow or silently deny)"
  }
  for (const key of THREAD_ACCESS_ACTION_KEYS) {
    const handler = candidate[key]
    if (handler !== undefined && typeof handler !== "function") {
      return `\`${key}\` is present but is not a function`
    }
  }
  return undefined
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

/**
 * OWN properties only. A hook's return value is data, and an inherited
 * `decision: "allow"` — from a class prototype, or an `Object.create(...)` —
 * is not a decision this policy made. Reading through the chain would let the
 * shape of an unrelated base object decide an authorization outcome.
 */
function own(record: Record<string, unknown>, key: string): unknown {
  return Object.hasOwn(record, key) ? record[key] : undefined
}

function renderValue(value: unknown): string {
  try {
    return JSON.stringify(value) ?? String(value)
  } catch {
    return String(value)
  }
}

/**
 * Normalize a hook's return value. NOT the same as middleware's, on purpose:
 * `runMiddleware` compares `=== "reject"` and falls through to CONTINUE on any
 * other value, so a policy that returned `undefined` (a missing return on one
 * branch) or a stale `{ action: "continue" }` object would silently allow.
 * Here, anything that is not a well-formed allow is a DENY.
 *
 * The deny it returns carries NO status, so `denyResponse` applies the
 * per-action default — 404 on a read, 403 otherwise. Pinning it to 403 would
 * make a broken read policy answer differently from a working one and hand back
 * the enumeration oracle the 404 default closes. The cost — a broken read
 * policy looks like an empty database — is paid by the warn, which is why the
 * warn is per denial rather than once per process.
 *
 * `operation` and `threadId` exist so the warn can name what failed; the value
 * alone is not diagnosable. `threadId` is optional because the policy unit
 * harness has no request to take one from.
 */
export function normalizeThreadAccessResult(
  value: unknown,
  operation: ThreadOperation,
  threadId?: string,
): ThreadAccessResult {
  if (isPlainRecord(value)) {
    const decision = own(value, "decision")
    if (decision === "allow") {
      const stamp = own(value, "stamp")
      if (isPlainRecord(stamp)) return { decision: "allow", stamp }
      if (stamp !== undefined) {
        // Reported, not swallowed: the stamp is the ONE field every later
        // request authorizes against, so dropping it silently turns a policy
        // bug into "this thread was created before the policy existed".
        console.warn(
          `Dawn thread access: the policy for ${operation} on ${threadId ?? "(no thread id)"} returned ` +
            `an allow whose \`stamp\` is not a JSON object, so it was dropped and this thread will carry ` +
            `no access stamp. Received: ${renderValue(stamp)}`,
        )
      }
      return { decision: "allow" }
    }
    if (decision === "deny") {
      const rawStatus = own(value, "status")
      const status = rawStatus === 403 || rawStatus === 404 ? rawStatus : undefined
      const body = own(value, "body")
      return {
        decision: "deny",
        ...(status !== undefined ? { status } : {}),
        ...(body !== undefined ? { body } : {}),
      }
    }
  }
  console.warn(
    `Dawn thread access: the policy for ${operation} on ${threadId ?? "(no thread id)"} returned ` +
      `a value that is neither an allow nor a deny, so the request was denied. Received: ${renderValue(value)}`,
  )
  return { decision: "deny" }
}

/**
 * The one boot line naming where the policy came from — the only signal an
 * operator has that a policy vanished (a stale manifest, or an embedder-built
 * fallback bag with no `loadThreadAccess`).
 *
 * The disk variant names the conventional path rather than the resolved
 * candidate: the runtime core has no filesystem, and the loader hands back only
 * the policy. All four candidate paths therefore report this same line.
 */
export function threadAccessBootLine(source: {
  readonly fromOptions: boolean
  readonly fromManifest: boolean
  readonly resolved: boolean
}): string {
  if (!source.resolved) return "Dawn: no thread access policy (all thread endpoints are open)"
  if (source.fromOptions) return "Dawn: thread access policy bound from the runtime options"
  if (source.fromManifest) return "Dawn: thread access policy bound from the build manifest"
  return "Dawn: thread access policy bound from src/thread-access.ts"
}
