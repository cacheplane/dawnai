import { existsSync, readdirSync, readFileSync, statSync } from "node:fs"
import { join, resolve, sep } from "node:path"
import { fileURLToPath } from "node:url"

import type { Command } from "commander"

import { CliError, type CommandIo, writeLine } from "../lib/output.js"

/** True when `target` is the same as, or nested inside, `dir`. */
function isInside(dir: string, target: string): boolean {
  const base = resolve(dir)
  const resolved = resolve(target)
  return resolved === base || resolved.startsWith(base + sep)
}

interface DocsArgs {
  readonly topic?: string
  /** Override the docs directory; used by tests. */
  readonly docsDir?: string
}

/** Resolve the bundled docs dir relative to this command's built location
 * (dist/commands/docs.js -> <package>/docs). */
function defaultDocsDir(): string {
  return fileURLToPath(new URL("../../docs", import.meta.url))
}

function listTopics(dir: string): string[] {
  const topics: string[] = []
  const walk = (current: string, prefix: string): void => {
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      if (entry.isDirectory()) {
        walk(join(current, entry.name), prefix ? `${prefix}/${entry.name}` : entry.name)
        continue
      }
      if (!entry.name.endsWith(".md") || (prefix === "" && entry.name === "README.md")) {
        continue
      }
      const base = entry.name.replace(/\.md$/, "")
      if (base === "index" && prefix !== "") {
        topics.push(prefix)
      } else {
        topics.push(prefix ? `${prefix}/${base}` : base)
      }
    }
  }
  walk(dir, "")
  return topics.sort()
}

export function registerDocsCommand(program: Command, io: CommandIo): void {
  program
    .command("docs [topic]")
    .description("Print the bundled, version-matched Dawn docs (or a single topic)")
    .action(async (topic: string | undefined) => {
      await runDocsCommand(topic !== undefined ? { topic } : {}, io)
    })
}

export async function runDocsCommand(args: DocsArgs, io: CommandIo): Promise<void> {
  const dir = args.docsDir ?? defaultDocsDir()
  if (!existsSync(dir)) {
    throw new CliError(
      `Bundled docs not found at ${dir}. If running from source, build the CLI first (pnpm --filter @dawn-ai/cli build).`,
    )
  }

  if (!args.topic) {
    writeLine(io.stdout, `Dawn docs (version-matched) at: ${dir}`)
    writeLine(io.stdout, "Index: dawn docs README  (or open docs/README.md)")
    writeLine(io.stdout, "")
    writeLine(io.stdout, "Topics:")
    for (const topic of listTopics(dir)) {
      writeLine(io.stdout, `  ${topic}`)
    }
    return
  }

  const slug = args.topic.replace(/\.md$/, "")
  let file = join(dir, `${slug}.md`)
  if (!isInside(dir, file) || !existsSync(file) || !statSync(file).isFile()) {
    const indexFile = join(dir, slug, "index.md")
    if (isInside(dir, indexFile) && existsSync(indexFile) && statSync(indexFile).isFile()) {
      file = indexFile
    } else {
      writeLine(io.stderr, `Unknown topic: ${args.topic}`)
      writeLine(io.stderr, "")
      writeLine(io.stderr, "Available topics:")
      for (const topic of listTopics(dir)) {
        writeLine(io.stderr, `  ${topic}`)
      }
      throw new CliError(`No doc named "${args.topic}".`)
    }
  }
  writeLine(io.stdout, readFileSync(file, "utf8"))
}
