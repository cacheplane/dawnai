import { readFile } from "node:fs/promises"

/**
 * Probe files are how these suites observe a run that outlives the request that
 * started it: the fixture route writes a file, the test polls for it.
 *
 * `writeFile` is NOT atomic — it opens with O_TRUNC and then writes, awaiting in
 * between. A reader polling the path can land in that window and read back an
 * empty or truncated file, which is how `JSON.parse(await waitForFile(...))`
 * produced an intermittent "Unexpected end of JSON input" in CI.
 *
 * Two defenses live here, and both are used:
 *   - `atomicWriteLines` makes the writer rename a finished temp file onto the
 *     target, so a reader sees either nothing or the whole body. That removes
 *     the race at the source.
 *   - `waitForFile` polls for *complete* content rather than mere existence, so
 *     a probe writer that has not been converted still cannot hand a caller a
 *     half-written file.
 */

export interface WaitForFileOptions {
  /** Poll interval between attempts. */
  intervalMs?: number
  /**
   * Decides whether the content read so far is the complete payload. Returning
   * false — or throwing, as `JSON.parse` does on a truncated read — keeps
   * polling. Defaults to "any non-whitespace content".
   */
  isComplete?: (content: string) => boolean
  /** How long to wait before giving up. */
  timeoutMs?: number
  /** Noun used in the timeout error, e.g. "started probe". */
  what?: string
}

const hasContent = (content: string): boolean => content.trim().length > 0

/**
 * Wait for `path` to exist AND to hold complete content, then return it.
 *
 * Throws on timeout with an error that distinguishes "never appeared" from
 * "appeared but never completed", and quotes what was last read.
 */
export async function waitForFile(path: string, options: WaitForFileOptions = {}): Promise<string> {
  const {
    intervalMs = 25,
    isComplete = hasContent,
    timeoutMs = 15_000,
    what = "probe file",
  } = options
  const startedAt = Date.now()
  let lastContent: string | undefined
  let lastRejection: unknown

  while (Date.now() - startedAt < timeoutMs) {
    let content: string | undefined
    try {
      content = await readFile(path, "utf8")
    } catch {
      // Not written yet — keep polling.
    }
    if (content !== undefined) {
      lastContent = content
      try {
        if (isComplete(content)) return content
        lastRejection = undefined
      } catch (error) {
        lastRejection = error
      }
    }
    await new Promise((resolve) => setTimeout(resolve, intervalMs))
  }

  const waited = Date.now() - startedAt
  if (lastContent === undefined) {
    throw new Error(`${what} never appeared: ${path} (waited ${waited}ms)`)
  }
  const preview = JSON.stringify(
    lastContent.length > 200 ? `${lastContent.slice(0, 200)}…` : lastContent,
  )
  throw new Error(
    `${what} never completed: ${path} (waited ${waited}ms, last read ${preview})`,
    lastRejection === undefined ? undefined : { cause: lastRejection },
  )
}

/**
 * Wait for `path` to hold parseable JSON, then return the parsed value. A
 * truncated read makes `JSON.parse` throw, which is treated as "not complete
 * yet" rather than as a test failure.
 */
export async function waitForJsonFile<T>(
  path: string,
  options: Omit<WaitForFileOptions, "isComplete"> = {},
): Promise<T> {
  const content = await waitForFile(path, {
    ...options,
    isComplete: (candidate) => {
      JSON.parse(candidate)
      return true
    },
  })
  return JSON.parse(content) as T
}

/**
 * Source lines for an atomic probe write, to inline into a generated fixture
 * route. Writes a sibling temp file and renames it onto the target; `rename` is
 * atomic within a directory, so a concurrent reader never observes a partial
 * body.
 *
 * The emitted code needs `rename` and `writeFile` from `node:fs/promises` in
 * scope. `pathExpr` is evaluated twice, so pass a plain expression.
 */
export function atomicWriteLines(pathExpr: string, bodyExpr: string, indent = "  "): string[] {
  return [
    `${indent}const __probeTmp = ${pathExpr} + ".tmp"`,
    `${indent}await writeFile(__probeTmp, ${bodyExpr})`,
    `${indent}await rename(__probeTmp, ${pathExpr})`,
  ]
}
