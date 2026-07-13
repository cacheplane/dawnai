import type { DawnErrorCode } from "@dawn-ai/sdk"
import type { SandboxProvider } from "@dawn-ai/workspace"

/**
 * Minimum Node version Dawn requires at runtime. Below this, `node:sqlite`
 * (used by @dawn-ai/sqlite-storage / @dawn-ai/memory) needs an experimental
 * flag and breaks. This check must not itself require Node ≥ floor to run —
 * it is a pure string compare with no `node:sqlite` import.
 */
const NODE_FLOOR = "22.13.0"

export interface RuntimeCheckResult {
  readonly name: "runtime"
  readonly node: {
    readonly version: string
    readonly ok: boolean
    readonly floor: string
    /** Present only when `ok` is false — DAWN_E5101 (Node below the supported floor). */
    readonly code?: DawnErrorCode
  }
  /** Present only when a sandbox provider is configured. */
  readonly docker?: {
    readonly ok: boolean
    readonly detail: string
    /** Present only when `ok` is false — DAWN_E2002 (sandbox preflight failed). */
    readonly code?: DawnErrorCode
  }
  readonly status: "passed" | "warning" | "failed"
}

function parseVersion(version: string): readonly [number, number, number] {
  const parts = version.split(".")
  const major = Number.parseInt(parts[0] ?? "", 10)
  const minor = Number.parseInt(parts[1] ?? "", 10)
  const patch = Number.parseInt(parts[2] ?? "", 10)
  return [
    Number.isNaN(major) ? 0 : major,
    Number.isNaN(minor) ? 0 : minor,
    Number.isNaN(patch) ? 0 : patch,
  ]
}

/** Pure numeric MAJOR.MINOR.PATCH comparison: is `a` ≥ `b`? No deps. */
export function gte(a: string, b: string): boolean {
  const [aMajor, aMinor, aPatch] = parseVersion(a)
  const [bMajor, bMinor, bPatch] = parseVersion(b)
  if (aMajor !== bMajor) return aMajor > bMajor
  if (aMinor !== bMinor) return aMinor > bMinor
  return aPatch >= bPatch
}

export async function checkRuntime(input: {
  readonly nodeVersion?: string
  readonly sandboxProvider?: Pick<SandboxProvider, "preflight" | "name">
}): Promise<RuntimeCheckResult> {
  const version = input.nodeVersion ?? process.versions.node
  const nodeOk = gte(version, NODE_FLOOR)
  const node: RuntimeCheckResult["node"] = {
    version,
    ok: nodeOk,
    floor: NODE_FLOOR,
    ...(nodeOk ? {} : { code: "DAWN_E5101" as const }),
  }

  let docker: RuntimeCheckResult["docker"]
  if (input.sandboxProvider?.preflight) {
    // Reuse the provider preflight contract ({ ok, detail?, warnings? }) — the
    // same one `dawn check` runs via collect-sandbox-errors. Surface detail verbatim.
    const result = await input.sandboxProvider.preflight()
    docker = {
      ok: result.ok,
      detail: result.detail ?? (result.ok ? "reachable" : "unreachable"),
      ...(result.ok ? {} : { code: "DAWN_E2002" as const }),
    }
  }

  const failed = !nodeOk || docker?.ok === false
  return {
    name: "runtime",
    node,
    ...(docker ? { docker } : {}),
    status: failed ? "failed" : "passed",
  }
}
