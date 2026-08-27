import type { Metadata } from "next"
import Content from "../../../content/docs/embedding.mdx"
import { DocsPage } from "../../components/docs/DocsPage"
import { resolveStaticSeoPage, toMetadata } from "../../seo/resolve"

export const metadata: Metadata = toMetadata(resolveStaticSeoPage("/docs/embedding"))

export default function Page() {
  return <DocsPage href="/docs/embedding" Content={Content} />
}
