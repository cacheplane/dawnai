import { NextResponse } from "next/server"
import { getBlueprint, loadBlueprints } from "../../../lib/blueprints"

export async function GET(_req: Request, ctx: { params: Promise<{ name: string }> }) {
  const { name } = await ctx.params
  const slug = name.replace(/\.md$/, "")
  const entry = getBlueprint(slug)
  if (!entry) {
    return NextResponse.json({ error: `Unknown blueprint "${slug}"` }, { status: 404 })
  }
  return new NextResponse(entry.body, {
    headers: { "Content-Type": "text/markdown; charset=utf-8" },
  })
}

export function generateStaticParams() {
  return loadBlueprints().map((entry) => ({ name: `${entry.meta.name}.md` }))
}
