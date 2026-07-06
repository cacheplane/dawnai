import type { DawnConfig } from "@dawn-ai/core"
import type { SandboxProvider } from "@dawn-ai/workspace"

/** Validate the dawn.config.ts sandbox block + run the provider preflight. */
export async function collectSandboxErrors(
  config: Pick<DawnConfig, "sandbox">,
): Promise<readonly string[]> {
  const sandbox = config.sandbox
  if (!sandbox) return []
  const errors: string[] = []
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
    return errors
  }
  if (typeof p.preflight === "function") {
    try {
      const result = await p.preflight()
      if (!result.ok) {
        errors.push(
          `Sandbox provider "${p.name}" preflight failed: ${result.detail ?? "unavailable"}.`,
        )
      }
    } catch (error) {
      errors.push(
        `Sandbox provider "${p.name}" preflight threw: ${error instanceof Error ? error.message : String(error)}.`,
      )
    }
  }
  return errors
}
