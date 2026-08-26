import type { Metadata } from "next"
import Content from "../../../content/docs/cli.mdx"
import { DocsPage } from "../../components/docs/DocsPage"
import { resolveStaticSeoPage, toMetadata } from "../../seo/resolve"

export const metadata: Metadata = toMetadata(resolveStaticSeoPage("/docs/cli"))

export default function Page() {
  return <DocsPage href="/docs/cli" Content={Content} />
}
