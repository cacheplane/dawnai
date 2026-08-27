import type { Metadata } from "next"
import Content from "../../../content/docs/thread-access.mdx"
import { DocsPage } from "../../components/docs/DocsPage"
import { resolveStaticSeoPage, toMetadata } from "../../seo/resolve"

export const metadata: Metadata = toMetadata(resolveStaticSeoPage("/docs/thread-access"))

export default function Page() {
  return <DocsPage href="/docs/thread-access" Content={Content} />
}
