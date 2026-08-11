import { promises as fs } from "node:fs"
import path from "node:path"
import { NextResponse } from "next/server"
import { webContentRoot } from "../../../../lib/content-root"

const DOCS_ROOT = path.join(webContentRoot(), "docs")

type ReadMarkdownFile = (filePath: string) => Promise<string>

const readMarkdownFile: ReadMarkdownFile = (filePath) => fs.readFile(filePath, "utf8")

interface RouteContext {
  readonly params: Promise<{ readonly slug: ReadonlyArray<string> }>
}

async function markdownResponse(
  slug: readonly string[],
  readFile: ReadMarkdownFile = readMarkdownFile,
): Promise<Response> {
  if (!slug || slug.length === 0) {
    return NextResponse.json({ error: "missing slug" }, { status: 400 })
  }

  // Reject traversal: each segment must be a plain identifier-ish string.
  for (const segment of slug) {
    if (!/^[a-zA-Z0-9_-]+$/.test(segment)) {
      return NextResponse.json({ error: "invalid slug" }, { status: 400 })
    }
  }

  const slugPath = slug.join("/")
  const candidates = [
    path.join(DOCS_ROOT, `${slugPath}.mdx`),
    path.join(DOCS_ROOT, slugPath, "index.mdx"),
  ]

  for (const filePath of candidates) {
    // Defensive containment check.
    if (!filePath.startsWith(DOCS_ROOT + path.sep) && filePath !== DOCS_ROOT) {
      return NextResponse.json({ error: "invalid slug" }, { status: 400 })
    }

    try {
      const body = await readFile(filePath)
      return new NextResponse(body, {
        status: 200,
        headers: {
          "content-type": "text/markdown; charset=utf-8",
          "cache-control": "public, max-age=60, must-revalidate",
        },
      })
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error
      // Try the next supported source layout.
    }
  }

  return NextResponse.json({ error: "not found" }, { status: 404 })
}

export async function GET(_req: Request, context: RouteContext): Promise<Response> {
  const { slug } = await context.params
  return markdownResponse(slug)
}
