import type { Metadata } from "next"
import Content from "../../../content/docs/agents.mdx"
import { DocsPage } from "../../components/docs/DocsPage"
import { resolveStaticSeoPage, toMetadata } from "../../seo/resolve"

export const metadata: Metadata = toMetadata(resolveStaticSeoPage("/docs/agents"))

export default function Page() {
  return <DocsPage href="/docs/agents" Content={Content} />
}
