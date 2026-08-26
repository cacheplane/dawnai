import type { Metadata } from "next"
import Content from "../../../../content/docs/recipes/stream-output.mdx"
import { DocsPage } from "../../../components/docs/DocsPage"
import { resolveStaticSeoPage, toMetadata } from "../../../seo/resolve"

export const metadata: Metadata = toMetadata(resolveStaticSeoPage("/docs/recipes/stream-output"))

export default function Page() {
  return <DocsPage href="/docs/recipes/stream-output" Content={Content} />
}
