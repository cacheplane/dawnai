/**
 * `dawn threads tail <thread-id>` — the first first-party Agent Protocol SSE
 * client. It parses the wire JSON defensively via `../lib/threads/*` and never
 * imports the server's internal frame types, so this command is a genuine
 * third-party consumer of the documented attach contract
 * (`/docs/dev-server/agent-protocol`) rather than a compile-time-coupled sibling.
 */
import type { Command } from "commander"
import { CliError, type CommandIo, writeLine } from "../lib/output.js"
import { consumeAttachStream } from "../lib/threads/tail-stream.js"

const DEFAULT_BASE = "http://127.0.0.1:3000"

const USAGE = [
  "dawn threads <subcommand> [args]",
  "  subcommands: tail <thread-id> [--url <base>] [--header <name: value>] [--json]",
].join("\n")

interface ThreadsOptions {
  readonly url?: string
  readonly header?: string[]
  readonly json?: boolean
}

export interface TailRequest {
  readonly url: URL
  readonly headers: Record<string, string>
  readonly json: boolean
}

function parseHeader(raw: string): readonly [string, string] {
  const colonIndex = raw.indexOf(":")
  if (colonIndex === -1) {
    throw new CliError(`Invalid --header "${raw}": expected "name: value".`, 2)
  }
  const name = raw.slice(0, colonIndex).trim()
  const value = raw.slice(colonIndex + 1).trim()
  if (name === "") {
    throw new CliError(`Invalid --header "${raw}": header name is empty.`, 2)
  }
  return [name, value]
}

/** Pure option validation — no I/O, so the failure modes are unit-testable. */
export function resolveTailRequest(threadId: string, options: ThreadsOptions): TailRequest {
  const base = options.url ?? DEFAULT_BASE
  let url: URL
  try {
    url = new URL(`/threads/${encodeURIComponent(threadId)}/runs/stream`, base)
  } catch (error) {
    throw new CliError(
      `Invalid --url "${base}": ${error instanceof Error ? error.message : String(error)}`,
      2,
    )
  }

  const headers: Record<string, string> = {}
  for (const raw of options.header ?? []) {
    const [name, value] = parseHeader(raw)
    headers[name] = value
  }

  return { url, headers, json: options.json ?? false }
}

function unwrapCause(error: unknown): string {
  if (error instanceof Error) {
    const cause = error.cause
    if (cause instanceof Error) return cause.message
    if (typeof cause === "string") return cause
    return error.message
  }
  return String(error)
}

function own(value: unknown, key: string): unknown {
  return typeof value === "object" && value !== null && Object.hasOwn(value, key)
    ? (value as Record<string, unknown>)[key]
    : undefined
}

/**
 * Dawn's error envelope is `{error: {kind, message, details?: {code?}, code?}}`
 * — see `createRequestErrorBody`/`buildBody` in the runtime. The code a caller
 * branches on rides at `error.details.code` when the handler passed it as
 * DETAILS (which every thread endpoint does) and at `error.code` only when it
 * came from the registry `options`. Reading a top-level `code` finds neither,
 * which silently degrades every coded failure to the generic branch.
 *
 * Own-property reads throughout: this is server-supplied JSON.
 */
async function readErrorBody(response: Response): Promise<{ code?: string; message?: string }> {
  let body: unknown
  try {
    body = await response.clone().json()
  } catch {
    return {}
  }
  const error = own(body, "error")
  const code = own(own(error, "details"), "code") ?? own(error, "code")
  const message = own(error, "message")
  return {
    ...(typeof code === "string" ? { code } : {}),
    ...(typeof message === "string" ? { message } : {}),
  }
}

/** The server's own sentence when it has one, never the raw envelope. */
async function readErrorMessage(response: Response): Promise<string> {
  const { message } = await readErrorBody(response)
  if (message) return message
  try {
    const text = await response.clone().text()
    return text.length > 0 ? text : response.statusText
  } catch {
    return response.statusText
  }
}

async function runTail(threadId: string, options: ThreadsOptions, io: CommandIo): Promise<void> {
  const request = resolveTailRequest(threadId, options)

  let response: Response
  try {
    response = await fetch(request.url, {
      headers: { accept: "text/event-stream", ...request.headers },
    })
  } catch (error) {
    throw new CliError(
      `Cannot reach the Dawn server at ${request.url.origin}: ${unwrapCause(error)}`,
      2,
    )
  }

  if (!response.ok) {
    if (response.status === 404) {
      throw new CliError(`Thread "${threadId}" not found.`, 2)
    }
    if (response.status === 409) {
      const { code } = await readErrorBody(response)
      if (code === "thread_route_unknown") {
        throw new CliError(`Thread "${threadId}" has never run; there is nothing to tail.`, 2)
      }
    }
    throw new CliError(
      `Failed to attach to thread "${threadId}" (${response.status}): ${await readErrorMessage(response)}`,
      2,
    )
  }

  if (!response.body) {
    throw new CliError(`The Dawn server returned no stream body for thread "${threadId}".`, 2)
  }

  const result = await consumeAttachStream({
    body: response.body,
    write: (line) => writeLine(io.stdout, line),
    json: request.json,
  })

  if (result.outcome === "detached") {
    throw new CliError(
      `Detached (${result.reason ?? "unknown"}). Reconnect for a fresh snapshot.`,
      1,
    )
  }
  if (result.outcome === "truncated") {
    throw new CliError("The attach stream ended without a terminal done frame.", 1)
  }
}

export function registerThreadsCommand(program: Command, io: CommandIo): void {
  program
    .command("threads [subcommand] [args...]")
    .description("Inspect and reattach to Dawn Agent Protocol threads")
    .option("--url <url>", "Base URL of the running Dawn server", DEFAULT_BASE)
    .option(
      "--header <header>",
      'Extra request header, as "name: value" (repeatable)',
      (value: string, previous: string[]) => [...previous, value],
      [] as string[],
    )
    .option("--json", "Print raw SSE frames as JSON instead of rendered lines")
    .addHelpText("after", `\n${USAGE}`)
    .action(async (subcommand: string | undefined, args: string[], options: ThreadsOptions) => {
      await runThreadsCommand(subcommand, args, options, io)
    })
}

export async function runThreadsCommand(
  subcommand: string | undefined,
  args: readonly string[],
  options: ThreadsOptions,
  io: CommandIo,
): Promise<void> {
  if (!subcommand) {
    throw new CliError(`Missing subcommand.\n${USAGE}`, 1)
  }

  switch (subcommand) {
    case "tail": {
      const threadId = args[0]
      if (!threadId) throw new CliError(`Usage: dawn threads tail <thread-id>`, 1)
      await runTail(threadId, options, io)
      break
    }
    default:
      throw new CliError(`Unknown subcommand "${subcommand}".\n${USAGE}`, 1)
  }
}
