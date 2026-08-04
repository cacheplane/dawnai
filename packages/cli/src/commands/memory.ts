import { existsSync } from "node:fs"
import { join, resolve } from "node:path"
import { discoverRoutes } from "@dawn-ai/core"
import {
  approveWithReconcile,
  type MemoryStore,
  parseNamespace,
  routeNamespaceKey,
} from "@dawn-ai/memory"
import type { Command } from "commander"
import { CliError, type CommandIo, formatErrorMessage, writeLine } from "../lib/output.js"
import { loadRouteMemory } from "../lib/runtime/load-memory.js"
import { resolveMemoryStore } from "../lib/runtime/resolve-memory.js"

interface MemoryOptions {
  readonly cwd?: string
}

const USAGE =
  "dawn memory <subcommand> [args]\n  subcommands: list, search <query>, inspect <id>, approve <id>, reject <id>, forget <id>"

export function registerMemoryCommand(program: Command, io: CommandIo): void {
  program
    .command("memory [subcommand] [args...]")
    .description("Inspect and manage the Dawn app's long-term memory store")
    .option("--cwd <path>", "Path to the Dawn app root")
    .action(async (subcommand: string | undefined, args: string[], options: MemoryOptions) => {
      const argv = subcommand ? [subcommand, ...args] : []
      await runMemoryCommand(argv, options, io)
    })
}

export async function runMemoryCommand(
  argv: readonly string[],
  options: MemoryOptions,
  io: CommandIo,
): Promise<void> {
  const subcommand = argv[0]

  if (!subcommand) {
    throw new CliError(`Missing subcommand.\n${USAGE}`, 1)
  }

  const appRoot = options.cwd ? resolve(options.cwd) : process.cwd()
  const store = await resolveMemoryStore(appRoot)

  switch (subcommand) {
    case "list": {
      await runList(store, io)
      break
    }
    case "search": {
      const query = argv[1]
      if (!query) throw new CliError("Usage: dawn memory search <query>", 1)
      await runSearch(store, query, io)
      break
    }
    case "inspect": {
      const id = argv[1]
      if (!id) throw new CliError("Usage: dawn memory inspect <id>", 1)
      await runInspect(store, id, io)
      break
    }
    case "approve": {
      const id = argv[1]
      if (!id) throw new CliError("Usage: dawn memory approve <id>", 1)
      await runApprove(store, appRoot, id, io)
      break
    }
    case "reject": {
      const id = argv[1]
      if (!id) throw new CliError("Usage: dawn memory reject <id>", 1)
      await runReject(store, id, io)
      break
    }
    case "forget": {
      const id = argv[1]
      if (!id) throw new CliError("Usage: dawn memory forget <id>", 1)
      await runForget(store, id, io)
      break
    }
    default: {
      throw new CliError(`Unknown subcommand: "${subcommand}".\n${USAGE}`, 1)
    }
  }
}

async function runList(store: MemoryStore, io: CommandIo): Promise<void> {
  const candidates = await store.listCandidates("")
  if (candidates.length === 0) {
    writeLine(io.stdout, "No candidate records found.")
    return
  }
  for (const rec of candidates) {
    writeLine(io.stdout, formatRecord(rec))
  }
}

async function runSearch(store: MemoryStore, query: string, io: CommandIo): Promise<void> {
  const candidates = await store.listCandidates("")
  const lower = query.toLowerCase()
  const matches = candidates.filter(
    (r) => r.content.toLowerCase().includes(lower) || r.namespace.toLowerCase().includes(lower),
  )
  if (matches.length === 0) {
    writeLine(io.stdout, `No records matching "${query}".`)
    return
  }
  for (const rec of matches) {
    writeLine(io.stdout, formatRecord(rec))
  }
}

async function runInspect(store: MemoryStore, id: string, io: CommandIo): Promise<void> {
  const rec = await store.get(id)
  if (!rec) throw new CliError(`Record not found: ${id}`, 1)
  writeLine(io.stdout, JSON.stringify(rec, null, 2))
}

async function runApprove(
  store: MemoryStore,
  appRoot: string,
  id: string,
  io: CommandIo,
): Promise<void> {
  const rec = await store.get(id)
  if (!rec) throw new CliError(`Record not found: ${id}`, 1)
  if (rec.status !== "candidate") {
    throw new CliError(`Record "${id}" is not a candidate (status: ${rec.status})`, 1)
  }
  const identity = await resolveIdentityKeys(appRoot, rec.namespace)
  const res = await approveWithReconcile(store, id, {
    identityKeys: identity.keys,
    now: new Date().toISOString(),
  })
  writeLine(io.stdout, `approved ${res.approved.id} (${res.action})`)
  for (const old of res.superseded) writeLine(io.stdout, `superseded ${old.id}`)
  if (identity.fallback) {
    writeLine(
      io.stdout,
      "note: route memory.ts not found for namespace; used default identity [subject, predicate]",
    )
  }
}

/**
 * Resolve the identity keys governing supersede reconciliation for a record's
 * namespace: find the route whose namespace key matches, load its memory.ts,
 * and use its declared `identity`. Falls back to [subject, predicate] when the
 * route (or its memory.ts) cannot be resolved.
 */
async function resolveIdentityKeys(
  appRoot: string,
  namespace: string,
): Promise<{ keys: readonly string[]; fallback: boolean }> {
  const DEFAULT = ["subject", "predicate"] as const
  const routeKey = parseNamespace(namespace).route
  if (!routeKey) return { keys: DEFAULT, fallback: true }
  let manifest: Awaited<ReturnType<typeof discoverRoutes>>
  try {
    manifest = await discoverRoutes({ appRoot })
  } catch {
    // No dawn.config.ts / unreadable app — fall back to the default.
    return { keys: DEFAULT, fallback: true }
  }
  for (const route of manifest.routes) {
    if (routeNamespaceKey(route.pathname) !== routeKey) continue
    const memoryFile = join(route.routeDir, "memory.ts")
    if (!existsSync(memoryFile)) break
    // A memory.ts that EXISTS but fails to load must NOT silently fall back to
    // the default identity keys — wrong keys could miss or mis-target a
    // supersede. Surface the load failure instead.
    try {
      const def = await loadRouteMemory(memoryFile)
      return { keys: def.identity ?? DEFAULT, fallback: false }
    } catch (cause) {
      throw new CliError(`Failed to load ${memoryFile}: ${formatErrorMessage(cause)}`, 1, { cause })
    }
  }
  return { keys: DEFAULT, fallback: true }
}

async function runReject(store: MemoryStore, id: string, io: CommandIo): Promise<void> {
  const rec = await store.get(id)
  if (!rec) throw new CliError(`Record not found: ${id}`, 1)
  await store.delete(id)
  writeLine(io.stdout, `Rejected and deleted: ${id}`)
}

async function runForget(store: MemoryStore, id: string, io: CommandIo): Promise<void> {
  const rec = await store.get(id)
  if (!rec) throw new CliError(`Record not found: ${id}`, 1)
  await store.delete(id)
  writeLine(io.stdout, `Forgotten: ${id}`)
}

function formatRecord(rec: {
  id: string
  status: string
  namespace: string
  content: string
}): string {
  return `${rec.id} [${rec.status}] ${rec.namespace} — ${rec.content}`
}
