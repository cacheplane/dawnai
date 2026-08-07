import { resolve } from "node:path"
import { approveWithReconcile, type MemoryStore } from "@dawn-ai/memory"
import type { ModelProviderId } from "@dawn-ai/sdk"
import { inferProvider } from "@dawn-ai/sdk"
import type { Command } from "commander"
import {
  type DistillResult,
  type ModelLike,
  runConsolidation,
  runReflection,
} from "../lib/memory/distill.js"
import { CliError, type CommandIo, writeLine } from "../lib/output.js"
import { resolveIdentityKeys } from "../lib/runtime/resolve-identity.js"
import {
  type ResolvedDistillConfig,
  resolveDistillConfig,
  resolveEpisodesConfig,
  resolveMemoryStore,
} from "../lib/runtime/resolve-memory.js"

interface MemoryOptions {
  readonly cwd?: string
}

const DISTILL_FLAGS =
  "[--dry-run] [--namespace <prefix>] [--model <id>] [--provider <id>] [--max-batches <n>]"

const USAGE = [
  "dawn memory <subcommand> [args]",
  "  subcommands: list, search <query>, inspect <id>, approve <id>, reject <id>, forget <id>,",
  "               prune [--cap <n>] [--namespace <prefix>],",
  `               consolidate ${DISTILL_FLAGS},`,
  `               reflect ${DISTILL_FLAGS}`,
].join("\n")

export function registerMemoryCommand(program: Command, io: CommandIo): void {
  program
    .command("memory [subcommand] [args...]")
    .description("Inspect and manage the Dawn app's long-term memory store")
    .option("--cwd <path>", "Path to the Dawn app root")
    // The subcommands own their flags (`prune --cap`, `consolidate --dry-run`, …) and
    // parse them out of `args`. Without this, commander claims every `--flag` after the
    // subcommand for itself and rejects it as an unknown option before the handler runs,
    // which made EVERY documented subcommand flag unusable from the real CLI.
    .passThroughOptions()
    // Commander only knows about `--cwd`, so `dawn memory --help` listed no subcommands
    // at all — `consolidate`, `reflect` and every subcommand flag were discoverable only
    // by triggering the error paths below. Same text, now reachable the obvious way.
    .addHelpText("after", `\n${USAGE}`)
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
    case "prune": {
      await runPrune(store, appRoot, argv.slice(1), io)
      break
    }
    case "consolidate":
    case "reflect": {
      await runDistill(store, appRoot, subcommand, argv.slice(1), io)
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

async function runReject(store: MemoryStore, id: string, io: CommandIo): Promise<void> {
  const rec = await store.get(id)
  if (!rec) throw new CliError(`Record not found: ${id}`, 1)
  await store.delete(id)
  writeLine(io.stdout, `Rejected and deleted: ${id}`)
}

async function runPrune(
  store: MemoryStore,
  appRoot: string,
  args: readonly string[],
  io: CommandIo,
): Promise<void> {
  const usage = "Usage: dawn memory prune [--cap <n>] [--namespace <prefix>]"
  let cap: number | undefined
  let namespacePrefix: string | undefined
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]
    if (arg === "--cap") {
      const raw = args[++i]
      if (raw === undefined) throw new CliError(`Missing value for --cap.\n${usage}`, 1)
      const parsed = Number(raw)
      if (!Number.isFinite(parsed) || parsed < 0) {
        throw new CliError(`Invalid --cap value: "${raw}" (expected a number >= 0).\n${usage}`, 1)
      }
      cap = parsed
    } else if (arg === "--namespace") {
      const raw = args[++i]
      if (raw === undefined) throw new CliError(`Missing value for --namespace.\n${usage}`, 1)
      namespacePrefix = raw
    } else {
      throw new CliError(`Unknown argument: "${arg}".\n${usage}`, 1)
    }
  }
  // No --cap → enforce the app's resolved episodic cap (memory.episodes.cap,
  // default 500) so the manual retention pass matches the documented default.
  const effectiveCap = cap ?? (await resolveEpisodesConfig(appRoot)).cap
  const res = await store.prune({
    now: new Date().toISOString(),
    cap: effectiveCap,
    ...(namespacePrefix !== undefined ? { namespacePrefix } : {}),
  })
  writeLine(io.stdout, `pruned: ${res.deletedExpired} expired, ${res.deletedOverCap} over-cap`)
}

/**
 * `dawn memory consolidate` / `dawn memory reflect` — the two distillation
 * passes. Both are threshold-aware no-ops (safe for cron), share the same flags,
 * and spend model tokens only when there is something to distill.
 */
