import type { Metadata } from "next"
import Content from "../../../content/docs/permissions.mdx"
import { DocsPage } from "../../components/docs/DocsPage"
import { resolveStaticSeoPage, toMetadata } from "../../seo/resolve"

export const metadata: Metadata = toMetadata(resolveStaticSeoPage("/docs/permissions"))

export default function Page() {
  return <DocsPage href="/docs/permissions" Content={Content} />
}
