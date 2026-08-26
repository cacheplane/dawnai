import type { Metadata } from "next"
import Content from "../../../../content/docs/recipes/research-web-ui.mdx"
import { DocsPage } from "../../../components/docs/DocsPage"
import { resolveStaticSeoPage, toMetadata } from "../../../seo/resolve"

export const metadata: Metadata = toMetadata(resolveStaticSeoPage("/docs/recipes/research-web-ui"))

export default function Page() {
  return <DocsPage href="/docs/recipes/research-web-ui" Content={Content} />
}
