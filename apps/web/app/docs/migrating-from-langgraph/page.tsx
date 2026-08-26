import type { Metadata } from "next"
import Content from "../../../content/docs/migrating-from-langgraph.mdx"
import { DocsPage } from "../../components/docs/DocsPage"
import { resolveStaticSeoPage, toMetadata } from "../../seo/resolve"

export const metadata: Metadata = toMetadata(resolveStaticSeoPage("/docs/migrating-from-langgraph"))

export default function Page() {
  return <DocsPage href="/docs/migrating-from-langgraph" Content={Content} />
}
