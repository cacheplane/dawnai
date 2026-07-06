import { loadDawnConfig } from "@dawn-ai/core"
import type { SandboxConfig, SandboxPolicy } from "@dawn-ai/workspace"
import { SandboxManager } from "./sandbox-manager.js"

const DEFAULT_IDLE_MS = 600_000
const DEFAULT_NETWORK: SandboxPolicy["network"] = { mode: "allow", denylist: ["169.254.169.254"] }

/** Build the per-server SandboxManager from dawn.config.ts, or undefined if unconfigured. */
export async function resolveSandboxManager(appRoot: string): Promise<SandboxManager | undefined> {
  let sandbox: SandboxConfig | undefined
  try {
    const loaded = await loadDawnConfig({ appRoot })
    sandbox = loaded.config.sandbox
  } catch {
    return undefined
  }
  if (!sandbox) return undefined
  const policy: SandboxPolicy = {
    network: sandbox.network ?? DEFAULT_NETWORK,
    ...(sandbox.env ? { env: sandbox.env } : {}),
    ...(sandbox.resources ? { resources: sandbox.resources } : {}),
    ...(sandbox.security ? { security: sandbox.security } : {}),
  }
  return new SandboxManager({
    provider: sandbox.provider,
    policy,
    idleTimeoutMs: sandbox.idleTimeoutMs ?? DEFAULT_IDLE_MS,
  })
}
