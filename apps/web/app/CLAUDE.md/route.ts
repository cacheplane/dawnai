import { readFile } from "node:fs/promises"
import path from "node:path"
import { NextResponse } from "next/server"

// CLAUDE.md and AGENTS.md serve the same content — Claude Code reads CLAUDE.md
// while other coding agents (Codex, etc.) read AGENTS.md. Single source of truth
// at templates/AGENTS.md prevents drift.
export async function GET() {
  const body = await readFile(path.join(process.cwd(), "content/templates/AGENTS.md"), "utf8")
  return new NextResponse(body, {
    headers: { "Content-Type": "text/markdown; charset=utf-8" },
  })
}
