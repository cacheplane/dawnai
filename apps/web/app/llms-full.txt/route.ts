import { readFile } from "node:fs/promises"
import path from "node:path"
import { NextResponse } from "next/server"
import { PROMPTS } from "../../content/prompts"

const CONTENT_ROOT = path.join(process.cwd(), "content")

const DOCS_PAGES = [
  { title: "Getting Started", path: "docs/getting-started.mdx" },
  { title: "Routes", path: "docs/routes.mdx" },
  { title: "Tools", path: "docs/tools.mdx" },
  { title: "State", path: "docs/state.mdx" },
  { title: "Testing", path: "docs/testing.mdx" },
  { title: "Dev Server", path: "docs/dev-server.mdx" },
  { title: "Deployment", path: "docs/deployment.mdx" },
  { title: "CLI Reference", path: "docs/cli.mdx" },
]

const TEMPLATES = [
  { title: "AGENTS.md template", path: "templates/AGENTS.md" },
  { title: "assistant.md template", path: "templates/assistant.md" },
]

async function readContent(relPath: string): Promise<string> {
  return readFile(path.join(CONTENT_ROOT, relPath), "utf8")
}

async function buildLlmsFull(): Promise<string> {
  const sections: string[] = [
    "# Dawn — Full Reference",
    "",
    "Generated reference for coding agents. This file is the concatenation of every Dawn documentation page, task-specific prompt, and agent config template served by dawnai.org.",
    "",
    "For the compact summary: https://dawnai.org/llms.txt",
    "For source: https://github.com/cacheplane/dawnai",
    "",
    "---",
    "",
    "## Documentation",
    "",
  ]

  for (const { title, path: p } of DOCS_PAGES) {
    sections.push(`### ${title}`, "", await readContent(p), "", "---", "")
  }

  sections.push("## Task-Specific Prompts", "")
  for (const entry of PROMPTS) {
    sections.push(`### ${entry.title}`, "", entry.body, "", "---", "")
  }

  sections.push("## Agent Config Templates", "")
  for (const { title, path: p } of TEMPLATES) {
    sections.push(`### ${title}`, "", await readContent(p), "", "---", "")
  }

  return sections.join("\n")
}

export async function GET() {
  const body = await buildLlmsFull()
  return new NextResponse(body, {
    headers: { "Content-Type": "text/plain; charset=utf-8" },
  })
}
