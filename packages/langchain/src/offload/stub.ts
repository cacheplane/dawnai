export interface BuildStubArgs {
  readonly content: string
  readonly relPath: string
  readonly previewLines: number
  readonly thresholdChars: number
}

export function buildStub(args: BuildStubArgs): string {
  const lines = args.content.split("\n").slice(0, args.previewLines)
  const preview = lines.join("\n")
  const chars = args.content.length.toLocaleString("en-US")
  const threshold = args.thresholdChars.toLocaleString("en-US")
  return [
    `[Tool output offloaded — ${chars} chars exceeded the ${threshold}-char limit.`,
    `Full output saved to: ${args.relPath}`,
    `Preview (first ${args.previewLines} lines):`,
    preview,
    `Read the full output with the readFile tool at the path above.]`,
  ].join("\n")
}
