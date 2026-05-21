/**
 * Public types for the Dawn HITL permissions system.
 *
 * The workspace capability calls into a `PermissionsStore` before
 * invoking its filesystem/exec backends. The store consults the
 * runtime file at .dawn/permissions.json plus the config-seeded
 * allow/deny lists and returns one of three decisions: "allow",
 * "deny", or "unknown". On "unknown" in interactive mode the
 * capability emits LangGraph's `interrupt()` with a `PermissionRequest`
 * payload; the resume mechanism returns a `PermissionDecision`.
 */

export type PermissionMode = "interactive" | "non-interactive" | "bypass"

export type PermissionDecision = "once" | "always" | "deny"

export interface PermissionsFile {
  readonly version: 1
  readonly allow: Readonly<Record<string, readonly string[]>>
  readonly deny: Readonly<Record<string, readonly string[]>>
}

export interface CommandDetail {
  readonly command: string
  readonly suggestedPattern: string
}

export interface PathDetail {
  readonly path: string
  readonly operation: "readFile" | "writeFile" | "listDir"
  readonly suggestedPattern: string
}

export interface PermissionRequest {
  readonly interruptId: string
  readonly kind: "command" | "path"
  readonly detail: CommandDetail | PathDetail
  readonly threadId: string
  readonly callId?: string
}

export interface PermissionsStore {
  /** Loaded once at construction; subsequent loads not exposed in v1. */
  load(): Promise<void>
  match(tool: string, candidate: string): "allow" | "deny" | "unknown"
  /** Persists an allow entry to disk and updates the in-memory cache. */
  addAllow(tool: string, pattern: string): Promise<void>
  /** Active mode (resolved from config + env at construction). */
  readonly mode: PermissionMode
}
