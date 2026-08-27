import type { Metadata } from "next"
import Content from "../../../../content/docs/memory/episodes.mdx"
import { DocsPage } from "../../../components/docs/DocsPage"
import { resolveStaticSeoPage, toMetadata } from "../../../seo/resolve"

export const metadata: Metadata = toMetadata(resolveStaticSeoPage("/docs/memory/episodes"))

export default function Page() {
  return <DocsPage href="/docs/memory/episodes" Content={Content} />
}
