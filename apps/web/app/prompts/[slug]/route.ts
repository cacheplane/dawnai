import { NextResponse } from "next/server"
import { PROMPTS, type PromptSlug } from "../../../content/prompts"

const SLUGS = new Set(PROMPTS.map((p) => p.slug))

export async function GET(_req: Request, ctx: { params: Promise<{ slug: string }> }) {
  const { slug } = await ctx.params
  if (!SLUGS.has(slug as PromptSlug)) {
    return new NextResponse("Not found", { status: 404 })
  }
  const entry = PROMPTS.find((p) => p.slug === slug)
  if (!entry) {
    return new NextResponse("Not found", { status: 404 })
  }
  return new NextResponse(entry.body, {
    headers: { "Content-Type": "text/markdown; charset=utf-8" },
  })
}

export function generateStaticParams() {
  return PROMPTS.map((p) => ({ slug: p.slug }))
}
