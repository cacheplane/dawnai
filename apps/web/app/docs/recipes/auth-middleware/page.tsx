import type { Metadata } from "next"
import Content from "../../../../content/docs/recipes/auth-middleware.mdx"
import { DocsPage } from "../../../components/docs/DocsPage"
import { resolveStaticSeoPage, toMetadata } from "../../../seo/resolve"

export const metadata: Metadata = toMetadata(resolveStaticSeoPage("/docs/recipes/auth-middleware"))

export default function Page() {
  return <DocsPage href="/docs/recipes/auth-middleware" Content={Content} />
}
