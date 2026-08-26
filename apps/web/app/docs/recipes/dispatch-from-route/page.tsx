import type { Metadata } from "next"
import Content from "../../../../content/docs/recipes/dispatch-from-route.mdx"
import { DocsPage } from "../../../components/docs/DocsPage"
import { resolveStaticSeoPage, toMetadata } from "../../../seo/resolve"

export const metadata: Metadata = toMetadata(
  resolveStaticSeoPage("/docs/recipes/dispatch-from-route"),
)

export default function Page() {
  return <DocsPage href="/docs/recipes/dispatch-from-route" Content={Content} />
}
