import type { Metadata } from "next"
import Content from "../../../content/docs/configuration.mdx"
import { DocsPage } from "../../components/docs/DocsPage"
import { resolveStaticSeoPage, toMetadata } from "../../seo/resolve"

export const metadata: Metadata = toMetadata(resolveStaticSeoPage("/docs/configuration"))

export default function Page() {
  return <DocsPage href="/docs/configuration" Content={Content} />
}
