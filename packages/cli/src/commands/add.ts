import type { Command } from "commander"

import { CliError, type CommandIo, writeLine } from "../lib/output.js"

interface AddArgs {
  readonly target?: string
  readonly baseUrl?: string
  readonly fetchImpl?: typeof fetch
}

interface CatalogEntry {
  readonly name: string
  readonly category: string
  readonly description: string
}

function resolveBaseUrl(explicit?: string): string {
  return explicit ?? process.env.DAWN_BLUEPRINTS_URL ?? "https://dawnai.org"
}

function isUrl(value: string): boolean {
  return /^https?:\/\//.test(value)
}

function isValidName(name: string): boolean {
  return /^[a-z0-9][a-z0-9-]*$/.test(name)
}

async function fetchText(
  fetchImpl: typeof fetch,
  url: string,
): Promise<{ status: number; text: string }> {
  let res: Response
  try {
    res = await fetchImpl(url, { signal: AbortSignal.timeout(15000) })
  } catch (error) {
    const reason =
      error instanceof Error && (error.name === "TimeoutError" || error.name === "AbortError")
        ? "timed out after 15s"
        : error instanceof Error
          ? error.message
          : String(error)
    throw new CliError(`Failed to reach ${url}: ${reason}`)
  }
  return { status: res.status, text: await res.text() }
}

async function loadCatalog(fetchImpl: typeof fetch, base: string): Promise<CatalogEntry[]> {
  const { status, text } = await fetchText(fetchImpl, `${base}/blueprints/index.json`)
  if (status !== 200) {
    throw new CliError(`Could not load the blueprint catalog (${status}) from ${base}.`)
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    throw new CliError(`Blueprint catalog at ${base} was not valid JSON.`)
  }
  if (
    !Array.isArray(parsed) ||
    !parsed.every(
      (e) =>
        typeof e === "object" &&
        e !== null &&
        typeof (e as CatalogEntry).name === "string" &&
        typeof (e as CatalogEntry).category === "string",
    )
  ) {
    throw new CliError(`Blueprint catalog at ${base} did not have the expected shape.`)
  }
  return parsed as CatalogEntry[]
}

export function registerAddCommand(program: Command, io: CommandIo): void {
  program
    .command("add [name]")
    .description("Add an integration via a blueprint — a guide for your coding agent to apply")
    .action(async (name: string | undefined) => {
      await runAddCommand(name !== undefined ? { target: name } : {}, io)
    })
}

export async function runAddCommand(args: AddArgs, io: CommandIo): Promise<void> {
  const fetchImpl = args.fetchImpl ?? fetch
  const base = resolveBaseUrl(args.baseUrl)

  if (!args.target) {
    const catalog = await loadCatalog(fetchImpl, base)
    writeLine(io.stdout, "Available Dawn blueprints — run `dawn add <name>`:")
    const byCategory = new Map<string, CatalogEntry[]>()
    for (const entry of catalog) {
      byCategory.set(entry.category, [...(byCategory.get(entry.category) ?? []), entry])
    }
    for (const category of [...byCategory.keys()].sort()) {
      writeLine(io.stdout, "")
      writeLine(io.stdout, `${category}:`)
      const entries = (byCategory.get(category) ?? []).sort((a, b) => a.name.localeCompare(b.name))
      for (const entry of entries) {
        writeLine(io.stdout, `  ${entry.name} — ${entry.description}`)
      }
    }
    return
  }

  if (isUrl(args.target)) {
    const { status, text } = await fetchText(fetchImpl, args.target)
    if (status !== 200) {
      throw new CliError(`Could not fetch blueprint from ${args.target} (${status}).`)
    }
    writeLine(io.stdout, text)
    return
  }

  if (!isValidName(args.target)) {
    throw new CliError(
      `Invalid blueprint name "${args.target}". Names are lowercase letters, digits, and hyphens (e.g. "pgvector"). Pass a full https:// URL for a third-party blueprint.`,
    )
  }

  const url = `${base}/blueprints/${args.target}.md`
  const { status, text } = await fetchText(fetchImpl, url)
  if (status === 200) {
    writeLine(io.stdout, `# Apply this Dawn blueprint: ${args.target}`)
    writeLine(io.stdout, "")
    writeLine(io.stdout, "Hand the guide below to your coding agent to apply it to this project.")
    writeLine(io.stdout, "")
    writeLine(io.stdout, text)
    return
  }
  if (status === 404) {
    const catalog = await loadCatalog(fetchImpl, base)
    writeLine(io.stderr, `Unknown blueprint: ${args.target}`)
    writeLine(io.stderr, "")
    writeLine(io.stderr, "Available blueprints:")
    for (const entry of catalog) {
      writeLine(io.stderr, `  ${entry.name} (${entry.category})`)
    }
    throw new CliError(`No blueprint named "${args.target}".`)
  }
  throw new CliError(`Failed to fetch ${url} (${status}).`)
}
