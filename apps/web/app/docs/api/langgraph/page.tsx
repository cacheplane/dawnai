import type { Metadata } from "next"
import Content from "../../../../content/docs/api/langgraph.mdx"
import { DocsPage } from "../../../components/docs/DocsPage"
import { resolveStaticSeoPage, toMetadata } from "../../../seo/resolve"

export const metadata: Metadata = toMetadata(resolveStaticSeoPage("/docs/api/langgraph"))

export default function Page() {
  return <DocsPage href="/docs/api/langgraph" Content={Content} />
}
