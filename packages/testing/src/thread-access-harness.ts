import { normalizeThreadAccessResult } from "@dawn-ai/cli/runtime"
import type {
  ThreadAccessPolicy,
  ThreadAccessRequest,
  ThreadAccessResult,
  ThreadAction,
  ThreadOperation,
  ThreadSubject,
} from "@dawn-ai/sdk"

/** A partial `ThreadAccessRequest`: only `action` is required. */
export interface ThreadAccessCheckSpec {
  readonly action: ThreadAction
  /** Defaults to the canonical operation for the action. */
  readonly operation?: ThreadOperation
  readonly threadId?: string
  readonly thread?: ThreadSubject
  readonly headers?: Readonly<Record<string, string>>
  readonly method?: string
  readonly url?: string
  readonly requestedMetadata?: Readonly<Record<string, unknown>>
}

export interface ThreadAccessHarness {
  /**
   * Run one request through the policy exactly as the runtime would: the same
   * `handler ?? fallback` selection, and the same result normalization — so a
   * handler that returns nothing on some branch denies here too.
   */
  check(spec: ThreadAccessCheckSpec): Promise<ThreadAccessResult>
}

const DEFAULT_OPERATION: Readonly<Record<ThreadAction, ThreadOperation>> = {
  create: "thread.create",
  delete: "thread.delete",
  read: "thread.get",
  update: "thread.cancel",
}

function defaultMethod(action: ThreadAction): string {
  if (action === "read") return "GET"
  if (action === "delete") return "DELETE"
  return "POST"
}

/**
 * Unit-test a thread access policy without booting a server.
 *
 * `createAgentHarness` is blind to policies by construction — it drives
 * `streamResolvedRoute` directly, takes no run slot and writes no threads-store
 * row — so this and `createAgentProtocolInjector({ threadAccess })` are the two
 * surfaces that make a policy testable.
 */
export function createThreadAccessHarness(options: {
  readonly policy: ThreadAccessPolicy
}): ThreadAccessHarness {
  return {
    async check(spec) {
      const operation = spec.operation ?? DEFAULT_OPERATION[spec.action]
      const request: ThreadAccessRequest = {
        action: spec.action,
        headers: spec.headers ?? {},
        method: spec.method ?? defaultMethod(spec.action),
        operation,
        requestedMetadata: spec.requestedMetadata,
        thread: spec.thread,
        threadId: spec.threadId,
        url: spec.url ?? (spec.threadId ? `/threads/${spec.threadId}` : "/threads"),
      }
      const handler = options.policy[spec.action] ?? options.policy.fallback
      return normalizeThreadAccessResult(await handler(request), operation, spec.threadId)
    },
  }
}
