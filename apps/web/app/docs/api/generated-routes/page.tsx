import type { Metadata } from "next"
import Content from "../../../../content/docs/api/generated-routes.mdx"
import { DocsPage } from "../../../components/docs/DocsPage"
import { resolveStaticSeoPage, toMetadata } from "../../../seo/resolve"

export const metadata: Metadata = toMetadata(resolveStaticSeoPage("/docs/api/generated-routes"))

export default function Page() {
  return <DocsPage href="/docs/api/generated-routes" Content={Content} />
}