async function runDistill(
  store: MemoryStore,
  appRoot: string,
  command: "consolidate" | "reflect",
  args: readonly string[],
  io: CommandIo,
): Promise<void> {
  const usage = `Usage: dawn memory ${command} ${DISTILL_FLAGS}`
  let dryRun = false
  let namespacePrefix: string | undefined
  let model: string | undefined
  let provider: string | undefined
  let maxBatches: number | undefined
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]
    if (arg === "--dry-run") {
      dryRun = true
    } else if (arg === "--namespace") {
      const raw = args[++i]
      if (raw === undefined) throw new CliError(`Missing value for --namespace.\n${usage}`, 1)
      namespacePrefix = raw
    } else if (arg === "--model") {
      // Overriding the model also moves the provider WITH it, unless the app
      // authored `memory.distill.provider` or `--provider` is given (see
      // `selectProvider`) — a Claude model id must never reach ChatOpenAI.
      const raw = args[++i]
      if (raw === undefined) throw new CliError(`Missing value for --model.\n${usage}`, 1)
      if (raw.trim() === "") {
        throw new CliError(`Invalid --model value: "${raw}" (expected a model id).\n${usage}`, 1)
      }
      model = raw
    } else if (arg === "--provider") {
      // The last resort when inference cannot help: custom/OpenAI-compatible
      // endpoints. Validated for shape only — `resolveProvider` owns the
      // supported-id check, and it runs lazily at model-construction time.
      const raw = args[++i]
      if (raw === undefined) throw new CliError(`Missing value for --provider.\n${usage}`, 1)
      if (raw.trim() === "") {
        throw new CliError(
          `Invalid --provider value: "${raw}" (expected a provider id).\n${usage}`,
          1,
        )
      }
      provider = raw
    } else if (arg === "--max-batches") {
      const raw = args[++i]
      if (raw === undefined) throw new CliError(`Missing value for --max-batches.\n${usage}`, 1)
      const parsed = Number(raw)
      if (!Number.isFinite(parsed) || parsed < 0) {
        throw new CliError(
          `Invalid --max-batches value: "${raw}" (expected a number >= 0).\n${usage}`,
          1,
        )
      }
      maxBatches = parsed
    } else {
      throw new CliError(`Unknown argument: "${arg}".\n${usage}`, 1)
    }
  }

  const resolved = await resolveDistillConfig(appRoot)
  const config: ResolvedDistillConfig = {
    ...resolved,
    ...(model !== undefined ? { model } : {}),
    ...(maxBatches !== undefined ? { maxBatches } : {}),
    provider: selectProvider(resolved, model, provider),
  }

  const run = command === "consolidate" ? runConsolidation : runReflection
  const result: DistillResult = await run({
    store,
    config,
    now: new Date().toISOString(),
    io,
    ...(dryRun ? { dryRun: true } : {}),
    ...(namespacePrefix !== undefined ? { namespacePrefix } : {}),
    // Lazy on purpose: nothing to distill → no provider resolution, no chat
    // model, no API key required. The cron no-op stays free and offline.
    createModel: () => createDistillModel(config),
  })

  if (result.batches > 0 || result.failed > 0) {
    writeLine(
      io.stdout,
      `${command}: ${result.batches} batch(es), ${result.written} written, ${result.failed} failed`,
    )
  }
  // Reported AFTER the per-batch lines the engine already printed — partial
  // progress is visible, and the non-zero exit still tells cron something broke.
  if (result.failed > 0) {
    throw new CliError(
      `${command} finished with ${result.failed} failed batch(es) — see the errors above.`,
      1,
    )
  }
}

/**
 * Which provider the distillation model is built with, in precedence order:
 *
 *  1. `--provider` — an explicit instruction, and the only escape hatch when
 *     inference cannot help (custom or OpenAI-compatible endpoints).
 *  2. An AUTHORED `memory.distill.provider` — a deliberate choice in the app's
 *     config, so `--model` may retarget the model id without silently moving
 *     the provider out from under it.
 *  3. Inference from the `--model` id — because the config's provider was
 *     itself only inferred from the CONFIGURED model, and that inference stops
 *     being valid the moment a different model is requested. Falls back to the
 *     resolved provider when the flag's id is unknown to `inferProvider` (a
 *     local/proxy id keeps working; `--provider` covers the rest).
 *  4. The resolved config provider — no flags, nothing to reconsider.
 */
function selectProvider(
  resolved: ResolvedDistillConfig,
  modelFlag: string | undefined,
  providerFlag: string | undefined,
): ModelProviderId {
  if (providerFlag !== undefined) return providerFlag
  if (modelFlag === undefined || resolved.providerAuthored) return resolved.provider
  return inferProvider(modelFlag) ?? resolved.provider
}

/**
 * Builds the distillation chat model from the resolved config. `resolveProvider`
 * narrows the configured provider id (throwing the same actionable "Unsupported
 * agent provider" error agents get), and `createChatModel` returns the LangChain
 * chat model — whose `.invoke(prompt)` resolves to a message with `.content`,
 * exactly `ModelLike`'s shape (the engine normalizes string vs content-part
 * array content). Imported lazily so `dawn memory list` never pays for the
 * LangChain barrel.
 */
async function createDistillModel(config: ResolvedDistillConfig): Promise<ModelLike> {
  const { createChatModel, resolveProvider } = await import("@dawn-ai/langchain")
  const provider = resolveProvider({ model: config.model, provider: config.provider })
  const model = await createChatModel({ model: config.model, provider })
  return model as ModelLike
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
