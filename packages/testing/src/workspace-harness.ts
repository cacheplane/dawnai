import { realpathSync } from "node:fs"
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { createWorkspaceFs } from "@dawn-ai/core"
import type { PermissionsStore } from "@dawn-ai/permissions"
import type { WorkspaceFs } from "@dawn-ai/sdk"
import { localFilesystem } from "@dawn-ai/workspace"

export interface WorkspaceHarness {
  readonly fs: WorkspaceFs
  readonly dir: string
  read(path: string): Promise<string>
  write(path: string, content: string): Promise<void>
  close(): Promise<void>
  [Symbol.asyncDispose](): Promise<void>
}

export interface WorkspaceHarnessOptions {
  readonly permissions?: PermissionsStore
}

export async function createWorkspaceHarness(
  opts?: WorkspaceHarnessOptions,
): Promise<WorkspaceHarness> {
  const root = await mkdtemp(join(tmpdir(), "dawn-ws-harness-"))
  const workspaceRoot = join(root, "workspace")
  await mkdir(workspaceRoot, { recursive: true })
  // Gate canonicalizes the root; realpath so inside-paths classify correctly.
  const canonicalRoot = realpathSync(workspaceRoot)
  const controller = new AbortController()
  const fs = createWorkspaceFs({
    workspaceRoot: canonicalRoot,
    backend: localFilesystem(),
    permissions: opts?.permissions,
    signal: controller.signal,
    interruptCapable: false,
  })

  let closed = false
  const close = async (): Promise<void> => {
    if (closed) return
    closed = true
    controller.abort()
    await rm(root, { force: true, recursive: true })
  }

  return {
    fs,
    dir: canonicalRoot,
    async read(path) {
      return await readFile(join(canonicalRoot, path), "utf8")
    },
    async write(path, content) {
      const abs = join(canonicalRoot, path)
      await mkdir(dirname(abs), { recursive: true })
      await writeFile(abs, content, "utf8")
    },
    close,
    [Symbol.asyncDispose]: close,
  }
}
