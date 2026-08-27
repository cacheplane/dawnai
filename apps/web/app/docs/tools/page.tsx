import type { Metadata } from "next"
import Content from "../../../content/docs/tools.mdx"
import { DocsPage } from "../../components/docs/DocsPage"
import { resolveStaticSeoPage, toMetadata } from "../../seo/resolve"

export const metadata: Metadata = toMetadata(resolveStaticSeoPage("/docs/tools"))

export default function Page() {
  return <DocsPage href="/docs/tools" Content={Content} promptSlug="add-a-tool" />
}
