import type { Metadata } from "next"
import Content from "../../../content/docs/dev-server.mdx"
import { DocsPage } from "../../components/docs/DocsPage"
import { resolveStaticSeoPage, toMetadata } from "../../seo/resolve"

export const metadata: Metadata = toMetadata(resolveStaticSeoPage("/docs/dev-server"))

export default function Page() {
  return <DocsPage href="/docs/dev-server" Content={Content} />
}
