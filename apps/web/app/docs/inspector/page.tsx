import type { Metadata } from "next"
import Content from "../../../content/docs/inspector.mdx"
import { DocsPage } from "../../components/docs/DocsPage"
import { resolveStaticSeoPage, toMetadata } from "../../seo/resolve"

export const metadata: Metadata = toMetadata(resolveStaticSeoPage("/docs/inspector"))

export default function Page() {
  return <DocsPage href="/docs/inspector" Content={Content} />
}
