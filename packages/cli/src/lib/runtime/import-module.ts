import { diagnose } from "../diagnostics.js"
import { CliError } from "../output.js"

export async function importModule(
  href: string,
  opts: {
    readonly kind: "route" | "tool" | "config"
    readonly appRoot?: string
    readonly sourcePath?: string
  },
): Promise<unknown> {
  try {
    return await import(href)
  } catch (error) {
    const diag = diagnose(error, opts.appRoot ? { appRoot: opts.appRoot } : undefined)
    if (!diag) throw error
    const where = opts.sourcePath
      ? ` (loading ${opts.kind} ${opts.sourcePath})`
      : ` (loading a ${opts.kind})`
    throw new CliError(`${diag.summary}${where}\n\n${diag.hint}`, 1, { cause: error })
  }
}
