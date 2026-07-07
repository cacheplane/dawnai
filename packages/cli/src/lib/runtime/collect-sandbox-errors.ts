import type { DawnConfig } from "@dawn-ai/core"
import type { SandboxProvider } from "@dawn-ai/workspace"

/** Validate the dawn.config.ts sandbox block + run the provider preflight. */
export async function collectSandboxErrors(
  config: Pick<DawnConfig, "sandbox">,
): Promise<{ readonly errors: readonly string[]; readonly warnings: readonly string[] }> {
  const sandbox = config.sandbox
  if (!sandbox) return { errors: [], warnings: [] }
  const errors: string[] = []
  const warnings: string[] = []
  const p = sandbox.provider as Partial<SandboxProvider> | undefined
  if (
    !p ||
    typeof p.acquire !== "function" ||
    typeof p.release !== "function" ||
    typeof p.destroy !== "function"
  ) {
    errors.push(
      `dawn.config sandbox.provider must implement acquire/release/destroy (got: ${p?.name ?? "undefined"}).`,
    )
    return { errors, warnings }
  }
  if (typeof p.preflight === "function") {
    try {
      const result = await p.preflight()
      if (!result.ok) {
        errors.push(
          `Sandbox provider "${p.name}" preflight failed: ${result.detail ?? "unavailable"}.`,
        )
      } else if (result.warnings) {
        warnings.push(...result.warnings)
      }
    } catch (error) {
      errors.push(
        `Sandbox provider "${p.name}" preflight threw: ${error instanceof Error ? error.message : String(error)}.`,
      )
    }
  }
  const sec = sandbox.security
  if (sec) {
    if (sec.pidsLimit !== undefined && (!Number.isInteger(sec.pidsLimit) || sec.pidsLimit <= 0)) {
      errors.push(
        `dawn.config sandbox.security.pidsLimit must be a positive integer (got: ${String(sec.pidsLimit)}).`,
      )
    }
    if (sec.runAsNonRoot === null) {
      errors.push(
        "dawn.config sandbox.security.runAsNonRoot must be a boolean or a { uid, gid } object, not null.",
      )
    } else if (typeof sec.runAsNonRoot === "object") {
      const { uid, gid } = sec.runAsNonRoot
      if (!Number.isInteger(uid) || uid < 0 || !Number.isInteger(gid) || gid < 0) {
        errors.push(
          "dawn.config sandbox.security.runAsNonRoot uid/gid must be non-negative integers.",
        )
      }
    }
  }
  return { errors, warnings }
}
