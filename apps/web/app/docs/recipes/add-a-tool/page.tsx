import type { Metadata } from "next"
import Content from "../../../../content/docs/recipes/add-a-tool.mdx"
import { DocsPage } from "../../../components/docs/DocsPage"
import { resolveStaticSeoPage, toMetadata } from "../../../seo/resolve"

export const metadata: Metadata = toMetadata(resolveStaticSeoPage("/docs/recipes/add-a-tool"))

export default function Page() {
  return <DocsPage href="/docs/recipes/add-a-tool" Content={Content} />
}
