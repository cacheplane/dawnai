import type { Metadata } from "next"
import Content from "../../../../content/docs/api/memory-pgvector.mdx"
import { DocsPage } from "../../../components/docs/DocsPage"
import { resolveStaticSeoPage, toMetadata } from "../../../seo/resolve"

export const metadata: Metadata = toMetadata(resolveStaticSeoPage("/docs/api/memory-pgvector"))

export default function Page() {
  return <DocsPage href="/docs/api/memory-pgvector" Content={Content} />
}
