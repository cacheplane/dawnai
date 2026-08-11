import { readFile } from "node:fs/promises"
import path from "node:path"
import { NextResponse } from "next/server"
import { webContentRoot } from "../../lib/content-root"

export async function GET() {
  const body = await readFile(path.join(webContentRoot(), "templates/AGENTS.md"), "utf8")
  return new NextResponse(body, {
    headers: { "Content-Type": "text/markdown; charset=utf-8" },
  })
}
