import { realpathSync } from "node:fs"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { BackendContext, FilesystemBackend, FilesystemMiddleware } from "@dawn-ai/workspace"
import { localFilesystem } from "@dawn-ai/workspace"

export interface MiddlewareHarness {
  readonly backend: FilesystemBackend
  readonly ctx: BackendContext
  readonly dir: string
  assertForwardsAll(): void
  close(): Promise<void>
  [Symbol.asyncDispose](): Promise<void>
}

export async function createMiddlewareHarness(
  middleware: FilesystemMiddleware,
): Promise<MiddlewareHarness> {
  const dir = realpathSync(await mkdtemp(join(tmpdir(), "dawn-mw-harness-")))
  const base = localFilesystem()
  const backend = middleware(base)
  const controller = new AbortController()
  const ctx: BackendContext = { signal: controller.signal, workspaceRoot: dir }

  let closed = false
  const close = async (): Promise<void> => {
    if (closed) return
    closed = true
    controller.abort()
    await rm(dir, { force: true, recursive: true })
  }

  return {
    backend,
    ctx,
    dir,
    assertForwardsAll() {
      const baseMethods = Object.keys(base) as Array<keyof FilesystemBackend>
      const missing = baseMethods.filter(
        (method) => typeof base[method] === "function" && typeof backend[method] !== "function",
      )
      if (missing.length > 0) {
        throw new Error(
          `Middleware dropped backend method(s) the base provides: ${missing.join(", ")}. ` +
            "A FilesystemMiddleware must forward every method (required and optional) it does not intercept.",
        )
      }
    },
    close,
    [Symbol.asyncDispose]: close,
  }
}
