import { promises as fs } from "node:fs"
import path from "node:path"
import { NextResponse } from "next/server"

const DOCS_ROOT = path.join(process.cwd(), "content", "docs")

interface RouteContext {
  readonly params: Promise<{ readonly slug: ReadonlyArray<string> }>
}

export async function GET(_req: Request, context: RouteContext): Promise<Response> {
  const { slug } = await context.params
  if (!slug || slug.length === 0) {
    return NextResponse.json({ error: "missing slug" }, { status: 400 })
  }

  // Reject traversal: each segment must be a plain identifier-ish string.
  for (const segment of slug) {
    if (!/^[a-zA-Z0-9_-]+$/.test(segment)) {
      return NextResponse.json({ error: "invalid slug" }, { status: 400 })
    }
  }

  const filePath = path.join(DOCS_ROOT, `${slug.join("/")}.mdx`)
  // Defensive containment check.
  if (!filePath.startsWith(DOCS_ROOT + path.sep) && filePath !== DOCS_ROOT) {
    return NextResponse.json({ error: "invalid slug" }, { status: 400 })
  }

  try {
    const body = await fs.readFile(filePath, "utf8")
    return new NextResponse(body, {
      status: 200,
      headers: {
        "content-type": "text/markdown; charset=utf-8",
        "cache-control": "public, max-age=60, must-revalidate",
      },
    })
  } catch {
    return NextResponse.json({ error: "not found" }, { status: 404 })
  }
}
