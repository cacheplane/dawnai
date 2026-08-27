import type { Metadata } from "next"
import Content from "../../../content/docs/errors.mdx"
import { DocsPage } from "../../components/docs/DocsPage"
import { resolveStaticSeoPage, toMetadata } from "../../seo/resolve"

export const metadata: Metadata = toMetadata(resolveStaticSeoPage("/docs/errors"))

export default function Page() {
  return <DocsPage href="/docs/errors" Content={Content} />
}
