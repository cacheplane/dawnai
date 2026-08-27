import type { Metadata } from "next"
import Content from "../../../../content/docs/testing-agents/fixtures.mdx"
import { DocsPage } from "../../../components/docs/DocsPage"
import { resolveStaticSeoPage, toMetadata } from "../../../seo/resolve"

export const metadata: Metadata = toMetadata(resolveStaticSeoPage("/docs/testing-agents/fixtures"))

export default function Page() {
  return <DocsPage href="/docs/testing-agents/fixtures" Content={Content} />
}
