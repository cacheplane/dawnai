import type { Metadata } from "next"
import Content from "../../../content/docs/state.mdx"
import { DocsPage } from "../../components/docs/DocsPage"
import { resolveStaticSeoPage, toMetadata } from "../../seo/resolve"

export const metadata: Metadata = toMetadata(resolveStaticSeoPage("/docs/state"))

export default function Page() {
  return <DocsPage href="/docs/state" Content={Content} />
}
