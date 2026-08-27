import type { Metadata } from "next"
import Content from "../../../content/docs/evals.mdx"
import { DocsPage } from "../../components/docs/DocsPage"
import { resolveStaticSeoPage, toMetadata } from "../../seo/resolve"

export const metadata: Metadata = toMetadata(resolveStaticSeoPage("/docs/evals"))

export default function Page() {
  return <DocsPage href="/docs/evals" Content={Content} />
}
