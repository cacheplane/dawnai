import type { Metadata } from "next"
import Content from "../../../content/docs/subagents.mdx"
import { DocsPage } from "../../components/docs/DocsPage"
import { resolveStaticSeoPage, toMetadata } from "../../seo/resolve"

export const metadata: Metadata = toMetadata(resolveStaticSeoPage("/docs/subagents"))

export default function Page() {
  return <DocsPage href="/docs/subagents" Content={Content} />
}
