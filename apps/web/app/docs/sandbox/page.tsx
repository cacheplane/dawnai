import type { Metadata } from "next"
import Content from "../../../content/docs/sandbox.mdx"
import { DocsPage } from "../../components/docs/DocsPage"
import { resolveStaticSeoPage, toMetadata } from "../../seo/resolve"

export const metadata: Metadata = toMetadata(resolveStaticSeoPage("/docs/sandbox"))

export default function Page() {
  return <DocsPage href="/docs/sandbox" Content={Content} />
}
