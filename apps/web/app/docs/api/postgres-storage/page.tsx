import type { Metadata } from "next"
import Content from "../../../../content/docs/api/postgres-storage.mdx"
import { DocsPage } from "../../../components/docs/DocsPage"
import { resolveStaticSeoPage, toMetadata } from "../../../seo/resolve"

export const metadata: Metadata = toMetadata(resolveStaticSeoPage("/docs/api/postgres-storage"))

export default function Page() {
  return <DocsPage href="/docs/api/postgres-storage" Content={Content} />
}
