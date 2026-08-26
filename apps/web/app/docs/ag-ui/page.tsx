import type { Metadata } from "next"
import Content from "../../../content/docs/ag-ui.mdx"
import { DocsPage } from "../../components/docs/DocsPage"
import { resolveStaticSeoPage, toMetadata } from "../../seo/resolve"

export const metadata: Metadata = toMetadata(resolveStaticSeoPage("/docs/ag-ui"))

export default function Page() {
  return <DocsPage href="/docs/ag-ui" Content={Content} />
}
