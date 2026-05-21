import { existsSync } from "node:fs"
import { mkdir, readFile, writeFile } from "node:fs/promises"
import { join } from "node:path"

import { matchPermission } from "./pattern-matching.js"
import type { PermissionMode, PermissionsFile, PermissionsStore } from "./types.js"

const PERMISSIONS_DIR = ".dawn"
const PERMISSIONS_FILE = "permissions.json"

interface CreateOptions {
  readonly appRoot: string
  readonly config: PermissionsFile | undefined
  readonly mode: PermissionMode
}

type MutableMap = Record<string, string[]>

interface State {
  configAllow: MutableMap
  configDeny: MutableMap
  runtimeAllow: MutableMap
  runtimeDeny: MutableMap
}

function emptyState(): State {
  return { configAllow: {}, configDeny: {}, runtimeAllow: {}, runtimeDeny: {} }
}

function cloneMap(src: Readonly<Record<string, readonly string[]>>): MutableMap {
  const out: MutableMap = {}
  for (const [k, v] of Object.entries(src)) out[k] = [...v]
  return out
}

function effectiveAllow(state: State, mode: PermissionMode): Record<string, string[]> {
  if (mode === "bypass") return {}
  const out: Record<string, string[]> = {}
  for (const [k, v] of Object.entries(state.configAllow)) out[k] = [...v]
  if (mode === "interactive") {
    for (const [k, v] of Object.entries(state.runtimeAllow)) {
      out[k] = [...(out[k] ?? []), ...v]
    }
  }
  return out
}

function effectiveDeny(state: State, mode: PermissionMode): Record<string, string[]> {
  if (mode === "bypass") return {}
  const out: Record<string, string[]> = {}
  for (const [k, v] of Object.entries(state.configDeny)) out[k] = [...v]
  if (mode === "interactive") {
    for (const [k, v] of Object.entries(state.runtimeDeny)) {
      out[k] = [...(out[k] ?? []), ...v]
    }
  }
  return out
}

export function createPermissionsStore(opts: CreateOptions): PermissionsStore {
  const { appRoot, config, mode } = opts
  const state = emptyState()
  if (config) {
    state.configAllow = cloneMap(config.allow)
    state.configDeny = cloneMap(config.deny)
  }

  let writeQueue: Promise<void> = Promise.resolve()

  async function loadRuntimeFile(): Promise<void> {
    const filePath = join(appRoot, PERMISSIONS_DIR, PERMISSIONS_FILE)
    if (!existsSync(filePath)) return
    let raw: string
    try {
      raw = await readFile(filePath, "utf8")
    } catch (err) {
      throw new Error(`Failed to read permissions.json: ${(err as Error).message}`)
    }
    let parsed: unknown
    try {
      parsed = JSON.parse(raw)
    } catch (err) {
      throw new Error(`Malformed permissions.json: ${(err as Error).message}`)
    }
    const p = parsed as Partial<PermissionsFile>
    if (p.allow && typeof p.allow === "object") {
      state.runtimeAllow = cloneMap(p.allow as Record<string, readonly string[]>)
    }
    if (p.deny && typeof p.deny === "object") {
      state.runtimeDeny = cloneMap(p.deny as Record<string, readonly string[]>)
    }
  }

  async function persistRuntimeFile(): Promise<void> {
    const dir = join(appRoot, PERMISSIONS_DIR)
    await mkdir(dir, { recursive: true })
    const file: PermissionsFile = {
      version: 1,
      allow: state.runtimeAllow,
      deny: state.runtimeDeny,
    }
    await writeFile(join(dir, PERMISSIONS_FILE), `${JSON.stringify(file, null, 2)}\n`, "utf8")
  }

  async function ensureGitignoreEntry(): Promise<void> {
    const gitignorePath = join(appRoot, ".gitignore")
    let content = ""
    if (existsSync(gitignorePath)) {
      content = await readFile(gitignorePath, "utf8")
      if (content.split("\n").some((line) => line.trim() === ".dawn/")) return
      if (!content.endsWith("\n") && content.length > 0) content += "\n"
      content += ".dawn/\n"
    } else {
      content = ".dawn/\n"
    }
    await writeFile(gitignorePath, content, "utf8")
  }

  return {
    mode,
    match(tool: string, candidate: string) {
      return matchPermission(
        tool,
        candidate,
        effectiveAllow(state, mode),
        effectiveDeny(state, mode),
      )
    },
    async load() {
      if (mode === "interactive") {
        await loadRuntimeFile()
      }
    },
    async addAllow(tool: string, pattern: string) {
      const job = async () => {
        const list = state.runtimeAllow[tool] ?? []
        if (!list.includes(pattern)) list.push(pattern)
        state.runtimeAllow[tool] = list
        await persistRuntimeFile()
        await ensureGitignoreEntry()
      }
      writeQueue = writeQueue.then(job, job)
      await writeQueue
    },
  }
}
