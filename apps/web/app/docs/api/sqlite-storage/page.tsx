import type { Metadata } from "next"
import Content from "../../../../content/docs/api/sqlite-storage.mdx"
import { DocsPage } from "../../../components/docs/DocsPage"
import { resolveStaticSeoPage, toMetadata } from "../../../seo/resolve"

export const metadata: Metadata = toMetadata(resolveStaticSeoPage("/docs/api/sqlite-storage"))

export default function Page() {
  return <DocsPage href="/docs/api/sqlite-storage" Content={Content} />
}
