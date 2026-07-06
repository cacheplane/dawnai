/**
 * Execution-sandbox contract. A SandboxProvider yields, per conversation
 * thread, a SandboxHandle whose filesystem/exec backends implement the same
 * interfaces the workspace capability already consumes — so swapping them in
 * redirects all of readFile/writeFile/listDir/runBash into the isolated env
 * with no change to the capability. See the execution-sandbox spec.
 */
import type { ExecBackend, FilesystemBackend } from "./types.js"

export interface SandboxPolicy {
  readonly network:
    | { readonly mode: "allow"; readonly denylist?: readonly string[] }
    | { readonly mode: "deny"; readonly allowlist?: readonly string[] }
  /** Explicit env injected into the sandbox. The host env is NEVER inherited. */
  readonly env?: Readonly<Record<string, string>>
  readonly resources?: {
    readonly memoryMb?: number
    readonly cpus?: number
    readonly timeoutMs?: number
  }
}

export interface SandboxHandle {
  readonly threadId: string
  readonly filesystem: FilesystemBackend
  readonly exec: ExecBackend
  /** Absolute path of the workspace root INSIDE the sandbox, e.g. "/workspace". */
  readonly workspaceRoot: string
}

export interface SandboxProvider {
  readonly name: string
  /**
   * Create-or-reattach the thread's sandbox. Idempotent per threadId: called at
   * the start of every turn; returns the same live sandbox across turns until
   * release()/destroy(). Reattaches an existing workspace volume by deterministic
   * name after a restart or container reap rather than starting empty.
   */
  acquire(input: {
    readonly threadId: string
    readonly policy: SandboxPolicy
    readonly signal: AbortSignal
  }): Promise<SandboxHandle>
  /** Drop warm compute but KEEP the workspace volume (idle-reap + shutdown). */
  release(threadId: string): Promise<void>
  /** Destroy the sandbox AND its workspace volume (thread delete). */
  destroy(threadId: string): Promise<void>
  /** Optional availability probe surfaced by `dawn check`. */
  preflight?(): Promise<{ readonly ok: boolean; readonly detail?: string }>
}

export interface SandboxConfig {
  readonly provider: SandboxProvider
  readonly network?: SandboxPolicy["network"]
  readonly env?: SandboxPolicy["env"]
  readonly resources?: SandboxPolicy["resources"]
  /** Manager-level idle reap window. Default 600_000 (10 min). */
  readonly idleTimeoutMs?: number
}
