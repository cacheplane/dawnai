import type { Metadata } from "next"
import Content from "../../../content/docs/context-management.mdx"
import { DocsPage } from "../../components/docs/DocsPage"
import { resolveStaticSeoPage, toMetadata } from "../../seo/resolve"

export const metadata: Metadata = toMetadata(resolveStaticSeoPage("/docs/context-management"))

export default function Page() {
  return <DocsPage href="/docs/context-management" Content={Content} />
}
