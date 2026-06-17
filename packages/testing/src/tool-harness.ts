import type { PermissionsStore } from "@dawn-ai/permissions"
import type { DawnToolContext } from "@dawn-ai/sdk"
import { createWorkspaceHarness, type WorkspaceHarness } from "./workspace-harness.js"

export interface ToolHarness<I, O> {
  invoke(input: I): Promise<O>
  readonly workspace: WorkspaceHarness
  close(): Promise<void>
  [Symbol.asyncDispose](): Promise<void>
}

export interface ToolHarnessOptions {
  readonly middleware?: Readonly<Record<string, unknown>>
  readonly workspace?: WorkspaceHarness
  readonly permissions?: PermissionsStore
}

export async function createToolHarness<I, O>(
  tool: (input: I, ctx: DawnToolContext) => Promise<O> | O,
  opts?: ToolHarnessOptions,
): Promise<ToolHarness<I, O>> {
  const ownsWorkspace = opts?.workspace === undefined
  const workspace =
    opts?.workspace ??
    (await createWorkspaceHarness(
      opts?.permissions ? { permissions: opts.permissions } : undefined,
    ))
  const controller = new AbortController()

  const close = async (): Promise<void> => {
    controller.abort()
    if (ownsWorkspace) await workspace.close()
  }

  return {
    async invoke(input) {
      const ctx: DawnToolContext = {
        signal: controller.signal,
        fs: workspace.fs,
        ...(opts?.middleware ? { middleware: opts.middleware } : {}),
      }
      return await tool(input, ctx)
    },
    workspace,
    close,
    [Symbol.asyncDispose]: close,
  }
}
