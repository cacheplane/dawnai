import type { Metadata } from "next"
import Content from "../../../../content/docs/deployment/edge.mdx"
import { DocsPage } from "../../../components/docs/DocsPage"
import { resolveStaticSeoPage, toMetadata } from "../../../seo/resolve"

export const metadata: Metadata = toMetadata(resolveStaticSeoPage("/docs/deployment/edge"))

export default function Page() {
  return <DocsPage href="/docs/deployment/edge" Content={Content} />
}
