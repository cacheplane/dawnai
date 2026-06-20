import { existsSync, readdirSync, readFileSync, statSync } from "node:fs"
import { join } from "node:path"
import { fileURLToPath } from "node:url"

import type { Command } from "commander"

import { CliError, type CommandIo, writeLine } from "../lib/output.js"

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
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      for (const sub of readdirSync(join(dir, entry.name))) {
        if (sub.endsWith(".md")) {
          topics.push(`${entry.name}/${sub.replace(/\.md$/, "")}`)
        }
      }
    } else if (entry.name.endsWith(".md") && entry.name !== "README.md") {
      topics.push(entry.name.replace(/\.md$/, ""))
    }
  }
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
  const file = join(dir, `${slug}.md`)
  if (!existsSync(file) || !statSync(file).isFile()) {
    writeLine(io.stderr, `Unknown topic: ${args.topic}`)
    writeLine(io.stderr, "")
    writeLine(io.stderr, "Available topics:")
    for (const topic of listTopics(dir)) {
      writeLine(io.stderr, `  ${topic}`)
    }
    throw new CliError(`No doc named "${args.topic}".`)
  }
  writeLine(io.stdout, readFileSync(file, "utf8"))
}
