import { readFileSync } from "node:fs"
import { readFile } from "node:fs/promises"
import path, { join } from "node:path"
import { NextResponse } from "next/server"
import { PROMPTS } from "../../content/prompts"
import { getAllPosts } from "../components/blog/post-index"

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

// Single source — `/AGENTS.md` and `/CLAUDE.md` both serve this file.
const TEMPLATES = [{ title: "AGENTS.md / CLAUDE.md template", path: "templates/AGENTS.md" }]

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
    "## Brand Assets",
    "Official Dawn AI logos, icons, favicons, and social assets:",
    "- Brand page: https://dawnai.org/brand",
    "- Asset manifest: https://dawnai.org/brand/assets.json",
    "- Full brand kit ZIP: https://dawnai.org/brand/dawn-ai-brand-assets.zip",
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

  sections.push("\n\n# Blog\n")
  for (const post of getAllPosts()) {
    const filename = `${post.date}-${post.slug}.mdx`
    const raw = readFileSync(join(process.cwd(), "content", "blog", filename), "utf8")
    sections.push(`\n## ${post.title}\n\n${raw}\n`)
  }

  return sections.join("\n")
}

export async function GET() {
  const body = await buildLlmsFull()
  return new NextResponse(body, {
    headers: { "Content-Type": "text/plain; charset=utf-8" },
  })
}
