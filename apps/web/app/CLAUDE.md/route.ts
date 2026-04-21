import { readFile } from "node:fs/promises"
import path from "node:path"
import { NextResponse } from "next/server"

export async function GET() {
  const body = await readFile(path.join(process.cwd(), "content/templates/CLAUDE.md"), "utf8")
  return new NextResponse(body, {
    headers: { "Content-Type": "text/markdown; charset=utf-8" },
  })
}
