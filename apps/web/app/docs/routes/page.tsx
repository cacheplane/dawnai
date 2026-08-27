import type { Metadata } from "next"
import Content from "../../../content/docs/routes.mdx"
import { DocsPage } from "../../components/docs/DocsPage"
import { resolveStaticSeoPage, toMetadata } from "../../seo/resolve"

export const metadata: Metadata = toMetadata(resolveStaticSeoPage("/docs/routes"))

export default function Page() {
  return <DocsPage href="/docs/routes" Content={Content} promptSlug="write-a-route" />
}
