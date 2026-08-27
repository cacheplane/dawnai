import type { Metadata } from "next"
import Content from "../../../content/docs/deployment.mdx"
import { DocsPage } from "../../components/docs/DocsPage"
import { resolveStaticSeoPage, toMetadata } from "../../seo/resolve"

export const metadata: Metadata = toMetadata(resolveStaticSeoPage("/docs/deployment"))

export default function Page() {
  return <DocsPage href="/docs/deployment" Content={Content} promptSlug="deploy" />
}
