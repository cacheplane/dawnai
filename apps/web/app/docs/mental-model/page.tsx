import type { Metadata } from "next"
import Content from "../../../content/docs/mental-model.mdx"
import { DocsPage } from "../../components/docs/DocsPage"
import { resolveStaticSeoPage, toMetadata } from "../../seo/resolve"

export const metadata: Metadata = toMetadata(resolveStaticSeoPage("/docs/mental-model"))

export default function Page() {
  return <DocsPage href="/docs/mental-model" Content={Content} />
}
