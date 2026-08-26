import type { Metadata } from "next"
import Content from "../../../content/docs/retry.mdx"
import { DocsPage } from "../../components/docs/DocsPage"
import { resolveStaticSeoPage, toMetadata } from "../../seo/resolve"

export const metadata: Metadata = toMetadata(resolveStaticSeoPage("/docs/retry"))

export default function Page() {
  return <DocsPage href="/docs/retry" Content={Content} />
}
