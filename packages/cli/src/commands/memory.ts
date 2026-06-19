import { resolve } from "node:path"
import type { MemoryStore } from "@dawn-ai/memory"
import type { Command } from "commander"
import { CliError, type CommandIo, writeLine } from "../lib/output.js"
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
  const store = (await resolveMemoryStore(appRoot)) as unknown as MemoryStore

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
      await runApprove(store, id, io)
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

async function runApprove(store: MemoryStore, id: string, io: CommandIo): Promise<void> {
  const rec = await store.get(id)
  if (!rec) throw new CliError(`Record not found: ${id}`, 1)
  if (rec.status !== "candidate") {
    throw new CliError(`Record "${id}" is not a candidate (status: ${rec.status})`, 1)
  }
  await store.update(id, { status: "active", updatedAt: new Date().toISOString() })
  writeLine(io.stdout, `Approved: ${id}`)
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
