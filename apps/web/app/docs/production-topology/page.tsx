import type { Metadata } from "next"
import Content from "../../../content/docs/production-topology.mdx"
import { DocsPage } from "../../components/docs/DocsPage"
import { resolveStaticSeoPage, toMetadata } from "../../seo/resolve"

export const metadata: Metadata = toMetadata(resolveStaticSeoPage("/docs/production-topology"))

export default function Page() {
  return <DocsPage href="/docs/production-topology" Content={Content} />
}
