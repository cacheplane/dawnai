import type { Metadata } from "next"
import Content from "../../../content/docs/access-control.mdx"
import { DocsPage } from "../../components/docs/DocsPage"
import { resolveStaticSeoPage, toMetadata } from "../../seo/resolve"

export const metadata: Metadata = toMetadata(resolveStaticSeoPage("/docs/access-control"))

export default function Page() {
  return <DocsPage href="/docs/access-control" Content={Content} />
}
