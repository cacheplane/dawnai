export interface BuildStubArgs {
  readonly content: string
  readonly relPath: string
  readonly previewLines: number
  readonly thresholdChars: number
}

/**
 * Source text used for the preview slice. When the offloaded content is a
 * single-line JSON blob (e.g. a tool returned an object, so newlines are escaped
 * as `\n`), pretty-print it so the preview shows readable lines instead of one
 * giant escaped line. Plain-text content (the common case) is returned as-is.
 * Only the preview is affected — the stored file and its hash are unchanged.
 */
function previewSource(content: string): string {
  const trimmed = content.trimStart()
  if (trimmed.startsWith("{") || trimmed.startsWith("[")) {
    try {
      return JSON.stringify(JSON.parse(content), null, 2)
    } catch {
      // Not valid JSON — fall through to the raw content.
    }
  }
  return content
}

export function buildStub(args: BuildStubArgs): string {
  const lines = previewSource(args.content).split("\n").slice(0, args.previewLines)
  const shown = lines.length
  const preview = lines.join("\n")
  const chars = args.content.length.toLocaleString("en-US")
  const threshold = args.thresholdChars.toLocaleString("en-US")
  return [
    `[Tool output offloaded — ${chars} chars exceeded the ${threshold}-char limit.`,
    `Full output saved to: ${args.relPath}`,
    `Preview (first ${shown} lines):`,
    preview,
    `Read the full output with the readFile tool at the path above.]`,
  ].join("\n")
}
