import type { Metadata } from "next"
import Content from "../../../content/docs/upgrading.mdx"
import { DocsPage } from "../../components/docs/DocsPage"
import { resolveStaticSeoPage, toMetadata } from "../../seo/resolve"

export const metadata: Metadata = toMetadata(resolveStaticSeoPage("/docs/upgrading"))

export default function Page() {
  return <DocsPage href="/docs/upgrading" Content={Content} />
}
