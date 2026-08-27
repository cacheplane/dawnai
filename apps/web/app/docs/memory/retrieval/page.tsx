import type { Metadata } from "next"
import Content from "../../../../content/docs/memory/retrieval.mdx"
import { DocsPage } from "../../../components/docs/DocsPage"
import { resolveStaticSeoPage, toMetadata } from "../../../seo/resolve"

export const metadata: Metadata = toMetadata(resolveStaticSeoPage("/docs/memory/retrieval"))

export default function Page() {
  return <DocsPage href="/docs/memory/retrieval" Content={Content} />
}
