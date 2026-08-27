import type { Metadata } from "next"
import Content from "../../../content/docs/observability.mdx"
import { DocsPage } from "../../components/docs/DocsPage"
import { resolveStaticSeoPage, toMetadata } from "../../seo/resolve"

export const metadata: Metadata = toMetadata(resolveStaticSeoPage("/docs/observability"))

export default function Page() {
  return <DocsPage href="/docs/observability" Content={Content} />
}
