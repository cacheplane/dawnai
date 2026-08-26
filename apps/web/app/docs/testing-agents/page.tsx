import type { Metadata } from "next"
import Content from "../../../content/docs/testing-agents.mdx"
import { DocsPage } from "../../components/docs/DocsPage"
import { resolveStaticSeoPage, toMetadata } from "../../seo/resolve"

export const metadata: Metadata = toMetadata(resolveStaticSeoPage("/docs/testing-agents"))

export default function Page() {
  return <DocsPage href="/docs/testing-agents" Content={Content} />
}
