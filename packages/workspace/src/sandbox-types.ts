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
    /** Per-thread workspace volume size in GiB (PVC providers, e.g. Kubernetes). Docker ignores it. */
    readonly diskGb?: number
  }
  readonly security?: SandboxSecurityPolicy
}

/**
 * Provider-agnostic hardening intent. Each provider translates these to its own
 * mechanism; a field left unset means the provider applies its SECURE default
 * (all of these default ON/hardened at the Docker provider). Authors relax
 * explicitly. See the sandbox-hardening spec.
 */
export interface SandboxSecurityPolicy {
  /** Drop all Linux capabilities. Secure default: true. */
  readonly dropAllCapabilities?: boolean
  /** Block setuid/setgid privilege escalation. Secure default: true. */
  readonly noNewPrivileges?: boolean
  /** Immutable root filesystem (workspace + scratch stay writable). Secure default: true. */
  readonly readOnlyRootFilesystem?: boolean
  /** Run as non-root. Secure default: true → uid/gid 1000:1000. `false` = image default (often root). */
  readonly runAsNonRoot?: boolean | { readonly uid: number; readonly gid: number }
  /** Max process count (fork-bomb defense). Secure default: 512. */
  readonly pidsLimit?: number
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
  /** Optional availability probe surfaced by `dawn check`. `warnings` are non-fatal notes (e.g. best-effort enforcement). */
  preflight?(): Promise<{
    readonly ok: boolean
    readonly detail?: string
    readonly warnings?: readonly string[]
  }>
}

export interface SandboxConfig {
  readonly provider: SandboxProvider
  readonly network?: SandboxPolicy["network"]
  readonly env?: SandboxPolicy["env"]
  readonly resources?: SandboxPolicy["resources"]
  readonly security?: SandboxSecurityPolicy
  /** Manager-level idle reap window. Default 600_000 (10 min). */
  readonly idleTimeoutMs?: number
}
