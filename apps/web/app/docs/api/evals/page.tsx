import type { Metadata } from "next"
import Content from "../../../../content/docs/api/evals.mdx"
import { DocsPage } from "../../../components/docs/DocsPage"
import { resolveStaticSeoPage, toMetadata } from "../../../seo/resolve"

export const metadata: Metadata = toMetadata(resolveStaticSeoPage("/docs/api/evals"))

export default function Page() {
  return <DocsPage href="/docs/api/evals" Content={Content} />
}
