import type { Metadata } from "next"
import Content from "../../../content/docs/testing.mdx"
import { DocsPage } from "../../components/docs/DocsPage"
import { resolveStaticSeoPage, toMetadata } from "../../seo/resolve"

export const metadata: Metadata = toMetadata(resolveStaticSeoPage("/docs/testing"))

export default function Page() {
  return <DocsPage href="/docs/testing" Content={Content} promptSlug="write-a-test" />
}
